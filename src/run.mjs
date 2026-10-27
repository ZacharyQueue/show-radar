// 一轮抓取：取数 → 存记录 → 合成演出 → 判断阶段 → 推送 → 健康检查和周报。
// 步骤说明见 docs/design.md“一轮怎么跑”。

import { ApiChangedError, BlockedError, NetworkError } from './errors.mjs'
import { fetchKey, MIN_FETCH_GAP_MS } from './fetch-log.mjs'
import { createSourceClient } from './http.mjs'
import { findShowForListing } from './merge.mjs'
import { digestMessage, eventCard, healthText, lateSourcesText, showLine, summaryTexts, textMessage, weeklyText, TEXT_MAX } from './notify/format.mjs'
import { displayFields, evaluateShow } from './stage.mjs'
import { beijingDate, beijingParts, startOfBeijingDay } from './time.mjs'
import { truncateBytes } from './text.mjs'

const DAY_MS = 86400_000
const ID_RETRY_MS = 7 * DAY_MS
const HEALTH_ALERT_RUNS = 3
const MAX_CARDS_PER_RUN = 15
const NETWORK_ERRORS_TO_STOP = 3
// 一天只取一次的数据源（everyRun 为 false），放到每天 9 点以后的第一轮取
const SLOW_SOURCE_HOUR = 9
const OUTBOX_KV = 'outbox.texts'
const SALE_KINDS = new Set(['sale_announced', 'resale_announced', 'sale_changed', 'sale_restored'])
// 一轮最多取这么久，到了就不再取新的艺人，已经取到的照常存下、推送。systemd 给一轮 40 分钟
export const ROUND_BUDGET_MS = 25 * 60_000

/**
 * @param {Object} o
 * @param {Object} o.store openStore() 的返回
 * @param {Array} o.adapters 数据源适配器
 * @param {Array} o.artists 艺人清单 [{ key, aliases }]，整份清单，用来同步状态库
 * @param {Object} o.notifier src/notify/index.mjs 的发送器：{ send, batch }
 * @param {string} [o.onlyArtist] 只跑这一位
 * @param {boolean} [o.forceSlow] 不看时段，一天只取一次的数据源也取
 * @param {Function} [o.now]
 * @param {Function} [o.log]
 * @param {Function} [o.clientFor] 测试时替换请求客户端
 * @param {Object} [o.fetchLog] 取数记录（src/fetch-log.mjs）。给了就守住“同一位艺人在同一个数据源上 1 小时内只取一次”，
 *   并且先取最久没取过的艺人：一轮没取完时，下一轮从没取到的开始
 * @param {number} [o.minFetchGapMs] 测试用；命令行不传，按 MIN_FETCH_GAP_MS
 * @param {AbortSignal} [o.signal] 被要求停下（systemd 停服务、Ctrl+C）时不再取新的艺人，已经取到的照常存下
 * @param {number} [o.budgetMs] 一轮最多取多久
 */
