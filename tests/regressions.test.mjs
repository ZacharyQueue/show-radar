// 整体审查找出的问题，每条一个场景，修好以后防止回退。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeListing } from '../src/listing.mjs'
import { findShowForListing } from '../src/merge.mjs'
import { eventCard, pickUrl, reminderCard, DESC_MAX } from '../src/notify/format.mjs'
import { createUnconfiguredNotifier } from '../src/notify/index.mjs'
import { runRound } from '../src/run.mjs'
import { runReminders } from '../src/remind.mjs'
import { evaluateShow } from '../src/stage.mjs'
import { openStore } from '../src/store.mjs'
import { fromBeijing } from '../src/time.mjs'
import { BlockedError } from '../src/errors.mjs'

const HOUR = 3600_000
const DAY = 24 * HOUR
const NOW = fromBeijing(2026, 10, 27, 9, 7)

function emptyShow(extra = {}) {
  return { id: 1, artistKey: '薛之谦', city: '无锡', venue: null, dateStart: '2026-11-13', dateEnd: '2026-11-22', title: '', isMixed: false, stage: null, round: 0, everSold: false, nextSaleAt: null, announcedSaleAt: null, withdrawRuns: 0, knownSaleTimes: [], reached: [], ...extra }
}

function ticket(extra = {}) {
  return { source: 'damai', sourceId: '1', artistKey: '薛之谦', kind: 'ticket', title: '薛之谦演唱会-无锡站', city: '无锡', venue: '无锡奥体', dateStart: '2026-11-13', dateEnd: '2026-11-22', matchedBy: 'id', isMixed: false, status: 'listed', saleTimes: [], hasSold: false, roundHint: null, roundHintAt: null, approval: null, url: 'https://m.damai.cn/1', missingRuns: 0, ...extra }
}

function approval(extra = {}) {
  return { source: 'gov', sourceId: 'g1', artistKey: '薛之谦', kind: 'approval', title: '薛之谦演唱会-无锡站', city: '无锡', venue: '无锡奥林匹克体育中心体育场', dateStart: '2026-11-12', dateEnd: '2026-11-22', matchedBy: 'title', isMixed: false, status: null, saleTimes: [], hasSold: false, roundHint: null, roundHintAt: null, approval: { date: '2026-10-09', number: 'x', approver: '江苏省文化和旅游厅', isChange: false }, url: 'https://gov/1', missingRuns: 0, ...extra }
}

function play(rounds, start = emptyShow()) {
  let show = start
  return rounds.map(({ listings, now }) => {
    const r = evaluateShow(show, listings, now)
    show = { ...show, ...r.next }
    return { ...r, show }
  })
}

test('卖过以后平台改回预约、没给时间：阶段是“等下一轮”；之后又在卖推“又有票了”', () => {
  const r = play([
    { now: NOW, listings: [ticket({ status: 'onsale', hasSold: true })] },
    { now: NOW + 6 * HOUR, listings: [ticket({ status: 'soldout', hasSold: true })] },
    { now: NOW + 12 * HOUR, listings: [ticket({ status: 'presale', hasSold: true })] },
    { now: NOW + 18 * HOUR, listings: [ticket({ status: 'onsale', hasSold: true })] },
  ])
  assert.equal(r[2].show.stage, 'waiting')
  assert.equal(r[2].event, null)
  assert.equal(r[3].event.kind, 'restock')
})

test('分批开售只露出下一批的时间：同一轮的下一批，不算二开', () => {
  const a = NOW + 2 * HOUR
  const b = a + DAY
  const c = b + DAY
  const r = play([
    { now: NOW, listings: [ticket({ source: 'maoyan', status: 'presale', saleTimes: [a] })] },
    { now: a + 4 * HOUR, listings: [ticket({ source: 'maoyan', status: 'presale', saleTimes: [b] })] },
    { now: b + 4 * HOUR, listings: [ticket({ source: 'maoyan', status: 'presale', saleTimes: [c] })] },
  ])
  assert.deepEqual(r.map((x) => x.show.round), [1, 1, 1])
  assert.equal(r[1].event.kind, 'sale_announced')
  assert.equal(r[1].event.detail.nextBatch, true)
  assert.equal(eventCard(r[1].event, r[1].show, [ticket({ source: 'maoyan', saleTimes: [b] })]).title, '薛之谦 · 无锡 · 下一批开售')
})

