import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateShow, stageLabel, timeline } from '../src/stage.mjs'
import { fromBeijing } from '../src/time.mjs'

const NOW = fromBeijing(2026, 10, 26, 9, 7)
const HOUR = 3600_000

function emptyShow(extra = {}) {
  return { id: 1, artistKey: '薛之谦', city: '无锡', venue: null, dateStart: '2026-11-13', dateEnd: '2026-11-22', title: '', isMixed: false, stage: null, round: 0, everSold: false, nextSaleAt: null, announcedSaleAt: null, knownSaleTimes: [], reached: [], ...extra }
}

function ticket(extra = {}) {
  return { source: 'damai', sourceId: '1', artistKey: '薛之谦', kind: 'ticket', title: '薛之谦“万兽之王”巡回演唱会-无锡站', city: '无锡', venue: '无锡奥体', dateStart: '2026-11-13', dateEnd: '2026-11-22', matchedBy: 'id', isMixed: false, status: 'listed', saleTimes: [], hasSold: false, roundHint: null, approval: null, url: 'https://m.damai.cn/shows/item.html?itemId=1', missingRuns: 0, ...extra }
}

function approval(extra = {}) {
  return { source: 'gov', sourceId: 'g1', artistKey: '薛之谦', kind: 'approval', title: '薛之谦“万兽之王”演唱会-无锡站', city: '无锡', venue: '无锡奥林匹克体育中心体育场', dateStart: '2026-11-13', dateEnd: '2026-11-22', matchedBy: 'title', isMixed: false, status: null, saleTimes: [], hasSold: false, roundHint: null, approval: { date: '2026-10-09', number: '320000522026000627', approver: '江苏省文化和旅游厅', isChange: false }, url: 'https://gov.example/x', missingRuns: 0, ...extra }
}

/** 按顺序跑几轮，每轮把上一轮的 next 当成存下的状态。 */
function play(rounds) {
  let show = emptyShow()
  const out = []
  for (const { listings, now } of rounds) {
    const r = evaluateShow(show, listings, now)
    show = { ...show, ...r.next }
    out.push({ ...r, show })
  }
  return out
}

test('完整一条线：报批 → 上架 → 待开票 → 开售 → 售罄 → 二开 → 三开', () => {
  const t1 = NOW + 24 * HOUR // 首开
  const t2 = NOW + 10 * 24 * HOUR // 二开
  const t3 = NOW + 20 * 24 * HOUR // 三开
  const r = play([
    { now: NOW, listings: [approval()] },
    { now: NOW + 6 * HOUR, listings: [approval(), ticket()] },
    { now: NOW + 12 * HOUR, listings: [approval(), ticket({ status: 'presale', saleTimes: [t1] })] },
    { now: NOW + 18 * HOUR, listings: [approval(), ticket({ status: 'presale', saleTimes: [t1] })] },
    { now: t1 + 6 * HOUR, listings: [approval(), ticket({ status: 'onsale', saleTimes: [t1], hasSold: true })] },
    { now: t1 + 12 * HOUR, listings: [approval(), ticket({ status: 'soldout', saleTimes: [t1], hasSold: true })] },
    { now: t1 + 18 * HOUR, listings: [approval(), ticket({ status: 'presale', saleTimes: [t1, t2], hasSold: true })] },
    { now: t2 + 6 * HOUR, listings: [approval(), ticket({ status: 'soldout', saleTimes: [t1, t2], hasSold: true })] },
    { now: t2 + 12 * HOUR, listings: [approval(), ticket({ status: 'presale', saleTimes: [t1, t2, t3], hasSold: true })] },
  ])
  assert.deepEqual(r.map((x) => x.show.stage), ['approved', 'listed', 'sale_pending', 'sale_pending', 'onsale', 'soldout', 'resale_pending', 'soldout', 'resale_pending'])
  assert.deepEqual(r.map((x) => x.event?.kind ?? null), ['approved', 'listed', 'sale_announced', null, null, null, 'resale_announced', null, 'resale_announced'])
  assert.equal(r[2].event.saleAt, t1)
  assert.deepEqual(r[2].event.detail.saleSources, ['damai'])
  assert.equal(r[6].event.round, 2)
  assert.equal(r[8].event.round, 3)
  assert.equal(stageLabel('resale_pending', 3), '三开')
  assert.equal(r[5].silent[0].kind, 'soldout')
  assert.deepEqual(timeline(r[8].show), ['已报批', '已上架', '待开票', '开售', '二开', '三开'])
})

test('开售时间改了推一次，原来的时间写进 detail', () => {
  const a = NOW + 24 * HOUR
  const b = NOW + 30 * HOUR
  const r = play([
    { now: NOW, listings: [ticket({ status: 'presale', saleTimes: [a] })] },
    { now: NOW + HOUR, listings: [ticket({ status: 'presale', saleTimes: [b] })] },
    { now: NOW + 2 * HOUR, listings: [ticket({ status: 'presale', saleTimes: [b] })] },
  ])
  assert.equal(r[0].event.kind, 'sale_announced')
  assert.equal(r[1].event.kind, 'sale_changed')
  assert.equal(r[1].event.detail.previousSaleAt, a)
  assert.equal(r[2].event, null)
})

