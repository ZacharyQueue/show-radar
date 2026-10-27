import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as maoyan from '../../src/sources/maoyan.mjs'
import { ApiChangedError, BlockedError } from '../../src/errors.mjs'
import { validateListing } from '../../src/listing.mjs'
import { runRound } from '../../src/run.mjs'
import { openStore } from '../../src/store.mjs'
import { fromBeijing } from '../../src/time.mjs'
import { fakeClient } from '../helpers/fake-http.mjs'

const fixture = (file) => JSON.parse(readFileSync(new URL(`../../fixtures/maoyan/${file}`, import.meta.url), 'utf8'))
// 和 fakeClient 的默认 now 一样：北京时间 2026-10-26 10:00
const NOW = fromBeijing(2026, 10, 26, 10, 0)
const XUE = { key: '薛之谦', aliases: [], ids: {} }

function byId(listings) {
  return Object.fromEntries(listings.map((l) => [l.sourceId, l]))
}

function ctxWith(client, extra = {}) {
  const logs = []
  return { client, now: () => NOW, log: (m) => logs.push(m), kv: { get() {}, set() {} }, logs, ...extra }
}

/** 按地址分派的假网关：搜索、详情、H5 搜索各给一个处理函数。 */
function gateway({ search, detail, h5 }) {
  return (req) => {
    const u = new URL(req.url)
    if (u.hostname === 'show.maoyan.com') return h5(req, u.searchParams.get('k'))
    const p = decodeURIComponent(u.pathname)
    const s = p.match(/\/performances\/0;st=0;k=([^;]*);p=(\d+);/)
    if (s) return search(req, s[1], +s[2])
    const d = p.match(/\/performance\/(\d+)$/)
    if (d) return detail(req, d[1])
    throw new Error(`没想到的地址 ${req.url}`)
  }
}

test('接口登记照 sources/index.mjs 的约定', () => {
  assert.equal(maoyan.name, 'maoyan')
  assert.equal(maoyan.label, '猫眼')
  assert.equal(maoyan.clientOptions.site, 'maoyan')
  assert.equal(maoyan.needsArtistId, true)
  assert.equal(maoyan.everyRun, true)
  for (const fn of ['resolveArtist', 'fetchArtist', 'check']) assert.equal(typeof maoyan[fn], 'function')
})

test('showTimeRange 的各种写法', () => {
  const cases = [
    ['2026.11.13 - 2026.11.22', '2026-11-13', '2026-11-22'],
    ['2026.10.31 - 11.08', '2026-10-31', '2026-11-08'],
    ['2026.10.31 - 2026.11.8', '2026-10-31', '2026-11-08'],
    ['2026.11.28 / 11.29', '2026-11-28', '2026-11-29'],
    ['2026.12.31 / 2027.1.1', '2026-12-31', '2027-01-01'],
    ['2026.12.31 - 2027.01.02', '2026-12-31', '2027-01-02'],
    ['2026.12.31 - 01.02', '2026-12-31', '2027-01-02'],
    ['2026.11.21 19:30 周六', '2026-11-21', '2026-11-21'],
    ['2025.5.25 16:30 周日', '2025-05-25', '2025-05-25'],
    ['2026.11.22 周日', '2026-11-22', '2026-11-22'],
    ['2026.08.07 - 12.31', '2026-08-07', '2026-12-31'],
  ]
  for (const [text, start, end] of cases) {
    assert.deepEqual(maoyan.parseShowTimeRange(text), { dateStart: start, dateEnd: end }, text)
  }
  for (const text of [null, '', '时间待定', '11.28 / 11.29']) {
    assert.deepEqual(maoyan.parseShowTimeRange(text), { dateStart: null, dateEnd: null }, String(text))
  }
})

test('H5 搜索按归一后的名字认艺人，不认“周深深”', () => {
  assert.deepEqual(maoyan.parseCelebrity(fixture('h5search_k_zhoushen.json'), { key: '周深', aliases: [] }), {
    id: '2819854',
    name: '周深',
  })
  assert.deepEqual(maoyan.parseCelebrity(fixture('h5search_k_xuezhiqian.json'), XUE), { id: '365480', name: '薛之谦' })
  assert.deepEqual(maoyan.parseCelebrity(fixture('h5search_k_lironghao.json'), { key: '李荣浩', aliases: [] }), {
    id: '1040236',
    name: '李荣浩',
  })
  // 别名也算
  assert.equal(maoyan.parseCelebrity(fixture('h5search_k_chenyixun.json'), { key: 'Eason', aliases: ['陈奕迅'] }).id, '17514')
  // 只有近名的不认
  assert.equal(maoyan.parseCelebrity(fixture('h5search_k_zhoushen.json'), { key: '周深深深', aliases: [] }), null)
  assert.equal(maoyan.parseCelebrity({ code: 200, data: { celebrityBasicDTOList: null } }, XUE), null)
})