test('分批的判断不吞掉真二开：中间见过在售或售罄，或者隔得远，照样加轮', () => {
  const a = NOW + 2 * HOUR
  const r = play([
    { now: NOW, listings: [ticket({ status: 'presale', saleTimes: [a] })] },
    { now: a + HOUR, listings: [ticket({ status: 'soldout', hasSold: true, saleTimes: [a] })] },
    { now: a + 7 * HOUR, listings: [ticket({ status: 'presale', hasSold: true, saleTimes: [a, a + DAY] })] },
  ])
  assert.equal(r[2].show.round, 2)
  assert.equal(r[2].event.kind, 'resale_announced')
  const far = play([
    { now: NOW, listings: [ticket({ status: 'presale', saleTimes: [a] })] },
    { now: a + HOUR, listings: [ticket({ status: 'presale', saleTimes: [a, a + 5 * DAY] })] },
  ])
  assert.equal(far[1].show.round, 2)
})

test('已报批或已上架以后两轮之间直接卖完：推“已上架（售罄）”或“已开售并售罄”', () => {
  const fromApproved = play([
    { now: NOW, listings: [approval()] },
    { now: NOW + 6 * HOUR, listings: [approval(), ticket({ status: 'soldout', hasSold: true })] },
  ])
  assert.equal(fromApproved[1].event.kind, 'listed')
  assert.equal(fromApproved[1].event.detail.soldout, true)
  const fromListed = play([
    { now: NOW, listings: [ticket()] },
    { now: NOW + 6 * HOUR, listings: [ticket({ status: 'soldout', hasSold: true })] },
  ])
  assert.equal(fromListed[1].event.kind, 'onsale_missed')
  assert.equal(eventCard(fromListed[1].event, fromListed[1].show, [ticket()]).title, '薛之谦 · 无锡 · 已开售并售罄')
})

test('延期、下架按天去重：隔天再延期照推；下架后又在卖推“恢复售票”', () => {
  const r = play([
    { now: NOW, listings: [ticket({ status: 'onsale', hasSold: true })] },
    { now: NOW + HOUR, listings: [ticket({ status: 'postponed', hasSold: true })] },
    { now: NOW + 2 * HOUR, listings: [ticket({ status: 'onsale', hasSold: true })] },
    { now: NOW + 2 * DAY, listings: [ticket({ status: 'postponed', hasSold: true })] },
  ])
  assert.equal(r[1].event.kind, 'postponed')
  assert.equal(r[2].event.kind, 'resumed')
  assert.equal(r[3].event.kind, 'postponed')
  assert.notEqual(r[1].event.saleAt, r[3].event.saleAt, '两次延期的事件键不同，不会被去重吞掉')

  const off = play([
    { now: NOW, listings: [ticket({ status: 'onsale', hasSold: true })] },
    { now: NOW + HOUR, listings: [ticket({ status: 'offline', hasSold: true })] },
    { now: NOW + 2 * HOUR, listings: [ticket({ status: 'presale', hasSold: true, saleTimes: [NOW + DAY] })] },
  ])
  assert.equal(off[1].event.kind, 'offline')
  assert.equal(off[2].event.kind, 'resumed')
  assert.equal(off[2].show.announcedSaleAt, NOW + DAY)
  assert.match(eventCard(off[2].event, off[2].show, [ticket({ saleTimes: [NOW + DAY] })]).description, /下架以后又挂出来了，10月28日（周三）09:07 开售/)
})

test('推过的开售时间撤掉：连着两轮没时间才推“撤了”；重新挂出推“重新公布”', () => {
  const x = NOW + 2 * DAY
  const r = play([
    { now: NOW, listings: [ticket({ status: 'presale', saleTimes: [x] })] },
    { now: NOW + 6 * HOUR, listings: [ticket({ status: 'presale' })] },
    { now: NOW + 12 * HOUR, listings: [ticket({ status: 'presale' })] },
    { now: NOW + 18 * HOUR, listings: [ticket({ status: 'presale', saleTimes: [x] })] },
  ])
  assert.equal(r[1].event, null, '一轮没给时间先不推')
  assert.equal(r[2].event.kind, 'sale_withdrawn')
  assert.equal(r[2].show.announcedSaleAt, null)
  assert.equal(r[3].event.kind, 'sale_restored')
  assert.equal(r[3].event.saleAt, x)

  const blip = play([
    { now: NOW, listings: [ticket({ status: 'presale', saleTimes: [x] })] },
    { now: NOW + 6 * HOUR, listings: [ticket({ status: 'presale' })] },
    { now: NOW + 12 * HOUR, listings: [ticket({ status: 'presale', saleTimes: [x] })] },
  ])
  assert.deepEqual(blip.map((b) => b.event?.kind ?? null), ['sale_announced', null, null], '只漏给一轮不推')
})

