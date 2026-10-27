// 大麦：走 H5 的 mtop 接口 mtop.damai.cn/h5/，用服务器下发的匿名令牌加前端公开的 md5 签名，不登录、不带个人 Cookie。
// 只用搜索和项目详情两个接口。票档库存 mtop.alibaba.detail.subpage.getdetail 和 PC 搜索 search.damai.cn 一律不碰。
// 接口和字段的实测结论见 docs/design.md“大麦”。

import { createHash } from 'node:crypto'
import { MOBILE_UA } from '../http.mjs'
import { ApiChangedError, BlockedError, NetworkError } from '../errors.mjs'
import { makeListing } from '../listing.mjs'
import { artistNames, normalizeCity, normalizeName, sameName } from '../text.mjs'
import { beijingDate, beijingParts, fromBeijing, parseBeijing, parseRelativeBeijing } from '../time.mjs'

export const name = 'damai'
export const label = '大麦'
export const clientOptions = { site: 'damai', userAgent: MOBILE_UA }
export const needsArtistId = true
export const everyRun = true

const SITE = 'damai'
const MTOP = 'https://mtop.damai.cn/h5'
const APP_KEY = '12574478'
const JSV = '2.7.5'
const HEADERS = { accept: 'application/json', referer: 'https://m.damai.cn/' }
const SEARCH_API = 'mtop.damai.wireless.search.search'
const DETAIL_API = 'mtop.damai.item.detail.getdetail'
const PAGE_SIZE = 30
const MAX_PAGES = 3
const MINUTE = 60_000
const DAY = 86_400_000
const YEAR = 365 * DAY

// ret 分四类：令牌要重取、被拦、接口变了（含要求登录）、服务端一时出错。其余的业务失败交给调用方
const RET_TOKEN = /TOKEN_EMPTY|TOKEN_EXOIRED|TOKEN_EXPIRED|ILLEGAL_ACCESS/
const RET_BLOCKED = /RGV587|USER_VALIDATE|TRAFFIC_LIMIT|FLOWLIMIT|ACCESS_DENIED|被挤爆/
const RET_CHANGED = /API_NOT_FOUND|API_NOT_EXIST|API_STOP|PARAMPARSE|SESSION_EXPIRED|SID_INVALID|NEED_LOGIN|AUTH_REJECT/
const RET_SERVER = /SERVICE_UNAVAILABLE|SERVICE_TIMEOUT|SERVICE_INNER_FAULT|SERVICE_FAULT|FAIL_SYS_HSF/
const BLOCK_LOCATION = /punish|captcha/i

// 每位艺人一份备忘，存在 ctx.kv 的 damai.items.<艺人> 里：{ 项目 ID: { list, retry } }。
// list 是上一轮列表上的开售时间，用来发现列表撤掉了的时间；retry 表示上一轮要取详情却没取到，这一轮再取。
// 每轮按这一轮的项目整份重写，不在列表上的项目自然去掉。
const MEMO_PREFIX = 'damai.items.'

// itemSaleStatus 是对照详情页文字推出来的：0 热卖、1 缺货、2 预约（等首开或下一轮）、7 延期
const SALE_STATUS = { 0: 'onsale', 1: 'soldout', 2: 'presale', 7: 'postponed' }

// 同一个客户端（也就是同一轮）里，同一个关键词的同一页只搜一次，resolveArtist 和 fetchArtist 共用
const searchCache = new WeakMap()

export async function resolveArtist(artist, ctx) {
  const seen = new Set()
  for (const n of artistNames(artist)) {
    const key = normalizeName(n)
    if (!key || seen.has(key)) continue
    seen.add(key)
    const found = findArtistAccount(await searchPage(ctx, n, 1), artist)
    if (found) return found
  }
  return null
}

