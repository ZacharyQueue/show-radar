// 秀动：网页接口 www.showstart.com/api/web/*。匿名可用，每个请求带前端算的签名。
// 签名照 RSSHub lib/routes/showstart/utils.ts 和官网前端的请求拦截器。接口和字段见 docs/design.md“秀动”。

import { createHash, randomInt } from 'node:crypto'
import { ApiChangedError, BlockedError, NetworkError } from '../errors.mjs'
import { DESKTOP_UA } from '../http.mjs'
import { makeListing } from '../listing.mjs'
import { artistNames, normalizeCity, normalizeName, sameName } from '../text.mjs'
import { beijingDate, parseBeijing, toDateString } from '../time.mjs'

export const name = 'showstart'
export const label = '秀动'
export const needsArtistId = true
export const everyRun = true
export const clientOptions = { site: 'showstart', userAgent: DESKTOP_UA }

const SITE = 'showstart'
const HOST = 'https://www.showstart.com'
const PAGE_SIZE = 20
const MAX_PAGES = 3
// 服务端给的有效期约 35 分钟，提前 5 分钟换
const TOKEN_TTL_MS = 30 * 60_000
// 万能青年旅店，check 用
const CHECK_PERFORMER_ID = '2502'
// 前端拦截器遇到这几种 state 会重取令牌再发一次
const TOKEN_STATES = ['token-expire-at', 'token-expire-ut', 'token-clean-at', 'login.other.terminal', 'token-clean-ut', 'user_not_login_default']
const BLOCK_WORDS = /频繁|太快|繁忙|限流|验证码|滑块/
// activity/info 查不到场次时回 {state:"100", msg:"活动不存在"}（2026-10-26 实测）
const MISSING_STATE = '100'
// 上一轮是这几种状态的，这一轮照样取详情：等开售的要看开售时间改没改、开了没有；停售的要看有没有又放票
const REFETCH_STATUSES = new Set([null, 'presale', 'listed', 'soldout'])
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
// 官网前端发的设备信息，只有分辨率有值；cpuMode 是一个空格
const DEVICE_INFO = encodeURI(
  JSON.stringify({
    vendorName: '',
    deviceMode: '',
    deviceName: '',
    systemName: '',
    systemVersion: '',
    cpuMode: ' ',
    cpuCores: '',
    cpuArch: '',
    memerySize: '',
    diskSize: '',
    network: '',
    resolution: '1920*1080',
    pixelResolution: '',
  }),
)

// ---------- 找艺人 ----------

/** 主名和每个别名各搜一次，名字归一后相同才认。繁体写法要写在别名里。 */
export async function resolveArtist(artist, ctx) {
  const seen = new Set()
  for (const keyword of artistNames(artist)) {
    const key = normalizeName(keyword)
    if (!key || seen.has(key)) continue
    seen.add(key)
    const json = await api(ctx, '/web/performer/list', { searchKeyword: keyword, pageNo: '1', pageSize: String(PAGE_SIZE) })
    const hit = pickPerformer(json, artist)
    if (hit) return hit
  }
  return null
}

/**
 * 从 performer/list 的结果里挑这位艺人。整名相同的优先；秀动常把中英文名写在一起
 * （“告五人 Accusefive”），拆开以后有一半相同也认。“五月天怪兽”不算五月天。
 */
export function pickPerformer(json, artist) {
  const list = json?.result?.result
  if (!Array.isArray(list)) throw new ApiChangedError(SITE, 'performer/list 的 result.result 不是数组')
  const names = artistNames(artist)
  const matches = (text) => names.some((n) => sameName(text, n))
  const hit = list.find((p) => matches(p.name)) ?? list.find((p) => nameParts(p.name).some(matches))
  return hit ? { id: String(hit.id), name: String(hit.name) } : null
}

const HAN = '\\u3400-\\u9fff\\uf900-\\ufaff'
const HAN_THEN_LATIN = new RegExp(`^([${HAN}·・]+)\\s*([A-Za-z][A-Za-z0-9 .&'’_-]*)$`)
const LATIN_THEN_HAN = new RegExp(`^([A-Za-z][A-Za-z0-9 .&'’_-]*?)\\s*([${HAN}·・]+)$`)

