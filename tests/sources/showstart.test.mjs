import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fakeClient } from '../helpers/fake-http.mjs'
import { ApiChangedError, BlockedError } from '../../src/errors.mjs'
import { validateListing } from '../../src/listing.mjs'
import { openStore } from '../../src/store.mjs'
import { fromBeijing } from '../../src/time.mjs'
import * as showstart from '../../src/sources/showstart.mjs'

const fixture = (file) => JSON.parse(readFileSync(new URL(`../../fixtures/showstart/${file}`, import.meta.url), 'utf8'))

// 2026-10-26 10:00 北京时间
const NOW = fromBeijing(2026, 10, 26, 10, 0)
const SOFIA = { key: '苏菲花园', aliases: [], ids: { showstart: '36536' } }

const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex')
const pathOf = (url) => new URL(url).pathname

function makeCtx(client, { now = NOW, previous = {}, kv = new Map() } = {}) {
  let clock = now
  const logs = []
  return {
    client,
    now: () => clock,
    setNow: (ms) => (clock = ms),
    log: (msg) => logs.push(msg),
    logs,
    kv: { get: (k) => kv.get(k), set: (k, v) => kv.set(k, v) },
    kvMap: kv,
    previous: (id) => previous[id] ?? null,
  }
}

/**
 * 按路径回 fixtures 的假秀动。routes 的值是秀动的 JSON（带 state），或 (body, req) => 它。
 * 要模拟 HTTP 状态或非 JSON 正文时，回 { status, text } 或 { json }。
 */
function fakeShowstart(routes) {
  return fakeClient(
    (req) => {
      const path = pathOf(req.url)
      const route = routes[path]
      if (!route) throw new Error(`没准备这个请求：${path}`)
      const body = req.body ? JSON.parse(req.body) : null
      const res = typeof route === 'function' ? route(body, req) : route
      return 'state' in res ? { json: res } : res
    },
    { site: 'showstart' },
  )
}

const TOKEN = fixture('01_waf_gettoken.json')
const TOKEN_VALUE = TOKEN.result.accessToken.access_token

// ---------- 解析 ----------

test('performer/list：整名相同才认，“五月天怪兽”不算五月天', () => {
  assert.deepEqual(showstart.pickPerformer(fixture('02_performer_list_万能青年旅店.json'), { key: '万能青年旅店', aliases: [] }), {
    id: '2502',
    name: '万能青年旅店',
  })
  assert.equal(showstart.pickPerformer(fixture('02_performer_list_五月天.json'), { key: '五月天', aliases: ['MAYDAY'] }).id, '3626847')
  assert.equal(showstart.pickPerformer(fixture('02_performer_list_五月天.json'), { key: '五月', aliases: [] }), null)
  // 平台录的是“回春丹乐队”，名字末尾的“乐队”不算，只写“回春丹”也认得上
  assert.equal(showstart.pickPerformer(fixture('v05_performer_list_回春丹.json'), { key: '回春丹', aliases: [] }).id, '955622')
  assert.equal(showstart.pickPerformer(fixture('v05_performer_list_回春丹.json'), { key: '回春', aliases: [] }), null)
  assert.equal(showstart.pickPerformer(fixture('v05_performer_list_回春丹.json'), { key: '回春丹', aliases: ['回春丹乐队'] }).id, '955622')
})

test('performer/list：中英文名写在一起的拆开认，繁体靠别名', () => {
  assert.deepEqual(showstart.pickPerformer(fixture('02_performer_list_告五人.json'), { key: '告五人', aliases: [] }), {
    id: '1697207',
    name: '告五人 Accusefive',
  })
  assert.equal(showstart.pickPerformer(fixture('02_performer_list_告五人.json'), { key: 'accusefive', aliases: [] }).id, '1697207')
  const caodong = { key: '草东没有派对', aliases: ['草東沒有派對'] }
  assert.equal(showstart.pickPerformer(fixture('02_performer_list_草東.json'), caodong).id, '59288')
  assert.equal(showstart.pickPerformer(fixture('02_performer_list_草東.json'), { key: '草东没有派对', aliases: [] }), null)
  assert.equal(showstart.pickPerformer(fixture('02_performer_list_草东没有派对.json'), caodong), null)
})

test('performer/list 格式变了抛 ApiChangedError', () => {
  assert.throws(() => showstart.pickPerformer({ state: '1', result: {} }, SOFIA), ApiChangedError)
})

