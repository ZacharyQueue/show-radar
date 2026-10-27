// 阶段、轮次和事件。规则见 docs/design.md“阶段”“推什么”。
// 只做计算，不读写状态库：输入演出上一轮的状态和名下的记录，输出新状态和要记的事件。

import { beijingDate, startOfBeijingDay } from './time.mjs'

export const SOURCE_ORDER = ['damai', 'maoyan', 'showstart', 'gov']
export const SOURCE_LABELS = { damai: '大麦', maoyan: '猫眼', showstart: '秀动', gov: '文旅部' }

// 售票记录连着这么多轮没在搜索里出现，就当它下线了
export const MISSING_RUNS_OFFLINE = 2

const MINUTE = 60_000
const PENDING = new Set(['sale_pending', 'resale_pending'])
// 同一轮分批开售时，两批之间最多隔这么久
const BATCH_GAP_MS = 72 * 3600_000
// 这些事件推出去以后，记下推过的开售时间
const SETS_ANNOUNCED = new Set(['sale_announced', 'resale_announced', 'sale_changed', 'sale_restored', 'resumed'])

export function roundName(round) {
  if (round <= 2) return '二开'
  if (round === 3) return '三开'
  return `第${round}轮开售`
}

export function stageLabel(stage, round = 0) {
  switch (stage) {
    case 'approved':
      return '已报批'
    case 'listed':
      return '已上架'
    case 'sale_pending':
      return '待开票'
    case 'resale_pending':
      return roundName(round)
    case 'onsale':
      return '开售'
    case 'soldout':
      return '售罄'
    case 'waiting':
      return '等下一轮'
    case 'postponed':
      return '延期'
    case 'offline':
      return '下架'
    case 'ended':
      return '已结束'
    default:
      return ''
  }
}

/**
 * @param {Object} show 上一轮存下的演出；新建的演出 stage 为 null、round 为 0
 * @param {Array} listings 名下的统一记录，带 missingRuns
 * @param {number} now
 * @returns {{ next: Object, event: Object|null, silent: Object[] }}
 *   next 是要存回去的演出字段；event 是要推的事件（每场每轮最多一条）；silent 是只记不推的事件
 */