test('薛之谦：去掉荧光棒周边，状态和开售时间取详情', () => {
  const listings = maoyan.parseListings(fixture('search_k_xuezhiqian_cat0_city10.json'), XUE, NOW, {
    details: { 505911: fixture('detail_505911.json'), 512082: fixture('detail_512082_xuezhiqian_wuxi.json') },
  })
  listings.forEach((l) => validateListing(l))
  assert.deepEqual(Object.keys(byId(listings)).sort(), ['505911', '512082'])
  const { 505911: xiamen, 512082: wuxi } = byId(listings)
  assert.deepEqual(wuxi, {
    source: 'maoyan',
    sourceId: '512082',
    artistKey: '薛之谦',
    kind: 'ticket',
    title: '薛之谦“万兽之王”巡回演唱会-无锡站',
    city: '无锡',
    venue: '无锡奥林匹克体育中心体育场',
    dateStart: '2026-11-13',
    dateEnd: '2026-11-22',
    matchedBy: 'title',
    isMixed: false,
    status: 'presale',
    saleTimes: [fromBeijing(2026, 10, 27, 17, 17)],
    hasSold: false,
    roundHint: null,
    roundHintAt: null,
    approval: null,
    url: 'https://show.maoyan.com/detail/512082',
  })
  assert.equal(xiamen.status, 'onsale')
  assert.deepEqual(xiamen.saleTimes, [fromBeijing(2026, 10, 26, 10, 0)])
  assert.equal(xiamen.hasSold, true)
  assert.equal(xiamen.dateStart, '2026-10-31')
  assert.equal(xiamen.dateEnd, '2026-11-08')
  assert.equal(xiamen.venue, '厦门奥林匹克体育中心-白鹭体育场')
})

test('国内直连抓的样本：许巍的音乐节列表说预售、详情说在售，取详情', () => {
  const zhoushen = maoyan.parseCelebrity(fixture('live-h5search-周深-2026-10-26.json'), { key: '周深', aliases: [] })
  assert.equal(zhoushen.id, '2819854')
  const xuwei = { key: '许巍', aliases: [], ids: { maoyan: '2823780' } }
  const search = fixture('live-search-许巍-2026-10-26.json')
  const detail = fixture('live-detail-509862-斑马音乐节-2026-10-26.json')
  assert.equal(search.data.find((i) => i.performanceId === 509862).ticketStatus, 2)
  assert.equal(detail.data.ticketStatus, 3)
  const m = byId(maoyan.parseListings(search, xuwei, NOW, { details: { 509862: detail } }))
  assert.deepEqual(Object.keys(m).sort(), ['489206', '509862', '512424', '513360'])
  assert.equal(m['509862'].status, 'onsale')
  assert.equal(m['509862'].city, '阜阳')
  assert.equal(m['509862'].dateStart, '2026-11-21')
  assert.equal(m['509862'].dateEnd, '2026-11-22')
  assert.deepEqual(m['509862'].saleTimes, [detail.data.saleRemindVO.onSaleTime])
  assert.ok(Object.values(m).every((l) => l.matchedBy === 'lineup' && l.isMixed))

  const xue = byId(
    maoyan.parseListings(fixture('live-search-薛之谦-2026-10-26.json'), XUE, NOW, {
      details: { 512082: fixture('live-detail-512082-薛之谦无锡-2026-10-26.json') },
    }),
  )
  assert.deepEqual(xue['512082'].saleTimes, [fromBeijing(2026, 10, 27, 17, 17)])
  assert.equal(xue['512082'].status, 'presale')
})

test('邓丽君：全是致敬金曲场，一条不留', () => {
  const listings = maoyan.parseListings(fixture('search_k_dengzilong_cat0_city10.json'), { key: '邓丽君', aliases: [] }, NOW)
  assert.deepEqual(listings, [])
})