test('按艺人列表 + 详情：苏菲花园 7 场巡演，上海站待开票', () => {
  const listings = showstart.parseActivities(fixture('10_activity_list_performerId_36536.json'), SOFIA, NOW, {
    313949: fixture('09_activity_info_313949.json'),
  })
  assert.equal(listings.length, 7)
  for (const l of listings) {
    validateListing(l)
    assert.equal(l.source, 'showstart')
    assert.equal(l.artistKey, '苏菲花园')
    assert.equal(l.matchedBy, 'id')
    assert.equal(l.isMixed, false)
  }
  const shanghai = listings.find((l) => l.sourceId === '313949')
  assert.equal(shanghai.title, '苏菲花园“同花顺”巡演 上海站')
  assert.equal(shanghai.city, '上海')
  assert.equal(shanghai.venue, '育音堂小镇 B厅 YUYINTOWN BASEMENT')
  assert.equal(shanghai.dateStart, '2026-12-11')
  assert.equal(shanghai.dateEnd, '2026-12-11')
  assert.equal(shanghai.url, 'https://www.showstart.com/event/313949')
  assert.equal(shanghai.status, 'presale')
  assert.deepEqual(shanghai.saleTimes, [fromBeijing(2026, 10, 27, 12, 0)])
  assert.equal(shanghai.hasSold, false)
  // 没取详情的不猜状态
  assert.equal(listings.find((l) => l.sourceId === '313942').status, null)
})

test('音乐节靠阵容关联：isMixed、matchedBy lineup', () => {
  const [festival] = showstart.parseActivities(fixture('10_activity_list_performerId_2502.json'), { key: '万能青年旅店', aliases: [] }, NOW)
  assert.equal(festival.sourceId, '311623')
  assert.equal(festival.isMixed, true)
  assert.equal(festival.matchedBy, 'lineup')
  assert.equal(festival.city, '阜阳')
  assert.equal(festival.dateStart, '2026-11-21')

  const huichundan = { key: '回春丹乐队', aliases: ['回春丹'] }
  const [concert, orange] = showstart.parseActivities(fixture('v06_list_perf_955622.json'), huichundan, NOW, {
    312058: fixture('v08_activity_info_312058.json'),
  })
  assert.equal(concert.matchedBy, 'id')
  assert.equal(concert.isMixed, false)
  assert.equal(concert.city, '石家庄')
  assert.equal(concert.dateStart, '2026-10-31')
  assert.equal(concert.status, 'onsale')
  assert.equal(concert.hasSold, true)
  assert.deepEqual(concert.saleTimes, [fromBeijing(2026, 10, 20, 13, 18)])
  assert.equal(orange.matchedBy, 'lineup')
  assert.equal(orange.isMixed, true)
})

test('标题带“音乐节”的单人专场也算多人同台；名字本身带斜杠的不拆', () => {
  const item = { id: 311029, title: '2026艺尚音乐节·鹿先森户外特别专场', performers: '鹿先森乐队', showTime: '2026/10/31 19:30', cityName: '杭州', siteName: 'x' }
  assert.equal(showstart.toListing(item, { key: '鹿先森乐队', aliases: [] }, NOW).isMixed, true)
  const acdc = { id: 1, title: 'AC/DC 中国巡演', performers: 'AC/DC', showTime: '2026/12/01 20:00', cityName: '上海市', siteName: 'y' }
  const l = showstart.toListing(acdc, { key: 'AC/DC', aliases: [] }, NOW)
  assert.equal(l.isMixed, false)
  assert.equal(l.matchedBy, 'id')
  assert.equal(l.city, '上海')
})

test('票档状态：待开票到点变开售，hasSold 跟着变', () => {
  const info = showstart.parseActivityInfo(fixture('v17_activity_info_313949.json'))
  const before = showstart.summarizeTickets(info, { dateStart: '2026-12-11' }, NOW)
  assert.equal(before.status, 'presale')
  assert.equal(before.hasSold, false)
  const after = showstart.summarizeTickets(info, { dateStart: '2026-12-11' }, fromBeijing(2026, 10, 27, 12, 0))
  assert.equal(after.status, 'onsale')
  assert.equal(after.hasSold, true)
  assert.deepEqual(after.saleTimes, before.saleTimes)
})

test('票档状态：只有占位票档（价格 0）是已上架，开售时间不算', () => {
  const info = showstart.parseActivityInfo(fixture('v17_activity_info_313720.json'))
  const r = showstart.summarizeTickets(info, { dateStart: '2026-11-28' }, NOW)
  assert.deepEqual(r, { status: 'listed', saleTimes: [], hasSold: false })
})