export async function runRound({
  store,
  adapters,
  artists,
  notifier,
  onlyArtist,
  forceSlow = false,
  now = Date.now,
  log = console.log,
  clientFor,
  fetchLog,
  minFetchGapMs = MIN_FETCH_GAP_MS,
  signal,
  budgetMs = ROUND_BUDGET_MS,
}) {
  const startedAt = now()
  const deadline = startedAt + budgetMs
  const runId = store.startRun(startedAt)
  store.syncArtists(artists, startedAt)
  const active = store.activeArtists().filter((a) => !onlyArtist || a.key === onlyArtist)
  const hadBaseline = new Map(active.map((a) => [a.key, store.hasAnyBaseline(a.key)]))

  // 1. 取数：各数据源同时跑，同一数据源里按艺人一位位来
  const results = await Promise.all(
    adapters.map((adapter) =>
      fetchSource({
        adapter,
        artists: active,
        store,
        now,
        log,
        forceSlow,
        fetchLog,
        minFetchGapMs,
        stop: () => (signal?.aborted ? 'signal' : now() >= deadline ? 'budget' : null),
        client: clientFor ? clientFor(adapter) : createSourceClient(adapter.clientOptions),
      }),
    ),
  )

  // 2. 存记录、合成演出、判断阶段，一个事务里做完
  const t = now()
  const newArtists = new Map()
  const lateShows = new Map() // 艺人 → { sources, showIds }：晚到的数据源独自建出的演出，合成一条补充消息
  store.transaction(() => {
    const created = new Map() // 这一轮新建的演出 → 建出它的数据源
    const firstSources = new Map() // 艺人 → 这一轮第一次取数成功的数据源
    const withData = new Set()
    const unlinked = []
    for (const r of results) {
      if (r.skipped) continue
      // 适配器的备忘和这一轮的记录一起落盘
      for (const [key, value] of r.staged) store.kv.set(key, value)
      // 一天只取一次的数据源：每位艺人今天都取过了才记今天取过。一轮取不完的，下一轮只取今天还没取的
      if (!r.adapter.everyRun && !r.error && r.perArtist.length && doneToday(r.adapter, active, fetchLog, t, r)) store.kv.set(`source.${r.adapter.name}.lastDay`, beijingDate(t))
      for (const { artist, listings } of r.perArtist) {
        const source = r.adapter.name
        withData.add(artist.key)
        if (!store.isBaselined(artist.key, source)) {
          if (!firstSources.has(artist.key)) firstSources.set(artist.key, new Set())
          firstSources.get(artist.key).add(source)
        }
        for (const listing of listings) {
          store.upsertListing(listing, t)
          if (store.showIdForListing(listing) == null) unlinked.push({ listing, source })
        }
        store.markMissing(artist.key, source, listings.map((l) => l.sourceId))
        store.markBaselined(artist.key, source, t)
      }
    }

    // 先把已归场的记录更新到演出上，再给新记录找场：同一轮里补上日期的场也能被找到
    const dateless = new Set()
    for (const artistKey of withData) {
      for (const show of store.showsForArtist(artistKey)) {
        if (show.stage === 'ended') continue
        if (show.dateStart == null) dateless.add(show.id)
        const listings = store.listingsOfShow(show.id)
        if (listings.length) store.updateShow(show.id, { ...show, ...displayFields(show, listings) }, t)
      }
    }
    for (const { listing, source } of unlinked) {
      const found = findShowForListing(listing, store.showsForArtist(listing.artistKey))
      const showId = found ? found.id : store.createShow(listing, t)
      if (!found) created.set(showId, new Set())
      created.get(showId)?.add(source)
      store.linkListing(showId, listing)
    }
    // 没日期时单独建的场，有了日期再归一次，对得上就并过去
    for (const id of dateless) {
      const show = store.getShow(id)
      const dated = show && store.listingsOfShow(id).find((l) => l.dateStart && l.city)
      if (!dated) continue
      const target = findShowForListing(dated, store.showsForArtist(show.artistKey), id)
      if (!target) continue
      store.absorbShow(id, target.id, t)
      if (created.has(id)) {
        if (!created.has(target.id)) created.set(target.id, new Set())
        for (const src of created.get(id)) created.get(target.id).add(src)
        created.delete(id)
      }
    }

    for (const artistKey of withData) {
      const first = firstSources.get(artistKey) ?? new Set()
      const summaryRound = !hadBaseline.get(artistKey)
      for (const show of store.showsForArtist(artistKey)) {
        if (show.stage === 'ended') continue
        const listings = store.listingsOfShow(show.id)
        if (!listings.length) continue
        const { next, event, silent } = evaluateShow(show, listings, t)
        store.updateShow(show.id, next, t)
        // 建底：汇总那一轮整位艺人只记不推；之后某个数据源第一次取到、独自建出的演出，也只记不推，合进补充消息
        const onlyFirst = created.has(show.id) && [...created.get(show.id)].every((s) => first.has(s))
        if (event) store.addEvent({ showId: show.id, artistKey, ...event, silent: summaryRound || onlyFirst }, t)
        for (const e of silent) store.addEvent({ showId: show.id, artistKey, ...e, silent: true }, t)
        if (onlyFirst && !summaryRound && next.stage && next.stage !== 'ended') {
          if (!lateShows.has(artistKey)) lateShows.set(artistKey, { sources: new Set(), showIds: [] })
          const late = lateShows.get(artistKey)
          for (const src of created.get(show.id)) late.sources.add(src)
          late.showIds.push(show.id)
        }
      }
      if (summaryRound) newArtists.set(artistKey, true)
    }
  })

  // 3. 健康检查：连着几轮取不到就提醒，恢复了再说一声
  const outbox = readOutbox(store)
  const health = []
  for (const r of results) {
    if (r.skipped) continue
    // 一次都没真正取过（比如所有艺人在它上面都没有 ID），不算成功也不算失败
    if (!r.error && r.attempted === 0) continue
    const h = store.getHealth(r.adapter.name)
    const failed = Boolean(r.error) || (r.perArtist.length === 0 && r.networkErrors > 0)
    if (failed) {
      h.failRuns += 1
      h.lastError = describeError(r.error ?? r.lastError)
      if (h.failRuns >= HEALTH_ALERT_RUNS && !h.alerted) {
        outbox.push(healthText({ source: r.adapter.name, status: 'down', reason: h.lastError, failRuns: h.failRuns }))
        h.alerted = true
      }
    } else {
      if (h.alerted) outbox.push(healthText({ source: r.adapter.name, status: 'up' }))
      h.failRuns = 0
      h.alerted = false
      h.lastError = null
      h.lastOkAt = t
    }
    store.saveHealth(h)
    health.push({ source: r.adapter.name, ok: !failed, reason: h.lastError })
  }

  // 4. 新关注艺人的汇总
  if (newArtists.size) {
    const entries = active
      .filter((a) => newArtists.has(a.key))
      .map((a) => ({
        artistKey: a.key,
        sources: results
          .filter((r) => !r.skipped && r.adapter.needsArtistId)
          .map((r) => {
            const got = r.perArtist.find((p) => p.artist.key === a.key)
            return { source: r.adapter.name, found: got ? Boolean(got.idFound || got.listings.length) : null }
          }),
        shows: store.showsForArtist(a.key),
      }))
    outbox.unshift(...summaryTexts(entries))
  }
  for (const [artistKey, late] of lateShows) {
    outbox.push(lateSourcesText(artistKey, [...late.sources], late.showIds.map((id) => store.getShow(id)).filter(Boolean)))
  }

  // 5. 周报：周一 9 点以后的第一轮
  const p = beijingParts(t)
  const weekKey = beijingDate(startOfBeijingDay(t) - ((p.weekday + 6) % 7) * DAY_MS)
  if (p.weekday === 1 && p.hour >= 9 && store.kv.get('weekly.lastWeek') !== weekKey) {
    const allActive = store.activeArtists()
    const tracked = allActive.flatMap((a) => store.showsForArtist(a.key)).filter((s) => s.stage && !['ended', 'offline'].includes(s.stage))
    outbox.push(weeklyText({ artistCount: allActive.length, showCount: tracked.length, pushedCount: store.countEventsSince(t - 7 * DAY_MS), health: allHealth(store, adapters) }))
    store.kv.set('weekly.lastWeek', weekKey)
  }
  writeOutbox(store, outbox)

  // 6. 推送
  const pushed = await deliver({ store, notifier, now, log })

  const stats = {
    sources: Object.fromEntries(
      results.map((r) => [
        r.adapter.name,
        r.skipped
          ? '跳过'
          : {
              ok: !r.error,
              artists: r.perArtist.length,
              listings: r.perArtist.reduce((n, x) => n + x.listings.length, 0),
              requests: r.requests,
              error: r.error ? describeError(r.error) : null,
              ...(r.recent.length ? { recent: r.recent, retryAt: r.retryAt } : {}),
              ...(r.unfinished.length ? { unfinished: r.unfinished } : {}),
            },
      ]),
    ),
    pushed,
  }
  store.finishRun(runId, now(), stats)
  return stats
}