/** “告五人 Accusefive” → ['告五人', 'Accusefive']；不是中文名接英文名的返回空数组。 */
function nameParts(text) {
  const s = String(text ?? '').trim()
  const m = s.match(HAN_THEN_LATIN) || s.match(LATIN_THEN_HAN)
  return m ? [m[1].trim(), m[2].trim()] : []
}

// ---------- 取演出 ----------

/**
 * 按音乐人 ID 取全国未开演的场次，翻完（最多 3 页）。没有 ID 不取：按关键词搜噪音太大。
 * 详情只在需要时取，见 needsDetail。
 */
export async function fetchArtist(artist, ctx) {
  const performerId = artist.ids?.showstart
  if (!performerId) return []

  const items = []
  for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
    const json = await api(ctx, '/web/activity/list', { performerId: String(performerId), pageNo: String(pageNo), pageSize: String(PAGE_SIZE) })
    const page = parseActivityList(json)
    items.push(...page.items)
    if (pageNo >= page.totalPage || page.items.length < PAGE_SIZE) break
    if (pageNo === MAX_PAGES) ctx.log?.(`秀动：${artist.key} 有 ${page.totalCount} 场，只取了前 ${MAX_PAGES * PAGE_SIZE} 场`)
  }

  const now = ctx.now()
  const session = sessionFor(ctx.client)
  const listings = []
  const fingerprints = []
  const detailDays = []
  const seen = new Set()
  for (const item of items) {
    const id = String(item.id)
    if (seen.has(id)) continue
    seen.add(id)
    const previous = ctx.previous ? ((await ctx.previous(id)) ?? null) : null
    const fp = listFingerprint(item)
    const fpKey = fingerprintKey(artist, id)
    const fpChanged = ctx.kv ? (await ctx.kv.get(fpKey)) !== fp : false
    // 在卖的场次每天重取一次详情：二开常是加一档更贵的票，列表上的最低价不变，指纹看不出来
    const dayKey = detailDayKey(artist, id)
    const today = beijingDate(now)
    const dailyDue = ctx.kv ? previous?.status === 'onsale' && (await ctx.kv.get(dayKey)) !== today : false
    let info = null
    let settled = true
    if (needsDetail(item, previous, fpChanged) || dailyDue) {
      const json = await api(ctx, '/web/activity/info', { activityId: id }, { allowMissing: true })
      info = json ? parseActivityInfo(json) : null
      // 详情没取到，下一轮再取
      settled = info != null
      if (info) {
        session.infoOk += 1
        detailDays.push([dayKey, today])
      }
      else {
        session.infoMissing += 1
        ctx.log?.(`秀动：${id} 的详情回“活动不存在”，沿用上一轮`)
        // 列表里有、详情却说不存在，一轮里连着两场都这样、一场也没取到，多半是详情接口改了参数
        if (session.infoOk === 0 && session.infoMissing >= 2) {
          throw new ApiChangedError(SITE, `activity/info 这一轮取了 ${session.infoMissing} 场都回“活动不存在”，列表里明明有，详情接口可能改了`)
        }
      }
    }
    listings.push(toListing(item, artist, now, { info, previous }))
    if (ctx.kv && settled) fingerprints.push([fpKey, fp])
  }
  // 整位艺人取完才记列表指纹：中途被拦时，下一轮还会重取这些详情
  for (const [key, value] of fingerprints) await ctx.kv.set(key, value)
  for (const [key, value] of detailDays) await ctx.kv.set(key, value)
  return listings
}

/** 新场次、列表字段变了、上一轮还在等开售或没开票，才取详情。 */
export function needsDetail(item, previous, fingerprintChanged = false) {
  if (!previous) return true
  if (fingerprintChanged) return true
  if (previous.title !== cleanTitle(item.title)) return true
  if (previous.dateStart !== toDateString(item.showTime)) return true
  return REFETCH_STATUSES.has(previous.status ?? null)
}