test('票档状态：名字带“待定”的票档即使有价格也排除', () => {
  const info = {
    tickets: [
      { ticketName: '早鸟票（时间待定）', startTime: '2026-11-01 12:00:00', endTime: '2026-12-01 00:00:00', status: 0, sellPriceStr: '99' },
    ],
  }
  assert.equal(showstart.summarizeTickets(info, { dateStart: '2026-12-01' }, NOW).status, 'listed')
})

test('票档状态：真实票档都停售了算 soldout，演出日期过了算 ended', () => {
  const info = showstart.parseActivityInfo(fixture('v08_activity_info_312058.json'))
  // 312058 的票档 10-31 0 点停售，演出是 10-31 晚上
  assert.equal(showstart.summarizeTickets(info, { dateStart: '2026-10-31' }, fromBeijing(2026, 10, 31, 10, 0)).status, 'soldout')
  const ended = showstart.parseActivityInfo(fixture('09_activity_info_308312_ended.json'))
  const r = showstart.summarizeTickets(ended, { dateStart: '2026-10-01' }, NOW)
  assert.equal(r.status, 'ended')
  assert.equal(r.hasSold, true)
  assert.deepEqual(r.saleTimes, [fromBeijing(2026, 9, 16, 15, 28)])
})

test('票档状态：二开，已有票档在卖、新票档开售时间在将来 → presale，hasSold 为真', () => {
  const info = {
    tickets: [
      { ticketName: '预售票', startTime: '2026-10-15 12:00:00', endTime: '2026-11-07 00:00:00', status: 0, sellPriceStr: '189' },
      { ticketName: '加场票', startTime: '2026-10-28 12:00:00', endTime: '2026-11-07 00:00:00', status: 0, sellPriceStr: '219' },
    ],
  }
  const r = showstart.summarizeTickets(info, { dateStart: '2026-11-07' }, NOW)
  assert.equal(r.status, 'presale')
  assert.equal(r.hasSold, true)
  assert.deepEqual(r.saleTimes, [fromBeijing(2026, 10, 15, 12, 0), fromBeijing(2026, 10, 28, 12, 0)])
})

test('标题带“延期”的是 postponed', () => {
  const all = fixture('05_activity_list_all_p1.json')
  const item = all.result.result.find((x) => x.id === 261480)
  const l = showstart.toListing(item, { key: 'djkk', aliases: [] }, NOW, { info: showstart.parseActivityInfo(fixture('v17_activity_info_313949.json')) })
  assert.equal(l.status, 'postponed')
  assert.equal(l.isMixed, true)
})

test('时间按北京时间解析，和本机时区无关', () => {
  // 313949 开售是北京时间 10-27 12:00，即 UTC 04:00
  const [t] = showstart.summarizeTickets(showstart.parseActivityInfo(fixture('09_activity_info_313949.json')), {}, NOW).saleTimes
  assert.equal(t, Date.UTC(2026, 9, 27, 4, 0))
})

test('activity/list、activity/info 格式变了抛 ApiChangedError', () => {
  assert.throws(() => showstart.parseActivityList({ state: '1', result: null }), ApiChangedError)
  assert.throws(() => showstart.parseActivityInfo({ state: '1', result: {} }), ApiChangedError)
  // 只剩标题、没有票档数组，判断不了售票状态
  assert.throws(() => showstart.parseActivityInfo({ state: '1', result: { title: 'x' } }), ApiChangedError)
  assert.throws(() => showstart.parseActivityInfo({ state: '1', result: { title: 'x', tickets: null } }), ApiChangedError)
})

test('10-26 实测样本：回春丹搜“回春丹”得到“回春丹乐队”，演唱会和音乐节都在卖', () => {
  const artist = { key: '回春丹', aliases: ['回春丹乐队'] }
  assert.deepEqual(showstart.pickPerformer(fixture('live-performer-list-回春丹-2026-10-26.json'), artist), { id: '955622', name: '回春丹乐队' })
  const at = fromBeijing(2026, 10, 27, 0, 21)
  const [concert, festival] = showstart.parseActivities(fixture('live-activity-list-performer-955622-p1-2026-10-26.json'), artist, at, {
    312058: fixture('live-activity-info-312058-2026-10-26.json'),
    312580: fixture('live-activity-info-312580-2026-10-26.json'),
  })
  assert.equal(concert.status, 'onsale')
  assert.equal(concert.matchedBy, 'id')
  // 音乐节详情里的阵容只列头牌，没有回春丹，靠音乐人 ID 关联
  assert.equal(festival.status, 'onsale')
  assert.equal(festival.matchedBy, 'lineup')
  assert.deepEqual(festival.saleTimes, [fromBeijing(2026, 10, 22, 13, 18)])
  assert.equal(festival.hasSold, true)
})

// ---------- 请求流程 ----------