test('同一轮分批开售不算二开', () => {
  const a = NOW + 24 * HOUR
  const b = NOW + 48 * HOUR
  const r = play([
    { now: NOW, listings: [ticket({ status: 'presale', saleTimes: [a, b] })] },
    { now: a + HOUR, listings: [ticket({ status: 'presale', saleTimes: [a, b], hasSold: true })] },
  ])
  assert.equal(r[0].show.stage, 'sale_pending')
  assert.equal(r[1].show.stage, 'sale_pending')
  assert.equal(r[1].show.round, 1)
  assert.equal(r[1].event.kind, 'sale_announced')
  assert.equal(r[1].event.saleAt, b)
})

test('售罄后又在卖、没见到预告，推“又有票了”，一天最多一次', () => {
  const r = play([
    { now: NOW, listings: [ticket({ status: 'soldout', hasSold: true })] },
    { now: NOW + 6 * HOUR, listings: [ticket({ status: 'onsale', hasSold: true })] },
    { now: NOW + 7 * HOUR, listings: [ticket({ status: 'soldout', hasSold: true })] },
    { now: NOW + 8 * HOUR, listings: [ticket({ status: 'onsale', hasSold: true })] },
  ])
  assert.equal(r[0].event.kind, 'listed')
  assert.equal(r[0].event.detail.soldout, true)
  assert.equal(r[1].event.kind, 'restock')
  assert.equal(r[3].event.kind, 'restock')
  assert.equal(r[1].event.saleAt, r[3].event.saleAt, '同一天的事件键相同，状态库会去重')
})

test('第一次见到就在卖，推“已开售”', () => {
  const r = play([{ now: NOW, listings: [ticket({ status: 'onsale', hasSold: true })] }])
  assert.equal(r[0].event.kind, 'onsale_missed')
  assert.deepEqual(r[0].event.detail.sources, ['damai'])
})

test('第一次见到就是开过票、等下一轮的，直接算二开', () => {
  const r = play([{ now: NOW, listings: [ticket({ status: 'presale', hasSold: true, saleTimes: [NOW - 5 * 24 * HOUR, NOW + 24 * HOUR] })] }])
  assert.equal(r[0].show.stage, 'resale_pending')
  assert.equal(r[0].event.kind, 'resale_announced')
  assert.equal(r[0].event.round, 2)
})

test('介绍里写了第三次销售，轮次取大的', () => {
  const r = play([{ now: NOW, listings: [ticket({ status: 'presale', hasSold: true, roundHint: 3, saleTimes: [NOW + HOUR] })] }])
  assert.equal(r[0].show.round, 3)
  assert.equal(r[0].event.round, 3)
})

test('延期、下架、演完', () => {
  const r = play([
    { now: NOW, listings: [ticket({ status: 'onsale', hasSold: true })] },
    { now: NOW + HOUR, listings: [ticket({ status: 'postponed', hasSold: true })] },
  ])
  assert.equal(r[1].event.kind, 'postponed')

  const off = play([
    { now: NOW, listings: [ticket({ status: 'onsale', hasSold: true })] },
    { now: NOW + HOUR, listings: [ticket({ status: 'onsale', hasSold: true, missingRuns: 2 })] },
  ])
  assert.equal(off[1].show.stage, 'offline')
  assert.equal(off[1].event.kind, 'offline')

  const ended = play([
    { now: NOW, listings: [ticket({ status: 'onsale', hasSold: true })] },
    { now: fromBeijing(2026, 11, 23, 9, 7), listings: [ticket({ status: 'onsale', hasSold: true })] },
  ])
  assert.equal(ended[1].show.stage, 'ended')
  assert.equal(ended[1].event, null)
})

test('已上架的演出后来补到报批，只记不推', () => {
  const r = play([
    { now: NOW, listings: [ticket()] },
    { now: NOW + HOUR, listings: [ticket(), approval()] },
  ])
  assert.equal(r[1].event, null)
  assert.equal(r[1].silent[0].kind, 'approved')
  assert.ok(r[1].show.reached.includes('approved'))
})

test('两家平台给的开售时间一样，都记上', () => {
  const t1 = NOW + 24 * HOUR
  const r = play([{ now: NOW, listings: [ticket({ status: 'presale', saleTimes: [t1] }), ticket({ source: 'maoyan', sourceId: 'm1', status: 'presale', saleTimes: [t1 + 20_000] })] }])
  assert.deepEqual(r[0].event.detail.saleSources, ['damai', 'maoyan'])
})

test('标题和场馆优先用售票平台的', () => {
  const r = play([{ now: NOW, listings: [approval(), ticket()] }])
  assert.equal(r[0].show.title, '薛之谦“万兽之王”巡回演唱会-无锡站')
  assert.equal(r[0].show.venue, '无锡奥体')
})