test('许巍：音乐节靠阵容认定，有没有艺人 ID 都认得出', () => {
  const page = fixture('search_k_xuwei_cat0_city10.json')
  for (const artist of [
    { key: '许巍', aliases: [], ids: { maoyan: '2823780' } },
    { key: '许巍', aliases: [], ids: {} },
  ]) {
    const listings = maoyan.parseListings(page, artist, NOW)
    assert.equal(listings.length, 4)
    for (const l of listings) {
      assert.equal(l.matchedBy, 'lineup')
      assert.equal(l.isMixed, true)
    }
  }
  // 名字对不上、ID 对得上也算
  const byIdOnly = maoyan.parseListings(page, { key: '许巍（歌手）', aliases: [], ids: { maoyan: 2823780 } }, NOW)
  assert.equal(byIdOnly.length, 4)
  assert.ok(byIdOnly.every((l) => l.matchedBy === 'lineup'))
})

test('李荣浩：名字不在标题里的拼盘记成 search', () => {
  const listings = maoyan.parseListings(fixture('search_lironghao.json'), { key: '李荣浩', aliases: [] }, NOW, {
    details: { 510559: fixture('detail_510559.json'), 511517: fixture('detail_511517.json') },
  })
  const m = byId(listings)
  assert.equal(listings.length, 7)
  for (const id of ['512132', '511517']) {
    assert.equal(m[id].matchedBy, 'search')
    assert.equal(m[id].isMixed, true)
  }
  for (const id of ['510559', '482538', '482849', '503333', '497702']) {
    assert.equal(m[id].matchedBy, 'title')
    assert.equal(m[id].isMixed, false)
  }
  assert.equal(m['510559'].status, 'presale')
  assert.deepEqual(m['510559'].saleTimes, [fromBeijing(2026, 10, 29, 13, 0)])
  assert.equal(m['510559'].dateEnd, '2027-01-02')
  assert.equal(m['511517'].status, 'presale')
  assert.deepEqual(m['511517'].saleTimes, [])
  // 没取详情、也没有上一轮的，先用列表的状态
  assert.equal(m['482538'].status, 'onsale')
  assert.equal(m['482538'].hasSold, true)
})

test('回春丹：标题里有名字算 title，阵容写成“回春丹乐队”的音乐节也靠阵容认定', () => {
  const m = byId(maoyan.parseListings(fixture('search_huichundan.json'), { key: '回春丹', aliases: [] }, NOW))
  assert.equal(m['511180'].matchedBy, 'title')
  assert.equal(m['511180'].dateStart, '2026-10-31')
  // 名字末尾的“乐队”不算，“回春丹”认得出阵容里的“回春丹乐队”
  assert.equal(m['512424'].matchedBy, 'lineup')
  assert.equal(m['512424'].isMixed, true)
})

test('周杰伦：舞蹈诗剧（分类 5）去掉', () => {
  const listings = maoyan.parseListings(fixture('search_k_zhoujielun_cat0_city10.json'), { key: '周杰伦', aliases: [] }, NOW)
  assert.deepEqual(listings.map((l) => l.sourceId).sort(), ['492940', '502950'])
  assert.equal(byId(listings)['492940'].city, '三亚')
})

test('分类只留演唱会、音乐节、Livehouse', () => {
  const listings = maoyan.parseListings(fixture('search_k_yinyuejie_cat0_city10.json'), { key: '谭维维', aliases: [] }, NOW)
  assert.equal(listings.length, 8)
  const m = byId(listings)
  assert.equal(m['505109'].matchedBy, 'lineup')
  assert.equal(m['511527'].city, '澄迈县')
  assert.equal(m['512194'].dateStart, '2026-11-21')
  assert.ok(!m['507705'], '音乐会（分类 6）不该留下')
})

test('详情回 1002 记成下线，沿用上一轮的开售时间', () => {
  const t = fromBeijing(2026, 10, 20, 12, 0)
  const [l] = maoyan.parseListings(fixture('search_k_xuezhiqian_cat0_city10.json'), XUE, NOW, {
    details: { 512082: fixture('detail_515200.json') },
    previous: (id) => (id === '512082' ? { status: 'onsale', saleTimes: [t], hasSold: true } : null),
  }).filter((x) => x.sourceId === '512082')
  assert.equal(l.status, 'offline')
  assert.deepEqual(l.saleTimes, [t])
  assert.equal(l.hasSold, true)
  assert.equal(l.title, '薛之谦“万兽之王”巡回演唱会-无锡站')
})