test('先取令牌，每个请求带签名和整组请求头（空值的也带）', async () => {
  const client = fakeShowstart({
    '/api/waf/gettoken': TOKEN,
    '/api/web/activity/list': fixture('10_activity_list_performerId_2502.json'),
    '/api/web/activity/info': { state: '1', result: { title: '巅峰·斑马音乐节', tickets: [] } },
  })
  const ctx = makeCtx(client)
  const listings = await showstart.fetchArtist({ key: '万能青年旅店', aliases: [], ids: { showstart: '2502' } }, ctx)
  assert.equal(listings.length, 1)
  assert.deepEqual(
    client.calls.map((c) => [c.method, pathOf(c.url)]),
    [
      ['POST', '/api/waf/gettoken'],
      ['POST', '/api/web/activity/list'],
      ['POST', '/api/web/activity/info'],
    ],
  )

  const [tokenCall, listCall, infoCall] = client.calls
  const deviceNo = tokenCall.headers.cdeviceno
  assert.match(deviceNo, /^[0-9a-z]{32}$/)
  // 取令牌时没有正文，cusat 是占位的 md5
  assert.equal(tokenCall.body, '')
  assert.match(tokenCall.headers.cusat, /^[0-9a-f]{32}$/)

  for (const call of client.calls) {
    const h = call.headers
    const path = pathOf(call.url).replace(/^\/api/, '')
    assert.equal(h.cdeviceno, deviceNo, '一轮内设备号不变')
    assert.equal(h.cookie, `token=${deviceNo}`)
    assert.match(h.crtraceid, /^[0-9A-Za-z]{32}\d{13}$/)
    for (const empty of ['cusid', 'cusit', 'cusut', 'cusname']) assert.equal(h[empty], '', `${empty} 要发空值`)
    assert.equal(h.cterminal, 'web')
    assert.equal(h.csappid, 'web')
    assert.equal(h.cversion, '999')
    assert.ok(h.cdeviceinfo.includes('1920*1080'))
    assert.equal(h.crpsign, md5(h.cusat + 'web' + deviceNo + (call.body ?? '') + path + '999web' + h.crtraceid))
  }
  assert.equal(listCall.headers.cusat, TOKEN_VALUE)
  assert.deepEqual(JSON.parse(listCall.body), { performerId: '2502', pageNo: '1', pageSize: '20' })
  assert.equal(listCall.headers['content-type'], 'application/json;charset=UTF-8')
  assert.deepEqual(JSON.parse(infoCall.body), { activityId: '311623' })
})

test('没有秀动 ID 不发请求，返回空数组', async () => {
  const client = fakeShowstart({})
  assert.deepEqual(await showstart.fetchArtist({ key: '薛之谦', aliases: [], ids: {} }, makeCtx(client)), [])
  assert.equal(client.calls.length, 0)
})

test('翻页：最多 3 页，到 totalPage 就停', async () => {
  const page = (pageNo, totalPage) => ({
    state: '1',
    result: {
      pageNo,
      pageSize: 20,
      totalCount: totalPage * 20,
      totalPage,
      result: Array.from({ length: 20 }, (_, i) => ({
        id: pageNo * 100 + i,
        title: `场次 ${pageNo}-${i}`,
        performers: '苏菲花园',
        showTime: '2026/12/03 20:00',
        cityName: '郑州',
        siteName: '7LIVEHOUSE',
        price: '¥68起',
      })),
    },
  })
  // 上一轮都取过详情、在卖、列表没变，这一轮只翻列表
  const previousFor = (pages) => {
    const prev = {}
    const kv = new Map()
    for (let p = 1; p <= pages; p++) {
      for (const item of page(p, pages).result.result) {
        prev[item.id] = { title: item.title, dateStart: '2026-12-03', status: 'onsale', saleTimes: [1], hasSold: true, roundHint: null }
        kv.set(`showstart:list:苏菲花园:${item.id}`, showstart.listFingerprint(item))
        kv.set(`showstart:detailDay:苏菲花园:${item.id}`, '2026-10-26')
      }
    }
    return { previous: prev, kv }
  }

  for (const [totalPage, expected] of [
    [5, 3],
    [2, 2],
  ]) {
    const client = fakeShowstart({
      '/api/waf/gettoken': TOKEN,
      '/api/web/activity/list': (body) => page(Number(body.pageNo), totalPage),
    })
    const ctx = makeCtx(client, previousFor(totalPage))
    const listings = await showstart.fetchArtist(SOFIA, ctx)
    const listCalls = client.calls.filter((c) => pathOf(c.url) === '/api/web/activity/list')
    assert.equal(listCalls.length, expected)
    assert.deepEqual(
      listCalls.map((c) => JSON.parse(c.body).pageNo),
      Array.from({ length: expected }, (_, i) => String(i + 1)),
    )
    assert.equal(listings.length, expected * 20)
    assert.ok(listings.every((l) => l.status === 'onsale'))
    if (totalPage > 3) assert.ok(ctx.logs.some((m) => m.includes('只取了前 60 场')))
  }
})