test('介绍里第三次销售的时间都过了、又有更晚的将来时间：第一次见到就算第 4 轮', () => {
  const third = fromBeijing(2026, 10, 26, 10, 0)
  const next = fromBeijing(2026, 10, 28, 10, 0)
  const r = play([{ now: NOW, listings: [ticket({ status: 'soldout', hasSold: true, roundHint: 3, roundHintAt: third, saleTimes: [third, next] })] }])
  assert.equal(r[0].show.round, 4)
  assert.equal(r[0].show.stage, 'resale_pending')
  const still = play([{ now: NOW, listings: [ticket({ status: 'presale', hasSold: true, roundHint: 3, roundHintAt: next, saleTimes: [next] })] }])
  assert.equal(still[0].show.round, 3, '将来时间就是介绍里那一轮，还是第 3 轮')
})

test('展示日期不用报批的：报批 11-12 起，售票 11-13 起，卡片写 11-13', () => {
  const r = play([{ now: NOW, listings: [approval(), ticket()] }])
  assert.equal(r[0].show.dateStart, '2026-11-13')
  const onlyGov = play([{ now: NOW, listings: [approval()] }])
  assert.equal(onlyGov[0].show.dateStart, '2026-11-12')
})

test('平台说演完了、日期是今天：算已结束，不推“可能取消”', () => {
  const today = fromBeijing(2026, 11, 13, 21, 7)
  const r = play([
    { now: NOW, listings: [ticket({ source: 'maoyan', status: 'onsale', hasSold: true, dateEnd: '2026-11-13', dateStart: '2026-11-13' })] },
    { now: today, listings: [ticket({ source: 'maoyan', status: 'ended', hasSold: true, dateEnd: '2026-11-13', dateStart: '2026-11-13' })] },
  ])
  assert.equal(r[1].show.stage, 'ended')
  assert.equal(r[1].event, null)
})

test('合场：专场和音乐节口径不一但场馆对得上，算同一场；报批不比“多人同台”', () => {
  const shows = [{ id: 7, artistKey: '鹿先森乐队', city: '杭州', venue: '杭州临平大剧院', dateStart: '2026-11-20', dateEnd: '2026-11-20', isMixed: false, stage: 'sale_pending' }]
  const mixed = { kind: 'ticket', artistKey: '鹿先森乐队', city: '杭州', venue: '杭州临平大剧院-空中舞台', dateStart: '2026-11-20', dateEnd: '2026-11-20', isMixed: true }
  assert.equal(findShowForListing(mixed, shows)?.id, 7)
  assert.equal(findShowForListing({ ...mixed, venue: '良渚文化公园' }, shows), null, '场馆也对不上就分开')
  assert.equal(findShowForListing({ ...mixed, kind: 'approval', venue: '别的写法' }, shows)?.id, 7)
})

test('卡片截断：标题和场馆里全是 & 也能截完，不卡死', () => {
  const show = { ...emptyShow({ stage: 'sale_pending', nextSaleAt: NOW + DAY, round: 1 }), title: '&'.repeat(120), venue: '&'.repeat(60) }
  const card = eventCard({ kind: 'sale_announced', round: 1, saleAt: NOW + DAY, detail: {} }, show, [ticket()])
  assert.ok(Buffer.byteLength(card.description) <= DESC_MAX)
  assert.ok(Buffer.byteLength(reminderCard(show, [ticket()]).description) <= DESC_MAX)
})

