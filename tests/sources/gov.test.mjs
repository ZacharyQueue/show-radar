import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as gov from '../../src/sources/gov.mjs'
import { decrypt, encrypt } from '../../src/sources/zwfw-sm4.mjs'
import { ApiChangedError, BlockedError, NetworkError } from '../../src/errors.mjs'
import { validateListing } from '../../src/listing.mjs'
import { fakeClient } from '../helpers/fake-http.mjs'

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/gov-national')
const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8')
const readJson = (name) => JSON.parse(read(name))

const KEY_RESPONSE = readJson('zwfw_portal_getsm4key.json')
const KEY = KEY_RESPONSE.data[0].smKey
const PAGE_JS_DETAILS = readJson('zwfw_swychdDetail_decrypted_via_page_js_2026-10-26.json')
// fakeClient 默认的时间：北京时间 2026-10-26 10:00
const NOW = Date.UTC(2026, 9, 26, 2, 0)
const TODAY = '2026-10-26'

const KEY_URL = 'https://zwfw.mct.gov.cn/portal/getsm4key'
const LIST_URL = 'https://zwfw.mct.gov.cn/portal/swychd'
const DETAIL_URL = 'https://zwfw.mct.gov.cn/portal/swychdDetail'

const ZHOU = { key: '周杰伦', aliases: ['Jay Chou'], ids: {} }

// —— 解析 ——

test('列表页：真实样本解析出 id、标题、开始日期和页数', () => {
  const page = gov.parseSearchPage(readJson('s_周杰伦.dec.json'))
  assert.equal(page.total, 23)
  assert.equal(page.totalPage, 2)
  assert.equal(page.items.length, 15)
  assert.deepEqual(page.items[3], {
    id: '72c1b9af256a45428c69e3607368cf87',
    title: '时光机广州嘉年华2026周杰伦世界巡回演唱会',
    dateStart: '2026-12-04',
  })
})

test('列表页：查不到时是空列表', () => {
  const page = gov.parseSearchPage(readJson('s_陳奕迅.dec.json'))
  assert.deepEqual(page, { total: 0, totalPage: 0, items: [] })
})

test('列表页：格式不对抛 ApiChangedError', () => {
  assert.throws(() => gov.parseSearchPage({ rows: [] }), ApiChangedError)
  assert.throws(() => gov.parseSearchPage(null), ApiChangedError)
})

test('过滤：标题里要有艺人的名字，致敬场去掉', () => {
  const items = [
    { id: 'a', title: 'G.E.M.邓紫棋I AM GLORIA(我是歌莉雅)巡回演唱会-深圳站' },
    { id: 'b', title: '致敬邓紫棋金曲演唱会' },
    { id: 'c', title: '“月亮代表我的心”经典作品交响演唱会' },
    { id: 'd', title: 'GLORIA 巡回演唱会' },
    { id: 'e', title: '關於 GEM 巡迴演唱會' },
  ]
  const kept = gov.filterSearchItems(items, { key: '邓紫棋', aliases: ['G.E.M.'] })
  assert.deepEqual(
    kept.map((i) => i.id),
    ['a', 'e'],
  )
})

test('过滤：带“纪念”“经典”的正式演出不当致敬场', () => {
  // 真实样本：上海交响乐团自己的闭幕音乐会，标题里有“纪念贝多芬”
  const page = gov.parseSearchPage(readJson('list_all_nocookie_q.dec.json'))
  const titled = page.items.filter((i) => i.title.includes('上海交响乐团'))
  assert.equal(titled.length, 6)
  const kept = gov.filterSearchItems(page.items, { key: '上海交响乐团', aliases: [] })
  assert.deepEqual(
    kept.map((i) => i.id),
    titled.map((i) => i.id),
  )
  assert.ok(kept.some((i) => i.title.includes('纪念贝多芬')))

  const items = [
    { id: 'own-classic', title: '张学友“学友·经典”世界巡回演唱会-北京站' },
    { id: 'own-anniv', title: '五月天25周年纪念演唱会-上海站' },
    { id: 'works', title: '久石让·经典作品音乐会' },
    { id: 'hits', title: '张学友金曲演唱会（非原唱）' },
    { id: 'hits2', title: '五月天经典金曲交响音乐会' },
  ]
  const keep = (artist) => gov.filterSearchItems(items, artist).map((i) => i.id)
  assert.deepEqual(keep({ key: '张学友', aliases: [] }), ['own-classic'])
  assert.deepEqual(keep({ key: '五月天', aliases: ['MAYDAY'] }), ['own-anniv'])
  assert.deepEqual(keep({ key: '久石让', aliases: [] }), [])
})