test('详情只在需要时取：新场次、列表变了、上一轮等开售', async () => {
  const list = fixture('10_activity_list_performerId_36536.json')
  const items = list.result.result
  const previous = {}
  const kv = new Map()
  for (const item of items) {
    previous[item.id] = {
      title: item.title,
      dateStart: item.showTime.slice(0, 10).replaceAll('/', '-'),
      status: 'onsale',
      saleTimes: [fromBeijing(2026, 10, 20, 12, 0)],
      hasSold: true,
      roundHint: null,
    }
    kv.set(`showstart:list:苏菲花园:${item.id}`, showstart.listFingerprint(item))
    kv.set(`showstart:detailDay:苏菲花园:${item.id}`, '2026-10-26') // 今天取过详情
  }
  delete previous[313942] // 新场次
  previous[313949].status = 'presale' // 上一轮等开售
  kv.set('showstart:list:苏菲花园:313946', '旧指纹') // 价格变了
  previous[313950].title = '旧标题' // 标题变了

  const client = fakeShowstart({
    '/api/waf/gettoken': TOKEN,
    '/api/web/activity/list': list,
    '/api/web/activity/info': () => fixture('09_activity_info_313949.json'),
  })
  const ctx = makeCtx(client, { previous, kv })
  const listings = await showstart.fetchArtist(SOFIA, ctx)
  const fetched = client.calls.filter((c) => pathOf(c.url) === '/api/web/activity/info').map((c) => JSON.parse(c.body).activityId)
  assert.deepEqual(fetched.sort(), ['313942', '313946', '313949', '313950'])

  // 没取详情的沿用上一轮
  const wuhan = listings.find((l) => l.sourceId === '313945')
  assert.equal(wuhan.status, 'onsale')
  assert.deepEqual(wuhan.saleTimes, [fromBeijing(2026, 10, 20, 12, 0)])
  assert.equal(wuhan.hasSold, true)
  // 取了详情的按详情
  assert.equal(listings.find((l) => l.sourceId === '313949').status, 'presale')
  // 列表指纹取完才记
  assert.equal(kv.get('showstart:list:苏菲花园:313946'), showstart.listFingerprint(items.find((x) => x.id === 313946)))
})

test('在卖的场次每天重取一次详情：加了更贵的票档、列表最低价不变也看得到', async () => {
  const list = fixture('10_activity_list_performerId_36536.json')
  const items = list.result.result
  const previous = {}
  const kv = new Map()
  for (const item of items) {
    previous[item.id] = { title: item.title, dateStart: item.showTime.slice(0, 10).replaceAll('/', '-'), status: 'onsale', saleTimes: [], hasSold: true, roundHint: null }
    kv.set(`showstart:list:苏菲花园:${item.id}`, showstart.listFingerprint(item))
    kv.set(`showstart:detailDay:苏菲花园:${item.id}`, '2026-10-25') // 昨天取的
  }
  const routes = { '/api/waf/gettoken': TOKEN, '/api/web/activity/list': list, '/api/web/activity/info': () => fixture('09_activity_info_313949.json') }
  const first = fakeShowstart(routes)
  await showstart.fetchArtist(SOFIA, makeCtx(first, { previous, kv }))
  const infoCalls = (client) => client.calls.filter((c) => pathOf(c.url) === '/api/web/activity/info').length
  assert.equal(infoCalls(first), items.length, '今天第一轮：在卖的都重取')
  assert.equal(kv.get(`showstart:detailDay:苏菲花园:${items[0].id}`), '2026-10-26')
  const second = fakeShowstart(routes)
  await showstart.fetchArtist(SOFIA, makeCtx(second, { previous, kv, now: NOW + 6 * 3600_000 }))
  assert.equal(infoCalls(second), 0, '同一天后面几轮不再取')
})