/** 列表上会变的字段：标题、演出时间、价格。统一记录里没有价格，所以另记在 kv 里比。 */
export function listFingerprint(item) {
  return [cleanTitle(item.title), item.showTime ?? '', item.price ?? ''].join('\n')
}

/**
 * 列表指纹的 kv 键，带上艺人。previous 按艺人分开存，指纹也要分开：
 * 两位关注的艺人同在一场音乐节时，先跑的记了新指纹，后跑的不能因此当成没变、漏取详情。
 */
export function fingerprintKey(artist, activityId) {
  return `showstart:list:${artist.key}:${activityId}`
}

/** 最近一次取到详情是哪天（北京时间），按艺人分开记。 */
export function detailDayKey(artist, activityId) {
  return `showstart:detailDay:${artist.key}:${activityId}`
}

// ---------- 解析（纯函数） ----------

/** activity/list 的响应 → { items, totalCount, totalPage }。 */
export function parseActivityList(json) {
  const r = json?.result
  if (!r || !Array.isArray(r.result)) throw new ApiChangedError(SITE, 'activity/list 的 result.result 不是数组')
  return { items: r.result, totalCount: Number(r.totalCount) || 0, totalPage: Number(r.totalPage) || 0 }
}

/** activity/info 的响应 → 详情对象。没有票档数组就判断不了售票状态，当接口变了。 */
export function parseActivityInfo(json) {
  const r = json?.result
  if (!r || typeof r !== 'object' || !Array.isArray(r.tickets)) {
    throw new ApiChangedError(SITE, 'activity/info 的 result.tickets 不是数组')
  }
  return r
}

/**
 * 列表响应加上取到的详情 → 统一记录。infos 以 activityId 为键，值是 activity/info 的原始响应。
 * 没有详情的场次 status 为 null。
 */
export function parseActivities(listJson, artist, now, infos = {}) {
  return parseActivityList(listJson).items.map((item) => {
    const raw = infos[item.id] ?? infos[String(item.id)]
    return toListing(item, artist, now, { info: raw ? parseActivityInfo(raw) : null })
  })
}

/** 一条列表项 → 统一记录。有详情按详情判断售票状态；没有就沿用 previous。 */
export function toListing(item, artist, now, { info = null, previous = null } = {}) {
  const title = cleanTitle(item.title)
  const dateStart = toDateString(item.showTime)
  const mixed = isMixedItem(title, item.performers, artist)
  let sale
  if (info) {
    sale = summarizeTickets(info, { title, dateStart }, now)
  } else if (previous) {
    const saleTimes = previous.saleTimes ?? []
    sale = {
      status: previous.status ?? null,
      saleTimes,
      hasSold: Boolean(previous.hasSold) || saleTimes.some((t) => t <= now),
      roundHint: previous.roundHint ?? null,
    }
  } else {
    sale = { status: null, saleTimes: [], hasSold: false }
  }
  if (isPostponed(title)) sale.status = 'postponed'
  return makeListing({
    source: 'showstart',
    sourceId: String(item.id),
    artistKey: artist.key,
    kind: 'ticket',
    title,
    city: normalizeCity(item.cityName),
    venue: String(item.siteName ?? '').trim() || null,
    dateStart,
    matchedBy: mixed ? 'lineup' : 'id',
    isMixed: mixed,
    url: `${HOST}/event/${item.id}`,
    ...sale,
  })
}

/**
 * 按票档判断售票状态。价格为 0 或票档名带“待定”的是占位票档，它的 startTime 是演出当天 0 点，不算。
 *   标题带“延期”                      → postponed
 *   有真实票档的开售时间在将来          → presale（首开前、二开前都算）
 *   有真实票档已开售、没停售、status 0 → onsale
 *   演出日期已过                        → ended
 *   只有占位票档                        → listed
 *   真实票档都停售了                    → soldout（秀动没有售罄字段，前端把 status 1 写成“停止销售”）
 * saleTimes 放全部真实票档的开售时间，过去的也放；hasSold 是有开售时间已经过了。
 */