export async function fetchArtist(artist, ctx) {
  const log = ctx.log ?? (() => {})
  const previous = ctx.previous ?? (() => null)
  const pages = await searchAll(ctx, artist.key)
  const memo = await readMemo(ctx, artist.key)
  const nextMemo = {}
  const out = []
  for (const listing of listingsFromSearch(pages, artist, nowOf(ctx), { log })) {
    const prev = previous(listing.sourceId) ?? null
    const mark = memo[listing.sourceId] ?? null
    const now = nowOf(ctx)
    const wanted = needsDetail(listing, prev, now, mark)
    const detail = wanted ? await fetchDetail(ctx, listing.sourceId, log) : null
    out.push(detail ? applyDetail(listing, detail, now, prev) : applyPrevious(listing, prev, now, mark))
    nextMemo[listing.sourceId] = wanted && !detail ? { list: listing.saleTimes, retry: true } : { list: listing.saleTimes }
  }
  // 整位艺人取完才写：中途被拦、出错时这一轮的记录不存，备忘也不动
  await writeMemo(ctx, artist.key, nextMemo)
  return out
}

export async function check(ctx) {
  try {
    const { data } = await searchPage(ctx, '薛之谦', 1)
    const items = (data.projectInfo ?? []).length
    const accounts = (data.baccountInfo ?? []).length
    return { ok: true, detail: `搜索“薛之谦”通了，${items} 个项目、${accounts} 个账号` }
  } catch (err) {
    return { ok: false, detail: err.message, error: err }
  }
}

// ---------- 请求 ----------

/** 签名：md5(令牌&t&appKey&data)，和大麦 H5 前端一样。 */
export function signMtop(token, t, data) {
  return createHash('md5').update(`${token}&${t}&${APP_KEY}&${data}`).digest('hex')
}

/**
 * 调一个 mtop 接口，返回 { ok, ret, json }。
 * 第一次没有令牌，服务端回 FAIL_SYS_TOKEN_EMPTY 并下发 _m_h5_tk；令牌过期、非法时重取一次再签。
 * 被拦抛 BlockedError，接口名变了、签名不再被接受抛 ApiChangedError，服务端一时出错抛 NetworkError。
 */
export async function callMtop(ctx, api, version, data) {
  const { client } = ctx
  const body = JSON.stringify(data)
  let refetched = false
  let lastRet = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = client.cookiesFor(MTOP).get('_m_h5_tk')
    const token = tokenOf(before)
    const t = String(nowOf(ctx))
    const query = new URLSearchParams({
      jsv: JSV,
      appKey: APP_KEY,
      t,
      sign: signMtop(token, t, body),
      api,
      v: version,
      type: 'originaljson',
      dataType: 'json',
      valueType: 'original',
      timeout: '10000',
      data: body,
    })
    const res = await client.request({ url: `${MTOP}/${api.toLowerCase()}/${version}/?${query}`, headers: HEADERS })
    checkStatus(res)
    const json = res.json()
    const ret = retText(json)
    lastRet = ret
    if (ret.startsWith('SUCCESS')) return { ok: true, ret, json }
    if (RET_TOKEN.test(ret)) {
      if (token) {
        if (refetched) throw new ApiChangedError(SITE, `签名不再被接受（${ret}）`)
        refetched = true
      }
      // 服务端多半同时下发了新令牌；没下发就清掉旧的，下一次不带令牌去换
      if (client.cookiesFor(MTOP).get('_m_h5_tk') === before) {
        client.cookiesFor(MTOP).delete('_m_h5_tk')
        client.cookiesFor(MTOP).delete('_m_h5_tk_enc')
      }
      continue
    }
    if (RET_BLOCKED.test(ret)) throw new BlockedError(SITE, ret)
    if (RET_CHANGED.test(ret)) throw new ApiChangedError(SITE, ret)
    if (RET_SERVER.test(ret)) throw new NetworkError(SITE, ret)
    return { ok: false, ret, json }
  }
  throw new ApiChangedError(SITE, `拿不到令牌（${lastRet}）`)
}

/** HTTP 状态先分类：跳到 punish、captcha 是被拦，跳到别处是接口变了，网关 5xx 网页是服务端一时出错。 */
function checkStatus(res) {
  if (res.status >= 300 && res.status < 400) {
    const location = String(res.headers?.location ?? '')
    if (BLOCK_LOCATION.test(location)) throw new BlockedError(SITE, `跳转到验证页 ${location.slice(0, 80)}`)
    throw new ApiChangedError(SITE, `HTTP ${res.status} 跳转到 ${location.slice(0, 80)}`)
  }
  if (res.status >= 500) throw new NetworkError(SITE, `HTTP ${res.status}`)
}