test('两位关注的艺人同在一场音乐节：列表变了，两人都取详情，都看到二开', async () => {
  // 用真的状态库：kv 共用，previous 按艺人取，和 run.mjs 一样
  const store = openStore(':memory:')
  const item = { id: 400001, title: '某某音乐节', performers: '甲乐队/乙乐队/丙', showTime: '2026/12/20 13:00', cityName: '上海', siteName: '草坪' }
  const list = (price) => ({ state: '1', result: { pageNo: 1, pageSize: 20, totalCount: 1, totalPage: 1, result: [{ ...item, price }] } })
  const early = { ticketName: '早鸟', startTime: '2026-10-20 12:00:00', endTime: '2026-12-20 00:00:00', status: 0, sellPriceStr: '199' }
  const second = { ticketName: '二开票', startTime: '2026-11-01 12:00:00', endTime: '2026-12-20 00:00:00', status: 0, sellPriceStr: '99' }
  const artists = [
    { key: '甲乐队', aliases: [], ids: { showstart: '1' } },
    { key: '乙乐队', aliases: [], ids: { showstart: '2' } },
  ]
  const round = async (at, price, tickets) => {
    const client = fakeShowstart({
      '/api/waf/gettoken': TOKEN,
      '/api/web/activity/list': list(price),
      '/api/web/activity/info': { state: '1', result: { title: '某某音乐节', tickets } },
    })
    const out = []
    for (const artist of artists) {
      const ctx = { client, now: () => at, log: () => {}, kv: store.kv, previous: (id) => store.getListing('showstart', String(id), artist.key) }
      const [l] = await showstart.fetchArtist(artist, ctx)
      store.upsertListing(l, at)
      out.push(l)
    }
    return { out, infoCalls: client.calls.filter((c) => pathOf(c.url) === '/api/web/activity/info').length }
  }

  const first = await round(NOW, '¥199起', [early])
  assert.deepEqual(first.out.map((l) => l.status), ['onsale', 'onsale'])
  const later = await round(NOW + 6 * 3600_000, '¥99起', [early, second])
  assert.equal(later.infoCalls, 2)
  for (const l of later.out) {
    assert.equal(l.status, 'presale', l.artistKey)
    assert.deepEqual(l.saleTimes, [fromBeijing(2026, 10, 20, 12, 0), fromBeijing(2026, 11, 1, 12, 0)])
  }
  assert.ok(store.kv.get('showstart:list:甲乐队:400001'))
  assert.ok(store.kv.get('showstart:list:乙乐队:400001'))
})

test('详情回“活动不存在”（state 100）：沿用上一轮，列表指纹不记，下一轮再取', async () => {
  const list = fixture('10_activity_list_performerId_2502.json')
  const client = fakeShowstart({
    '/api/waf/gettoken': TOKEN,
    '/api/web/activity/list': list,
    '/api/web/activity/info': { status: 200, state: '100', msg: '活动不存在' },
  })
  const ctx = makeCtx(client)
  const [l] = await showstart.fetchArtist({ key: '万能青年旅店', aliases: [], ids: { showstart: '2502' } }, ctx)
  assert.equal(l.status, null)
  assert.equal(ctx.kvMap.has('showstart:list:万能青年旅店:311623'), false)
  assert.ok(ctx.logs.some((m) => m.includes('311623') && m.includes('活动不存在')))
})

test('详情回别的认不出的 state：抛 ApiChangedError，不吞', async () => {
  for (const res of [
    { state: 'sys404', success: false, msg: '' },
    { status: 200, state: '200', msg: '参数错误' },
  ]) {
    const client = fakeShowstart({
      '/api/waf/gettoken': TOKEN,
      '/api/web/activity/list': fixture('10_activity_list_performerId_2502.json'),
      '/api/web/activity/info': res,
    })
    await assert.rejects(showstart.fetchArtist({ key: '万能青年旅店', aliases: [], ids: { showstart: '2502' } }, makeCtx(client)), ApiChangedError)
  }
  // state 100 带着限流提示，照样当被拦
  const client = fakeShowstart({
    '/api/waf/gettoken': TOKEN,
    '/api/web/activity/list': fixture('10_activity_list_performerId_2502.json'),
    '/api/web/activity/info': { state: '100', msg: '操作太频繁，请稍后再试' },
  })
  await assert.rejects(showstart.fetchArtist({ key: '万能青年旅店', aliases: [], ids: { showstart: '2502' } }, makeCtx(client)), BlockedError)
})

