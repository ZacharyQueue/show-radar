import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fakeClient } from '../helpers/fake-http.mjs'
import * as damai from '../../src/sources/damai.mjs'
import { ApiChangedError, BlockedError, NetworkError } from '../../src/errors.mjs'
import { validateListing } from '../../src/listing.mjs'
import { MOBILE_UA } from '../../src/http.mjs'
import { fromBeijing } from '../../src/time.mjs'

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../fixtures/damai/${name}`, import.meta.url), 'utf8'))
const clone = (o) => JSON.parse(JSON.stringify(o))
const md5 = (s) => createHash('md5').update(s).digest('hex')
const at = (mo, d, h = 0, mi = 0, y = 2026) => fromBeijing(y, mo, d, h, mi)

// 薛之谦搜索样本里接口自己的 currentTime：北京时间 2026-10-26 23:12
const NOW = 1793027543684
const XUE = { key: '薛之谦', aliases: [], ids: { damai: '609' } }
const XU = { key: '许嵩', aliases: [], ids: { damai: '615' } }
const SEARCH_XUE = 'mtop_search_xuezhiqian_p1__signed.json'
const TOKEN_EMPTY = { api: 'mtop.damai.wireless.search.search', ret: ['FAIL_SYS_TOKEN_EMPTY::令牌为空'], v: '1.0' }

function byId(listings) {
  return Object.fromEntries(listings.map((l) => [l.sourceId, l]))
}

function tokenCookies(token, enc = 'enc') {
  return [`_m_h5_tk=${token}_1793030000000;Path=/;Domain=damai.cn;Max-Age=5400`, `_m_h5_tk_enc=${enc};Path=/;Domain=damai.cn;Max-Age=5400`]
}

/**
 * 假的 mtop 服务端：没带令牌回 TOKEN_EMPTY 并下发令牌；签名不对回 ILLEGAL_ACCESS；
 * 对了按 api 交给 routes，routes[api](data, req) 返回 { json } 或 { status }。
 */
function mtopServer(routes, { token = 'tok123' } = {}) {
  return (req) => {
    const q = new URL(req.url).searchParams
    const m = (req.headers.cookie ?? '').match(/_m_h5_tk=([^;]+)/)
    if (!m) return { json: TOKEN_EMPTY, headers: { 'set-cookie': tokenCookies(token) } }
    const expected = md5(`${m[1].split('_')[0]}&${q.get('t')}&12574478&${q.get('data')}`)
    if (q.get('sign') !== expected) return { json: { ret: ['FAIL_SYS_ILLEGAL_ACCESS::非法请求'] } }
    const route = routes[q.get('api')]
    if (!route) return { json: { ret: ['FAIL_SYS_API_NOT_FOUNDED::请求API不存在'] } }
    return route(JSON.parse(q.get('data')), req)
  }
}

/** 和状态库一样，值一律存成字符串。几轮之间传同一个，就是同一个状态库。 */
function memoryKv() {
  const map = new Map()
  return {
    map,
    get: (key) => map.get(key) ?? null,
    set: (key, value) => map.set(key, typeof value === 'string' ? value : JSON.stringify(value)),
  }
}

function makeCtx(handler, { now = NOW, previous = {}, kv = memoryKv() } = {}) {
  const client = fakeClient(handler, { site: 'damai' })
  const logs = []
  return {
    client,
    now: () => now,
    log: (msg) => logs.push(msg),
    kv,
    previous: (id) => previous[id] ?? null,
    logs,
  }
}

function detailCalls(ctx) {
  return ctx.client.calls
    .filter((c) => new URL(c.url).searchParams.get('api') === 'mtop.damai.item.detail.getdetail')
    .map((c) => JSON.parse(new URL(c.url).searchParams.get('data')).itemId)
}

function apis(ctx) {
  return ctx.client.calls.map((c) => new URL(c.url).searchParams.get('api'))
}

// ---------- 模块接口 ----------

test('导出的接口和 sources/index.mjs 约定的一致', () => {
  assert.equal(damai.name, 'damai')
  assert.equal(damai.label, '大麦')
  assert.equal(damai.needsArtistId, true)
  assert.equal(damai.everyRun, true)
  assert.deepEqual(damai.clientOptions, { site: 'damai', userAgent: MOBILE_UA })
  for (const fn of ['resolveArtist', 'fetchArtist', 'check']) assert.equal(typeof damai[fn], 'function')
})

// ---------- 解析搜索 ----------

test('薛之谦：按艺人 ID 核对，周边荧光棒去掉，状态和开售时间对上', () => {
  const listings = damai.listingsFromSearch(fixture(SEARCH_XUE), XUE, NOW)
  listings.forEach(validateListing)
  assert.deepEqual(listings.map((l) => l.sourceId), ['1089011559335', '1083650546473'])
  const { 1089011559335: wuxi, 1083650546473: xiamen } = byId(listings)
  assert.deepEqual(wuxi, {
    source: 'damai',
    sourceId: '1089011559335',
    artistKey: '薛之谦',
    kind: 'ticket',
    title: '薛之谦“万兽之王”巡回演唱会- 无锡站',
    city: '无锡',
    venue: '无锡奥林匹克体育中心体育场',
    dateStart: '2026-11-13',
    dateEnd: '2026-11-22',
    matchedBy: 'id',
    isMixed: false,
    status: 'presale',
    // upTime、“明天17:17”、倒计时三处说的是同一刻，合成一个
    saleTimes: [at(10, 27, 17, 17)],
    hasSold: false,
    roundHint: null,
    roundHintAt: null,
    approval: null,
    url: 'https://m.damai.cn/shows/item.html?itemId=1089011559335',
  })
  assert.equal(xiamen.status, 'soldout')
  assert.deepEqual(xiamen.saleTimes, [at(10, 28, 10, 0)])
  assert.equal(xiamen.hasSold, true)
  assert.equal(xiamen.dateStart, '2026-10-31')
  assert.equal(xiamen.dateEnd, '2026-11-08')
})

test('还没有大麦 ID 时，靠 artisteNames 认，记成 title', () => {
  const listings = damai.listingsFromSearch(fixture(SEARCH_XUE), { key: '薛之谦', aliases: [], ids: {} }, NOW)
  assert.deepEqual(listings.map((l) => [l.sourceId, l.matchedBy]), [
    ['1089011559335', 'title'],
    ['1083650546473', 'title'],
  ])
})

test('致敬类舞蹈诗剧 artisteNames 为 null，去掉', () => {
  const listings = damai.listingsFromSearch(fixture('mtop_search_zhoujielun_p1.json'), { key: '周杰伦', ids: { damai: 2031 } }, NOW)
  assert.deepEqual(listings.map((l) => l.sourceId).sort(), ['1065510412698', '1077189102025'])
  assert.ok(listings.every((l) => l.status === 'soldout' && l.hasSold && l.matchedBy === 'id'))
})

test('音乐节靠阵容核对：isMixed，没 ID 记 lineup，有 ID 记 id', () => {
  const json = fixture('mtop_search_huichundan_p1.json')
  const byLineup = byId(damai.listingsFromSearch(json, { key: '回春丹乐队', ids: {} }, NOW))
  assert.equal(byLineup['1083691103272'].matchedBy, 'lineup')
  assert.equal(byLineup['1083691103272'].isMixed, true)
  assert.equal(byLineup['1091322501408'].isMixed, true)
  assert.equal(byLineup['1088976277541'].matchedBy, 'title')
  assert.equal(byLineup['1088976277541'].isMixed, false)

  const withId = damai.listingsFromSearch(json, { key: '回春丹乐队', ids: { damai: '12026694' } }, NOW)
  assert.equal(withId.length, 3)
  assert.ok(withId.every((l) => l.matchedBy === 'id'))
})

test('名字末尾的“乐队”不算：“回春丹”认得出“回春丹乐队”；只是包含关系的不认', () => {
  const json = fixture('mtop_search_huichundan_p1.json')
  assert.equal(damai.listingsFromSearch(json, { key: '回春丹', ids: {} }, NOW).length, 3)
  assert.deepEqual(damai.listingsFromSearch(json, { key: '回春', ids: {} }, NOW), [])
  const withId = damai.listingsFromSearch(json, { key: '回春丹', ids: { damai: 12026694 } }, NOW)
  assert.equal(withId.length, 3)
  assert.ok(withId.every((l) => l.matchedBy === 'id'))
})

test('音乐节类目算 isMixed，致敬场和没有阵容的音乐节去掉', () => {
  const listings = damai.listingsFromSearch(fixture('mtop_search_yinyuejie_p1.json'), { key: '许巍' }, NOW)
  assert.deepEqual(listings.map((l) => l.title).sort(), ['2026深圳•光核音乐节', '2026蜜桃音乐节', '巅峰·斑马音乐节', '橘子湾音乐节'])
  assert.ok(listings.every((l) => l.isMixed && l.matchedBy === 'lineup'))
  // 只有一位艺人、类目是音乐节的也算
  const json = fixture('mtop_search_yinyuejie_p1.json')
  const argy = damai.listingsFromSearch(json, { key: 'ARGY' }, NOW)
  assert.equal(argy.length, 1)
  assert.equal(argy[0].isMixed, true)
  assert.equal(argy[0].matchedBy, 'lineup')
})

test('拼盘演唱会：多位艺人同台记 isMixed', () => {
  const listings = byId(damai.listingsFromSearch(fixture('v_damai_search_lironghao.json'), { key: '李荣浩', ids: {} }, NOW))
  assert.equal(listings['1086308563577'].isMixed, true)
  assert.equal(listings['1086308563577'].matchedBy, 'lineup')
  assert.equal(listings['1069758826573'].isMixed, false)
})

test('延期：itemSaleStatus=7，日期待定且不拿占位的 nearestPerformTime 当日期', () => {
  const [l] = damai.listingsFromSearch(fixture('mtop_search_yanqi_p1.json'), { key: '张远' }, NOW)
  assert.equal(l.sourceId, '1020177860424')
  assert.equal(l.status, 'postponed')
  assert.equal(l.dateStart, null)
  assert.equal(l.dateEnd, null)
  assert.equal(l.hasSold, false)
})

test('没见过的 itemSaleStatus 记成 listed，并写日志', () => {
  const json = clone(fixture(SEARCH_XUE))
  json.data.projectInfo[0].itemSaleStatus = 5
  const logs = []
  const [l] = damai.listingsFromSearch(json, XUE, NOW, { log: (m) => logs.push(m) })
  assert.equal(l.status, 'listed')
  assert.match(logs.join('\n'), /1089011559335.*itemSaleStatus=5/)
})

test('只有 siteStatus=16 的 upTime 算开售时间', () => {
  const lin = byId(damai.listingsFromSearch(fixture('damai_search_林忆莲.json'), { key: '林忆莲' }, NOW))
  assert.deepEqual(lin['1089895389130'].saleTimes, [at(10, 27, 11, 0)])
  assert.deepEqual(lin['1083901579374'].saleTimes, []) // siteStatus=3，upTime 是普通时间戳
  const li = byId(damai.listingsFromSearch(fixture('v_damai_search_lironghao.json'), { key: '李荣浩' }, NOW))
  assert.deepEqual(li['1051563675746'].saleTimes, []) // siteStatus=15
  assert.deepEqual(li['1086140371733'].saleTimes, [at(10, 29, 13, 0)]) // 只有 upTime，没有倒计时
  assert.equal(li['1086140371733'].dateEnd, '2027-01-02')
})

test('倒计时按接口的 currentTime 算并取整到分钟，不随本机时间漂', () => {
  const json = clone(fixture(SEARCH_XUE))
  const p = json.data.projectInfo[0]
  delete p.upTime
  delete p.onSaleTime
  const [a] = damai.listingsFromSearch(json, XUE, NOW + 5 * 60_000)
  assert.deepEqual(a.saleTimes, [at(10, 27, 17, 17)])
})

test('演出日期的几种写法', () => {
  const cases = [
    ['2026.11.13-11.22', '2026-11-13', '2026-11-22'],
    ['2026.11.21', '2026-11-21', '2026-11-21'],
    ['2026.12.19 周六 19:00', '2026-12-19', '2026-12-19'],
    ['2026.10.31 周六 18:18', '2026-10-31', '2026-10-31'],
    ['2026.12.31-2027.01.02', '2026-12-31', '2027-01-02'],
    ['2026.12.31-01.02', '2026-12-31', '2027-01-02'],
    ['2026.11.6/11.8', '2026-11-06', '2026-11-08'],
    ['2026.11.13-15', '2026-11-13', '2026-11-15'],
    ['2026年8月7日-12月31日', '2026-08-07', '2026-12-31'],
  ]
  for (const [text, dateStart, dateEnd] of cases) assert.deepEqual(damai.parseShowTime(text), { dateStart, dateEnd }, text)
  for (const text of ['时间延期待定', '时间待定', '2026.02.30', '', null]) assert.equal(damai.parseShowTime(text), null, String(text))
})

test('日期解析不了时用 nearestPerformTime', () => {
  const json = clone(fixture(SEARCH_XUE))
  json.data.projectInfo[0].showTime = '场次待定'
  const [l] = damai.listingsFromSearch(json, XUE, NOW)
  assert.equal(l.dateStart, '2026-11-13')
  assert.equal(l.dateEnd, '2026-11-13')
})

test('搜索返回格式变了抛 ApiChangedError', () => {
  assert.throws(() => damai.listingsFromSearch({ ret: ['SUCCESS::调用成功'] }, XUE, NOW), ApiChangedError)
  assert.throws(() => damai.listingsFromSearch({ data: { total: 3, projectInfo: {} } }, XUE, NOW), ApiChangedError)
  assert.throws(() => damai.listingsFromSearch({ data: { total: 3 } }, XUE, NOW), ApiChangedError)
  // 没有项目时 projectInfo 本来就不出现
  assert.deepEqual(damai.listingsFromSearch(fixture('mtop_search_wuyuetian_p1.json'), { key: '五月天' }, NOW), [])
})

test('找艺人账号：type=2、名字归一后相同才认', () => {
  assert.deepEqual(damai.findArtistAccount(fixture(SEARCH_XUE), { key: '薛之谦' }), { id: '609', name: '薛之谦' })
  assert.deepEqual(damai.findArtistAccount(fixture('mtop_search_wanqing_p1.json'), { key: '万能青年旅店' }), { id: '71713', name: '万能青年旅店' })
  assert.deepEqual(damai.findArtistAccount(fixture('mtop_search_huichundan_p1.json'), { key: '回春丹' }), { id: '12026694', name: '回春丹乐队' })
  assert.equal(damai.findArtistAccount(fixture('mtop_search_huichundan_p1.json'), { key: '回春' }), null)
  assert.deepEqual(damai.findArtistAccount(fixture('mtop_search_huichundan_p1.json'), { key: '回春丹', aliases: ['回春丹乐队'] }), {
    id: '12026694',
    name: '回春丹乐队',
  })
  // type=5 是巡演 IP，不是艺人
  assert.equal(damai.findArtistAccount(fixture('mtop_search_yinyuejie_p1.json'), { key: '氧气森林音乐节' }), null)
})

// ---------- 解析详情 ----------

test('详情：无锡首开前，场次开售时间和介绍对得上，没开过票', () => {
  const d = damai.parseDetail(fixture('mtop_detail_1089011559335_xuezhiqian_wuxi.json'), NOW)
  assert.deepEqual([...new Set(d.saleTimes)].sort(), [at(10, 27, 17, 17), at(10, 28, 17, 17)])
  assert.equal(d.roundHint, null)
  assert.equal(d.roundHintAt, at(10, 28, 17, 17))
  assert.equal(d.firstSaleAt, null)
})

test('详情：厦门介绍里的第二次、第三次销售时间都解析出来，轮次取 3', () => {
  const d = damai.parseDetail(fixture('mtop_detail_1083650546473_xuezhiqian_xiamen.json'), NOW)
  assert.equal(d.roundHint, 3)
  assert.deepEqual([...new Set(d.saleTimes)].sort(), [
    at(10, 8, 17, 17),
    at(10, 10, 17, 17),
    at(10, 14, 17, 17),
    at(10, 19, 17, 17),
    at(10, 20, 17, 17),
    at(10, 25, 10, 0),
    at(10, 26, 10, 0),
  ])
  // 轮次时间是介绍里最晚的那个：第三次销售的 10-26 10:00
  assert.equal(d.roundHintAt, at(10, 26, 10, 0))
  // 退票规则从首开 10-08 17:17 起算
  assert.equal(d.firstSaleAt, at(10, 8, 17, 17))
})

test('详情：“将于9月24日11:00进行第二次开售”', () => {
  const d = damai.parseDetail(fixture('damai_detail_1079818937981_linyilian_chengdu.json'), NOW)
  assert.equal(d.roundHint, 2)
  assert.deepEqual(d.saleTimes, [at(9, 24, 11, 0)])
  assert.equal(d.roundHintAt, at(9, 24, 11, 0))
  assert.equal(d.firstSaleAt, at(9, 16, 11, 0))
})

test('详情：带年份的“大麦抢先购时间”“正式预售时间”', () => {
  const d = damai.parseDetail(fixture('mtop_detail_1081432722707_huyanbin_chongqing.json'), NOW)
  assert.deepEqual(d.saleTimes, [at(9, 24, 11, 0), at(9, 25, 11, 0)])
  assert.equal(d.roundHint, null)
})

test('详情：演完的贵阳站日期待定，没写年份的按离现在最近的一年算，“再次销售”不压低轮次', () => {
  const d = damai.parseDetail(fixture('v_damai_detail_1085142029424_xuezhiqian_guiyang_ended.json'), NOW)
  assert.equal(d.roundHint, 3)
  assert.equal(Math.min(...d.saleTimes), at(9, 30, 10, 0))
  assert.equal(Math.max(...d.saleTimes), at(10, 21, 10, 0))
})

test('详情：周深佛山已上架、开票时间未定，什么都没有', () => {
  assert.deepEqual(damai.parseDetail(fixture('v_damai_detail_1084030402927_zhoushen_foshan.json'), NOW), {
    saleTimes: [],
    roundHint: null,
    roundHintAt: null,
    firstSaleAt: null,
  })
})

test('介绍文字：退票、演出时间不算开售时间；标题下一句的时间算；没写年份的取演出前那一年', () => {
  const html =
    '<p>第二次开售时间：</p><p>1月5日 10:00</p><p>演出时间：1月20日 19:30</p>' +
    '<p>12月30日 17:17停止退票，12月31日(周四)下午3点半开票</p>'
  const anchor = at(1, 21, 0, 0, 2027)
  const r = damai.parseIntroduce(html, { anchor, now: NOW })
  assert.equal(r.roundHint, 2)
  assert.deepEqual(r.saleTimes, [at(1, 5, 10, 0, 2027), at(12, 31, 15, 30)])
  assert.equal(r.roundHintAt, at(1, 5, 10, 0, 2027))
  assert.equal(damai.parseIntroduce('<p>第二次开售，时间另行通知</p>', { now: NOW }).roundHintAt, null)
})

test('合并详情：开过票看退票规则；不取详情时沿用上一轮', () => {
  const [wuxi, xiamen] = damai.listingsFromSearch(fixture(SEARCH_XUE), XUE, NOW)
  const dx = damai.parseDetail(fixture('mtop_detail_1083650546473_xuezhiqian_xiamen.json'), NOW)
  const merged = damai.applyDetail(xiamen, dx, NOW)
  assert.equal(merged.roundHint, 3)
  assert.equal(merged.hasSold, true)
  assert.ok(merged.saleTimes.includes(at(10, 28, 10, 0)))
  assert.ok(merged.saleTimes.includes(at(10, 8, 17, 17)))

  // 预约中、没退票规则、开售时间都在将来：没开过票
  const dw = damai.parseDetail(fixture('mtop_detail_1089011559335_xuezhiqian_wuxi.json'), NOW)
  const w = damai.applyDetail(wuxi, dw, NOW)
  assert.equal(w.hasSold, false)
  assert.deepEqual(w.saleTimes, [at(10, 27, 17, 17), at(10, 28, 17, 17)])
  // 首开那一刻过了，就算开过票
  assert.equal(damai.applyDetail(wuxi, dw, at(10, 27, 17, 18)).hasSold, true)

  const kept = damai.applyPrevious(wuxi, { ...w, roundHint: 2, roundHintAt: at(10, 20, 10, 0), hasSold: true }, NOW)
  assert.deepEqual(kept.saleTimes, w.saleTimes)
  assert.equal(kept.roundHint, 2)
  assert.equal(kept.roundHintAt, at(10, 20, 10, 0))
  assert.equal(kept.hasSold, true)
})

test('什么时候取详情', () => {
  const [wuxi, xiamen] = damai.listingsFromSearch(fixture(SEARCH_XUE), XUE, NOW)
  const prevWuxi = { ...wuxi, saleTimes: [at(10, 27, 17, 17), at(10, 28, 17, 17)] }
  assert.equal(damai.needsDetail(wuxi, null, NOW), true, '新项目')
  assert.equal(damai.needsDetail(wuxi, prevWuxi, NOW), false, '没变')
  assert.equal(damai.needsDetail(wuxi, { ...prevWuxi, status: 'soldout' }, NOW), true, '状态变了')
  assert.equal(damai.needsDetail(wuxi, { ...prevWuxi, saleTimes: [at(10, 28, 17, 17)] }, NOW), true, '列表上出现新的开售时间')
  assert.equal(damai.needsDetail(xiamen, { ...xiamen }, NOW), false)
  const presale = { ...wuxi, saleTimes: [] }
  assert.equal(damai.needsDetail(presale, { ...presale, saleTimes: [at(10, 1, 10, 0)] }, NOW), true, '预约中、上一轮只有过去的开售时间')
  assert.equal(damai.needsDetail(presale, { ...presale, saleTimes: [at(10, 30, 10, 0)] }, NOW), false)

  // 备忘：上一轮详情没取到的要再取；只在详情里的时间不算撤掉
  assert.equal(damai.needsDetail(wuxi, prevWuxi, NOW, { list: [at(10, 27, 17, 17)] }), false, '没变，有备忘')
  assert.equal(damai.needsDetail(wuxi, prevWuxi, NOW, { list: [at(10, 27, 17, 17)], retry: true }), true, '上一轮详情没取到')
  // 列表撤掉了上一轮还在的将来开售时间
  const pulled = { ...xiamen, saleTimes: [] }
  const memo = { list: [at(10, 28, 10, 0)] }
  assert.equal(damai.needsDetail(pulled, xiamen, NOW, memo), true, '列表撤掉了将来的开售时间')
  assert.equal(damai.needsDetail(pulled, xiamen, NOW), false, '没有备忘时照旧')
  assert.equal(damai.needsDetail(pulled, xiamen, at(10, 28, 10, 1), memo), false, '开售时间已过，列表不再给是正常的')
  assert.deepEqual(damai.applyPrevious(pulled, xiamen, NOW, memo).saleTimes, [])
  assert.deepEqual(damai.applyPrevious(pulled, xiamen, at(10, 28, 10, 1), memo).saleTimes, [at(10, 28, 10, 0)])
})

test('实测样本（北京时间 2026-10-27 00:24）：周深 5 站都按 ID 认上，澳门晚会是拼盘', () => {
  const json = fixture('live-search-周深-2026-10-27.json')
  const now = json.data.currentTime
  const listings = byId(damai.listingsFromSearch(json, { key: '周深', ids: { damai: '71964' } }, now))
  assert.equal(Object.keys(listings).length, 5)
  assert.ok(Object.values(listings).every((l) => l.matchedBy === 'id'))
  assert.equal(listings['1091326429218'].isMixed, true)
  assert.equal(listings['1083966678533'].status, 'presale')
  assert.deepEqual(listings['1083966678533'].saleTimes, [])
  assert.equal(listings['1083966678533'].dateEnd, '2027-01-01')

  // 南宁还没开票：“条件退”只有标签、没有规则
  const nanning = damai.parseDetail(fixture('live-detail-1083966678533-周深南宁-2026-10-27.json'), now)
  assert.deepEqual(nanning, { saleTimes: [], roundHint: null, roundHintAt: null, firstSaleAt: null })
  assert.equal(damai.applyDetail(listings['1083966678533'], nanning, now).hasSold, false)
  // 澳门晚会“不支持退”，靠热卖状态认定开过票
  const gala = damai.parseDetail(fixture('live-detail-1091326429218-wgala澳门-2026-10-27.json'), now)
  assert.equal(damai.applyDetail(listings['1091326429218'], gala, now).hasSold, true)
})

test('实测样本：厦门站隔了一个多小时再取，结果和探测时一致', () => {
  const search = fixture('live-search-薛之谦-2026-10-27.json')
  const now = search.data.currentTime
  const [, xiamen] = damai.listingsFromSearch(search, XUE, now)
  const d = damai.parseDetail(fixture('live-detail-1083650546473-薛之谦厦门-2026-10-27.json'), now)
  const merged = damai.applyDetail(xiamen, d, now)
  assert.equal(merged.status, 'soldout')
  assert.equal(merged.roundHint, 3)
  assert.equal(merged.roundHintAt, at(10, 26, 10, 0))
  assert.equal(Math.max(...merged.saleTimes), at(10, 28, 10, 0))
  assert.equal(fixture('live-token-empty-2026-10-27.json').ret[0], 'FAIL_SYS_TOKEN_EMPTY::令牌为空')
})

test('许嵩温州：场次开售时间 10-28 还没到，退票规则从 10-20 起算是改期前留下的，不算开过票', () => {
  // 北京时间 10-26 23:30，在退票规则的 10-20 之后、场次开售的 10-28 19:00 之前
  const now = at(10, 26, 23, 30)
  const listings = byId(damai.listingsFromSearch(fixture('damai_search_许嵩.json'), XU, now))
  const wenzhou = listings['1090946772880']
  assert.equal(wenzhou.status, 'presale')
  assert.equal(wenzhou.hasSold, false)

  const d = damai.parseDetail(fixture('damai_detail_1090946772880_xusong_wenzhou.json'), now)
  assert.equal(d.firstSaleAt, null)
  assert.deepEqual(d.saleTimes, [at(10, 28, 19, 0), at(10, 28, 20, 0)])
  const merged = damai.applyDetail(wenzhou, d, now)
  assert.equal(merged.status, 'presale')
  assert.equal(merged.hasSold, false)
  assert.deepEqual(merged.saleTimes, [at(10, 28, 19, 0), at(10, 28, 20, 0)])

  // 第一场过了开售时间，照旧按“某个开售时间已经过了”算开过票
  const later = at(10, 28, 19, 1)
  assert.equal(damai.applyDetail(wenzhou, damai.parseDetail(fixture('damai_detail_1090946772880_xusong_wenzhou.json'), later), later).hasSold, true)
  // 两场都过了、场次开售时间还挂着：退票规则比它早，照样不认
  assert.equal(damai.parseDetail(fixture('damai_detail_1090946772880_xusong_wenzhou.json'), at(10, 29, 0, 0)).firstSaleAt, null)
  // 没有场次开售时间时，退票规则照旧算首开
  const bare = clone(fixture('damai_detail_1090946772880_xusong_wenzhou.json'))
  bare.data.item.performInfos = []
  assert.equal(damai.parseDetail(bare, now).firstSaleAt, at(10, 20, 19, 0))
  // 南宁没有场次开售时间，退票规则从 9-29 起算，开过票
  const nanning = damai.applyDetail(listings['1086111708947'], damai.parseDetail(fixture('damai_detail_1086111708947_xusong_nanning.json'), now), now)
  assert.equal(nanning.hasSold, true)
})

test('薛之谦厦门：介绍里将来的三开时间不否掉退票规则', () => {
  // 北京时间 10-24 12:00，三开的 10-25、10-26 都还没到
  const now = at(10, 24, 12, 0)
  const d = damai.parseDetail(fixture('live-detail-1083650546473-薛之谦厦门-2026-10-27.json'), now)
  assert.equal(d.firstSaleAt, at(10, 8, 17, 17))
  assert.equal(d.roundHint, 3)
  assert.equal(d.roundHintAt, at(10, 26, 10, 0))
  const [, xiamen] = damai.listingsFromSearch(fixture('live-search-薛之谦-2026-10-27.json'), XUE, now)
  assert.equal(damai.applyDetail({ ...xiamen, status: 'presale', hasSold: false }, d, now).hasSold, true)
})

test('轮次时间跟着轮次走：轮次大的那份，一样大取这一轮的；那份没有时取另一份的', () => {
  const [, xiamen] = damai.listingsFromSearch(fixture(SEARCH_XUE), XUE, NOW)
  const d = damai.parseDetail(fixture('mtop_detail_1083650546473_xuezhiqian_xiamen.json'), NOW)
  const pick = (detail, previous) => {
    const l = damai.applyDetail(xiamen, { ...d, ...detail }, NOW, previous && { ...xiamen, ...previous })
    return [l.roundHint, l.roundHintAt]
  }
  const T1 = at(10, 20, 17, 17)
  const T2 = at(10, 26, 10, 0)
  assert.deepEqual(pick({}, null), [3, T2])
  assert.deepEqual(pick({}, { roundHint: 2, roundHintAt: T1 }), [3, T2], '这一轮轮次大')
  assert.deepEqual(pick({ roundHintAt: T1 }, { roundHint: 3, roundHintAt: T2 }), [3, T1], '一样大，主办方改了时间，取这一轮的')
  assert.deepEqual(pick({ roundHint: 2, roundHintAt: T1 }, { roundHint: 3, roundHintAt: T2 }), [3, T2], '上一轮轮次大')
  assert.deepEqual(pick({ roundHintAt: null }, { roundHint: 3, roundHintAt: T1 }), [3, T1], '这一轮没写时间，不丢')
  assert.deepEqual(pick({}, { roundHint: 3 }), [3, T2], '上一轮的记录还没有这个字段')
  assert.deepEqual(pick({ roundHint: null, roundHintAt: null }, { roundHint: null, roundHintAt: T1 }), [null, T1])
})

// ---------- 请求流程 ----------

test('第一次请求取匿名令牌，再按 md5(token&t&appKey&data) 签名', async () => {
  const ctx = makeCtx(mtopServer({ 'mtop.damai.wireless.search.search': () => ({ json: fixture(SEARCH_XUE) }) }))
  const result = await damai.check(ctx)
  assert.equal(result.ok, true)
  assert.match(result.detail, /薛之谦/)

  const [first, second] = ctx.client.calls
  assert.equal(ctx.client.calls.length, 2)
  assert.equal(first.headers.cookie, undefined)
  const url = new URL(second.url)
  assert.equal(url.origin + url.pathname, 'https://mtop.damai.cn/h5/mtop.damai.wireless.search.search/1.0/')
  const q = url.searchParams
  assert.equal(q.get('appKey'), '12574478')
  assert.equal(q.get('jsv'), '2.7.5')
  assert.equal(q.get('api'), 'mtop.damai.wireless.search.search')
  assert.equal(q.get('v'), '1.0')
  assert.equal(q.get('type'), 'originaljson')
  assert.equal(q.get('t'), String(NOW))
  assert.equal(q.get('sign'), md5(`tok123&${NOW}&12574478&${q.get('data')}`))
  assert.equal(damai.signMtop('tok123', String(NOW), q.get('data')), q.get('sign'))
  assert.deepEqual(JSON.parse(q.get('data')), {
    cityId: 0,
    longitude: 0,
    latitude: 0,
    pageIndex: 1,
    pageSize: 30,
    keyword: '薛之谦',
    sourceType: 11,
    returnItemOption: 4,
    option: 434,
  })
  assert.match(second.headers.cookie, /_m_h5_tk=tok123_1793030000000/)
  assert.match(second.headers.cookie, /_m_h5_tk_enc=enc/)
  assert.equal(second.headers.referer, 'https://m.damai.cn/')
})

test('令牌过期：服务端下发新令牌，重签一次', async () => {
  let expired = true
  const server = mtopServer({ 'mtop.damai.wireless.search.search': () => ({ json: fixture(SEARCH_XUE) }) }, { token: 'new456' })
  const ctx = makeCtx((req) => {
    if (expired && /_m_h5_tk=old/.test(req.headers.cookie ?? '')) {
      expired = false
      return { json: { ret: ['FAIL_SYS_TOKEN_EXOIRED::令牌过期'] }, headers: { 'set-cookie': tokenCookies('new456') } }
    }
    return server(req)
  })
  ctx.client.cookiesFor('https://mtop.damai.cn/h5').set('_m_h5_tk', 'old_1')
  ctx.client.cookiesFor('https://mtop.damai.cn/h5').set('_m_h5_tk_enc', 'oldenc')
  assert.equal((await damai.check(ctx)).ok, true)
  assert.equal(ctx.client.calls.length, 2)
  assert.match(ctx.client.calls[1].headers.cookie, /_m_h5_tk=new456/)
})

test('令牌非法又没下发新的：清掉旧令牌重新取', async () => {
  const server = mtopServer({ 'mtop.damai.wireless.search.search': () => ({ json: fixture(SEARCH_XUE) }) })
  const ctx = makeCtx((req) =>
    /_m_h5_tk=stale/.test(req.headers.cookie ?? '') ? { json: { ret: ['FAIL_SYS_ILLEGAL_ACCESS::非法请求'] } } : server(req),
  )
  ctx.client.cookiesFor('https://mtop.damai.cn/h5').set('_m_h5_tk', 'stale_1')
  assert.equal((await damai.check(ctx)).ok, true)
  // stale 被拒 → 不带令牌换新的 → 签名成功
  assert.equal(ctx.client.calls.length, 3)
  assert.equal(ctx.client.calls[1].headers.cookie, undefined)
})

test('重取令牌以后签名还是不被接受：抛 ApiChangedError，不无限重试', async () => {
  const ctx = makeCtx((req) =>
    /_m_h5_tk=/.test(req.headers.cookie ?? '')
      ? { json: { ret: ['FAIL_SYS_ILLEGAL_ACCESS::非法请求'] } }
      : { json: TOKEN_EMPTY, headers: { 'set-cookie': tokenCookies('tok123') } },
  )
  await assert.rejects(damai.fetchArtist(XUE, ctx), ApiChangedError)
  assert.ok(ctx.client.calls.length <= 3)
})

test('服务端一直不给令牌：抛 ApiChangedError', async () => {
  const ctx = makeCtx(() => ({ json: TOKEN_EMPTY }))
  await assert.rejects(damai.resolveArtist(XUE, ctx), ApiChangedError)
  assert.equal(ctx.client.calls.length, 3)
})

test('接口名变了抛 ApiChangedError', async () => {
  const ctx = makeCtx(mtopServer({}))
  await assert.rejects(damai.fetchArtist(XUE, ctx), (err) => err instanceof ApiChangedError && /API_NOT_FOUND/.test(err.reason))
})

test('被拦：滑块、限流、HTTP 403 都抛 BlockedError', async () => {
  const slider = {
    ret: ['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试'],
    data: { url: 'https://mtop.damai.cn/_____tmd_____/punish?x5secdata=xx' },
  }
  for (const res of [{ json: slider }, { json: { ret: ['FAIL_SYS_TRAFFIC_LIMIT::被挤爆啦'] } }, { status: 403, text: 'forbidden' }]) {
    const ctx = makeCtx(mtopServer({ 'mtop.damai.wireless.search.search': () => res }))
    await assert.rejects(damai.fetchArtist(XUE, ctx), BlockedError)
  }
  const ctx = makeCtx(mtopServer({ 'mtop.damai.wireless.search.search': () => ({ json: slider }) }))
  const result = await damai.check(ctx)
  assert.equal(result.ok, false)
  assert.ok(result.error instanceof BlockedError)
})

test('服务端一时出错抛 NetworkError；搜索的其他业务失败当接口变了', async () => {
  const busy = makeCtx(mtopServer({ 'mtop.damai.wireless.search.search': () => ({ json: { ret: ['FAIL_SYS_SERVICE_UNAVAILABLE::服务不可用'] } }) }))
  await assert.rejects(damai.fetchArtist(XUE, busy), NetworkError)
  const odd = makeCtx(mtopServer({ 'mtop.damai.wireless.search.search': () => ({ json: { ret: ['FAIL_BIZ_SOMETHING::出错'] } }) }))
  await assert.rejects(damai.fetchArtist(XUE, odd), ApiChangedError)
})

test('翻页：有下一页再翻，最多 3 页', async () => {
  const template = fixture(SEARCH_XUE).data.projectInfo[0]
  const page = (pageIndex, count, total) => ({
    ret: ['SUCCESS::调用成功'],
    data: {
      currentTime: NOW,
      total,
      projectInfo: Array.from({ length: count }, (_, i) => ({ ...template, id: 2000000000000 + pageIndex * 100 + i, siteStatus: 3 })),
    },
  })
  const seen = []
  const server = (total) =>
    mtopServer({
      'mtop.damai.wireless.search.search': (data) => {
        seen.push(data.pageIndex)
        return { json: page(data.pageIndex, Math.min(30, total - (data.pageIndex - 1) * 30), total) }
      },
      // 新项目都要取详情，这里不关心详情内容
      'mtop.damai.item.detail.getdetail': () => ({ json: { ret: ['SUCCESS::调用成功'], data: { item: {} } } }),
    })

  const ctx = makeCtx(server(65))
  const listings = await damai.fetchArtist({ key: '薛之谦', ids: {} }, ctx)
  assert.deepEqual(seen, [1, 2, 3])
  assert.equal(listings.length, 65)

  seen.length = 0
  await damai.fetchArtist({ key: '薛之谦', ids: {} }, makeCtx(server(200)))
  assert.deepEqual(seen, [1, 2, 3])

  seen.length = 0
  await damai.fetchArtist(XUE, makeCtx(server(30)))
  assert.deepEqual(seen, [1])
})

test('fetchArtist：新项目取详情，下一轮没变就不取，沿用上一轮', async () => {
  const routes = {
    'mtop.damai.wireless.search.search': () => ({ json: fixture(SEARCH_XUE) }),
    'mtop.damai.item.detail.getdetail': ({ itemId }) => ({
      json: fixture(itemId === '1089011559335' ? 'mtop_detail_1089011559335_xuezhiqian_wuxi.json' : 'mtop_detail_1083650546473_xuezhiqian_xiamen.json'),
    }),
  }
  const kv = memoryKv()
  const ctx1 = makeCtx(mtopServer(routes), { kv })
  const first = await damai.fetchArtist(XUE, ctx1)
  first.forEach(validateListing)
  assert.deepEqual(apis(ctx1), [
    'mtop.damai.wireless.search.search',
    'mtop.damai.wireless.search.search',
    'mtop.damai.item.detail.getdetail',
    'mtop.damai.item.detail.getdetail',
  ])
  assert.deepEqual(
    ctx1.client.calls.slice(2).map((c) => JSON.parse(new URL(c.url).searchParams.get('data'))),
    [{ itemId: '1089011559335' }, { itemId: '1083650546473' }],
  )
  const { 1089011559335: wuxi, 1083650546473: xiamen } = byId(first)
  assert.deepEqual(wuxi.saleTimes, [at(10, 27, 17, 17), at(10, 28, 17, 17)])
  assert.equal(wuxi.hasSold, false)
  assert.equal(xiamen.roundHint, 3)
  assert.equal(xiamen.hasSold, true)
  assert.ok(xiamen.saleTimes.includes(at(10, 28, 10, 0)))

  // 无锡 10-28 17:17 那一批只在详情里，不算列表撤掉的时间，不会每轮都去取详情
  const ctx2 = makeCtx(mtopServer(routes), { previous: byId(first), kv })
  const second = await damai.fetchArtist(XUE, ctx2)
  assert.deepEqual(apis(ctx2), ['mtop.damai.wireless.search.search', 'mtop.damai.wireless.search.search'])
  assert.deepEqual(second, first)

  const ctx3 = makeCtx(mtopServer(routes), { previous: { ...byId(first), 1089011559335: { ...wuxi, status: 'soldout' } }, kv })
  await damai.fetchArtist(XUE, ctx3)
  assert.equal(apis(ctx3).filter((a) => a === 'mtop.damai.item.detail.getdetail').length, 1)
})

test('详情取不到时不影响整轮：业务失败和一时出错都退回列表的字段', async () => {
  for (const detail of [{ ret: ['FAIL_BIZ_ITEM_NOT_FOUND::项目不存在'] }, { ret: ['FAIL_SYS_SERVICE_TIMEOUT::超时'] }]) {
    const ctx = makeCtx(
      mtopServer({
        'mtop.damai.wireless.search.search': () => ({ json: fixture(SEARCH_XUE) }),
        'mtop.damai.item.detail.getdetail': () => ({ json: detail }),
      }),
    )
    const listings = await damai.fetchArtist(XUE, ctx)
    assert.deepEqual(listings, damai.listingsFromSearch(fixture(SEARCH_XUE), XUE, NOW))
    assert.equal(ctx.logs.length, 2)
  }
})

test('详情被拦：整个数据源这一轮停掉', async () => {
  const ctx = makeCtx(
    mtopServer({
      'mtop.damai.wireless.search.search': () => ({ json: fixture(SEARCH_XUE) }),
      'mtop.damai.item.detail.getdetail': () => ({ json: { ret: ['RGV587_ERROR::SM::哎哟喂,被挤爆啦'] } }),
    }),
  )
  await assert.rejects(damai.fetchArtist(XUE, ctx), BlockedError)
})

test('详情这一轮没取到，下一轮列表没变也再取；取到以后不再取', async () => {
  // 胡彦斌搜索样本里接口自己的 currentTime：北京时间 2026-10-26 23:13
  const now = 1793027630831
  const hu = { key: '胡彦斌', aliases: [], ids: { damai: '195' } }
  const CQ = '1081432722707'
  const search = () => ({ json: fixture('mtop_search_huyanbin_p1.json') })
  const ok = ({ itemId }) => ({
    json: itemId === CQ ? fixture('mtop_detail_1081432722707_huyanbin_chongqing.json') : { ret: ['SUCCESS::调用成功'], data: { item: {} } },
  })
  const failures = [
    { json: { ret: ['FAIL_SYS_SERVICE_TIMEOUT::超时'] } },
    { json: { ret: ['FAIL_BIZ_ITEM_NOT_FOUND::项目不存在'] } },
    { status: 502, text: '<html><body>502 Bad Gateway</body></html>' },
  ]
  for (const failure of failures) {
    const kv = memoryKv()
    const ctx1 = makeCtx(mtopServer({ 'mtop.damai.wireless.search.search': search, 'mtop.damai.item.detail.getdetail': () => failure }), { now, kv })
    const r1 = byId(await damai.fetchArtist(hu, ctx1))
    assert.equal(detailCalls(ctx1).length, 3)
    assert.equal(r1[CQ].status, 'presale')
    assert.equal(r1[CQ].hasSold, false)

    // 第二轮列表和第一轮一模一样，照样补取详情：重庆退票规则从 9-25 起算，早就开过票
    const ctx2 = makeCtx(mtopServer({ 'mtop.damai.wireless.search.search': search, 'mtop.damai.item.detail.getdetail': ok }), { now, kv, previous: r1 })
    const r2 = byId(await damai.fetchArtist(hu, ctx2))
    assert.deepEqual(detailCalls(ctx2).sort(), Object.keys(r1).sort(), JSON.stringify(failure))
    assert.equal(r2[CQ].hasSold, true)
    assert.ok(r2[CQ].saleTimes.includes(at(9, 25, 11, 0)))

    // 第三轮：都取到了，不再取
    const ctx3 = makeCtx(mtopServer({ 'mtop.damai.wireless.search.search': search, 'mtop.damai.item.detail.getdetail': ok }), { now, kv, previous: r2 })
    const r3 = byId(await damai.fetchArtist(hu, ctx3))
    assert.deepEqual(detailCalls(ctx3), [])
    assert.deepEqual(r3, r2)
  }
})

test('网关 5xx 网页算一时出错：详情遇到只退回列表的字段，搜索遇到抛 NetworkError', async () => {
  const gateway = { status: 502, text: '<html><body>502 Bad Gateway</body></html>' }
  const ctx = makeCtx(
    mtopServer({
      'mtop.damai.wireless.search.search': () => ({ json: fixture(SEARCH_XUE) }),
      'mtop.damai.item.detail.getdetail': () => gateway,
    }),
  )
  const listings = await damai.fetchArtist(XUE, ctx)
  assert.deepEqual(listings, damai.listingsFromSearch(fixture(SEARCH_XUE), XUE, NOW))
  assert.equal(ctx.logs.filter((m) => /HTTP 502/.test(m)).length, 2)

  for (const status of [500, 503, 504]) {
    const busy = makeCtx(mtopServer({ 'mtop.damai.wireless.search.search': () => ({ status, text: '<html>busy</html>' }) }))
    await assert.rejects(damai.fetchArtist(XUE, busy), (err) => err instanceof NetworkError && err.reason === `HTTP ${status}`)
    const r = await damai.check(makeCtx(mtopServer({ 'mtop.damai.wireless.search.search': () => ({ status, text: '' }) })))
    assert.equal(r.ok, false)
    assert.ok(r.error instanceof NetworkError)
  }
})

test('跳转：去 punish、captcha 是被拦，去别处是接口变了；详情遇到也一样停掉', async () => {
  const redirect = (location) => () => ({ status: 302, headers: { location }, text: '' })
  const punish = redirect('https://mtop.damai.cn/_____tmd_____/punish?x5secdata=xx&x5step=1')
  const captcha = redirect('https://h5api.m.taobao.com/h5/captcha/index.html?smPolicy=x')
  for (const route of [punish, captcha]) {
    const ctx = makeCtx(mtopServer({ 'mtop.damai.wireless.search.search': route }))
    await assert.rejects(damai.fetchArtist(XUE, ctx), BlockedError)
  }
  const moved = makeCtx(mtopServer({ 'mtop.damai.wireless.search.search': redirect('https://m.damai.cn/') }))
  await assert.rejects(damai.resolveArtist(XUE, moved), (err) => err instanceof ApiChangedError && /302/.test(err.reason))

  const detail = makeCtx(
    mtopServer({
      'mtop.damai.wireless.search.search': () => ({ json: fixture(SEARCH_XUE) }),
      'mtop.damai.item.detail.getdetail': punish,
    }),
  )
  await assert.rejects(damai.fetchArtist(XUE, detail), BlockedError)
})

test('列表撤掉了将来的开售时间：再取一次详情；详情也取不到时不沿用撤掉的时间', async () => {
  const XM = '1083650546473'
  const search1 = fixture('live-search-薛之谦-2026-10-27.json')
  const now1 = search1.data.currentTime
  // 下一轮（6 小时后）平台撤掉了厦门 10-28 10:00 那一轮，状态还是缺货
  const search2 = clone(search1)
  const p = search2.data.projectInfo.find((x) => String(x.id) === XM)
  p.siteStatus = 3
  p.upTime = now1 - 3_600_000
  const now2 = now1 + 6 * 3_600_000
  const detailOk = ({ itemId }) => ({
    json: fixture(itemId === XM ? 'live-detail-1083650546473-薛之谦厦门-2026-10-27.json' : 'mtop_detail_1089011559335_xuezhiqian_wuxi.json'),
  })

  const kv = memoryKv()
  const ctx1 = makeCtx(mtopServer({ 'mtop.damai.wireless.search.search': () => ({ json: search1 }), 'mtop.damai.item.detail.getdetail': detailOk }), {
    now: now1,
    kv,
  })
  const r1 = byId(await damai.fetchArtist(XUE, ctx1))
  assert.ok(r1[XM].saleTimes.includes(at(10, 28, 10, 0)))
  const fork = () => {
    const copy = memoryKv()
    for (const [k, v] of kv.map) copy.map.set(k, v)
    return copy
  }

  // 详情取到了：只按列表和详情，10-28 10:00 不再出现；无锡没变，不取
  const ctx2 = makeCtx(mtopServer({ 'mtop.damai.wireless.search.search': () => ({ json: search2 }), 'mtop.damai.item.detail.getdetail': detailOk }), {
    now: now2,
    kv: fork(),
    previous: r1,
  })
  const r2 = byId(await damai.fetchArtist(XUE, ctx2))
  assert.deepEqual(detailCalls(ctx2), [XM])
  assert.ok(!r2[XM].saleTimes.some((t) => t > now2))
  assert.equal(r2[XM].roundHint, 3)
  assert.equal(r2[XM].roundHintAt, at(10, 26, 10, 0))
  assert.equal(r2[XM].hasSold, true)

  // 详情也取不到：照样去掉撤掉的时间，下一轮再取
  const failKv = fork()
  const ctx3 = makeCtx(
    mtopServer({
      'mtop.damai.wireless.search.search': () => ({ json: search2 }),
      'mtop.damai.item.detail.getdetail': () => ({ json: { ret: ['FAIL_SYS_SERVICE_TIMEOUT::超时'] } }),
    }),
    { now: now2, kv: failKv, previous: r1 },
  )
  const r3 = byId(await damai.fetchArtist(XUE, ctx3))
  assert.deepEqual(detailCalls(ctx3), [XM])
  assert.ok(!r3[XM].saleTimes.some((t) => t > now2))
  assert.equal(r3[XM].roundHint, 3)
  assert.equal(r3[XM].roundHintAt, at(10, 26, 10, 0))
  const ctx4 = makeCtx(mtopServer({ 'mtop.damai.wireless.search.search': () => ({ json: search2 }), 'mtop.damai.item.detail.getdetail': detailOk }), {
    now: now2,
    kv: failKv,
    previous: r3,
  })
  await damai.fetchArtist(XUE, ctx4)
  assert.deepEqual(detailCalls(ctx4), [XM])
})

test('备忘按艺人分开存，只留这一轮列表上的项目；读到坏的备忘当作没有', async () => {
  const kv = memoryKv()
  kv.set('damai.items.薛之谦', '{坏了')
  const routes = {
    'mtop.damai.wireless.search.search': () => ({ json: fixture(SEARCH_XUE) }),
    'mtop.damai.item.detail.getdetail': () => ({ json: { ret: ['FAIL_SYS_SERVICE_TIMEOUT::超时'] } }),
  }
  await damai.fetchArtist(XUE, makeCtx(mtopServer(routes), { kv }))
  assert.deepEqual(JSON.parse(kv.get('damai.items.薛之谦')), {
    1089011559335: { list: [at(10, 27, 17, 17)], retry: true },
    1083650546473: { list: [at(10, 28, 10, 0)], retry: true },
  })
  // 没有 kv 也能跑
  const bare = makeCtx(mtopServer(routes))
  delete bare.kv
  assert.equal((await damai.fetchArtist(XUE, bare)).length, 2)
})

test('resolveArtist：主名找不到再用别名；同一轮里 fetchArtist 不再重复搜第一页', async () => {
  const searched = []
  const ctx = makeCtx(
    mtopServer({
      'mtop.damai.wireless.search.search': (data) => {
        searched.push(data.keyword)
        return { json: fixture(data.keyword === '回春丹乐队' ? 'mtop_search_huichundan_p1.json' : 'mtop_search_wuyuetian_p1.json') }
      },
      'mtop.damai.item.detail.getdetail': () => ({ json: fixture('mtop_detail_1085731682222_banma_festival_fuyang.json') }),
    }),
  )
  const artist = { key: '回春丹乐队', aliases: ['回春丹'], ids: {} }
  assert.deepEqual(await damai.resolveArtist(artist, ctx), { id: '12026694', name: '回春丹乐队' })
  assert.deepEqual(searched, ['回春丹乐队'])

  await damai.fetchArtist({ ...artist, ids: { damai: '12026694' } }, ctx)
  assert.deepEqual(searched, ['回春丹乐队'])

  const ctx2 = makeCtx(
    mtopServer({
      'mtop.damai.wireless.search.search': (data) => {
        searched.push(data.keyword)
        return { json: fixture(data.keyword === '回春丹乐队' ? 'mtop_search_huichundan_p1.json' : 'mtop_search_wuyuetian_p1.json') }
      },
    }),
  )
  searched.length = 0
  assert.deepEqual(await damai.resolveArtist({ key: '回春丹', aliases: ['回春丹', '回春丹乐队'] }, ctx2), { id: '12026694', name: '回春丹乐队' })
  assert.deepEqual(searched, ['回春丹', '回春丹乐队'])

  searched.length = 0
  assert.equal(await damai.resolveArtist({ key: '不存在的人', aliases: [] }, ctx2), null)
})

test('只请求 mtop.damai.cn 的搜索和详情，不碰票档接口和 PC 搜索', async () => {
  const ctx = makeCtx(
    mtopServer({
      'mtop.damai.wireless.search.search': () => ({ json: fixture('v_damai_search_lironghao.json') }),
      'mtop.damai.item.detail.getdetail': () => ({ json: fixture('v_damai_detail_1077678186644_lironghao_zhenjiang.json') }),
    }),
  )
  await damai.resolveArtist({ key: '李荣浩' }, ctx)
  await damai.fetchArtist({ key: '李荣浩', ids: { damai: '71654' } }, ctx)
  for (const call of ctx.client.calls) {
    const url = new URL(call.url)
    assert.equal(url.host, 'mtop.damai.cn')
    assert.ok(['mtop.damai.wireless.search.search', 'mtop.damai.item.detail.getdetail'].includes(url.searchParams.get('api')))
    assert.doesNotMatch(call.url, /subpage/)
  }
})