test('列表和详情对不上时信详情，不认识的状态记成 listed 并留日志', () => {
  const search = fixture('search_k_xuezhiqian_cat0_city10.json')
  const postponed = fixture('detail_512082_xuezhiqian_wuxi.json')
  postponed.data.ticketStatus = 12
  let m = byId(maoyan.parseListings(search, XUE, NOW, { details: { 512082: postponed } }))
  assert.equal(m['512082'].status, 'postponed')

  const odd = fixture('detail_512082_xuezhiqian_wuxi.json')
  odd.data.ticketStatus = 99
  const logs = []
  m = byId(maoyan.parseListings(search, XUE, NOW, { details: { 512082: odd }, log: (x) => logs.push(x) }))
  assert.equal(m['512082'].status, 'listed')
  assert.match(logs.join('\n'), /ticketStatus=99/)
})

test('状态映射', () => {
  const expected = { 1: 'presale', 11: 'presale', 2: 'onsale', 3: 'onsale', 4: 'soldout', 5: 'ended', 12: 'postponed', 0: 'listed' }
  for (const [code, status] of Object.entries(expected)) assert.equal(maoyan.statusOf(+code), status, code)
  // 已结束的项目详情还能取到，ticketStatus=5
  assert.equal(maoyan.statusOf(fixture('detail_400000.json').data.ticketStatus), 'ended')
})

test('没取详情的沿用上一轮的状态和开售时间，开售时间过了就算开过票', () => {
  const t = fromBeijing(2026, 10, 19, 20, 0)
  const m = byId(
    maoyan.parseListings(fixture('search_zhoushen.json'), { key: '周深', aliases: [] }, NOW, {
      previous: (id) => (id === '507981' ? { status: 'onsale', saleTimes: [t], hasSold: false } : null),
    }),
  )
  assert.equal(m['507981'].status, 'onsale')
  assert.deepEqual(m['507981'].saleTimes, [t])
  assert.equal(m['507981'].hasSold, true)
})

test('详情什么时候要取', () => {
  const item = (ticketStatus) => ({ performanceId: 1, ticketStatus })
  assert.equal(maoyan.needsDetail(item(3), null), true, '新项目')
  assert.equal(maoyan.needsDetail(item(3), { status: 'onsale' }), false, '在售没变')
  assert.equal(maoyan.needsDetail(item(2), { status: 'onsale' }), false, '预售和在售都算 onsale')
  assert.equal(maoyan.needsDetail(item(4), { status: 'onsale' }), true, '列表状态变了')
  assert.equal(maoyan.needsDetail(item(1), { status: 'presale' }), true, '还没开售，可能刚公布开售时间')
  assert.equal(maoyan.needsDetail(item(1), { status: 'listed' }), true)
  assert.equal(maoyan.needsDetail(item(3), { status: 'ended' }), false, '已结束的不再取')
  assert.equal(maoyan.needsDetail(item(3), { status: 'offline' }), true, '下线后又出现')
})

test('resolveArtist：请求 H5 搜索，按名字认出艺人', async () => {
  const client = fakeClient(gateway({ h5: () => ({ json: fixture('h5search_k_zhoushen.json') }) }))
  const found = await maoyan.resolveArtist({ key: '周深', aliases: [] }, ctxWith(client))
  assert.deepEqual(found, { id: '2819854', name: '周深' })
  assert.equal(client.calls.length, 1)
  const u = new URL(client.calls[0].url)
  assert.equal(u.hostname, 'show.maoyan.com')
  assert.equal(u.pathname, '/maoyansh/myshow/ajax/search/0;st=0;p=1;s=20;tft=0')
  assert.equal(u.searchParams.get('k'), '周深')
  assert.equal(u.searchParams.get('sellChannel'), '13')
  assert.equal(client.calls[0].headers.cookie, undefined)
  assert.match(client.calls[0].headers['user-agent'], /iPhone/)
})