test('一轮里详情连着两场都“活动不存在”、一场也没取到：当详情接口变了，不再往下取', async () => {
  const client = fakeShowstart({
    '/api/waf/gettoken': TOKEN,
    '/api/web/activity/list': fixture('10_activity_list_performerId_36536.json'),
    '/api/web/activity/info': { status: 200, state: '100', msg: '活动不存在' },
  })
  const ctx = makeCtx(client)
  await assert.rejects(showstart.fetchArtist(SOFIA, ctx), (err) => err instanceof ApiChangedError && err.message.includes('activity/info'))
  assert.equal(client.calls.filter((c) => pathOf(c.url) === '/api/web/activity/info').length, 2)
  assert.equal(ctx.kvMap.size, 0)

  // 分在两位艺人身上也算：一轮一个客户端
  const one = (id) => ({ state: '1', result: { pageNo: 1, pageSize: 20, totalCount: 1, totalPage: 1, result: [{ id, title: `专场 ${id}`, performers: 'x', showTime: '2026/12/20 20:00', cityName: '上海', siteName: 'y', price: '¥99起' }] } })
  const shared = fakeShowstart({
    '/api/waf/gettoken': TOKEN,
    '/api/web/activity/list': (body) => one(Number(body.performerId)),
    '/api/web/activity/info': { status: 200, state: '100', msg: '活动不存在' },
  })
  const [l] = await showstart.fetchArtist({ key: 'x', aliases: [], ids: { showstart: '11' } }, makeCtx(shared))
  assert.equal(l.status, null)
  await assert.rejects(showstart.fetchArtist({ key: 'x', aliases: [], ids: { showstart: '12' } }, makeCtx(shared)), ApiChangedError)
})

test('一轮里取到过详情，后面个别场次“活动不存在”不算接口变了', async () => {
  const items = fixture('10_activity_list_performerId_36536.json').result.result
  const firstId = String(items[0].id)
  const client = fakeShowstart({
    '/api/waf/gettoken': TOKEN,
    '/api/web/activity/list': fixture('10_activity_list_performerId_36536.json'),
    '/api/web/activity/info': (body) => (body.activityId === firstId ? fixture('09_activity_info_313949.json') : { status: 200, state: '100', msg: '活动不存在' }),
  })
  const listings = await showstart.fetchArtist(SOFIA, makeCtx(client))
  assert.equal(listings.length, items.length)
  assert.equal(listings.filter((l) => l.status == null).length, items.length - 1)
})

test('令牌失效类的 state：重取一次令牌再发', async () => {
  let listCount = 0
  const client = fakeShowstart({
    '/api/waf/gettoken': TOKEN,
    '/api/web/activity/list': () => (++listCount === 1 ? { state: 'token-expire-at', success: false } : fixture('10_activity_list_performerId_2502.json')),
    '/api/web/activity/info': fixture('09_activity_info_313949.json'),
  })
  const listings = await showstart.fetchArtist({ key: '万能青年旅店', aliases: [], ids: { showstart: '2502' } }, makeCtx(client))
  assert.equal(listings.length, 1)
  assert.deepEqual(
    client.calls.map((c) => pathOf(c.url)),
    ['/api/waf/gettoken', '/api/web/activity/list', '/api/waf/gettoken', '/api/web/activity/list', '/api/web/activity/info'],
  )
})

test('重取令牌后还是失效，抛 ApiChangedError', async () => {
  const client = fakeShowstart({
    '/api/waf/gettoken': TOKEN,
    '/api/web/activity/list': { state: 'USER_NOT_LOGIN_DEFAULT', success: false },
  })
  await assert.rejects(showstart.fetchArtist(SOFIA, makeCtx(client)), ApiChangedError)
  assert.equal(client.calls.length, 4)
})

test('令牌 30 分钟内沿用，过了重取', async () => {
  const client = fakeShowstart({
    '/api/waf/gettoken': TOKEN,
    '/api/web/performer/list': fixture('02_performer_list_万能青年旅店.json'),
  })
  const ctx = makeCtx(client)
  const wanqing = { key: '万能青年旅店', aliases: [] }
  await showstart.resolveArtist(wanqing, ctx)
  ctx.setNow(NOW + 29 * 60_000)
  await showstart.resolveArtist(wanqing, ctx)
  assert.equal(client.calls.filter((c) => pathOf(c.url) === '/api/waf/gettoken').length, 1)
  ctx.setNow(NOW + 31 * 60_000)
  await showstart.resolveArtist(wanqing, ctx)
  assert.equal(client.calls.filter((c) => pathOf(c.url) === '/api/waf/gettoken').length, 2)
})

test('签名错（sys002）、请求头不全（sys001）都抛 ApiChangedError', async () => {
  const badSign = fakeShowstart({ '/api/waf/gettoken': TOKEN, '/api/web/activity/list': fixture('13_badsign_activity_list.json') })
  await assert.rejects(showstart.fetchArtist(SOFIA, makeCtx(badSign)), (err) => err instanceof ApiChangedError && err.message.includes('sys002'))
  const missing = fakeShowstart({ '/api/waf/gettoken': fixture('v01_token_noempty.json') })
  await assert.rejects(showstart.fetchArtist(SOFIA, makeCtx(missing)), (err) => err instanceof ApiChangedError && err.message.includes('sys001'))
})

