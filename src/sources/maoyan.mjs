// 猫眼：走大众点评网关 m.dianping.com/myshow/ajax，匿名、不签名、不带 Cookie。
// 艺人 ID 从猫眼 H5 搜索拿，只用来核对音乐节阵容。要签名的 v2 接口、/mysh/odea、wx.maoyan.com 一律不碰。
// 接口和字段的实测结论见 docs/design.md“猫眼”。

import { DESKTOP_UA, MOBILE_UA } from '../http.mjs'
import { ApiChangedError, BlockedError, NetworkError } from '../errors.mjs'
import { makeListing } from '../listing.mjs'
import { artistNames, containsAnyName, isTributeFor, normalizeCity, normalizeName, sameName } from '../text.mjs'
import { beijingDate, fromBeijing } from '../time.mjs'

export const name = 'maoyan'
export const label = '猫眼'
export const clientOptions = { site: 'maoyan', userAgent: DESKTOP_UA }
export const needsArtistId = true
export const everyRun = true

const SITE = 'maoyan'
const GATEWAY = 'https://m.dianping.com/myshow/ajax'
const H5_SEARCH = 'https://show.maoyan.com/maoyansh/myshow/ajax/search/0;st=0;p=1;s=20;tft=0'
const PAGE_SIZE = 20
const MAX_PAGES = 3
// 只留演唱会、音乐节、Livehouse
const CATEGORIES = new Set([1, 10, 17])
const FESTIVAL = 10
const HEADERS = { accept: 'application/json, text/plain, */*', referer: 'https://show.maoyan.com/' }
// 网关自己说的风控话术：前端遇到 406 就弹验证，签名接口被拦时回“前方拥堵”
const BLOCK_MSG = /拥堵|频繁|验证|稍后再试|稍后重试/
const BLOCK_PAGE = /yoda|verify\.meituan|captcha/i

// 详情的 ticketStatus，映射来自站点 JS：1 即将开售、2 预售、3 在售中、4 已售罄、5 已结束、11 即将预售、12 演出延期
const TICKET_STATUS = { 1: 'presale', 11: 'presale', 2: 'onsale', 3: 'onsale', 4: 'soldout', 5: 'ended', 12: 'postponed' }

// H5 搜索出过错的请求客户端。客户端一轮一个，所以只在这一轮里不再问 show.maoyan.com，下一轮再试。
const h5Down = new WeakSet()

/**
 * 艺人 ID 可有可无：只用来核对音乐节阵容，阵容按名字也认得出。
 * 所以 H5 搜索（show.maoyan.com）连不上、被拦、格式变了都不往外抛，记日志、返回 undefined（这一轮没查成），
 * run.mjs 照常调 fetchArtist 去 m.dianping.com 按名字搜。往外抛的话，run.mjs 会跳过这位艺人的按名搜索，被拦时整个猫眼一起停。
 */
export async function resolveArtist(artist, ctx) {
  if (h5Down.has(ctx.client)) return undefined
  const seen = new Set()
  for (const n of artistNames(artist)) {
    const key = normalizeName(n)
    if (!key || seen.has(key)) continue
    seen.add(key)
    let found
    try {
      const json = await getJson(ctx.client, `${H5_SEARCH}?k=${encodeURIComponent(n)}&sellChannel=13&cityId=10`, {
        'user-agent': MOBILE_UA,
      })
      found = parseCelebrity(json, artist)
    } catch (err) {
      if (!(err instanceof NetworkError || err instanceof BlockedError || err instanceof ApiChangedError)) throw err
      h5Down.add(ctx.client)
      ctx.log?.(`H5 搜索出错，这一轮不再请求 show.maoyan.com，艺人 ID 先空着，照样按名字搜：${err.message}`)
      return undefined
    }
    if (found) return found
  }
  return null
}

