// 文旅部政务服务平台“全国涉外营业性演出活动”查询：管“已报批”这一格。
// 请求和响应都用站点版 SM4 加密（src/sources/zwfw-sm4.mjs），密钥按天下发，不要 Cookie。
// 库里没有演员字段，只能拿艺人的名字去搜演出名称。接口细节见 docs/design.md。

import { ApiChangedError, NetworkError } from '../errors.mjs'
import { makeListing } from '../listing.mjs'
import { artistNames, containsAnyName, isTributeFor, normalizeCity, normalizeName } from '../text.mjs'
import { beijingDate, toDateString } from '../time.mjs'
import { decrypt, encrypt } from './zwfw-sm4.mjs'

export const name = 'gov'
export const label = '文旅部'
export const clientOptions = { site: 'gov', minGapMs: 3000 }
export const needsArtistId = false
// 一天只取一次：库在凌晨 1 点半前后入库，零点前后接口实测会挂住，run.mjs 放到 9 点以后的第一轮取
export const everyRun = false

const BASE = 'https://zwfw.mct.gov.cn'
const FORM_PAGE = `${BASE}/wycx/qgswyyxychd/`
const RESULT_PAGE = `${FORM_PAGE}qgswyyxychdjg/`
const KEY_URL = `${BASE}/portal/getsm4key`
const LIST_URL = `${BASE}/portal/swychd`
const DETAIL_URL = `${BASE}/portal/swychdDetail`
const KV_KEY = 'gov.smKey'
const MAX_PAGES = 3
const CHECK_NAME = '周杰伦'

const CHANGE_WORDS = ['变更', '增加演员', '延期', '取消']
// 致敬场只认强信号。这里没有艺人 ID 和阵容能把误滤的捞回来，滤掉就彻底丢了；
// 公共词表里的“纪念”“经典”常出现在艺人自己的演出里（“上海交响乐团纪念贝多芬”“学友·经典世界巡回”）。
// 第二级行政区是占位写法时，城市要从别的级别取
const PLACEHOLDER_PLACE = new Set(['市辖区', '县', '市辖县', '省直辖县级行政区划', '自治区直辖县级行政区划', '省直辖行政单位'])
const MUNICIPALITY = /^(北京|天津|上海|重庆)市?$|特别行政区$/

/** 政府公示没有艺人 ID，按名字搜演出名称。 */
export async function resolveArtist() {
  return null
}

/**
 * 主名和每个别名各搜一次，只搜今天及以后开始的演出，每个名字最多翻 3 页。
 * 新出现的记录取一次详情；上一轮见过的沿用上一轮的字段，批复内容不会变。
 */
export async function fetchArtist(artist, ctx) {
  const session = keySession(ctx)
  const names = artistNames(artist)
  const today = beijingDate(ctx.now())
  const found = new Map()
  for (const searchName of uniqueNames(names)) {
    for (const item of await searchAll(ctx, session, searchName, today)) {
      if (!found.has(item.id)) found.set(item.id, item)
    }
  }

  const listings = []
  for (const item of filterSearchItems([...found.values()], artist)) {
    const previous = await ctx.previous?.(item.id)
    if (previous) {
      listings.push(makeListing({ ...previous, artistKey: artist.key }))
      continue
    }
    const detail = await fetchDetail(ctx, session, item.id)
    const listing = detail && parseDetail(detail, artist)
    if (listing) listings.push(listing)
  }
  return listings
}

/** 取一次密钥，再按“周杰伦”查一页。 */
export async function check(ctx) {
  const session = keySession(ctx)
  const key = await session.refresh()
  const page = await searchPage(ctx, session, CHECK_NAME, 1, beijingDate(ctx.now()))
  return { ok: true, detail: `密钥日期 ${key.sendDay ?? '未知'}；“${CHECK_NAME}”今天以后的演出 ${page.total} 条` }
}

// —— 解析：纯函数，测试直接喂 fixtures ——

/**
 * 解密后的列表页 → { total, totalPage, items: [{ id, title, dateStart }] }。
 * 格式不对抛 ApiChangedError。
 */
export function parseSearchPage(page) {
  if (!page || typeof page !== 'object' || !Array.isArray(page.list) || !page.pagination) {
    throw new ApiChangedError('gov', '列表解密后没有 pagination 和 list')
  }
  const items = []
  for (const row of page.list) {
    if (!row?.id) continue
    items.push({ id: String(row.id), title: clean(row.performanceName) ?? '', dateStart: toDateString(row.performingBeginTime) })
  }
  return {
    total: Number(page.pagination.total) || 0,
    totalPage: Number(page.pagination.totalPage) || 0,
    items,
  }
}