/**
 * 一个数据源跑完全部艺人。被拦、接口变了就停；网络错误连着 3 次也停。
 * 1 小时内去取过的艺人跳过，记在 recent 里，retryAt 是最早能再取的时间：手动连着跑也不会把站点刷爆。
 * 时间到了或被要求停下，不再取新的艺人，没取到的记在 unfinished 里。
 */
async function fetchSource({ adapter, artists, store, now, log, forceSlow, client, fetchLog, minFetchGapMs, stop }) {
  const out = { adapter, perArtist: [], error: null, lastError: null, networkErrors: 0, requests: 0, skipped: false, attempted: 0, staged: new Map(), recent: [], retryAt: null, unfinished: [] }
  if (!adapter.everyRun && !forceSlow) {
    const p = beijingParts(now())
    if (p.hour < SLOW_SOURCE_HOUR || store.kv.get(`source.${adapter.name}.lastDay`) === beijingDate(now())) {
      out.skipped = true
      return out
    }
  }
  // 适配器写的备忘先暂存，和这一轮的记录在同一个事务里落盘；一轮中途被杀，两边一起作废
  const kv = {
    get: (key) => (out.staged.has(key) ? out.staged.get(key) : store.kv.get(key)),
    set: (key, value) => out.staged.set(key, value == null ? null : typeof value === 'string' ? value : JSON.stringify(value)),
  }
  // 最久没取过的先取：上一轮时间到了没取完的，这一轮排在前面
  // 记录的时间在将来（时钟拨过），和下面一样当作没取过
  const lastOf = (a) => {
    const last = fetchLog?.get(fetchKey(adapter.name, a.key))
    return last != null && last <= now() ? last : -Infinity
  }
  const ordered = fetchLog ? [...artists].sort((a, b) => lastOf(a) - lastOf(b)) : artists
  for (const [i, artist] of ordered.entries()) {
    const why = stop()
    if (why) {
      out.unfinished = ordered.slice(i).map((a) => a.key)
      const reason = why === 'signal' ? '收到停止信号' : '这一轮的时间到了'
      log(`[${adapter.name}] ${reason}，还有 ${out.unfinished.length} 位艺人下一轮先取：${out.unfinished.join('、')}`)
      break
    }
    if (fetchLog) {
      const last = fetchLog.get(fetchKey(adapter.name, artist.key))
      // 一天只取一次的数据源，今天取过的不再取
      if (!adapter.everyRun && last != null && last <= now() && beijingDate(last) === beijingDate(now())) continue
      // 记录的时间在将来（电脑时钟拨过），当作没取过
      if (last != null && last <= now() && now() - last < minFetchGapMs) {
        out.recent.push(artist.key)
        out.retryAt = Math.min(out.retryAt ?? Infinity, last + minFetchGapMs)
        continue
      }
      // 去取之前就记下：被拦、出错也算取过一次，不能马上重来
      fetchLog.set(fetchKey(adapter.name, artist.key), now())
    }
    const ctx = {
      client,
      now,
      log: (msg) => log(`[${adapter.name}] ${msg}`),
      kv,
      previous: (sourceId) => store.getListing(adapter.name, String(sourceId), artist.key),
    }
    try {
      const ids = { ...artist.ids }
      let idFound = ids[adapter.name] != null
      if (adapter.needsArtistId && !idFound) {
        const checked = artist.idsCheckedAt[adapter.name]
        if (checked == null || now() - checked > ID_RETRY_MS) {
          out.attempted += 1
          const found = await adapter.resolveArtist(artist, ctx)
          // undefined 表示这一轮没查成，下一轮再查；null 才是查过、平台上没有
          if (found !== undefined) store.setArtistId(artist.key, adapter.name, found, now())
          if (found) {
            ids[adapter.name] = String(found.id)
            idFound = true
          }
        }
      }
      if (!adapter.needsArtistId || ids[adapter.name] != null) out.attempted += 1
      const listings = await adapter.fetchArtist({ key: artist.key, aliases: artist.aliases, ids }, ctx)
      out.perArtist.push({ artist, listings, idFound })
      out.networkErrors = 0
    } catch (err) {
      if (err instanceof NetworkError) {
        out.lastError = err
        out.networkErrors += 1
        log(`[${adapter.name}] ${artist.key}：${err.message}`)
        if (out.networkErrors >= NETWORK_ERRORS_TO_STOP) {
          out.error = err
          break
        }
        continue
      }
      // 被拦、接口变了，或者适配器自己出了错：这一轮停掉这个数据源
      out.error = err
      log(`[${adapter.name}] 停止：${err instanceof BlockedError || err instanceof ApiChangedError ? err.message : err.stack}`)
      break
    }
  }
  out.requests = client.requestCount
  return out
}