test('链接按记录挑：同一平台原场售罄、加场开售，链接指向加场', () => {
  const sale = NOW + DAY
  const listings = [ticket({ sourceId: 'd1', status: 'soldout', url: 'https://m.damai.cn/d1' }), ticket({ sourceId: 'd2', status: 'presale', saleTimes: [sale], url: 'https://m.damai.cn/d2' })]
  assert.equal(pickUrl({ kind: 'resale_announced', saleAt: sale, detail: {} }, listings), 'https://m.damai.cn/d2')
  assert.equal(reminderCard({ ...emptyShow(), nextSaleAt: sale }, listings).url, 'https://m.damai.cn/d2')
})

// —— 整轮 ——

function adapter(name, fetch, extra = {}) {
  return { name, label: name, clientOptions: { site: name }, needsArtistId: true, everyRun: true, resolveArtist: async (a) => ({ id: `${name}-${a.key}`, name: a.key }), fetchArtist: fetch, check: async () => ({ ok: true, detail: '' }), ...extra }
}

function tl(source, id, extra = {}) {
  return makeListing({ source, sourceId: id, artistKey: '薛之谦', kind: 'ticket', title: `薛之谦演唱会-${extra.city ?? '无锡'}站`, city: '无锡', venue: '无锡奥体', dateStart: '2026-11-13', dateEnd: '2026-11-22', matchedBy: 'id', status: 'presale', url: `https://${source}/${id}`, ...extra })
}

function recorder() {
  const cards = []
  const texts = []
  return { cards, texts, single: true, batch: false, send: async (m) => (m.title && m.description ? cards.push(m) : texts.push(m.text)) }
}

function rig(adapters) {
  const store = openStore(':memory:')
  let clock = NOW
  const run = (notifier, opts = {}) =>
    runRound({ store, adapters: opts.adapters ?? adapters, artists: opts.artists ?? [{ key: '薛之谦', aliases: [] }], notifier, now: () => clock, log: () => {}, clientFor: () => ({ requestCount: 0 }), ...opts })
  return { store, run, advance: (ms) => (clock += ms) }
}

test('晚到的数据源：第一轮秀动被拦，第二轮取到独家场次，补发一条，不逐张推', async () => {
  let blocked = true
  const { run, advance } = rig([
    adapter('damai', async () => [tl('damai', 'd1')]),
    adapter('showstart', async () => {
      if (blocked) throw new BlockedError('showstart', 'HTTP 469')
      return [tl('showstart', 's1', { city: '上海', venue: '育音堂', dateStart: '2026-12-05', dateEnd: '2026-12-05' })]
    }),
  ])
  const first = recorder()
  await run(first)
  assert.match(first.texts[0], /开始关注 薛之谦/)
  blocked = false
  advance(6 * HOUR)
  const second = recorder()
  await run(second)
  assert.equal(second.cards.length, 0)
  assert.equal(second.texts.length, 1)
  assert.match(second.texts[0], /^秀动这次取到了 薛之谦：新增 1 场/)
  assert.match(second.texts[0], /上海 12月5日 已上架/)
})

test('没日期时单独建的场，有了日期以后并进别家建的那场，只推一次', async () => {
  let dated = false
  const { store, run, advance } = rig([
    adapter('damai', async () => [tl('damai', 'd1', dated ? {} : { dateStart: null, dateEnd: null })]),
    adapter('maoyan', async () => (dated ? [tl('maoyan', 'm1', { status: 'presale', saleTimes: [NOW + 3 * DAY] })] : [])),
  ])
  await run(recorder())
  assert.equal(store.showsForArtist('薛之谦').length, 1)
  dated = true
  advance(6 * HOUR)
  const r = recorder()
  await run(r)
  assert.equal(store.showsForArtist('薛之谦').length, 1, '两条记录在同一场')
  assert.deepEqual(r.cards.map((c) => c.title), ['薛之谦 · 无锡 · 待开票'])
})

test('适配器写的备忘和记录一起落盘：这一轮存记录失败，备忘也不留', async () => {
  const { store, run } = rig([
    adapter('showstart', async (artist, ctx) => {
      ctx.kv.set('showstart:list:薛之谦:s1', '新指纹')
      return [tl('showstart', 's1')]
    }),
  ])
  const realTx = store.transaction
  store.transaction = () => {
    throw new Error('磁盘满了')
  }
  await assert.rejects(run(recorder()), /磁盘满了/)
  assert.equal(store.kv.get('showstart:list:薛之谦:s1'), null)
  store.transaction = realTx
  await run(recorder())
  assert.equal(store.kv.get('showstart:list:薛之谦:s1'), '新指纹')
})