export async function fetchArtist(artist, ctx) {
  const now = ctx.now()
  const previous = ctx.previous ?? (() => null)
  const log = ctx.log ?? (() => {})
  const pages = await searchPerformances(ctx.client, artist.key)
  const details = new Map()
  for (const { item } of selectCandidates(pages, artist)) {
    const id = String(item.performanceId)
    if (!needsDetail(item, previous(id))) continue
    try {
      details.set(id, await fetchDetail(ctx.client, id))
    } catch (err) {
      // 单个详情连不上，沿用上一轮或列表的状态，不让整个数据源这一轮作废
      if (!(err instanceof NetworkError)) throw err
      log(`猫眼详情 ${id} 取不到，先用列表的状态：${err.reason}`)
    }
  }
  return parseListings(pages, artist, now, { details, previous, log })
}

export async function check(ctx) {
  try {
    const [page] = await searchPerformances(ctx.client, '薛之谦', 1)
    return { ok: true, detail: `搜索“薛之谦”通了，${page.data.length} 条` }
  } catch (err) {
    return { ok: false, detail: err.message, error: err }
  }
}

/** 按关键词搜全国，hasMore 就翻页，最多 maxPages 页。返回每页原样的 JSON。 */
async function searchPerformances(client, keyword, maxPages = MAX_PAGES) {
  const pages = []
  for (let p = 1; p <= maxPages; p++) {
    const url = `${GATEWAY}/performances/0;st=0;k=${encodeURIComponent(keyword)};p=${p};s=${PAGE_SIZE};tft=0?cityId=10&sellChannel=7`
    const json = await getJson(client, url)
    if (json.data == null) json.data = []
    if (!Array.isArray(json.data)) throw new ApiChangedError(SITE, '搜索结果 data 不是数组')
    pages.push(json)
    if (!json.paging?.hasMore || json.data.length === 0) break
  }
  return pages
}

/** 取详情。下线的项目回 code 1002，原样返回，由 parseListings 判成 offline。 */
async function fetchDetail(client, id) {
  const json = await getJson(client, `${GATEWAY}/performance/${encodeURIComponent(id)}?sellChannel=7`, {}, [1002])
  if (json.code === 200 && (json.data == null || typeof json.data !== 'object')) {
    throw new ApiChangedError(SITE, `详情 ${id} 没有 data`)
  }
  return json
}

/** 发请求、拆网关信封。被拦、接口变了、服务器出错分别抛三种错误。okCodes 是除 200 以外照常返回的业务码。 */
async function getJson(client, url, headers = {}, okCodes = []) {
  const res = await client.request({ url, headers: { ...HEADERS, ...headers }, sendCookies: false })
  if (res.status === 406) throw new BlockedError(SITE, 'HTTP 406')
  if (res.status >= 300 && res.status < 400) {
    const location = String(res.headers.location ?? '')
    if (BLOCK_PAGE.test(location)) throw new BlockedError(SITE, `跳转到验证页 ${location.slice(0, 60)}`)
    throw new ApiChangedError(SITE, `HTTP ${res.status} 跳转到 ${location.slice(0, 60)}`)
  }
  if (res.status >= 500) throw new NetworkError(SITE, `HTTP ${res.status}`)
  if (res.status !== 200) throw new ApiChangedError(SITE, `HTTP ${res.status}`)
  let json
  try {
    json = JSON.parse(res.text)
  } catch {
    if (BLOCK_PAGE.test(res.text)) throw new BlockedError(SITE, '返回了验证页')
    throw new ApiChangedError(SITE, `返回的不是 JSON：${res.text.slice(0, 80)}`)
  }
  if (json == null || typeof json !== 'object') throw new ApiChangedError(SITE, '返回的不是对象')
  const msg = String(json.msg ?? '')
  if (json.code === 200) return json
  if (json.code === 406 || BLOCK_MSG.test(msg)) throw new BlockedError(SITE, `code ${json.code} ${msg}`)
  if (okCodes.includes(json.code)) return json
  if (json.code >= 500 && json.code < 600) throw new NetworkError(SITE, `code ${json.code} ${msg}`)
  throw new ApiChangedError(SITE, `code ${json.code} ${msg}`)
}

