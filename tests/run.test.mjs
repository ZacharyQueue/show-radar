// 一整轮：建底、推送、合成、健康提醒、周报、开售提醒。数据源用假的，不联网。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BlockedError } from '../src/errors.mjs'
import { makeListing } from '../src/listing.mjs'
import { memoryFetchLog } from '../src/fetch-log.mjs'
import { runRound } from '../src/run.mjs'
import { runReminders } from '../src/remind.mjs'
import { openStore } from '../src/store.mjs'
import { fromBeijing } from '../src/time.mjs'

const HOUR = 3600_000
// 2026-10-27 是周二
const TUE = fromBeijing(2026, 10, 27, 9, 7)

function adapter(name, fetch, extra = {}) {
  return {
    name,
    label: name,
    clientOptions: { site: name },
    needsArtistId: true,
    everyRun: true,
    resolveArtist: async (artist) => ({ id: `${name}-${artist.key}`, name: artist.key }),
    fetchArtist: fetch,
    check: async () => ({ ok: true, detail: '' }),
    ...extra,
  }
}

function ticket(source, id, extra = {}) {
  return makeListing({ source, sourceId: id, artistKey: '薛之谦', kind: 'ticket', title: `薛之谦演唱会-${extra.city ?? '无锡'}站`, city: '无锡', venue: '无锡奥体', dateStart: '2026-11-13', dateEnd: '2026-11-22', matchedBy: 'id', status: 'listed', url: `https://${source}/${id}`, ...extra })
}

// 假的发送器：带 HTML 描述的是卡片，其余是文字消息。batch 为真时模仿 Server酱，一次推送只收一条合成的消息
function recorder({ failText = 0, batch = false } = {}) {
  const cards = []
  const texts = []
  const digests = []
  let textFailures = failText
  return {
    cards,
    texts,
    digests,
    single: !batch,
    batch,
    sendDigest: async (m) => digests.push(m),
    send: async (m) => {
      if (m.title && m.description) return cards.push(m)
      if (textFailures > 0) {
        textFailures--
        throw new Error('网络断了')
      }
      texts.push(m.text)
    },
  }
}

function setup() {
  const store = openStore(':memory:')
  const state = { damai: [], maoyan: [] }
  const adapters = [adapter('damai', async () => state.damai), adapter('maoyan', async () => state.maoyan)]
  let clock = TUE
  const run = (notifier, opts = {}) =>
    runRound({ store, adapters: opts.adapters ?? adapters, artists: [{ key: '薛之谦', aliases: [] }], notifier, now: () => clock, log: () => {}, clientFor: () => ({ requestCount: 0 }), ...opts })
  return { store, state, run, advance: (ms) => (clock += ms), now: () => clock }
}

test('第一轮只建底、发汇总；之后的变化逐条推', async () => {
  const { store, state, run, advance, now } = setup()
  const sale = TUE + 30 * HOUR
  state.damai = [ticket('damai', 'd1', { status: 'presale', saleTimes: [sale] }), ticket('damai', 'd2', { city: '厦门', dateStart: '2026-10-31', dateEnd: '2026-11-08', status: 'soldout', hasSold: true })]
  state.maoyan = [ticket('maoyan', 'm1', { status: 'presale', saleTimes: [sale] })]
  const n1 = recorder()
  await run(n1)
  assert.equal(n1.cards.length, 0, '建底不推卡片')
  assert.equal(n1.texts.length, 1)
  assert.match(n1.texts[0], /开始关注 薛之谦/)
  assert.match(n1.texts[0], /现在有 2 场/)
  assert.equal(store.showsForArtist('薛之谦').length, 2, '大麦和猫眼的无锡站合成一场')

  // 6 小时后：厦门站二开，另冒出一场新的
  advance(6 * HOUR)
  const resale = now() + 40 * HOUR
  state.damai = [state.damai[0], ticket('damai', 'd2', { city: '厦门', dateStart: '2026-10-31', dateEnd: '2026-11-08', status: 'presale', hasSold: true, saleTimes: [resale] }), ticket('damai', 'd3', { city: '昆明', dateStart: '2026-12-05' })]
  const n2 = recorder()
  await run(n2)
  assert.deepEqual(n2.cards.map((c) => c.title).sort(), ['薛之谦 · 厦门 · 二开', '薛之谦 · 昆明 · 已上架'])
  assert.equal(n2.texts.length, 0)

  // 再跑一轮，没有变化就不推
  advance(6 * HOUR)
  const n3 = recorder()
  await run(n3)
  assert.equal(n3.cards.length + n3.texts.length, 0)

  // 开售前 40 分钟内提醒一次
  const n4 = recorder()
  const due = await runReminders({ store, notifier: n4, now: () => sale - 35 * 60_000 })
  assert.equal(due, 1)
  assert.equal(n4.cards[0].title, '薛之谦 · 无锡 · 快开售了')
  assert.equal(await runReminders({ store, notifier: recorder(), now: () => sale - 25 * 60_000 }), 0, '提醒过就不再提醒')
})