export function evaluateShow(show, listings, now) {
  const tickets = listings.filter((l) => l.kind === 'ticket')
  const live = tickets.filter(isLive)
  const approvals = listings.filter((l) => l.kind === 'approval')
  const display = displayFields(show, listings)
  const today = beijingDate(now)
  const day = startOfBeijingDay(now)
  const over = display.dateEnd != null && display.dateEnd < today

  const times = unique(live.flatMap((l) => l.saleTimes ?? []).map(toMinute))
  const future = times.filter((t) => t > now).sort((a, b) => a - b)
  const nextSaleAt = future[0] ?? null

  // 开过票：平台明说过（退票规则、热卖、缺货），或者某个开售时间已经过了
  const prev = show.stage
  const isNewShow = prev == null
  const statedSold = tickets.some((l) => l.hasSold || l.status === 'onsale' || l.status === 'soldout')
  const everSold = show.everSold || statedSold || times.some((t) => t <= now)
  const announced = show.announcedSaleAt == null ? null : toMinute(show.announcedSaleAt)

  // 轮次：开过票以后再出现没见过的将来开售时间，算下一轮
  const known = new Set((show.knownSaleTimes ?? []).map(toMinute))
  const fresh = future.filter((t) => !known.has(t))
  let round = show.round ?? 0
  if (round === 0 && (nextSaleAt != null || everSold)) round = 1
  // 同一轮的下一批：上一轮还在等开售、上一批刚过、新时间离上一批不远。平台常常只露出下一批的时间
  const passedAnnounced = PENDING.has(prev) && announced != null && announced <= now
  const nextBatch = fresh.length > 0 && passedAnnounced && fresh.every((t) => t - announced <= BATCH_GAP_MS)
  // 推过的开售时间在两轮之间过去了，也算开过票：没赶上看到在售，不等于没开
  const soldBefore = show.everSold || passedAnnounced
  if (fresh.length && soldBefore && !nextBatch) round += 1
  else if (fresh.length && isNewShow && statedSold && !live.some((l) => l.status === 'onsale')) round = Math.max(round, 2)
  // 介绍里写了第 N 次：那一轮的时间都过了、又有更晚的将来时间，就是第 N+1 轮
  const { hint, hintAt } = roundHintOf(listings)
  const effectiveHint = hint && nextSaleAt != null && hintAt != null && hintAt <= now && nextSaleAt > hintAt ? hint + 1 : hint
  if (effectiveHint > round) round = effectiveHint

  let stage
  if (live.some((l) => l.status === 'postponed')) stage = 'postponed'
  else if (over) stage = 'ended'
  else if (tickets.length && !live.length) {
    // 平台说演完了，或者今天就是最后一天：算已结束，不推“可能取消”
    const endedNow = tickets.some((l) => l.status === 'ended') || (display.dateEnd != null && display.dateEnd <= today)
    stage = endedNow ? 'ended' : 'offline'
  } else if (!live.length) stage = approvals.length ? 'approved' : null
  else if (nextSaleAt != null) stage = round >= 2 ? 'resale_pending' : 'sale_pending'
  else if (live.some((l) => l.status === 'onsale')) stage = 'onsale'
  else if (live.some((l) => l.status === 'soldout')) stage = 'soldout'
  else if (everSold) stage = 'waiting'
  else stage = 'listed'

  const reached = new Set(show.reached ?? [])
  const silent = []
  if (approvals.length && !reached.has('approved') && stage !== 'approved' && !isNewShow) {
    silent.push({ kind: 'approved', round: 0, saleAt: 0, detail: {} })
  }
  if (approvals.length) reached.add('approved')
  if (tickets.length) reached.add('listed')
  if (stage) reached.add(stage)

  // 推过的开售时间撤掉了：连着两轮都没有将来的开售时间才算，免得平台一轮漏给就推一对假消息
  const withdrawing = nextSaleAt == null && announced != null && announced > now && ['listed', 'waiting', 'approved'].includes(stage)
  const withdrawRuns = withdrawing ? (show.withdrawRuns ?? 0) + 1 : 0

  const saleSources = nextSaleAt == null ? [] : sourcesWithTime(live, nextSaleAt)
  const onsaleSources = sourcesWithStatus(live, 'onsale')
  let event = null

  if (isNewShow) {
    event = firstEvent(stage, round, nextSaleAt, saleSources, onsaleSources)
  } else if (stage === 'postponed') {
    if (prev !== 'postponed') event = { kind: 'postponed', round: 0, saleAt: day, detail: {} }
  } else if (stage === 'offline') {
    if (prev !== 'offline' && prev !== 'ended') event = { kind: 'offline', round: 0, saleAt: day, detail: {} }
  } else if (stage === 'ended') {
    // 演完了不推
  } else if ((prev === 'offline' || prev === 'postponed') && stage !== 'approved') {
    event = { kind: 'resumed', round, saleAt: day, detail: { from: prev, nextSaleAt, saleSources, sources: onsaleSources } }
  } else if (stage === 'listed' || stage === 'waiting') {
    if (withdrawRuns === 2) {
      event = { kind: 'sale_withdrawn', round, saleAt: announced, detail: {} }
      reached.add('withdrawn')
    } else if (prev === 'approved' && stage === 'listed') {
      event = { kind: 'listed', round: 0, saleAt: 0, detail: {} }
    }
  } else if (PENDING.has(stage)) {
    if (announced == null || announced <= now) {
      let kind = stage === 'resale_pending' ? 'resale_announced' : 'sale_announced'
      if (announced == null && reached.has('withdrawn')) kind = 'sale_restored'
      reached.delete('withdrawn')
      event = { kind, round, saleAt: nextSaleAt, detail: { saleSources, nextBatch } }
    } else if (announced !== nextSaleAt) {
      event = { kind: 'sale_changed', round, saleAt: nextSaleAt, detail: { saleSources, previousSaleAt: announced } }
    }
  } else if (stage === 'onsale') {
    if (prev === 'soldout' || prev === 'waiting') {
      event = { kind: 'restock', round, saleAt: day, detail: { sources: onsaleSources } }
    } else if (prev === 'approved' || prev === 'listed') {
      event = { kind: 'onsale_missed', round, saleAt: 0, detail: { sources: onsaleSources } }
    }
  } else if (stage === 'soldout') {
    if (prev !== 'soldout') silent.push({ kind: 'soldout', round, saleAt: day, detail: {} })
    // 两轮之间就上架、开售、卖完了，用户一条都没收到
    if (prev === 'approved') event = { kind: 'listed', round, saleAt: 0, detail: { soldout: true } }
    else if (prev === 'listed') event = { kind: 'onsale_missed', round, saleAt: 0, detail: { sources: [], soldout: true } }
  }

  let announcedSaleAt = show.announcedSaleAt ?? null
  if (event && SETS_ANNOUNCED.has(event.kind)) announcedSaleAt = nextSaleAt
  if (event?.kind === 'sale_withdrawn') announcedSaleAt = null

  return {
    next: {
      ...display,
      stage,
      round,
      everSold,
      nextSaleAt,
      announcedSaleAt,
      withdrawRuns,
      knownSaleTimes: unique([...(show.knownSaleTimes ?? []).map(toMinute), ...future]).sort((a, b) => a - b),
      reached: [...reached],
    },
    event,
    silent,
  }
}

/** 售票记录还算在卖：没下线、没演完、缺席没超过两轮。 */
function isLive(l) {
  return l.kind === 'ticket' && !['offline', 'ended'].includes(l.status) && (l.missingRuns ?? 0) < MISSING_RUNS_OFFLINE
}