export function summarizeTickets(info, { title = '', dateStart = null } = {}, now) {
  const tickets = Array.isArray(info?.tickets) ? info.tickets : []
  const real = tickets.filter(isRealTicket).map((t) => ({
    start: parseBeijing(t.startTime),
    end: parseBeijing(t.endTime),
    status: Number(t.status),
  }))
  const saleTimes = [...new Set(real.map((t) => t.start).filter((t) => t != null))].sort((a, b) => a - b)
  const hasSold = saleTimes.some((t) => t <= now)
  let status
  if (isPostponed(title) || isPostponed(info?.title)) status = 'postponed'
  else if (real.some((t) => t.start != null && t.start > now)) status = 'presale'
  else if (real.some((t) => t.start != null && t.start <= now && (t.end == null || now < t.end) && t.status === 0)) status = 'onsale'
  else if (dateStart && dateStart < beijingDate(now)) status = 'ended'
  else if (!real.length) status = 'listed'
  else status = 'soldout'
  return { status, saleTimes, hasSold }
}

function isRealTicket(t) {
  const price = Number.parseFloat(t?.sellPriceStr)
  return price > 0 && !String(t?.ticketName ?? '').includes('待定')
}

function isPostponed(title) {
  return String(title ?? '').includes('延期')
}

/** 阵容里不止一位艺人，或标题带“音乐节”，算多人同台。 */
function isMixedItem(title, performers, artist) {
  if (title.includes('音乐节')) return true
  const text = String(performers ?? '').trim()
  // 名字本身带斜杠的（AC/DC）不拆
  if (!text || artistNames(artist).some((n) => sameName(text, n))) return false
  return text.split('/').filter((s) => s.trim()).length > 1
}

function cleanTitle(title) {
  return String(title ?? '').trim()
}

// ---------- 健康检查 ----------

/** 取一次令牌，再按万能青年旅店的音乐人 ID 列一次。 */
export async function check(ctx) {
  try {
    await ensureToken(ctx, { force: true })
    const json = await api(ctx, '/web/activity/list', { performerId: CHECK_PERFORMER_ID, pageNo: '1', pageSize: String(PAGE_SIZE) })
    const page = parseActivityList(json)
    return { ok: true, detail: `令牌拿到了；万能青年旅店（${CHECK_PERFORMER_ID}）现在有 ${page.totalCount} 场` }
  } catch (err) {
    if (err instanceof BlockedError || err instanceof ApiChangedError || err instanceof NetworkError) {
      return { ok: false, detail: err.message, error: err }
    }
    throw err
  }
}

// ---------- 请求和签名 ----------

// 每个请求客户端一份会话：设备号、令牌，以及这一轮详情取到和没取到的场次数。
// 一轮一个客户端，设备号这一轮内不变。
const sessions = new WeakMap()

function sessionFor(client) {
  let s = sessions.get(client)
  if (!s) {
    s = { deviceNo: randomString(32).toLowerCase(), accessToken: null, idToken: '', expireAt: 0, infoOk: 0, infoMissing: 0 }
    sessions.set(client, s)
  }
  return s
}

/** 取匿名令牌。还在有效期内就沿用，force 时重取。 */
async function ensureToken(ctx, { force = false } = {}) {
  const s = sessionFor(ctx.client)
  const now = ctx.now()
  if (!force && s.accessToken && now < s.expireAt) return s
  // 还没有令牌时，前端拿当前毫秒数的 md5 占位
  const body = await post(ctx, s, '/waf/gettoken', undefined, md5(String(now)))
  const token = body?.result?.accessToken?.access_token
  if (String(body?.state) !== '1' || !token) throw stateError(body, '/waf/gettoken')
  s.accessToken = token
  s.idToken = body.result.idToken?.id_token ?? ''
  s.expireAt = now + TOKEN_TTL_MS
  return s
}