async function searchPage(ctx, keyword, pageIndex) {
  let cache = searchCache.get(ctx.client)
  if (!cache) searchCache.set(ctx.client, (cache = new Map()))
  const key = `${keyword}\n${pageIndex}`
  if (cache.has(key)) return cache.get(key)
  const res = await callMtop(ctx, SEARCH_API, '1.0', {
    cityId: 0,
    longitude: 0,
    latitude: 0,
    pageIndex,
    pageSize: PAGE_SIZE,
    keyword,
    sourceType: 11,
    returnItemOption: 4,
    option: 434,
  })
  if (!res.ok) throw new ApiChangedError(SITE, `搜索返回 ${res.ret}`)
  searchData(res.json)
  cache.set(key, res.json)
  return res.json
}

/** 按关键词搜全国，有下一页再翻，最多 3 页。返回每页原样的 JSON。 */
async function searchAll(ctx, keyword) {
  const pages = []
  for (let p = 1; p <= MAX_PAGES; p++) {
    const json = await searchPage(ctx, keyword, p)
    pages.push(json)
    const data = json.data
    if (!(data.projectInfo ?? []).length || p * PAGE_SIZE >= (Number(data.total) || 0)) break
  }
  return pages
}

/** 取详情，只要和开售有关的几样。业务失败或一时连不上返回 null，沿用列表和上一轮，下一轮再取。 */
async function fetchDetail(ctx, itemId, log) {
  try {
    const res = await callMtop(ctx, DETAIL_API, '1.0', { itemId })
    if (res.ok) return parseDetail(res.json, nowOf(ctx))
    log(`大麦详情 ${itemId} 返回 ${res.ret}，先用列表的字段`)
  } catch (err) {
    if (!(err instanceof NetworkError)) throw err
    log(`大麦详情 ${itemId} 取不到，先用列表的字段：${err.reason}`)
  }
  return null
}

// ---------- 解析：都是纯函数，测试直接喂 fixtures ----------

/** 搜索结果里 type=2、名字归一后和艺人名之一相同的艺人账号。同名的几位取粉丝最多的。 */
export function findArtistAccount(json, artist) {
  const names = artistNames(artist)
  const hits = (searchData(json).baccountInfo ?? []).filter(
    (a) => Number(a.type) === 2 && a.damaiId != null && names.some((n) => sameName(n, a.name)),
  )
  if (!hits.length) return null
  const best = hits.reduce((a, b) => ((Number(b.fansCount) || 0) > (Number(a.fansCount) || 0) ? b : a))
  return { id: String(best.damaiId), name: best.name }
}

/**
 * 搜索结果（一页或几页）翻译成统一记录，只用列表上的字段，不含详情。
 * 留下 artisteNames 里有这位艺人的项目，和出现在他账号 performanceInfo 里的项目；周边（categoryName“其他”）去掉。
 */
export function listingsFromSearch(input, artist, now, { log = () => {} } = {}) {
  const pages = Array.isArray(input) ? input : [input]
  const datas = pages.map(searchData)
  const names = artistNames(artist)
  const damaiId = artist.ids?.damai != null ? String(artist.ids.damai) : null
  const accounts = datas.flatMap((d) => d.baccountInfo ?? []).filter((a) => Number(a.type) === 2)
  // 有艺人 ID 时只认这个账号；还没有 ID 时退一步认同名账号，但不记成 id
  const account = damaiId
    ? accounts.find((a) => String(a.damaiId) === damaiId)
    : accounts.find((a) => names.some((n) => sameName(n, a.name)))
  const accountItems = new Set((account?.performanceInfo ?? []).map((p) => String(p.projectId)))

  const out = []
  const seen = new Set()
  for (const data of datas) {
    const currentTime = Number(data.currentTime) || now
    for (const p of data.projectInfo ?? []) {
      const id = p?.id == null ? '' : String(p.id)
      if (!id || seen.has(id)) continue
      seen.add(id)
      if (p.categoryName === '其他') continue
      const lineup = Array.isArray(p.artisteNames) ? p.artisteNames : []
      const byName = lineup.some((a) => names.some((n) => sameName(a, n)))
      const inAccount = accountItems.has(id)
      if (!byName && !inAccount) continue
      const isMixed = lineup.length > 1 || isFestival(p)
      const matchedBy = inAccount && damaiId ? 'id' : byName ? (isMixed ? 'lineup' : 'title') : 'search'
      const status = saleStatus(p.itemSaleStatus, id, log)
      const saleTimes = listSaleTimes(p, currentTime)
      out.push(
        makeListing({
          source: SITE,
          sourceId: id,
          artistKey: artist.key,
          kind: 'ticket',
          title: cleanText(p.name),
          city: normalizeCity(p.cityName ?? p.venueCity),
          venue: p.venueName || null,
          ...showDates(p.showTime, p.nearestPerformTime, now),
          matchedBy,
          isMixed,
          status,
          saleTimes,
          hasSold: status === 'onsale' || status === 'soldout' || saleTimes.some((t) => t <= now),
          roundHint: null,
          roundHintAt: null,
          url: itemUrl(id),
        }),
      )
    }
  }
  const missing = [...accountItems].filter((id) => !seen.has(id))
  if (missing.length) log(`大麦：${artist.key} 的账号下有 ${missing.length} 个项目不在搜索结果里（${missing.join('、')}）`)
  return out
}