test('连着两轮没出现的售票记录算下架', async () => {
  const { state, run, advance } = setup()
  state.damai = [ticket('damai', 'd1', { status: 'onsale', hasSold: true })]
  await run(recorder())
  state.damai = []
  advance(6 * HOUR)
  const a = recorder()
  await run(a)
  assert.equal(a.cards.length, 0, '缺一轮不算')
  advance(6 * HOUR)
  const b = recorder()
  await run(b)
  assert.equal(b.cards[0].title, '薛之谦 · 无锡 · 下架')
})

test('数据源连着 3 轮被拦提醒一次，恢复了再说一声', async () => {
  const { state, run, advance } = setup()
  let blocked = true
  const adapters = [
    adapter('damai', async () => {
      if (blocked) throw new BlockedError('damai', 'HTTP 403')
      return state.damai
    }),
  ]
  const texts = []
  for (let i = 0; i < 4; i++) {
    const r = recorder()
    await run(r, { adapters })
    texts.push(...r.texts)
    advance(6 * HOUR)
  }
  assert.equal(texts.filter((t) => t.includes('大麦') || t.includes('damai')).length, 1)
  assert.match(texts.find((t) => t.includes('连着')), /连着 3 轮取不到数据，原因：被平台拦下（HTTP 403）/)
  blocked = false
  const r = recorder()
  await run(r, { adapters })
  assert.ok(r.texts.some((t) => t.includes('恢复了')))
})

test('文字消息发不出去，留到下一轮再发', async () => {
  const { state, run, advance } = setup()
  state.damai = [ticket('damai', 'd1')]
  const failing = recorder({ failText: 1 })
  await run(failing)
  assert.equal(failing.texts.length, 0)
  advance(6 * HOUR)
  const ok = recorder()
  await run(ok)
  assert.match(ok.texts[0], /开始关注 薛之谦/)
})

test('一天只取一次的数据源，9 点前不取', async () => {
  const { run, advance } = setup()
  let calls = 0
  const gov = adapter(
    'gov',
    async () => {
      calls++
      return []
    },
    { everyRun: false, needsArtistId: false, resolveArtist: async () => null },
  )
  await run(recorder(), { adapters: [gov], now: () => fromBeijing(2026, 10, 27, 3, 7) })
  assert.equal(calls, 0)
  await run(recorder(), { adapters: [gov] })
  assert.equal(calls, 1)
  advance(6 * HOUR)
  await run(recorder(), { adapters: [gov] })
  assert.equal(calls, 1, '同一天不再取')
  await run(recorder(), { adapters: [gov], forceSlow: true })
  assert.equal(calls, 2)
})

test('报批记录和售票记录合成同一场', async () => {
  const { store, state, run, advance } = setup()
  state.damai = [ticket('damai', 'd1')]
  await run(recorder())
  advance(6 * HOUR)
  const govAdapter = adapter('gov', async () => [makeListing({ source: 'gov', sourceId: 'g1', artistKey: '薛之谦', kind: 'approval', title: '薛之谦演唱会-无锡站', city: '无锡', venue: '无锡奥林匹克体育中心体育场', dateStart: '2026-11-13', dateEnd: '2026-11-22', matchedBy: 'title', approval: { date: '2026-10-09', number: 'x', approver: '江苏省文化和旅游厅', isChange: false }, url: 'https://gov/g1' })], { everyRun: false, needsArtistId: false })
  const r = recorder()
  await run(r, { adapters: [adapter('damai', async () => state.damai), govAdapter] })
  const shows = store.showsForArtist('薛之谦')
  assert.equal(shows.length, 1)
  assert.ok(shows[0].reached.includes('approved'))
  assert.equal(r.cards.length, 0, '已上架以后补到报批不推')
})

test('只跑一位艺人时不停用清单里的其他人；周一 9 点以后发周报', async () => {
  const store = openStore(':memory:')
  const artists = [
    { key: '薛之谦', aliases: [] },
    { key: '许嵩', aliases: [] },
  ]
  const r = recorder()
  await runRound({ store, adapters: [adapter('damai', async () => [])], artists, notifier: r, onlyArtist: '许嵩', now: () => fromBeijing(2026, 11, 2, 9, 7), log: () => {}, clientFor: () => ({ requestCount: 0 }) })
  assert.equal(store.activeArtists().length, 2)
  assert.ok(r.texts.some((t) => t.startsWith('演出雷达周报')))
  const again = recorder()
  await runRound({ store, adapters: [adapter('damai', async () => [])], artists, notifier: again, now: () => fromBeijing(2026, 11, 2, 15, 7), log: () => {}, clientFor: () => ({ requestCount: 0 }) })
  assert.ok(!again.texts.some((t) => t.startsWith('演出雷达周报')), '一周只发一次')
})