test('resolveArtist：主名找不到再试别名，同一个名字不重复搜', async () => {
  const seen = []
  const client = fakeClient(
    gateway({
      h5: (req, k) => {
        seen.push(k)
        const list = k === '草東沒有派對' ? [{ id: 900, celebrityId: 3000001, celebrityName: '草東沒有派對' }] : []
        return { json: { code: 200, data: { celebrityBasicDTOList: list, performanceVOList: [] } } }
      },
    }),
  )
  const found = await maoyan.resolveArtist({ key: '草东没有派对', aliases: ['草東沒有派對'] }, ctxWith(client))
  assert.deepEqual(found, { id: '3000001', name: '草東沒有派對' })
  assert.deepEqual(seen, ['草东没有派对', '草東沒有派對'])

  const client2 = fakeClient(gateway({ h5: () => ({ json: fixture('h5search_k_zhoushen.json') }) }))
  assert.equal(await maoyan.resolveArtist({ key: '周深深深', aliases: ['周深深深 '] }, ctxWith(client2)), null)
  assert.equal(client2.calls.length, 1)
})

test('fetchArtist：搜一次，新项目各取一次详情，周边不取', async () => {
  const client = fakeClient(
    gateway({
      search: () => ({ json: fixture('search_k_xuezhiqian_cat0_city10.json') }),
      detail: (req, id) => ({ json: fixture(id === '505911' ? 'detail_505911.json' : 'detail_512082_xuezhiqian_wuxi.json') }),
    }),
  )
  const listings = await maoyan.fetchArtist(XUE, ctxWith(client))
  assert.equal(client.calls.length, 3)
  const search = client.calls[0].url
  assert.ok(search.startsWith('https://m.dianping.com/myshow/ajax/performances/0;st=0;k=%E8%96%9B%E4%B9%8B%E8%B0%A6;p=1;s=20;tft=0?'))
  assert.ok(search.endsWith('?cityId=10&sellChannel=7'))
  assert.deepEqual(
    client.calls.slice(1).map((c) => c.url).sort(),
    [
      'https://m.dianping.com/myshow/ajax/performance/505911?sellChannel=7',
      'https://m.dianping.com/myshow/ajax/performance/512082?sellChannel=7',
    ],
  )
  for (const c of client.calls) {
    assert.equal(c.headers.cookie, undefined)
    assert.equal(c.headers.referer, 'https://show.maoyan.com/')
  }
  const m = byId(listings)
  assert.equal(m['512082'].status, 'presale')
  assert.deepEqual(m['512082'].saleTimes, [fromBeijing(2026, 10, 27, 17, 17)])
})

test('fetchArtist：上一轮在售、列表没变的不取详情；还没开售的照取', async () => {
  const t = fromBeijing(2026, 10, 26, 10, 0)
  const previous = (id) =>
    ({
      505911: { status: 'onsale', saleTimes: [t], hasSold: true },
      512082: { status: 'presale', saleTimes: [], hasSold: false },
    })[id] ?? null
  const client = fakeClient(
    gateway({
      search: () => ({ json: fixture('search_k_xuezhiqian_cat0_city10.json') }),
      detail: () => ({ json: fixture('detail_512082_xuezhiqian_wuxi.json') }),
    }),
  )
  const m = byId(await maoyan.fetchArtist(XUE, ctxWith(client, { previous })))
  assert.deepEqual(client.calls.map((c) => new URL(c.url).pathname).slice(1), ['/myshow/ajax/performance/512082'])
  assert.equal(m['505911'].status, 'onsale')
  assert.deepEqual(m['505911'].saleTimes, [t])
  assert.deepEqual(m['512082'].saleTimes, [fromBeijing(2026, 10, 27, 17, 17)])
})

test('fetchArtist：hasMore 就翻页，最多 3 页', async () => {
  const pagesAsked = []
  const glowStick = fixture('search_k_xuezhiqian_cat0_city10.json').data[1]
  const client = fakeClient(
    gateway({
      search: (req, k, p) => {
        pagesAsked.push(p)
        return { json: { code: 200, data: [{ ...glowStick, performanceId: 900 + p }], paging: { pageNo: p, hasMore: true } } }
      },
    }),
  )
  assert.deepEqual(await maoyan.fetchArtist(XUE, ctxWith(client)), [])
  assert.deepEqual(pagesAsked, [1, 2, 3])
})

test('fetchArtist：没结果时只发一次请求', async () => {
  const client = fakeClient(gateway({ search: () => ({ json: fixture('search_k_wuyuetian_cat0_city10.json') }) }))
  assert.deepEqual(await maoyan.fetchArtist({ key: '五月天', aliases: [], ids: {} }, ctxWith(client)), [])
  assert.equal(client.calls.length, 1)
})