/**
 * 详情里和开售有关的几样：
 *   saleTimes    场次开售时间 item.performInfos[].saleTime，加上介绍里写的各轮开售时间
 *   roundHint    介绍里写的“第 N 次销售”，N 小于 2 或没写为 null
 *   roundHintAt  介绍里写的开售时间里最晚的一个，没写为 null
 *   firstSaleAt  退票规则里最早的 startTime，也就是首开时间；没有退票规则为 null
 */
export function parseDetail(json, now) {
  const data = json?.data
  if (!data || typeof data !== 'object') throw new ApiChangedError(SITE, '详情返回里没有 data')
  const item = data.item ?? {}
  const performSaleTimes = []
  for (const p of item.performInfos ?? []) {
    const t = Number(p?.saleTime)
    if (t > 0) performSaleTimes.push(t)
  }
  const show = parseShowTime(item.showTime)
  const anchor = show ? parseBeijing(show.dateEnd) + DAY : null
  const intro = parseIntroduce(data.desc?.introduce, { anchor, now })
  // 场次开售时间只在首开前给。它还没到，或者退票规则比它还早，退票规则是改期前留下的，不算开过票（许嵩温州站）。
  // 介绍里的时间不拿来否掉退票规则：二开、三开之前，介绍里本来就写着将来的开售时间（薛之谦厦门站）
  let firstSaleAt = firstRefundStart(data.serviceTips)
  if (firstSaleAt != null && performSaleTimes.length) {
    if (performSaleTimes.some((t) => t > now) || firstSaleAt < Math.min(...performSaleTimes)) firstSaleAt = null
  }
  return {
    saleTimes: [...performSaleTimes, ...intro.saleTimes],
    roundHint: intro.roundHint,
    roundHintAt: intro.roundHintAt,
    firstSaleAt,
  }
}

/**
 * 这几种情况才取详情：新项目、上一轮详情没取到、列表上的状态变了、列表上出现新的开售时间、
 * 列表撤掉了上一轮还在的将来开售时间、预约中却还不知道下一次开售时间。memo 是备忘里这个项目的那条。
 */
export function needsDetail(listing, previous, now, memo = null) {
  if (!previous || memo?.retry) return true
  if (previous.status !== listing.status) return true
  const known = new Set(previous.saleTimes ?? [])
  if (listing.saleTimes.some((t) => !known.has(t))) return true
  if (withdrawnTimes(listing, memo, now).length) return true
  if (listing.status === 'presale' && !(previous.saleTimes ?? []).some((t) => t > now)) return true
  return false
}

/** 列表记录并上这一轮取到的详情。开过票一旦为真不再变回去，轮次取大的，轮次时间跟着轮次走。 */
export function applyDetail(listing, detail, now, previous = null) {
  const saleTimes = [...listing.saleTimes, ...detail.saleTimes]
  const hasSold =
    listing.hasSold ||
    Boolean(previous?.hasSold) ||
    (detail.firstSaleAt != null && detail.firstSaleAt <= now) ||
    saleTimes.some((t) => t <= now)
  return makeListing({ ...listing, saleTimes, hasSold, ...pickRound(detail, previous) })
}