test('过滤：告五人用成员本名报批的那条，别名里有本名才认', () => {
  const items = gov.parseSearchPage({
    pagination: { total: 1, totalPage: 1 },
    list: [{ id: 'x', performanceName: PAGE_JS_DETAILS.panyunan_guangzhou_gaowuren.performanceName, performingBeginTime: '2025-09-12' }],
  }).items
  assert.equal(gov.filterSearchItems(items, { key: '告五人', aliases: [] }).length, 1)
  assert.equal(gov.filterSearchItems(items, { key: '潘云安', aliases: [] }).length, 1)
  assert.equal(gov.filterSearchItems(items, { key: '草东没有派对', aliases: [] }).length, 0)
})

test('详情：周杰伦广州站翻译成统一记录', () => {
  const listing = gov.parseDetail(readJson('d_72c1b9af256a45428c69e3607368cf87.dec.json'), ZHOU)
  assert.deepEqual(listing, {
    source: 'gov',
    sourceId: '72c1b9af256a45428c69e3607368cf87',
    artistKey: '周杰伦',
    kind: 'approval',
    title: '时光机广州嘉年华2026周杰伦世界巡回演唱会',
    city: '广州',
    venue: '广州天河体育中心',
    dateStart: '2026-12-04',
    dateEnd: '2026-12-06',
    matchedBy: 'title',
    isMixed: false,
    status: null,
    saleTimes: [],
    hasSold: false,
    roundHint: null,
    roundHintAt: null,
    approval: { date: '2026-07-14', number: '440100522026001088', approver: '广州市文化广电旅游局', isChange: false },
    url: 'https://zwfw.mct.gov.cn/wycx/qgswyyxychd/qgswyyxychdjg/xq/?id=72c1b9af256a45428c69e3607368cf87',
  })
})

test('详情：报批单位、报批地、区县都不进统一记录', () => {
  const samples = [
    readJson('d_72c1b9af256a45428c69e3607368cf87.dec.json'),
    readJson('d_81a217d6ab2ad3b43ccb791e5f4542d6.dec.json'),
    ...Object.values(PAGE_JS_DETAILS).filter((v) => v && typeof v === 'object' && v.id),
  ]
  assert.equal(samples.length, 9)
  for (const detail of samples) {
    const listing = gov.parseDetail(detail, ZHOU)
    validateListing(listing)
    const text = JSON.stringify(listing)
    assert.ok(!text.includes(detail.approvalUnit), detail.approvalUnit)
    assert.ok(!text.includes('cdTime') && !text.includes('approvalPlace'))
    assert.ok(!text.includes(String(detail.cdTime)))
  }
})

test('详情：城市在直辖市写“市辖区”时取第一级，上海写“上海市”也归一', () => {
  const caomei = gov.parseDetail(PAGE_JS_DETAILS.caomei_chongqing, { key: '草莓音乐节', aliases: [] })
  assert.equal(caomei.city, '重庆')
  assert.equal(caomei.isMixed, true)
  assert.deepEqual(caomei.approval, { date: '2026-10-21', number: '500000522026000369', approver: '重庆市文化和旅游发展委员会', isChange: false })

  const mayday = gov.parseDetail(PAGE_JS_DETAILS.wuyuetian_shanghai, { key: '五月天', aliases: [] })
  assert.equal(mayday.city, '上海')
  assert.equal(mayday.venue, '上海东亚体育文化中心有限公司（上海体育场）')
  assert.equal(mayday.approval.number, '沪文旅许[2024]6118号')

  const lrh = gov.parseDetail(readJson('d_81a217d6ab2ad3b43ccb791e5f4542d6.dec.json'), { key: '李荣浩', aliases: [] })
  assert.equal(lrh.city, '成都')
  assert.equal(lrh.dateStart, '2026-09-05')
  assert.equal(lrh.dateEnd, '2026-09-06')
})

