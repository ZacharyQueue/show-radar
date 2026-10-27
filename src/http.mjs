// 请求客户端：每个站点一个，管请求间隔、超时、Cookie 和被拦识别。适配器只通过它发请求。

import http from 'node:http'
import https from 'node:https'
import zlib from 'node:zlib'
import { ApiChangedError, BlockedError, NetworkError } from './errors.mjs'

export const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
export const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

const BLOCK_STATUSES = new Set([403, 412, 429, 469])
// 对数据源站点，两次请求至少隔这么久。写死在这里，适配器传更小的值也按它算，保护各平台
export const MIN_GAP_FLOOR_MS = 2000
// 推送通道不是数据源，不受上面的下限约束。只认这几个名字，数据源传 floor: false 也没用
export const PUSH_SITES = new Set(['wecom', 'serverchan', 'wxpusher', 'bark'])

// 除了推送通道，所有请求都只许发往这些域名，在发出去之前查最终的网址：拼字符串、模板都绕不过。
// 推送通道不查，Bark 和企业微信可能是自建的地址。可选的数据源在 clientOptions.hosts 里声明自己的域名
export const SOURCE_SITES = new Set(['damai', 'maoyan', 'showstart'])
const SOURCE_HOSTS = new Set(['mtop.damai.cn', 'm.damai.cn', 'show.maoyan.com', 'm.dianping.com', 'www.showstart.com'])
const MTOP_APIS = new Set(['mtop.damai.wireless.search.search', 'mtop.damai.item.detail.getdetail'])
// 下单、库存、支付、登录、验证码一类的接口
const FORBIDDEN_PATH = /order|cart|buy|pay|login|passport|captcha|subpage|sku|stock/i

/** 不许请求的地址抛错。只读这一条规矩落在这里，不靠各个适配器自觉。 */
export function assertAllowedUrl(url, hosts = []) {
  const u = new URL(url)
  if (!SOURCE_HOSTS.has(u.hostname) && !hosts.includes(u.hostname)) throw new Error(`不许请求的地址：${u.hostname}。数据源只能访问白名单里的域名`)
  // 猫眼把搜索词放在路径的“;k=”一段里，乐队名可能正好带 order、pay 这类词，查之前去掉。
  // 要在解码之前去：名字里的 / 和 ; 编码成了 %2F、%3B，先解码就会被当成分隔符，后半截名字漏出来
  const raw = u.hostname === 'm.dianping.com' || u.hostname === 'show.maoyan.com' ? u.pathname.replace(/;k=[^;/]*/g, '') : u.pathname
  let route
  try {
    route = decodeURIComponent(raw)
  } catch {
    throw new Error(`网址的编码不对，不发：${u.pathname.slice(0, 80)}`)
  }
  if (FORBIDDEN_PATH.test(route)) throw new Error(`不许请求下单、库存、登录一类的接口：${u.pathname}`)
  if (u.hostname === 'mtop.damai.cn') {
    const api = route.split('/')[2]?.toLowerCase()
    if (!MTOP_APIS.has(api)) throw new Error(`不许请求的大麦接口：${api}`)
  }
}

// 最近一次请求数据源的时间，整个进程共用。run、check 放锁之前等到它过了 2 秒，下一个进程才开始请求。
// 进程被杀就等不成，所以每次请求还会通知 onSourceRequest 登记的函数，由它写到磁盘上，下一个进程开始前读
let lastSourceRequestAt = -Infinity
let sourceRequestHook = null
export function msUntilSourceGap(now = Date.now()) {
  return Math.max(0, lastSourceRequestAt + MIN_GAP_FLOOR_MS - now)
}
export function onSourceRequest(fn) {
  sourceRequestHook = fn
}

// 数据源的 clientOptions 只认这几项：sleep、now、transport 这类测试用的口子不许适配器自己塞
const SOURCE_OPTION_KEYS = new Set(['site', 'userAgent', 'minGapMs', 'hosts'])

/** 按适配器的 clientOptions 建请求客户端。推送通道的名字不能拿来当数据源的站点名，多余的选项直接报错。 */
export function createSourceClient(clientOptions) {
  const extra = Object.keys(clientOptions).filter((k) => !SOURCE_OPTION_KEYS.has(k))
  if (extra.length) throw new Error(`数据源的 clientOptions 不认这些项：${extra.join('、')}`)
  if (PUSH_SITES.has(clientOptions.site)) throw new Error(`${clientOptions.site} 是推送通道的名字，数据源不能用`)
  return createClient(clientOptions)
}
// 阿里系滑块和验证码页的特征，出现就算被拦
const BLOCK_MARKERS = ['_____tmd_____/punish', '"action":"captcha"', 'RGV587_ERROR', 'FAIL_SYS_USER_VALIDATE']

/**
 * @param {Object} options
 * @param {string} options.site 站点名，写进错误和日志
 * @param {number} [options.minGapMs] 两次请求的最小间隔，不低于 MIN_GAP_FLOOR_MS
 * @param {boolean} [options.floor] 推送通道传 false，不受间隔下限约束；只对 PUSH_SITES 里的站点有效
 * @param {boolean} [options.retry] 网络出错时重发一次。推送通道传 false：消息可能已经收下，只是回得慢，重发会推两遍
 * @param {string[]} [options.hosts] 可选数据源自己的域名，加进白名单
 * @param {number} [options.timeoutMs]
 * @param {string} [options.localAddress] 绑定的本机地址；默认读 SHOW_RADAR_LOCAL_ADDRESS
 * @param {string} [options.userAgent]
 * @param {Function} [options.transport] 测试时替换真实网络
 * @param {Function} [options.sleep]
 * @param {Function} [options.now]
 */