/** 只留演出名里有艺人任一名字、又不像致敬场的。 */
export function filterSearchItems(items, artist) {
  const names = artistNames(artist)
  return items.filter((item) => containsAnyName(item.title, names) && !isTributeFor(item.title, names))
}

/**
 * 解密后的详情 → 统一记录。已删除的记录返回 null。
 * 只取演出名、日期、城市、场馆、文号、审批日期、审批单位。报批单位、报批地、人名电话一概不进。
 */
export function parseDetail(detail, artist) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
    throw new ApiChangedError('gov', '详情解密后不是对象')
  }
  if (!detail.id) throw new ApiChangedError('gov', '详情里没有 id')
  if (detail.delFlag != null && String(detail.delFlag) !== '0') return null
  const title = clean(detail.performanceName) ?? ''
  return makeListing({
    source: 'gov',
    sourceId: String(detail.id),
    artistKey: artist.key,
    kind: 'approval',
    title,
    city: cityOf(detail),
    venue: clean(detail.performingVenues),
    dateStart: toDateString(detail.performingBeginTime),
    dateEnd: toDateString(detail.performingEndTime),
    matchedBy: 'title',
    isMixed: title.includes('音乐节'),
    status: null,
    approval: {
      date: toDateString(detail.approvalTime),
      number: clean(detail.symbol),
      approver: clean(detail.acceptGroup),
      isChange: CHANGE_WORDS.some((w) => title.includes(w)),
    },
    url: detailUrl(detail.id),
  })
}

/** 详情页地址。列表里的相对链接 ./xq/ 要拼在 qgswyyxychdjg/ 后面。 */
export function detailUrl(id) {
  return `${RESULT_PAGE}xq/?id=${encodeURIComponent(id)}`
}

/** 城市取演出地第二级；直辖市第二级写“市辖区”，取第一级；省直辖的县级市取第三级。 */
function cityOf(detail) {
  const [p1, p2, p3] = [detail.performancePlace1, detail.performancePlace2, detail.performancePlace3].map(clean)
  if (p2 && !PLACEHOLDER_PLACE.has(p2)) return normalizeCity(p2)
  if (p1 && MUNICIPALITY.test(p1)) return normalizeCity(p1)
  if (p2 && p3) return normalizeCity(p3)
  return normalizeCity(p1)
}

function clean(value) {
  if (value == null) return null
  const s = String(value).trim()
  return s || null
}

/** 要搜的名字去重。站点按原文模糊搜、拉丁字母不分大小写，所以只按小写去重，不按归一后的名字。 */
function uniqueNames(names) {
  const seen = new Set()
  const out = []
  for (const n of names) {
    const s = String(n ?? '').trim()
    if (!s || seen.has(s.toLowerCase())) continue
    seen.add(s.toLowerCase())
    out.push(s)
  }
  return out
}

// —— 请求 ——

/**
 * 列表按开始日期倒序，第 1 页离今天最远。超过 3 页时取第 1 页和最后 2 页（开演最近的）：
 * 截掉的中间几页，等前面的演完、条数少了，以后几轮能取到；截掉最近的，开演前就再也取不到了。
 */
async function searchAll(ctx, session, searchName, today) {
  const first = await searchPage(ctx, session, searchName, 1, today)
  const items = [...first.items]
  let from = 2
  if (first.totalPage > MAX_PAGES) {
    from = first.totalPage - MAX_PAGES + 2
    ctx.log?.(`文旅部：“${searchName}”今天以后有 ${first.total} 条、${first.totalPage} 页，只取第 1 页和最后 ${MAX_PAGES - 1} 页`)
  }
  for (let page = from; page <= first.totalPage; page++) {
    items.push(...(await searchPage(ctx, session, searchName, page, today)).items)
  }
  return items
}

async function searchPage(ctx, session, searchName, page, today) {
  // 字段顺序和取值照站点表单：页码、每页条数都是字符串
  const payload = {
    pageSize: '15',
    pageNum: String(page),
    performanceName: searchName,
    performancePlace1: '',
    performingBeginTime: today,
    performingEndTime: '',
  }
  const data = await callApi(ctx, session, LIST_URL, payload, RESULT_PAGE)
  if (data == null) return { total: 0, totalPage: 0, items: [] }
  return parseSearchPage(data)
}