/**
 * 发消息，返回发出去的条数。
 * 逐条发的通道（企业微信、WxPusher、Bark）：先发文字（汇总、提醒、周报），再发卡片，一轮最多 15 张，多的合成一条清单。
 * 按条数计费的通道（Server酱）：这一轮要发的全部合成一条。
 * 一条消息只要有一种通道发出去了就算推过；都没发出去的留到下一轮。
 */
async function deliver({ store, notifier, now, log }) {
  const outbox = readOutbox(store)
  const queue = latestPending(store, now)
  if (!outbox.length && !queue.length) return 0
  const cards = new Map(queue.map((e) => [e.id, eventCard(e, store.getShow(e.showId), store.listingsOfShow(e.showId))]))
  const sentTexts = new Set()
  const sentEvents = new Set()
  // 发失败时怎么说：另一路已经送到的，不说“下一轮再发”，免得说了却不重发
  const failed = (path) => (err) => log(`${path}这次没发出去：${err.message}`)

  if (notifier.single) {
    single: {
      for (let i = 0; i < outbox.length; i++) {
        try {
          await notifier.send(textMessage(outbox[i]))
        } catch (err) {
          failed('逐条推送')(err)
          break single
        }
        sentTexts.add(i)
      }
      for (const e of queue.slice(0, MAX_CARDS_PER_RUN)) {
        try {
          await notifier.send(cards.get(e.id))
        } catch (err) {
          failed('逐条推送')(err)
          break single
        }
        sentEvents.add(e.id)
      }
      const overflow = queue.slice(MAX_CARDS_PER_RUN)
      if (overflow.length) {
        const lines = overflow.map((e) => {
          const show = store.getShow(e.showId)
          return `· ${show.artistKey} ${showLine(show)}`
        })
        try {
          await notifier.send(textMessage(truncateBytes(`这一轮变化比较多，还有 ${overflow.length} 场：\n${lines.join('\n')}`, TEXT_MAX)))
          for (const e of overflow) sentEvents.add(e.id)
        } catch (err) {
          failed('逐条推送')(err)
        }
      }
    }
  }

  if (notifier.batch) {
    try {
      await notifier.sendDigest(digestMessage([...outbox.map(textMessage), ...cards.values()]))
      outbox.forEach((_, i) => sentTexts.add(i))
      for (const e of queue) sentEvents.add(e.id)
    } catch (err) {
      failed('合成的那条')(err)
    }
  }

  writeOutbox(
    store,
    outbox.filter((_, i) => !sentTexts.has(i)),
  )
  for (const id of sentEvents) store.markNotified(id, now())
  const left = outbox.length - sentTexts.size + queue.length - sentEvents.size
  if (left) log(`还有 ${left} 条一个通道都没发出去，下一轮再发`)
  return sentTexts.size + sentEvents.size
}