test('fetchArtist：详情下线记成 offline，详情连不上用列表的状态', async () => {
  const client = fakeClient(
    gateway({
      search: () => ({ json: fixture('search_k_xuezhiqian_cat0_city10.json') }),
      detail: (req, id) => {
        if (id === '505911') return { json: fixture('detail_515200.json') }
        throw new Error('socket hang up')
      },
    }),
  )
  const ctx = ctxWith(client)
  const m = byId(await maoyan.fetchArtist(XUE, ctx))
  assert.equal(m['505911'].status, 'offline')
  assert.equal(m['512082'].status, 'presale')
  assert.deepEqual(m['512082'].saleTimes, [])
  assert.match(ctx.logs.join('\n'), /512082/)
})

test('被拦时抛 BlockedError', async () => {
  const blocked = [
    { status: 403, text: 'Forbidden' },
    { status: 406, text: '' },
    { status: 302, headers: { location: 'https://verify.meituan.com/v2/web/general_page?action=spiderindefence' } },
    { json: { code: 406, msg: '', data: null } },
    { json: { code: 1002, msg: '前方拥堵，请稍后再试～', data: null } },
    { json: { code: 500, msg: '前方拥堵，请稍后重试', data: null } },
    { text: '<html><script src="https://s3plus.meituan.net/v1/mss_xxx/yoda.seed.js"></script></html>' },
  ]
  for (const res of blocked) {
    const client = fakeClient(gateway({ search: () => res }))
    await assert.rejects(maoyan.fetchArtist(XUE, ctxWith(client)), BlockedError, JSON.stringify(res))
  }
  // 详情被拦也停掉整个数据源
  const client = fakeClient(
    gateway({
      search: () => ({ json: fixture('search_k_xuezhiqian_cat0_city10.json') }),
      detail: () => ({ json: { code: 406, msg: '', data: null } }),
    }),
  )
  await assert.rejects(maoyan.fetchArtist(XUE, ctxWith(client)), BlockedError)
})

test('接口变了抛 ApiChangedError', async () => {
  const changed = [
    { status: 404, text: '<html>Not Found</html>' },
    { text: '<html>猫眼演出</html>' },
    { json: { code: 4001, msg: '参数错误', data: null } },
    { json: { code: 200, data: { list: [] } } },
    { json: { code: 200, data: [{ name: '没有编号的项目', categoryId: 1 }] } },
    { status: 301, headers: { location: 'https://m.dianping.com/' } },
  ]
  for (const res of changed) {
    const client = fakeClient(gateway({ search: () => res }))
    await assert.rejects(maoyan.fetchArtist(XUE, ctxWith(client)), ApiChangedError, JSON.stringify(res))
  }
  const client = fakeClient(
    gateway({
      search: () => ({ json: fixture('search_k_xuezhiqian_cat0_city10.json') }),
      detail: () => ({ json: { code: 200, data: null } }),
    }),
  )
  await assert.rejects(maoyan.fetchArtist(XUE, ctxWith(client)), ApiChangedError)
})

test('resolveArtist：H5 搜索连不上、被拦、格式变了都返回 undefined（这一轮没查成），这一轮不再问 show.maoyan.com', async () => {
  const failures = [
    ['超时', () => {
      throw new Error('超过 20 秒没有响应')
    }],
    ['HTTP 429', () => ({ status: 429 })],
    ['前方拥堵', () => ({ json: { code: 1002, msg: '前方拥堵，请稍后再试～', data: null } })],
    ['跳到验证页', () => ({ status: 302, headers: { location: 'https://verify.meituan.com/v2/web/general_page' } })],
    ['格式变了', () => ({ json: { code: 200, data: { celebrityBasicDTOList: {} } } })],
  ]
  for (const [label, h5] of failures) {
    const client = fakeClient(gateway({ h5 }))
    const ctx = ctxWith(client)
    assert.equal(await maoyan.resolveArtist(XUE, ctx), undefined, label)
    assert.match(ctx.logs.join('\n'), /show\.maoyan\.com/, label)
    const asked = client.calls.length
    // 同一轮（同一个客户端）的下一位艺人不再请求 H5 搜索
    assert.equal(await maoyan.resolveArtist({ key: '周深', aliases: [] }, ctxWith(client)), undefined, label)
    assert.equal(client.calls.length, asked, label)
  }
  // 下一轮换了客户端，照常再试
  const next = fakeClient(gateway({ h5: () => ({ json: fixture('h5search_k_zhoushen.json') }) }))
  assert.deepEqual(await maoyan.resolveArtist({ key: '周深', aliases: [] }, ctxWith(next)), { id: '2819854', name: '周深' })
})