/** 这一轮没有详情时，沿用上一轮的开售时间、开过票、轮次和轮次时间。列表撤掉了的将来开售时间不再沿用。 */
export function applyPrevious(listing, previous, now, memo = null) {
  if (!previous) return listing
  const gone = new Set(withdrawnTimes(listing, memo, now))
  const saleTimes = [...listing.saleTimes, ...(previous.saleTimes ?? []).filter((t) => !gone.has(t))]
  const hasSold = listing.hasSold || Boolean(previous.hasSold) || saleTimes.some((t) => t <= now)
  return makeListing({ ...listing, saleTimes, hasSold, roundHint: previous.roundHint ?? null, roundHintAt: previous.roundHintAt ?? null })
}

/**
 * 演出日期的几种写法：“2026.11.13-11.22”“2026.11.21 周六 19:00”“2026.12.31-2027.01.02”
 * “2026.11.6/11.8”“2026年8月7日-12月31日”。解析不了（“时间延期待定”）返回 null。
 */
export function parseShowTime(text) {
  if (text == null) return null
  let s = String(text).replace(/\s+/g, ' ').trim()
  s = s.replace(/\s*(?:周|星期)[一二三四五六日天].*$/, '').replace(/\s+\d{1,2}[:：]\d{2}.*$/, '')
  s = s.replace(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/g, '$1.$2.$3').replace(/[年月]/g, '.').replace(/[日号]/g, '')
  const parts = s.split(/\s*[-~～至/、,，]\s*/).filter(Boolean)
  if (!parts.length) return null
  let year = null
  let month = null
  let prev = null
  const dates = []
  for (const part of parts) {
    if (!/^\d{1,4}(?:\.\d{1,2}){0,2}\.?$/.test(part)) return null
    const nums = part.split('.').filter(Boolean).map(Number)
    let y = year
    let m = month
    let d
    if (nums.length === 3) [y, m, d] = nums
    else if (nums.length === 2) [m, d] = nums
    else [d] = nums
    if (y == null || m == null) return null
    let ms = validDay(y, m, d)
    // 没写年份的后一个日期比前一个早，是跨了年：“2026.12.31-01.02”
    if (ms != null && nums.length < 3 && prev != null && ms < prev) ms = validDay((y += 1), m, d)
    if (ms == null) return null
    year = y
    month = m
    prev = ms
    dates.push(ms)
  }
  return { dateStart: beijingDate(Math.min(...dates)), dateEnd: beijingDate(Math.max(...dates)) }
}

/**
 * 详情介绍（主办方写的 HTML）里的开售时间和轮次，比如“第三次销售时间：10月25日 10:00销售10月31日、11月1日场次”。
 * 只认带“销售、开售、预售、开票”这类字眼的句子，和紧跟在“第二次销售时间：”这种标题后面那一句；
 * 带“退票、截止、演出时间、入场”的句子不认。没写年份的，取不晚于演出最后一天的那一年；不知道演出日期时取离现在最近的那一年。
 * roundHintAt 是认出来的开售时间里最晚的一个，没认出时间为 null。
 */
export function parseIntroduce(html, { anchor = null, now }) {
  const text = htmlToText(html)
  let round = 0
  for (const m of text.matchAll(ROUND_RE)) round = Math.max(round, cnNumber(m[1]))
  if (AGAIN_RE.test(text)) round = Math.max(round, 2)
  const saleTimes = []
  let pending = false
  for (const raw of text.split(/[\n。；;，,！!]/)) {
    const s = raw.trim()
    if (!s) continue
    const excluded = NOT_SALE_WORDS.test(s)
    const isSale = SALE_WORDS.test(s) && !excluded
    const times = findTimes(s, anchor, now)
    if (times.length && (isSale || (pending && !excluded))) saleTimes.push(...times)
    pending = isSale && !times.length
  }
  return { saleTimes, roundHint: round >= 2 ? round : null, roundHintAt: saleTimes.length ? Math.max(...saleTimes) : null }
}