test('详情：省直辖的县级市取第三级，香港去掉“特别行政区”', () => {
  const base = { ...PAGE_JS_DETAILS.xuezhiqian_wuxi }
  const jiyuan = gov.parseDetail({ ...base, performancePlace1: '河南省', performancePlace2: '省直辖县级行政区划', performancePlace3: '济源市' }, ZHOU)
  assert.equal(jiyuan.city, '济源')
  const hk = gov.parseDetail({ ...base, performancePlace1: '香港特别行政区', performancePlace2: '', performancePlace3: '' }, ZHOU)
  assert.equal(hk.city, '香港')
})

test('详情：变更、增加演员、延期、取消算变更记录', () => {
  const base = PAGE_JS_DETAILS.xuezhiqian_wuxi
  const titles = {
    '薛之谦“万兽之王”演唱会-北京站（“增加演员”）': true,
    '关于“告五人 [宇宙超有趣] 2024 SUPER LIVE TOUR（超级现场） 新世界上海演唱会”变更演出场次的申请': true,
    '某某巡回演唱会-南京站（延期）': true,
    '某某巡回演唱会-南京站取消部分场次': true,
    '薛之谦“万兽之王”巡回演唱会-无锡站': false,
  }
  for (const [title, isChange] of Object.entries(titles)) {
    assert.equal(gov.parseDetail({ ...base, performanceName: title }, ZHOU).approval.isChange, isChange, title)
  }
})

test('详情：已删除的返回 null，不是对象抛 ApiChangedError', () => {
  assert.equal(gov.parseDetail({ ...PAGE_JS_DETAILS.xuezhiqian_wuxi, delFlag: '1' }, ZHOU), null)
  assert.throws(() => gov.parseDetail([], ZHOU), ApiChangedError)
  assert.throws(() => gov.parseDetail({ performanceName: 'x' }, ZHOU), ApiChangedError)
})

// —— 请求流程 ——

function memoryKv(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    get: (k) => map.get(k) ?? null,
    set: (k, v) => {
      map.set(k, v)
    },
  }
}

function payloadOf(req, key = KEY) {
  return JSON.parse(decrypt(new URLSearchParams(req.body).get('data'), key))
}

function encrypted(obj, key = KEY) {
  return { json: { code: 200, data: encrypt(JSON.stringify(obj), key), message: '获取数据成功！' } }
}

const EMPTY_PAGE = { pagination: { total: 0, current: 1, totalPage: 0, pageSize: 15 }, list: [] }

/**
 * 假的 zwfw 服务端：用 serverKey 解请求，解不开回 code 500（真站点就是这样），
 * lists[名字][页码] 是列表页，details[id] 是详情，没有的详情回 204。
 */
function fakeServer({ serverKey = KEY, lists = {}, details = {}, keyHandler, override } = {}) {
  return fakeClient(
    (req) => {
      if (override) {
        const res = override(req)
        if (res) return res
      }
      if (req.url === KEY_URL) {
        if (keyHandler) return keyHandler(req)
        return { json: KEY_RESPONSE, headers: { 'set-cookie': ['zwfwToken=abc; Path=/; HttpOnly'] } }
      }
      let payload
      try {
        payload = payloadOf(req, serverKey)
      } catch {
        return { json: { msg: '系统内部异常', code: 500, message: '系统内部异常' } }
      }
      if (req.url === LIST_URL) {
        const page = lists[payload.performanceName]?.[payload.pageNum]
        if (typeof page === 'string') return { text: page }
        return encrypted(page ?? EMPTY_PAGE, serverKey)
      }
      if (req.url === DETAIL_URL) {
        const detail = details[payload.id]
        if (typeof detail === 'string') return { text: detail }
        if (!detail) return { json: { code: 204, message: '暂无数据' } }
        return encrypted(detail, serverKey)
      }
      return { status: 404, text: 'not found' }
    },
    { site: 'gov', now: () => NOW },
  )
}