test('详情回 sys002 也照样抛，不吞', async () => {
  const client = fakeShowstart({
    '/api/waf/gettoken': TOKEN,
    '/api/web/activity/list': fixture('10_activity_list_performerId_2502.json'),
    '/api/web/activity/info': fixture('v04_badsign.json'),
  })
  await assert.rejects(showstart.fetchArtist({ key: '万能青年旅店', aliases: [], ids: { showstart: '2502' } }, makeCtx(client)), ApiChangedError)
})

test('被拦：HTTP 469、验证页、限流提示都抛 BlockedError', async () => {
  const cases = [
    { status: 469, text: '' },
    { status: 200, text: '<html><script src="https://turing.captcha.qcloud.com/TCaptcha.js"></script></html>' },
    { json: { state: 'sys009', success: false, msg: '操作太频繁，请稍后再试' } },
  ]
  for (const res of cases) {
    const client = fakeShowstart({ '/api/waf/gettoken': TOKEN, '/api/web/activity/list': () => res })
    await assert.rejects(showstart.fetchArtist(SOFIA, makeCtx(client)), BlockedError)
  }
})

test('返回的不是 JSON、也不像验证页：ApiChangedError', async () => {
  const client = fakeShowstart({ '/api/waf/gettoken': () => ({ status: 404, text: '<html>404 Not Found openresty</html>' }) })
  await assert.rejects(showstart.fetchArtist(SOFIA, makeCtx(client)), ApiChangedError)
})

test('找艺人：主名搜不到再试别名，名字相同的写法只搜一次', async () => {
  const client = fakeShowstart({
    '/api/waf/gettoken': TOKEN,
    '/api/web/performer/list': (body) =>
      body.searchKeyword === '草東沒有派對' ? fixture('02_performer_list_草東.json') : fixture('02_performer_list_草东没有派对.json'),
  })
  const artist = { key: '草东没有派对', aliases: ['草东 没有派对', '草東沒有派對'], ids: {} }
  assert.deepEqual(await showstart.resolveArtist(artist, makeCtx(client)), { id: '59288', name: '草東沒有派對' })
  const keywords = client.calls.filter((c) => pathOf(c.url) === '/api/web/performer/list').map((c) => JSON.parse(c.body))
  assert.deepEqual(keywords, [
    { searchKeyword: '草东没有派对', pageNo: '1', pageSize: '20' },
    { searchKeyword: '草東沒有派對', pageNo: '1', pageSize: '20' },
  ])
})

test('找艺人：都搜不到返回 null', async () => {
  const client = fakeShowstart({ '/api/waf/gettoken': TOKEN, '/api/web/performer/list': fixture('02_performer_list_草东没有派对.json') })
  assert.equal(await showstart.resolveArtist({ key: '草东没有派对', aliases: [], ids: {} }, makeCtx(client)), null)
})

test('check：取一次令牌，再列一次万青', async () => {
  const client = fakeShowstart({ '/api/waf/gettoken': TOKEN, '/api/web/activity/list': fixture('10_activity_list_performerId_2502.json') })
  const r = await showstart.check(makeCtx(client))
  assert.equal(r.ok, true)
  assert.match(r.detail, /1 场/)
  assert.deepEqual(
    client.calls.map((c) => pathOf(c.url)),
    ['/api/waf/gettoken', '/api/web/activity/list'],
  )
  assert.equal(JSON.parse(client.calls[1].body).performerId, '2502')

  const blocked = fakeShowstart({ '/api/waf/gettoken': () => ({ status: 403, text: '' }) })
  const b = await showstart.check(makeCtx(blocked))
  assert.equal(b.ok, false)
  assert.ok(b.error instanceof BlockedError)
})

test('导出的接口齐全', () => {
  assert.equal(showstart.name, 'showstart')
  assert.equal(showstart.label, '秀动')
  assert.equal(showstart.needsArtistId, true)
  assert.equal(showstart.everyRun, true)
  assert.equal(showstart.clientOptions.site, 'showstart')
  for (const fn of ['resolveArtist', 'fetchArtist', 'check']) assert.equal(typeof showstart[fn], 'function')
  // 签名函数和前端一致：accessToken + cusut + idToken + userId + 'web' + 设备号 + 正文 + 路径 + '999web' + traceId
  assert.equal(
    showstart.signRequest({ accessToken: 'a', idToken: '', deviceNo: 'd', bodyText: '{}', path: '/web/x', traceId: 't' }),
    md5('aweb' + 'd' + '{}' + '/web/x' + '999webt'),
  )
})