test('合成模式（Server酱）：一轮的汇总和卡片合成一条发，开售提醒也合成一条', async () => {
  const { store, state, run, advance, now } = setup()
  const sale = TUE + 30 * HOUR
  state.damai = [ticket('damai', 'd1', { status: 'presale', saleTimes: [sale] })]
  const first = recorder({ batch: true })
  await run(first)
  assert.equal(first.digests.length, 1)
  assert.match(first.digests[0].short, /^开始关注 薛之谦/)

  advance(6 * HOUR)
  state.damai = [ticket('damai', 'd1', { status: 'presale', saleTimes: [sale] }), ticket('damai', 'd2', { city: '厦门', dateStart: '2026-10-31', status: 'presale', saleTimes: [now() + 50 * HOUR] }), ticket('damai', 'd3', { city: '昆明', dateStart: '2026-12-05' })]
  const second = recorder({ batch: true })
  await run(second)
  assert.equal(second.digests.length, 1, '两场的变化合成一条')
  assert.match(second.digests[0].short, /^薛之谦·厦门 待开票 .* 等2条$/)
  assert.equal(store.pendingEvents().length, 0, '合成的那条发出去，事件都算推过')

  const remind = recorder({ batch: true })
  assert.equal(await runReminders({ store, notifier: remind, now: () => sale - 35 * 60_000 }), 1)
  assert.equal(remind.digests[0].short, '薛之谦·无锡 15:07 开售', '周二 9:07 再过 30 小时是周三 15:07')
})

test('合成模式发失败：汇总和事件都留到下一轮', async () => {
  const { store, state, run, advance } = setup()
  state.damai = [ticket('damai', 'd1')]
  const failing = { batch: true, sendDigest: async () => { throw new Error('额度用完了') } }
  await run(failing)
  advance(6 * HOUR)
  const ok = recorder({ batch: true })
  await run(ok)
  assert.match(ok.digests[0].text, /开始关注 薛之谦/)
  assert.equal(store.pendingEvents().length, 0)
})

test('同一位艺人在同一个数据源上 1 小时内只取一次，被拦也算取过', async () => {
  const { state, run, advance } = setup()
  let damaiCalls = 0
  let maoyanCalls = 0
  const adapters = [
    adapter('damai', async () => (damaiCalls++, state.damai)),
    adapter('maoyan', async () => {
      maoyanCalls++
      throw new BlockedError('maoyan', 'HTTP 403')
    }),
  ]
  const fetchLog = memoryFetchLog()
  const opts = { adapters, fetchLog, minFetchGapMs: HOUR }
  const first = await run(recorder(), opts)
  assert.equal(damaiCalls, 1)
  advance(20 * 60_000)
  const again = await run(recorder(), opts)
  assert.equal(damaiCalls, 1, '20 分钟后再跑不取')
  assert.equal(maoyanCalls, 1, '被拦的也不马上重来')
  assert.deepEqual(again.sources.damai.recent, ['薛之谦'])
  assert.equal(first.sources.damai.recent, undefined)
  advance(HOUR)
  await run(recorder(), opts)
  assert.equal(damaiCalls, 2, '过了 1 小时照常取')
})

test('Server酱和逐条的通道一起配：逐条的照样一张张收、最多 15 张，Server酱收合成的一条', async () => {
  const { state, run, advance, now } = setup()
  await run(recorder())
  advance(6 * HOUR)
  state.damai = Array.from({ length: 17 }, (_, i) => ticket('damai', `d${i}`, { city: `城市${i}`, status: 'presale', saleTimes: [now() + (40 + i) * HOUR] }))
  const both = { ...recorder(), single: true, batch: true }
  await run(both)
  assert.equal(both.cards.length, 15, '逐条通道最多 15 张')
  assert.match(both.texts[0], /还有 2 场/)
  assert.equal(both.digests.length, 1)
  assert.match(both.digests[0].short, /等17条$/)
})

test('合成的那条没发出去、逐条的发出去了，也算推过，不重复推', async () => {
  const { store, state, run, advance, now } = setup()
  await run(recorder())
  advance(6 * HOUR)
  state.damai = [ticket('damai', 'd1', { status: 'presale', saleTimes: [now() + 40 * HOUR] })]
  const half = { ...recorder(), single: true, batch: true, sendDigest: async () => { throw new Error('额度用完了') } }
  await run(half)
  assert.equal(half.cards.length, 1)
  assert.equal(store.pendingEvents().length, 0)
})