const SALE_WORDS = /销售|开售|预售|开票|抢先购|优先购|放票|售票|发售|开抢/
const NOT_SALE_WORDS = /退票|截止|停止|演出时间|入场|检票|开演|开场|结束/
const ROUND_RE = /([一二三四五六七八九十]|\d{1,2})\s*[次轮](?:销售|开售|开票|放票|售票|发售)/g
const AGAIN_RE = /再次(?:销售|开售|开票|放票|售票|发售)/
const CN_DIGITS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
// “2026年9月24日11:00”“10月14日 17:17”“10月15日(周四)13:00”“10月20日下午3点半”
const CN_TIME =
  /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]\s*(?:[（(]\s*(?:周|星期)[一二三四五六日天]\s*[）)]|(?:周|星期)[一二三四五六日天])?\s*(上午|中午|下午|晚上)?\s*(\d{1,2})\s*(?:[:：]\s*(\d{2})|点\s*(?:(\d{1,2})\s*分|(半))?)/g
const NUM_TIME = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s+(\d{1,2})[:：](\d{2})/g

function findTimes(s, anchor, now) {
  const out = []
  for (const m of s.matchAll(CN_TIME)) {
    const [, y, mo, d, ampm, h, mi, mi2, half] = m
    let hour = +h
    if ((ampm === '下午' || ampm === '晚上') && hour < 12) hour += 12
    if (ampm === '中午' && hour < 11) hour += 12
    const minute = mi != null ? +mi : mi2 != null ? +mi2 : half ? 30 : 0
    const t = y ? validStamp(+y, +mo, +d, hour, minute) : pickYear(+mo, +d, hour, minute, anchor, now)
    if (t != null) out.push(t)
  }
  for (const m of s.matchAll(NUM_TIME)) {
    const t = validStamp(+m[1], +m[2], +m[3], +m[4], +m[5])
    if (t != null) out.push(t)
  }
  return out
}

function pickYear(month, day, hour, minute, anchor, now) {
  const y = beijingParts(anchor ?? now).year
  const candidates = [y - 1, y, y + 1].map((yy) => validStamp(yy, month, day, hour, minute)).filter((t) => t != null)
  if (!candidates.length) return null
  if (anchor != null) {
    const before = candidates.filter((t) => t <= anchor)
    if (before.length) return Math.max(...before)
  }
  return candidates.reduce((a, b) => (Math.abs(b - now) < Math.abs(a - now) ? b : a))
}

/** 退票规则（serviceTerm 里带 performRules 的那条）里最早的 startTime。规则从首开那一刻起算。 */
function firstRefundStart(serviceTips) {
  let first = null
  for (const term of serviceTips?.serviceTerm ?? []) {
    if (typeof term?.tagDescJson !== 'string') continue
    let desc
    try {
      desc = JSON.parse(term.tagDescJson)
    } catch {
      continue
    }
    for (const perform of desc?.performRules ?? []) {
      for (const rule of perform?.rules ?? []) {
        const t = Number(rule?.startTime)
        if (t > 0 && (first == null || t < first)) first = t
      }
    }
  }
  return first
}

/** 列表上的开售时间：siteStatus=16 时的 upTime、onSaleTime（“明天17:17”）、countdownTime（倒计时毫秒）。 */
function listSaleTimes(p, currentTime) {
  const times = []
  const up = Number(p.upTime)
  // siteStatus=3 时 upTime 只是个普通时间戳，不是开售时间
  if (Number(p.siteStatus) === 16 && up > 0) times.push(up)
  if (typeof p.onSaleTime === 'string' && /\d{1,2}[:：]\d{2}/.test(p.onSaleTime)) {
    const t = parseRelativeBeijing(p.onSaleTime, currentTime)
    if (t != null) times.push(t)
  }
  // 倒计时按接口自己的 currentTime 算，取整到分钟，免得每轮差几百毫秒就被当成新的开售时间
  const countdown = Number(p.countdownTime)
  if (countdown > 0) times.push(Math.round((currentTime + countdown) / MINUTE) * MINUTE)
  return times
}

function showDates(showTime, nearestPerformTime, now) {
  const parsed = parseShowTime(showTime)
  if (parsed) return parsed
  // 延期项目的 nearestPerformTime 是 2036、2037 年这种占位值，离现在太远的不当日期用
  const t = Number(nearestPerformTime)
  if (t > 0 && t > now - YEAR && t < now + 2 * YEAR) return { dateStart: beijingDate(t), dateEnd: beijingDate(t) }
  return { dateStart: null, dateEnd: null }
}

function saleStatus(value, id, log) {
  const status = SALE_STATUS[value]
  if (status) return status
  log(`大麦项目 ${id} 的 itemSaleStatus=${value}，没见过这个值，先记成已上架`)
  return 'listed'
}