/** 一天只取一次的数据源，今天每位艺人都取过了没有。没有取数记录时（测试），看这一轮有没有取完。 */
function doneToday(adapter, artists, fetchLog, t, r) {
  if (!fetchLog) return !r.unfinished.length
  return artists.every((a) => {
    const last = fetchLog.get(fetchKey(adapter.name, a.key))
    return last != null && last <= t && beijingDate(last) === beijingDate(t)
  })
}

/** 要推的事件：开售时间已经过了的不再推；同一场演出积了几条没发的，只推最新那条。 */
function latestPending(store, now) {
  const latest = new Map()
  for (const e of store.pendingEvents()) {
    const t = now()
    if (SALE_KINDS.has(e.kind) && e.saleAt && e.saleAt <= t) {
      store.markNotified(e.id, t)
      continue
    }
    const older = latest.get(e.showId)
    if (older) store.markNotified(older.id, t)
    latest.set(e.showId, e)
  }
  return [...latest.values()]
}

function readOutbox(store) {
  try {
    return JSON.parse(store.kv.get(OUTBOX_KV) ?? '[]')
  } catch {
    return []
  }
}

function writeOutbox(store, list) {
  store.kv.set(OUTBOX_KV, JSON.stringify(list))
}

function allHealth(store, adapters) {
  return adapters.map((a) => {
    const h = store.getHealth(a.name)
    return { source: a.name, ok: h.failRuns === 0, reason: h.lastError }
  })
}

export function describeError(err) {
  if (!err) return '未知原因'
  if (err instanceof BlockedError) return `被平台拦下（${err.reason}）`
  if (err instanceof ApiChangedError) return `接口变了，要改代码（${err.reason}）`
  if (err instanceof NetworkError) return `连不上（${err.reason}）`
  return `程序出错（${err.message}）`
}