test('整轮：H5 搜索超时或被拦，照样去 m.dianping.com 按名字搜，猫眼不停', async () => {
  const searches = { 薛之谦: 'search_k_xuezhiqian_cat0_city10.json', 许巍: 'live-search-许巍-2026-10-26.json' }
  const details = {
    505911: 'detail_505911.json',
    512082: 'detail_512082_xuezhiqian_wuxi.json',
    509862: 'live-detail-509862-斑马音乐节-2026-10-26.json',
  }
  for (const [mode, h5] of [
    ['超时', () => {
      throw new Error('超过 20 秒没有响应')
    }],
    ['被拦', () => ({ json: { code: 1002, msg: '前方拥堵，请稍后再试～', data: null } })],
  ]) {
    const client = fakeClient(
      gateway({
        h5,
        search: (req, k) => ({ json: fixture(searches[k]) }),
        detail: (req, id) => ({ json: fixture(details[id] ?? 'detail_515200.json') }),
      }),
      { site: 'maoyan', now: () => NOW },
    )
    const stats = await runRound({
      store: openStore(':memory:'),
      adapters: [maoyan],
      artists: [{ key: '薛之谦', aliases: [] }, { key: '许巍', aliases: [] }],
      notifier: { sendCard: async () => {}, sendText: async () => {} },
      now: () => NOW,
      log: () => {},
      clientFor: () => client,
    })
    const result = stats.sources.maoyan
    assert.equal(result.ok, true, mode)
    assert.equal(result.artists, 2, mode)
    assert.ok(result.listings > 0, mode)
    const searched = client.calls
      .map((c) => decodeURIComponent(new URL(c.url).pathname).match(/\/performances\/0;st=0;k=([^;]*);/)?.[1])
      .filter(Boolean)
    assert.deepEqual(searched, ['薛之谦', '许巍'], mode)
    // 超时时客户端自己重试一次；之后这一轮不再请求 show.maoyan.com
    const h5Calls = client.calls.filter((c) => new URL(c.url).hostname === 'show.maoyan.com').length
    assert.equal(h5Calls, mode === '超时' ? 2 : 1, mode)
  }
})

test(
  '艺人自己带“经典”“纪念”“金曲”字样的演唱会，标题有名字就记成 title',
  () => {
    const base = fixture('search_k_xuezhiqian_cat0_city10.json').data.find((i) => i.performanceId === 512082)
    const cases = [
      ['张学友', '张学友[A CLASSIC TOUR 学友.经典]世界巡回演唱会-无锡站'],
      ['五月天', '五月天 出道25周年纪念演唱会-无锡站'],
      ['谭咏麟', '谭咏麟「银河岁月」金曲演唱会-无锡站'],
    ]
    for (const [key, title] of cases) {
      const [l] = maoyan.parseListings({ code: 200, data: [{ ...base, name: title }] }, { key, aliases: [] }, NOW)
      assert.equal(l?.matchedBy, 'title', title)
    }
    // 紧挨着名字的致敬场照样丢
    assert.deepEqual(maoyan.parseListings(fixture('search_k_dengzilong_cat0_city10.json'), { key: '邓丽君', aliases: [] }, NOW), [])
  },
)

test('check：搜一次薛之谦', async () => {
  const client = fakeClient(gateway({ search: () => ({ json: fixture('search_k_xuezhiqian_cat0_city10.json') }) }))
  const result = await maoyan.check(ctxWith(client))
  assert.equal(result.ok, true)
  assert.match(result.detail, /3 条/)
  assert.equal(client.calls.length, 1)
  assert.equal(new URL(client.calls[0].url).pathname, '/myshow/ajax/performances/0;st=0;k=%E8%96%9B%E4%B9%8B%E8%B0%A6;p=1;s=20;tft=0')

  const blocked = fakeClient(gateway({ search: () => ({ status: 403 }) }))
  const bad = await maoyan.check(ctxWith(blocked))
  assert.equal(bad.ok, false)
  assert.ok(bad.error instanceof BlockedError)
})