test('一个数据源这一轮一次都没真正取过，不把被拦的计数清零，也不推“恢复了”', async () => {
  let mode = 'blocked'
  const showstart = adapter(
    'showstart',
    async (artist) => {
      if (mode === 'blocked') throw new BlockedError('showstart', 'HTTP 469')
      return []
    },
    { resolveArtist: async () => null },
  )
  const { store, run, advance } = rig([showstart])
  for (let i = 0; i < 3; i++) {
    await run(recorder(), { adapters: [{ ...showstart, resolveArtist: async (a) => ({ id: '1', name: a.key }) }] })
    advance(6 * HOUR)
  }
  assert.equal(store.getHealth('showstart').alerted, true)
  // 艺人在秀动上没有 ID、几天前刚找过，这一轮一个请求都没发
  mode = 'ok'
  store.syncArtists([{ key: '新人', aliases: [] }], NOW)
  store.setArtistId('新人', 'showstart', null, NOW + 18 * HOUR)
  const r = recorder()
  await run(r, { adapters: [{ ...showstart, fetchArtist: async () => [] }], artists: [{ key: '新人', aliases: [] }] })
  assert.equal(store.getHealth('showstart').alerted, true)
  assert.ok(!r.texts.some((t) => t.includes('恢复了')))
})

test('取消关注：没推出去的消息作废；再关注回来重新发汇总，期间的变化不逐张推', async () => {
  let listings = [tl('damai', 'd1')]
  const { store, run, advance } = rig([adapter('damai', async () => listings)])
  await run(recorder())
  // 有一张卡片没发出去
  listings = [tl('damai', 'd1', { saleTimes: [NOW + 3 * DAY] })]
  advance(6 * HOUR)
  const failing = { sendCard: async () => { throw new Error('网络断了') }, sendText: async () => {} }
  await run(failing)
  assert.equal(store.pendingEvents().length, 1)
  advance(6 * HOUR)
  await run(recorder(), { artists: [] })
  assert.equal(store.pendingEvents().length, 0, '取消关注时作废')
  listings = [tl('damai', 'd1', { saleTimes: [NOW + 3 * DAY] }), tl('damai', 'd2', { city: '厦门', dateStart: '2026-12-01', dateEnd: '2026-12-01' })]
  advance(6 * HOUR)
  const back = recorder()
  await run(back)
  assert.equal(back.cards.length, 0)
  assert.match(back.texts[0], /开始关注 薛之谦/)
})

test('补了别名，还没找到 ID 的平台下一轮就重找，不等 7 天', async () => {
  let resolves = 0
  const showstart = adapter('showstart', async () => [], {
    resolveArtist: async (a) => {
      resolves++
      return a.aliases.includes('薛之谦Joker') ? { id: '87412', name: '薛之谦' } : null
    },
  })
  const { store, run, advance } = rig([showstart])
  await run(recorder())
  advance(6 * HOUR)
  await run(recorder())
  assert.equal(resolves, 1, '没改别名，7 天内不重找')
  advance(6 * HOUR)
  await run(recorder(), { artists: [{ key: '薛之谦', aliases: ['薛之谦Joker'] }] })
  assert.equal(resolves, 2)
  assert.equal(store.activeArtists()[0].ids.showstart, '87412')
})

test('还没配企业微信：消息打印出来但不算发出去，配好以后照样发', async () => {
  const { store, run, advance } = rig([adapter('damai', async () => [tl('damai', 'd1', { saleTimes: [NOW + 3 * DAY] })])])
  const printed = []
  await run(createUnconfiguredNotifier((s) => printed.push(s)))
  assert.ok(printed.length > 0)
  advance(10 * 60_000)
  assert.equal(await runReminders({ store, notifier: createUnconfiguredNotifier(() => {}), now: () => NOW + 3 * DAY - 35 * 60_000 }), 0)
  const r = recorder()
  await run(r)
  assert.match(r.texts[0], /开始关注 薛之谦/)
  assert.equal(await runReminders({ store, notifier: recorder(), now: () => NOW + 3 * DAY - 35 * 60_000 }), 1, '提醒也没被吃掉')
})