function isFestival(p) {
  return [p.categoryName, p.guideCategoryName, p.guideSubCategoryName].includes('音乐节')
}

/** 搜索返回的 data，格式不对抛 ApiChangedError。 */
function searchData(json) {
  const data = json?.data
  if (!data || typeof data !== 'object') throw new ApiChangedError(SITE, '搜索返回里没有 data')
  const items = data.projectInfo
  if (items !== undefined && items !== null && !Array.isArray(items)) throw new ApiChangedError(SITE, 'projectInfo 不是数组')
  if ((Number(data.total) || 0) > 0 && !Array.isArray(items)) throw new ApiChangedError(SITE, `total=${data.total} 却没有 projectInfo`)
  return data
}

/** 上一轮列表上有、这一轮列表上没了、还没到的开售时间。已经过去的不算撤掉，开售以后列表本来就不再给。 */
function withdrawnTimes(listing, memo, now) {
  const current = new Set(listing.saleTimes)
  return (Array.isArray(memo?.list) ? memo.list : []).filter((t) => Number.isFinite(t) && t > now && !current.has(t))
}

async function readMemo(ctx, artistKey) {
  const raw = ctx.kv ? await ctx.kv.get(MEMO_PREFIX + artistKey) : null
  if (raw == null) return {}
  let memo = raw
  if (typeof raw === 'string') {
    try {
      memo = JSON.parse(raw)
    } catch {
      return {}
    }
  }
  return memo && typeof memo === 'object' && !Array.isArray(memo) ? memo : {}
}

async function writeMemo(ctx, artistKey, memo) {
  if (ctx.kv) await ctx.kv.set(MEMO_PREFIX + artistKey, JSON.stringify(memo))
}

function retText(json) {
  const ret = json?.ret
  if (Array.isArray(ret)) return ret.join(',')
  if (typeof ret === 'string') return ret
  throw new ApiChangedError(SITE, '返回里没有 ret')
}

function tokenOf(cookieValue) {
  return (cookieValue ?? '').split('_')[0]
}

function itemUrl(id) {
  return `https://m.damai.cn/shows/item.html?itemId=${id}`
}

function maxRound(a, b) {
  if (a == null) return b ?? null
  if (b == null) return a
  return Math.max(a, b)
}

/**
 * 这一轮的详情和上一轮的记录合出轮次和轮次时间。轮次取大的；时间取轮次大的那份的，一样大取这一轮的。
 * 那份没有时间（比如上一轮的记录早于这个字段），取另一份的，不丢成 null。
 */
function pickRound(detail, previous) {
  const fresh = detail.roundHint ?? 0
  const old = previous?.roundHint ?? 0
  const freshAt = Number.isFinite(detail.roundHintAt) ? detail.roundHintAt : null
  const oldAt = Number.isFinite(previous?.roundHintAt) ? previous.roundHintAt : null
  const roundHintAt = fresh >= old ? freshAt ?? oldAt : oldAt ?? freshAt
  return { roundHint: maxRound(detail.roundHint, previous?.roundHint), roundHintAt }
}

function cnNumber(s) {
  return CN_DIGITS[s] ?? Number(s)
}

function validDay(y, m, d) {
  return validStamp(y, m, d, 0, 0)
}

function validStamp(y, m, d, hour, minute) {
  if (!(y >= 2000 && y <= 2100) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null
  if (!(hour >= 0 && hour <= 23) || !(minute >= 0 && minute <= 59)) return null
  const ms = fromBeijing(y, m, d, hour, minute)
  const p = beijingParts(ms)
  return p.month === m && p.day === d ? ms : null
}

/** 项目名里带搜索高亮的 <span>，介绍是整段 HTML。去标签、解实体。 */
function cleanText(html) {
  return htmlToText(html).replace(/\s+/g, ' ').trim()
}

function htmlToText(html) {
  if (html == null) return ''
  return String(html)
    .replace(/<br\s*\/?>|<\/(?:p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|nbsp|amp|lt|gt|quot|apos|#39);/gi, (all, e) => {
      const named = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()]
      if (named) return named
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : all
    })
}

function nowOf(ctx) {
  return ctx.now ? ctx.now() : Date.now()
}