/** H5 搜索结果里找名字归一后和艺人相同的那位，平台排在前面的优先。搜“周深”会先出来“周深深”。 */
export function parseCelebrity(json, artist) {
  const list = json?.data?.celebrityBasicDTOList
  if (list == null) return null
  if (!Array.isArray(list)) throw new ApiChangedError(SITE, 'celebrityBasicDTOList 不是数组')
  const names = artistNames(artist)
  const hit = list.find((c) => c?.celebrityId != null && names.some((n) => sameName(c.celebrityName, n)))
  return hit ? { id: String(hit.celebrityId), name: hit.celebrityName } : null
}

/**
 * 搜索结果翻译成统一记录，纯函数。
 * @param {Object|Object[]} search 搜索接口的 JSON，一页或几页
 * @param {Object} artist
 * @param {number} now 毫秒
 * @param {Object} [options]
 * @param {Map|Object} [options.details] performanceId → 详情接口的 JSON（code 200 或 1002）
 * @param {Function} [options.previous] sourceId → 上一轮的统一记录；没取详情的项目沿用它的状态和开售时间
 * @param {Function} [options.log]
 */
export function parseListings(search, artist, now, { details = new Map(), previous = () => null, log = () => {} } = {}) {
  const getDetail = (id) => (details instanceof Map ? details.get(id) : details[id])
  return selectCandidates([].concat(search), artist).map(({ item, match }) => {
    const id = String(item.performanceId)
    return buildListing({ item, match, detailJson: getDetail(id), prev: previous(id), artist, now, log })
  })
}

/** 留下演唱会、音乐节、Livehouse 里能认定是这位艺人的，按 performanceId 去重。 */
function selectCandidates(pages, artist) {
  const seen = new Set()
  const out = []
  let items = 0
  let withId = 0
  for (const page of pages) {
    for (const item of page?.data ?? []) {
      items++
      if (item?.performanceId == null) continue
      withId++
      const id = String(item.performanceId)
      if (seen.has(id) || !CATEGORIES.has(item.categoryId)) continue
      seen.add(id)
      const match = matchItem(item, artist)
      if (match) out.push({ item, match })
    }
  }
  if (items > 0 && withId === 0) throw new ApiChangedError(SITE, '搜索结果里没有 performanceId')
  return out
}

/**
 * 认定是不是这位艺人的演出：
 * 阵容里有他（ID 或名字）算 lineup；标题含名字、又不是致敬场的算 title；
 * 都没有但搜索返回了，多半是名字不在标题里的拼盘，算 search，这时带“经典”“金曲”的也当致敬场丢掉。
 */
export function matchItem(item, artist) {
  const names = artistNames(artist)
  const id = artist.ids?.maoyan
  const lineup = Array.isArray(item.celebrityRelationVOS) ? item.celebrityRelationVOS : []
  const festival = item.categoryId === FESTIVAL
  const inLineup = lineup.some(
    (c) => (id != null && String(c.celebrityId) === String(id)) || names.some((n) => sameName(c.celebrityName, n)),
  )
  if (inLineup) return { matchedBy: 'lineup', isMixed: festival || lineup.length > 1 }
  if (containsAnyName(item.name, names)) {
    if (isTributeFor(item.name, names)) return null
    return { matchedBy: 'title', isMixed: festival || lineup.length > 1 }
  }
  // 标题里没有艺人名、只是搜索返回的：带“经典”“金曲”这类词的也当致敬场
  if (isTributeFor(item.name, names, { loose: true })) return null
  return { matchedBy: 'search', isMixed: true }
}

/** 要不要取详情：新项目、列表状态和上一轮不同、上一轮还没开售（可能刚公布开售时间）。已结束的不再取。 */
export function needsDetail(item, prev) {
  if (!prev) return true
  if (prev.status === 'ended') return false
  if (prev.status === 'presale' || prev.status === 'listed') return true
  return statusOf(item.ticketStatus) !== prev.status
}