test('开售提醒：逐条的一场一条，合成的那条也发', async () => {
  const { store, state, run, advance } = setup()
  const sale = TUE + 30 * HOUR
  state.damai = [ticket('damai', 'd1', { status: 'presale', saleTimes: [sale] }), ticket('damai', 'd2', { city: '厦门', status: 'presale', saleTimes: [sale + 3 * 60_000] })]
  await run(recorder())
  advance(HOUR)
  const both = { ...recorder(), single: true, batch: true }
  assert.equal(await runReminders({ store, notifier: both, now: () => sale - 35 * 60_000 }), 2)
  assert.equal(both.cards.length, 2)
  assert.equal(both.digests.length, 1)
})

test('一轮的时间到了：不再取新的艺人，已经取到的照样存下；下一轮先取没取到的', async () => {
  const store = openStore(':memory:')
  const order = []
  let clock = TUE
  const slow = adapter('damai', async (a) => {
    order.push(a.key)
    clock += 10 * 60_000
    return [ticket('damai', `d-${a.key}`, { artistKey: a.key })]
  })
  const artists = ['甲', '乙', '丙', '丁'].map((key) => ({ key, aliases: [] }))
  const fetchLog = memoryFetchLog()
  const go = () => runRound({ store, adapters: [slow], artists, notifier: recorder(), now: () => clock, log: () => {}, clientFor: () => ({ requestCount: 0 }), fetchLog, minFetchGapMs: HOUR, budgetMs: 25 * 60_000 })
  // 状态库按加入时间、主名排：丁、丙、乙、甲
  const first = await go()
  assert.deepEqual(order, ['丁', '丙', '乙'])
  assert.deepEqual(first.sources.damai.unfinished, ['甲'])
  assert.equal(store.showsForArtist('丁').length, 1, '取到的存下了')
  clock += 2 * HOUR
  order.length = 0
  await go()
  assert.equal(order[0], '甲', '上一轮没取到的排最前')
})

test('被要求停下：不再取新的艺人，已经取到的照样存下', async () => {
  const store = openStore(':memory:')
  const ctrl = new AbortController()
  const a = adapter('damai', async (artist) => {
    ctrl.abort()
    return [ticket('damai', `d-${artist.key}`, { artistKey: artist.key })]
  })
  const stats = await runRound({ store, adapters: [a], artists: [{ key: '甲', aliases: [] }, { key: '乙', aliases: [] }], notifier: recorder(), now: () => TUE, log: () => {}, clientFor: () => ({ requestCount: 0 }), signal: ctrl.signal })
  // 状态库按主名排，乙在甲前面
  assert.deepEqual(stats.sources.damai.unfinished, ['甲'])
  assert.equal(store.showsForArtist('乙').length, 1)
})

test('取数记录的时间在将来（时钟拨过）当作没取过；跳过时说清最早什么时候能再取', async () => {
  const { run, now } = setup()
  const fetchLog = memoryFetchLog()
  fetchLog.set('damai\u0000薛之谦', now() + 8 * HOUR)
  fetchLog.set('maoyan\u0000薛之谦', now() - 20 * 60_000)
  const stats = await run(recorder(), { fetchLog, minFetchGapMs: HOUR })
  assert.equal(stats.sources.damai.recent, undefined, '将来的时间不算')
  assert.deepEqual(stats.sources.maoyan.recent, ['薛之谦'])
  assert.equal(stats.sources.maoyan.retryAt, now() + 40 * 60_000)
})

test('一天只取一次的数据源一轮没取完：下一轮只取今天还没取的，都取过了才算今天取过', async () => {
  const store = openStore(':memory:')
  const fetched = []
  let clock = fromBeijing(2026, 10, 27, 9, 7)
  const slow = adapter(
    'gov',
    async (a) => {
      fetched.push(a.key)
      clock += 10 * 60_000
      return []
    },
    { everyRun: false, needsArtistId: false },
  )
  const artists = ['甲', '乙', '丙', '丁'].map((key) => ({ key, aliases: [] }))
  const fetchLog = memoryFetchLog()
  const go = () => runRound({ store, adapters: [slow], artists, notifier: recorder(), now: () => clock, log: () => {}, clientFor: () => ({ requestCount: 0 }), fetchLog, minFetchGapMs: HOUR, budgetMs: 25 * 60_000 })
  await go()
  assert.equal(fetched.length, 3)
  assert.equal(store.kv.get('source.gov.lastDay'), null, '没取完不算今天取过')
  clock = fromBeijing(2026, 10, 27, 15, 7)
  fetched.length = 0
  await go()
  assert.equal(fetched.length, 1, '只取今天还没取的那一位')
  assert.equal(store.kv.get('source.gov.lastDay'), '2026-10-27')
  clock = fromBeijing(2026, 10, 27, 21, 7)
  fetched.length = 0
  await go()
  assert.equal(fetched.length, 0, '今天都取过了')
})