export function createClient(options) {
  const {
    site,
    minGapMs = 2500,
    timeoutMs = 20000,
    localAddress = process.env.SHOW_RADAR_LOCAL_ADDRESS || undefined,
    userAgent = DESKTOP_UA,
    transport = nodeTransport,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    floor = true,
    retry = true,
    hosts = [],
  } = options
  const isPush = PUSH_SITES.has(site)
  const guarded = !isPush
  const gapMs = floor || !isPush ? Math.max(MIN_GAP_FLOOR_MS, minGapMs) : minGapMs
  // Cookie 按域名分开存：一个客户端可能要访问几个域名（猫眼走 show.maoyan.com 和 m.dianping.com）
  const jars = new Map()
  const jarFor = (url) => {
    const host = new URL(url).hostname
    if (!jars.has(host)) jars.set(host, new Map())
    return jars.get(host)
  }
  let lastAt = -Infinity
  let count = 0

  async function waitGap() {
    const wait = lastAt + gapMs - now()
    if (wait > 0) await sleep(wait)
  }

  /**
   * @param {Object} req
   * @param {string} [req.method]
   * @param {string} req.url
   * @param {Object} [req.headers]
   * @param {*} [req.json] 作为 JSON 正文发送
   * @param {Object} [req.form] 作为表单正文发送
   * @param {string} [req.body] 原样发送
   * @param {boolean} [req.sendCookies] 默认带上本站点攒下的 Cookie
   */
  async function request({ method = 'GET', url, headers = {}, json, form, body, sendCookies = true }) {
    const h = {
      'user-agent': userAgent,
      'accept-language': 'zh-CN,zh;q=0.9',
      'accept-encoding': 'gzip, deflate, br',
      ...lowerKeys(headers),
    }
    let payload = body
    if (json !== undefined) {
      payload = JSON.stringify(json)
      h['content-type'] ??= 'application/json;charset=UTF-8'
    } else if (form !== undefined) {
      payload = new URLSearchParams(form).toString()
      h['content-type'] ??= 'application/x-www-form-urlencoded; charset=UTF-8'
    }
    const cookies = jarFor(url)
    if (sendCookies && cookies.size && h.cookie === undefined) {
      h.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ')
    }

    if (guarded) assertAllowedUrl(url, hosts)
    let lastError
    for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
      await waitGap()
      lastAt = now()
      if (!isPush) {
        lastSourceRequestAt = Date.now()
        sourceRequestHook?.(lastSourceRequestAt)
      }
      count++
      let res
      try {
        res = await transport({ method, url, headers: h, body: payload, timeoutMs, localAddress })
      } catch (err) {
        if (err.code === 'EADDRNOTAVAIL' && localAddress) {
          throw new NetworkError(site, `绑不上 SHOW_RADAR_LOCAL_ADDRESS 写的地址 ${localAddress}：这台电脑现在不是这个地址，查一下局域网地址再改`)
        }
        lastError = err
        continue
      }
      storeCookies(cookies, res.headers['set-cookie'])
      if (BLOCK_STATUSES.has(res.status)) throw new BlockedError(site, `HTTP ${res.status}`)
      if (res.headers.bxpunish === '1') throw new BlockedError(site, '验证码（bxpunish）')
      // 跳到验证页的 302 正文常常是空的，要看跳转地址
      const location = String(res.headers.location ?? '')
      if (res.status >= 300 && res.status < 400 && /punish|captcha|verify\.meituan|yoda/i.test(location)) {
        throw new BlockedError(site, `跳到验证页（${location.slice(0, 60)}）`)
      }
      const marker = BLOCK_MARKERS.find((m) => res.text.includes(m))
      if (marker) throw new BlockedError(site, `验证码或滑块（${marker}）`)
      return {
        status: res.status,
        headers: res.headers,
        text: res.text,
        json() {
          try {
            return JSON.parse(res.text)
          } catch {
            throw new ApiChangedError(site, `返回的不是 JSON：${res.text.slice(0, 80)}`)
          }
        },
      }
    }
    throw new NetworkError(site, lastError?.message ?? '未知错误')
  }

  function storeCookies(jar, setCookie) {
    for (const line of [].concat(setCookie ?? [])) {
      const pair = line.split(';')[0]
      const i = pair.indexOf('=')
      if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
    }
  }

  return {
    site,
    request,
    /** 某个网址所在域名的 Cookie */
    cookiesFor: (url) => jarFor(url),
    get requestCount() {
      return count
    },
  }
}

/** 真实网络：node:http/https，不跟随跳转，按 content-encoding 解压，正文按 UTF-8 读。 */
export function nodeTransport({ method, url, headers, body, timeoutMs, localAddress }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'http:' ? http : https
    const req = lib.request(
      u,
      { method, headers: body != null ? { ...headers, 'content-length': Buffer.byteLength(body) } : headers, localAddress },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('error', reject)
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, headers: res.headers, text: decode(Buffer.concat(chunks), res.headers['content-encoding']) })
          } catch (err) {
            reject(err)
          }
        })
      },
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`超过 ${timeoutMs / 1000} 秒没有响应`)))
    req.on('error', reject)
    if (body != null) req.write(body)
    req.end()
  })
}

function decode(buf, encoding) {
  if (encoding === 'gzip') return zlib.gunzipSync(buf).toString('utf8')
  if (encoding === 'deflate') return zlib.inflateSync(buf).toString('utf8')
  if (encoding === 'br') return zlib.brotliDecompressSync(buf).toString('utf8')
  return buf.toString('utf8')
}

function lowerKeys(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k.toLowerCase()] = v
  return out
}