/** ticketStatus 翻译成统一记录的状态，不认识的算 listed。 */
export function statusOf(code, log) {
  const status = TICKET_STATUS[code]
  if (status) return status
  log?.(`猫眼出现没见过的 ticketStatus=${code}，先记成 listed`)
  return 'listed'
}

function buildListing({ item, match, detailJson, prev, artist, now, log }) {
  const id = String(item.performanceId)
  const detail = detailJson?.code === 200 ? detailJson.data : null
  // 列表和详情对不上时信详情；阵容只在列表里有
  const src = { ...item, ...pickPresent(detail, ['name', 'cityName', 'shopName', 'showTimeRange', 'projectStartTime', 'projectEndTime']) }
  let status
  let saleTimes
  if (detailJson?.code === 1002) {
    status = 'offline'
    saleTimes = prev?.saleTimes ?? []
  } else if (detail) {
    status = statusOf(detail.ticketStatus, log)
    const onSaleTime = detail.saleRemindVO?.onSaleTime
    saleTimes = Number.isFinite(onSaleTime) ? [onSaleTime] : []
  } else if (prev) {
    status = prev.status
    saleTimes = prev.saleTimes ?? []
  } else {
    status = statusOf(item.ticketStatus, log)
    saleTimes = []
  }
  const { dateStart, dateEnd } = showDates(src)
  return makeListing({
    source: 'maoyan',
    sourceId: id,
    artistKey: artist.key,
    kind: 'ticket',
    title: String(src.name ?? '').trim(),
    city: normalizeCity(src.cityName),
    venue: src.shopName ? String(src.shopName).trim() : null,
    dateStart,
    dateEnd,
    matchedBy: match.matchedBy,
    isMixed: match.isMixed,
    status,
    saleTimes,
    hasSold: Boolean(prev?.hasSold) || status === 'onsale' || status === 'soldout' || saleTimes.some((t) => t <= now),
    roundHint: null,
    url: `https://show.maoyan.com/detail/${id}`,
  })
}

function pickPresent(obj, keys) {
  const out = {}
  if (!obj) return out
  for (const k of keys) if (obj[k] != null && obj[k] !== '') out[k] = obj[k]
  return out
}

function showDates(src) {
  const range = parseShowTimeRange(src.showTimeRange)
  if (range.dateStart) return range
  // showTimeRange 解析不了时，用毫秒的起止时间兜底
  const start = Number.isFinite(src.projectStartTime) ? beijingDate(src.projectStartTime) : null
  const end = Number.isFinite(src.projectEndTime) ? beijingDate(src.projectEndTime) : start
  return { dateStart: start, dateEnd: end }
}

/**
 * 解析 showTimeRange，取第一天和最后一天。见过的写法：
 * “2026.11.13 - 2026.11.22”“2026.10.31 - 11.08”“2026.11.28 / 11.29”“2026.12.31 / 2027.1.1”
 * “2026.11.21 19:30 周六”“2026.11.22 周日”。后面的日期不写年份时沿用前一个，月日倒退了就算下一年。
 */
export function parseShowTimeRange(text) {
  const empty = { dateStart: null, dateEnd: null }
  if (!text) return empty
  const dates = []
  let year = null
  let last = null
  for (const m of String(text).matchAll(/(?<!\d)(?:(\d{4})\.)?(\d{1,2})\.(\d{1,2})(?!\d)/g)) {
    const month = +m[2]
    const day = +m[3]
    if (month < 1 || month > 12 || day < 1 || day > 31) continue
    if (m[1]) year = +m[1]
    else if (year == null) continue
    else if (last && month * 100 + day < last) year++
    last = month * 100 + day
    dates.push(beijingDate(fromBeijing(year, month, day)))
  }
  if (!dates.length) return empty
  return { dateStart: dates[0], dateEnd: dates[dates.length - 1] }
}