function makeCtx(client, { kv = memoryKv(), previous = new Map(), logs = [] } = {}) {
  return { client, now: () => NOW, log: (m) => logs.push(m), kv, previous: (id) => previous.get(id) ?? null }
}

const callsTo = (client, url) => client.calls.filter((c) => c.url === url)

test('fetchArtist：取密钥、按主名和别名搜、翻页、合并、新 id 取详情、旧 id 沿用', async () => {
  const page2 = {
    pagination: { total: 18, current: 2, totalPage: 2, pageSize: 15 },
    list: [
      { id: '72c1b9af256a45428c69e3607368cf87', performanceName: '时光机广州嘉年华2026周杰伦世界巡回演唱会', performingBeginTime: '2026-12-04' },
      { id: 'tribute', performanceName: '致敬周杰伦经典金曲演唱会', performingBeginTime: '2026-11-01' },
    ],
  }
  const client = fakeServer({
    lists: { 周杰伦: { 1: read('s_周杰伦.raw.json'), 2: page2 } },
    details: { '72c1b9af256a45428c69e3607368cf87': read('d_72c1b9af256a45428c69e3607368cf87.raw.json') },
  })
  const sanya = gov.parseDetail({ ...PAGE_JS_DETAILS.xuezhiqian_wuxi, id: 'b16971c0bdd64be23440a3632c175100', performanceName: '阳光 三亚 嘉年华2026周杰伦演唱会' }, { key: '别人' })
  const kv = memoryKv()
  const ctx = makeCtx(client, { kv, previous: new Map([[sanya.sourceId, sanya]]) })

  const listings = await gov.fetchArtist(ZHOU, ctx)

  // 1 次密钥，周杰伦 2 页，Jay Chou 1 页；第 1 页 15 条去掉沿用的 1 条，取 14 次详情
  assert.equal(callsTo(client, KEY_URL).length, 1)
  assert.equal(callsTo(client, LIST_URL).length, 3)
  assert.equal(callsTo(client, DETAIL_URL).length, 14)
  assert.equal(client.calls.length, 18)

  const lists = callsTo(client, LIST_URL).map((c) => new URLSearchParams(c.body).get('data'))
  assert.equal(
    decrypt(lists[0], KEY),
    `{"pageSize":"15","pageNum":"1","performanceName":"周杰伦","performancePlace1":"","performingBeginTime":"${TODAY}","performingEndTime":""}`,
  )
  assert.equal(payloadOf(callsTo(client, LIST_URL)[1]).pageNum, '2')
  assert.equal(payloadOf(callsTo(client, LIST_URL)[2]).performanceName, 'Jay Chou')
  assert.deepEqual(payloadOf(callsTo(client, DETAIL_URL)[2]), { id: '72c1b9af256a45428c69e3607368cf87' })
  assert.ok(!callsTo(client, DETAIL_URL).some((c) => payloadOf(c).id === sanya.sourceId))
  assert.ok(!callsTo(client, DETAIL_URL).some((c) => payloadOf(c).id === 'tribute'))

  for (const call of client.calls) {
    assert.equal(call.method, 'POST')
    assert.equal(call.headers['x-requested-with'], 'XMLHttpRequest')
    assert.match(call.headers.referer, /^https:\/\/zwfw\.mct\.gov\.cn\/wycx\/qgswyyxychd\//)
    assert.equal(call.headers.cookie, undefined)
  }
  assert.equal(callsTo(client, KEY_URL)[0].headers.referer, 'https://zwfw.mct.gov.cn/wycx/qgswyyxychd/')

  assert.deepEqual(kv.map.get('gov.smKey'), { smKey: KEY, sendDay: TODAY, fetchedDay: TODAY })

  assert.deepEqual(
    listings.map((l) => l.sourceId),
    ['b16971c0bdd64be23440a3632c175100', '72c1b9af256a45428c69e3607368cf87'],
  )
  assert.equal(listings[0].artistKey, '周杰伦')
  assert.equal(listings[0].city, sanya.city)
  assert.equal(listings[1].city, '广州')
  assert.equal(listings[1].approval.number, '440100522026001088')
  listings.forEach(validateListing)
})

test('fetchArtist：每个名字最多翻 3 页，别名和主名大小写相同只搜一次', async () => {
  const many = { pagination: { total: 60, current: 1, totalPage: 4, pageSize: 15 }, list: [] }
  const client = fakeServer({ lists: { 'G.E.M.': { 1: many } } })
  await gov.fetchArtist({ key: '邓紫棋', aliases: ['G.E.M.', 'g.e.m.'] }, makeCtx(client))
  const pages = callsTo(client, LIST_URL).map((c) => payloadOf(c))
  assert.deepEqual(
    pages.map((p) => `${p.performanceName}#${p.pageNum}`),
    ['邓紫棋#1', 'G.E.M.#1', 'G.E.M.#3', 'G.E.M.#4'],
  )
})

test('fetchArtist：超过 3 页时留下开演最近的，写一行日志', async () => {
  // 列表按开始日期倒序：60 条从 2027-12 排到 2027-03，最后一页是开演最近的
  const rows = Array.from({ length: 60 }, (_, i) => ({
    id: `id${i}`,
    performanceName: `某某音乐节-${i}`,
    performingBeginTime: `2027-${String(12 - Math.floor(i / 6)).padStart(2, '0')}-01`,
  }))
  const pageOf = (n) => ({ pagination: { total: 60, current: n, totalPage: 4, pageSize: 15 }, list: rows.slice((n - 1) * 15, n * 15) })
  const client = fakeServer({ lists: { 某某音乐节: { 1: pageOf(1), 2: pageOf(2), 3: pageOf(3), 4: pageOf(4) } } })
  const logs = []
  await gov.fetchArtist({ key: '某某音乐节', aliases: [] }, makeCtx(client, { logs }))

  assert.deepEqual(
    callsTo(client, LIST_URL).map((c) => payloadOf(c).pageNum),
    ['1', '3', '4'],
  )
  const detailIds = new Set(callsTo(client, DETAIL_URL).map((c) => payloadOf(c).id))
  assert.equal(detailIds.size, 45)
  // 开演最近的 15 条（2027-03 到 2027-05）一条不少
  for (const row of rows.slice(45)) assert.ok(detailIds.has(row.id), row.performingBeginTime)
  assert.ok(!detailIds.has('id15'))
  assert.equal(logs.length, 1)
  assert.match(logs[0], /某某音乐节.*60 条/)
})

test('fetchArtist：详情 code 204 的记录跳过', async () => {
  const client = fakeServer({ lists: { 周杰伦: { 1: read('s_周杰伦.raw.json') } } })
  const listings = await gov.fetchArtist({ key: '周杰伦', aliases: [] }, makeCtx(client))
  assert.deepEqual(listings, [])
  assert.equal(callsTo(client, DETAIL_URL).length, 15)
})

test('密钥：kv 里有今天的就不再取', async () => {
  const kv = memoryKv({ 'gov.smKey': { smKey: KEY, sendDay: TODAY, fetchedDay: TODAY } })
  const client = fakeServer()
  await gov.fetchArtist({ key: '五月天', aliases: [] }, makeCtx(client, { kv }))
  assert.equal(callsTo(client, KEY_URL).length, 0)
  assert.equal(callsTo(client, LIST_URL).length, 1)
})

test('密钥：kv 里存成 JSON 字符串也认', async () => {
  const kv = memoryKv({ 'gov.smKey': JSON.stringify({ smKey: KEY, sendDay: TODAY, fetchedDay: TODAY }) })
  const client = fakeServer()
  await gov.fetchArtist({ key: '五月天', aliases: [] }, makeCtx(client, { kv }))
  assert.equal(callsTo(client, KEY_URL).length, 0)
})

test('密钥：北京时间换天了就重取', async () => {
  const kv = memoryKv({ 'gov.smKey': { smKey: KEY, sendDay: '2026-10-25', fetchedDay: '2026-10-25' } })
  const client = fakeServer()
  await gov.fetchArtist({ key: '五月天', aliases: [] }, makeCtx(client, { kv }))
  assert.equal(callsTo(client, KEY_URL).length, 1)
  assert.equal(client.calls[0].url, KEY_URL)
  assert.equal(kv.map.get('gov.smKey').sendDay, TODAY)
})

test('密钥：存下的旧密钥服务端解不开（code 500），重取一次再试', async () => {
  const logs = []
  const kv = memoryKv({ 'gov.smKey': { smKey: 'aaaaaaaaaaaaaaaa', sendDay: TODAY, fetchedDay: TODAY } })
  const client = fakeServer()
  const listings = await gov.fetchArtist({ key: '五月天', aliases: [] }, makeCtx(client, { kv, logs }))
  assert.deepEqual(listings, [])
  assert.deepEqual(
    client.calls.map((c) => c.url),
    [LIST_URL, KEY_URL, LIST_URL],
  )
  assert.equal(kv.map.get('gov.smKey').smKey, KEY)
  assert.equal(logs.length, 1)
})

test('密钥：存下的旧密钥解不开响应，重取一次再试', async () => {
  const kv = memoryKv({ 'gov.smKey': { smKey: 'aaaaaaaaaaaaaaaa', sendDay: TODAY, fetchedDay: TODAY } })
  let first = true
  // 服务端不校验请求，只管用当天的真密钥加密响应
  const client = fakeServer({
    override: (req) => {
      if (req.url !== LIST_URL) return null
      if (first) {
        first = false
        return encrypted(EMPTY_PAGE, KEY)
      }
      return encrypted({ ...EMPTY_PAGE, pagination: { ...EMPTY_PAGE.pagination, total: 0 } }, KEY)
    },
  })
  await gov.fetchArtist({ key: '五月天', aliases: [] }, makeCtx(client, { kv }))
  assert.deepEqual(
    client.calls.map((c) => c.url),
    [LIST_URL, KEY_URL, LIST_URL],
  )
})

test('接口变了：新取的密钥服务端还是解不开（code 500）', async () => {
  const client = fakeServer({ serverKey: '0123456789abcdef' })
  await assert.rejects(gov.fetchArtist({ key: '五月天', aliases: [] }, makeCtx(client)), ApiChangedError)
  assert.equal(callsTo(client, KEY_URL).length, 1)
  assert.equal(callsTo(client, LIST_URL).length, 1)
})

test('接口变了：新取的密钥遇到 HTTP 500', async () => {
  const client = fakeServer({ override: (req) => (req.url === LIST_URL ? { status: 500, text: '<html>error</html>' } : null) })
  await assert.rejects(gov.fetchArtist({ key: '五月天', aliases: [] }, makeCtx(client)), (err) => {
    assert.ok(err instanceof ApiChangedError)
    assert.match(err.message, /HTTP 500/)
    return true
  })
})

test('接口变了：新取的密钥解出来不是 JSON', async () => {
  const client = fakeServer({ override: (req) => (req.url === LIST_URL ? { json: { code: 200, data: encrypt('<html>', KEY) } } : null) })
  await assert.rejects(gov.fetchArtist({ key: '五月天', aliases: [] }, makeCtx(client)), /不是 JSON/)
})

test('接口变了：code 不是 200、204、500', async () => {
  const client = fakeServer({ override: (req) => (req.url === LIST_URL ? { json: { code: 401, message: '未授权' } } : null) })
  await assert.rejects(gov.fetchArtist({ key: '五月天', aliases: [] }, makeCtx(client)), ApiChangedError)
})

test('接口变了：返回的不是 JSON、HTTP 404', async () => {
  const html = fakeServer({ override: (req) => (req.url === LIST_URL ? { text: '<html>维护中</html>' } : null) })
  await assert.rejects(gov.fetchArtist({ key: '五月天', aliases: [] }, makeCtx(html)), ApiChangedError)
  const missing = fakeServer({ override: (req) => (req.url === DETAIL_URL ? { status: 404, text: '' } : null), lists: { 周杰伦: { 1: read('s_周杰伦.raw.json') } } })
  await assert.rejects(gov.fetchArtist({ key: '周杰伦', aliases: [] }, makeCtx(missing)), ApiChangedError)
})

test('接口变了：取密钥的返回格式不对', async () => {
  const client = fakeServer({ keyHandler: () => ({ json: { code: 200, data: [] } }) })
  await assert.rejects(gov.fetchArtist({ key: '五月天', aliases: [] }, makeCtx(client)), ApiChangedError)
})

test('网络出错：取密钥、列表回 5xx 都算网络错误，不算接口变了', async () => {
  for (const status of [500, 502, 503, 504]) {
    const keyDown = fakeServer({ keyHandler: () => ({ status, text: '<html>Bad Gateway</html>' }) })
    await assert.rejects(gov.fetchArtist({ key: '五月天', aliases: [] }, makeCtx(keyDown)), NetworkError, `取密钥 ${status}`)
    assert.equal(keyDown.calls.length, 1)
  }
  for (const status of [502, 503, 504]) {
    const listDown = fakeServer({ override: (req) => (req.url === LIST_URL ? { status, text: '' } : null) })
    await assert.rejects(gov.fetchArtist({ key: '五月天', aliases: [] }, makeCtx(listDown)), NetworkError, `列表 ${status}`)
  }
  const keyMissing = fakeServer({ keyHandler: () => ({ status: 404, text: '' }) })
  await assert.rejects(gov.fetchArtist({ key: '五月天', aliases: [] }, makeCtx(keyMissing)), ApiChangedError)
})

test('被拦：列表回 412、取密钥回 403', async () => {
  const listBlocked = fakeServer({ override: (req) => (req.url === LIST_URL ? { status: 412, text: '' } : null) })
  await assert.rejects(gov.fetchArtist({ key: '五月天', aliases: [] }, makeCtx(listBlocked)), BlockedError)
  const keyBlocked = fakeServer({ keyHandler: () => ({ status: 403, text: '' }) })
  await assert.rejects(gov.fetchArtist({ key: '五月天', aliases: [] }, makeCtx(keyBlocked)), BlockedError)
  assert.equal(keyBlocked.calls.length, 1)
})

test('check：取一次密钥，按周杰伦查一页', async () => {
  const kv = memoryKv({ 'gov.smKey': { smKey: KEY, sendDay: TODAY, fetchedDay: TODAY } })
  const client = fakeServer({ lists: { 周杰伦: { 1: read('s_周杰伦.raw.json') } } })
  const result = await gov.check(makeCtx(client, { kv }))
  assert.equal(result.ok, true)
  assert.match(result.detail, /23 条/)
  assert.deepEqual(
    client.calls.map((c) => c.url),
    [KEY_URL, LIST_URL],
  )
  assert.equal(payloadOf(client.calls[1]).performingBeginTime, TODAY)
})

test('导出的接口', async () => {
  assert.equal(gov.name, 'gov')
  assert.equal(gov.label, '文旅部')
  assert.equal(gov.needsArtistId, false)
  assert.equal(gov.everyRun, false)
  assert.deepEqual(gov.clientOptions, { site: 'gov', minGapMs: 3000 })
  assert.equal(await gov.resolveArtist(ZHOU, {}), null)
})