async function fetchDetail(ctx, session, id) {
  return callApi(ctx, session, DETAIL_URL, { id }, detailUrl(id))
}

/**
 * 加密发出、解密收回。code 204 返回 null。
 * 用的是存下的旧密钥时，服务端解不开（500）或我们解不开响应，就重取密钥再试一次；
 * 密钥是这次新取的还不行，说明加密方式变了，抛 ApiChangedError。
 */
async function callApi(ctx, session, url, payload, referer) {
  for (;;) {
    const key = await session.get()
    const res = await ctx.client.request({
      method: 'POST',
      url,
      headers: xhrHeaders(referer),
      form: { data: encrypt(JSON.stringify(payload), key.smKey) },
      sendCookies: false,
    })
    let problem
    if (res.status === 500) {
      problem = '服务端解不开请求（HTTP 500）'
    } else if (res.status >= 502 && res.status <= 504) {
      throw new NetworkError('gov', `HTTP ${res.status}`)
    } else if (res.status !== 200) {
      throw new ApiChangedError('gov', `HTTP ${res.status}`)
    } else {
      const body = res.json()
      const code = Number(body?.code)
      if (code === 204) return null
      if (code === 500) {
        problem = `服务端解不开请求（${body.message ?? body.msg ?? 'code 500'}）`
      } else if (code !== 200) {
        throw new ApiChangedError('gov', `返回 code ${body?.code}：${body?.message ?? ''}`)
      } else {
        const data = decryptJson(body.data, key.smKey)
        if (data !== undefined) return data
        problem = '响应解密后不是 JSON'
      }
    }
    if (key.fresh) throw new ApiChangedError('gov', `${problem}，密钥是新取的，加密方式可能变了`)
    ctx.log?.(`文旅部：${problem}，重取密钥`)
    await session.refresh()
  }
}

function decryptJson(cipherText, smKey) {
  if (typeof cipherText !== 'string' || !cipherText) return undefined
  try {
    return JSON.parse(decrypt(cipherText, smKey))
  } catch {
    return undefined
  }
}

function xhrHeaders(referer) {
  return {
    accept: 'application/json, text/javascript, */*; q=0.01',
    origin: BASE,
    referer,
    'x-requested-with': 'XMLHttpRequest',
  }
}

/**
 * 当天的密钥。存在 ctx.kv 的 gov.smKey 里：{ smKey, sendDay, fetchedDay }。
 * sendDay 或 fetchedDay 是北京时间今天就沿用；换天、或者用着解不开，就重取。
 */
function keySession(ctx) {
  let current = null
  return {
    async get() {
      if (current) return current
      const saved = readSaved(await ctx.kv?.get(KV_KEY))
      const today = beijingDate(ctx.now())
      if (saved && (saved.sendDay === today || saved.fetchedDay === today)) {
        current = { smKey: saved.smKey, sendDay: saved.sendDay, fresh: false }
        return current
      }
      return this.refresh()
    },
    async refresh() {
      const { smKey, sendDay } = await fetchKey(ctx)
      await ctx.kv?.set(KV_KEY, { smKey, sendDay, fetchedDay: beijingDate(ctx.now()) })
      current = { smKey, sendDay, fresh: true }
      return current
    },
  }
}

function readSaved(value) {
  let v = value
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return null
    }
  }
  return v && typeof v.smKey === 'string' && v.smKey.length === 16 ? v : null
}

async function fetchKey(ctx) {
  const res = await ctx.client.request({
    method: 'POST',
    url: KEY_URL,
    headers: xhrHeaders(FORM_PAGE),
    body: '',
    sendCookies: false,
  })
  // 取密钥不带加密，5xx 只能是后端或网关出错，按网络错误算
  if (res.status >= 500 && res.status <= 599) throw new NetworkError('gov', `取密钥 HTTP ${res.status}`)
  if (res.status !== 200) throw new ApiChangedError('gov', `取密钥 HTTP ${res.status}`)
  const body = res.json()
  const row = Array.isArray(body?.data) ? body.data[0] : null
  if (Number(body?.code) !== 200 || typeof row?.smKey !== 'string' || row.smKey.length !== 16) {
    throw new ApiChangedError('gov', `取密钥的返回格式变了：${JSON.stringify(body).slice(0, 80)}`)
  }
  return { smKey: row.smKey, sendDay: toDateString(row.sendDay) }
}