/** 介绍里写的最大的“第 N 次”，和那一轮列出的最晚时间。 */
function roundHintOf(listings) {
  let hint = 0
  let hintAt = null
  for (const l of listings) {
    const h = l.roundHint ?? 0
    if (h > hint) {
      hint = h
      hintAt = l.roundHintAt ?? null
    } else if (h === hint && h > 0 && l.roundHintAt != null && (hintAt == null || l.roundHintAt > hintAt)) {
      hintAt = l.roundHintAt
    }
  }
  return { hint, hintAt }
}

/** 新出现的演出：按它一出现就到的阶段推一条。 */
function firstEvent(stage, round, nextSaleAt, saleSources, onsaleSources) {
  switch (stage) {
    case 'approved':
      return { kind: 'approved', round: 0, saleAt: 0, detail: {} }
    case 'listed':
      return { kind: 'listed', round: 0, saleAt: 0, detail: {} }
    case 'soldout':
      return { kind: 'listed', round, saleAt: 0, detail: { soldout: true } }
    case 'waiting':
      return { kind: 'listed', round, saleAt: 0, detail: { waiting: true } }
    case 'sale_pending':
      return { kind: 'sale_announced', round, saleAt: nextSaleAt, detail: { saleSources } }
    case 'resale_pending':
      return { kind: 'resale_announced', round, saleAt: nextSaleAt, detail: { saleSources } }
    case 'onsale':
      return { kind: 'onsale_missed', round, saleAt: 0, detail: { sources: onsaleSources } }
    case 'postponed':
      return { kind: 'postponed', round: 0, saleAt: 0, detail: {} }
    default:
      return null
  }
}

/**
 * 演出给人看的字段：标题、场馆优先用售票平台的，按大麦、猫眼、秀动、文旅部的顺序取。
 * 日期优先取还在卖的售票记录，其次全部售票记录，最后才用报批：报批的日期常含搭台、彩排日。
 * “是否多人同台”按售票记录重算，大麦、猫眼优先，报批不算。
 */
export function displayFields(show, listings) {
  const byOrder = (a, b) => (a.kind === 'ticket' ? 0 : 1) - (b.kind === 'ticket' ? 0 : 1) || SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source)
  const sorted = [...listings].sort(byOrder)
  const first = (pick) => sorted.map(pick).find((v) => v != null && v !== '')
  const tickets = listings.filter((l) => l.kind === 'ticket')
  const live = tickets.filter(isLive)
  const datesFrom = [live, tickets, listings].find((group) => group.some((l) => l.dateStart)) ?? []
  const starts = datesFrom.map((l) => l.dateStart).filter(Boolean).sort()
  const ends = datesFrom.map((l) => l.dateEnd ?? l.dateStart).filter(Boolean).sort()
  const mixedFrom = [...tickets].sort(byOrder)[0]
  return {
    artistKey: show.artistKey,
    city: show.city ?? first((l) => l.city) ?? null,
    venue: first((l) => l.venue) ?? show.venue ?? null,
    title: first((l) => l.title) ?? show.title ?? '',
    dateStart: starts[0] ?? show.dateStart ?? null,
    dateEnd: ends[ends.length - 1] ?? show.dateEnd ?? null,
    isMixed: mixedFrom ? mixedFrom.isMixed : (show.isMixed ?? false),
  }
}

/** 时间线：已报批 → 已上架 → 待开票 → 开售 → 二开…，只列到过的。 */
export function timeline(show) {
  const reached = new Set(show.reached ?? [])
  const steps = []
  if (reached.has('approved')) steps.push('已报批')
  if (reached.has('listed')) steps.push('已上架')
  if (reached.has('sale_pending') || show.round >= 1) steps.push('待开票')
  if (show.everSold) steps.push('开售')
  for (let r = 2; r <= (show.round ?? 0); r++) steps.push(roundName(r))
  if (show.stage === 'soldout') steps.push('售罄')
  if (show.stage === 'waiting') steps.push('等下一轮')
  if (show.stage === 'postponed') steps.push('延期')
  if (show.stage === 'offline') steps.push('下架')
  return steps
}

function sourcesWithTime(listings, t) {
  return orderSources(listings.filter((l) => (l.saleTimes ?? []).some((x) => toMinute(x) === t)).map((l) => l.source))
}

function sourcesWithStatus(listings, status) {
  return orderSources(listings.filter((l) => l.status === status).map((l) => l.source))
}

function orderSources(sources) {
  return unique(sources).sort((a, b) => SOURCE_ORDER.indexOf(a) - SOURCE_ORDER.indexOf(b))
}

function toMinute(t) {
  return Math.round(t / MINUTE) * MINUTE
}

function unique(arr) {
  return [...new Set(arr)]
}