/**
 * 发一个 /api/web/* 请求，返回响应 JSON。令牌过期类的 state 重取令牌再发一次。
 * allowMissing 时，state 100（实测是“活动不存在”）返回 null；别的认不出的 state 照样抛。
 */
async function api(ctx, path, payload, { allowMissing = false } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await ensureToken(ctx, { force: attempt > 0 })
    const body = await post(ctx, s, path, payload, s.accessToken)
    const state = String(body.state ?? '').toLowerCase()
    if (state === '1') return body
    if (TOKEN_STATES.includes(state) && attempt === 0) {
      ctx.log?.(`秀动：令牌失效（${state}），重取一次`)
      continue
    }
    const err = stateError(body, path)
    // 限流提示照样当被拦，哪怕 state 也是 100
    if (allowMissing && state === MISSING_STATE && !(err instanceof BlockedError)) return null
    throw err
  }
}

function stateError(body, path) {
  const state = String(body?.state ?? '').toLowerCase()
  const msg = String(body?.msg ?? '')
  if (state === 'sys002') return new ApiChangedError(SITE, `${path} 签名不被接受（sys002 ${msg}），前端可能改了签名`)
  if (state === 'sys001') return new ApiChangedError(SITE, `${path} 请求头或参数不全（sys001 ${msg}），前端可能改了请求头`)
  if (TOKEN_STATES.includes(state)) return new ApiChangedError(SITE, `${path} 令牌刚换过仍被拒（${state}）`)
  if (BLOCK_WORDS.test(msg)) return new BlockedError(SITE, `${path} ${msg}`)
  return new ApiChangedError(SITE, `${path} 回了 state=${state || '空'} ${msg}`.trim())
}

/** 签好名发出去。空值的请求头也要发，少了服务端回 sys001。 */
async function post(ctx, session, path, payload, accessToken) {
  const bodyText = payload === undefined ? '' : JSON.stringify(payload)
  const traceId = randomString(32) + ctx.now()
  const headers = {
    origin: HOST,
    referer: `${HOST}/`,
    cookie: `token=${session.deviceNo}`,
    cdeviceinfo: DEVICE_INFO,
    cdeviceno: session.deviceNo,
    crtraceid: traceId,
    crpsign: signRequest({ accessToken, idToken: session.idToken, deviceNo: session.deviceNo, bodyText, path, traceId }),
    csappid: 'web',
    cterminal: 'web',
    cversion: '999',
    cusat: accessToken,
    cusid: '',
    cusit: session.idToken,
    cusut: '',
    cusname: '',
  }
  if (bodyText) headers['content-type'] = 'application/json;charset=UTF-8'
  const res = await ctx.client.request({ method: 'POST', url: `${HOST}/api${path}`, headers, body: bodyText, sendCookies: false })
  return readJson(res, path)
}

/**
 * crpsign = md5(accessToken + cusut + idToken + userId + 'web' + 设备号 + JSON 正文 + 路径 + '999web' + traceId)。
 * 匿名时 cusut、userId 为空，idToken 一般也为空。路径不带 /api 前缀。
 */
export function signRequest({ accessToken, idToken = '', deviceNo, bodyText = '', path, traceId }) {
  return md5(accessToken + '' + idToken + '' + 'web' + deviceNo + bodyText + path + '999web' + traceId)
}

function readJson(res, path) {
  if (res.status >= 500) throw new NetworkError(SITE, `${path} HTTP ${res.status}`)
  let body
  try {
    body = JSON.parse(res.text)
  } catch {
    if (/captcha|验证码|滑块|访问受限|拦截/i.test(res.text)) throw new BlockedError(SITE, `${path} 返回了验证页`)
    throw new ApiChangedError(SITE, `${path} HTTP ${res.status}，返回的不是 JSON：${res.text.slice(0, 80)}`)
  }
  if (!body || typeof body !== 'object') throw new ApiChangedError(SITE, `${path} 返回的不是对象`)
  return body
}

function md5(text) {
  return createHash('md5').update(text, 'utf8').digest('hex')
}

function randomString(length) {
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)]
  return out
}
