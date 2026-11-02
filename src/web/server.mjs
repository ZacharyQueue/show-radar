// 本机网页服务（docs/design.md“本机网页”）。零依赖，用 node:http。
// 网页能改推送密钥、能触发请求，只给这台电脑上的这个人用：
//   只监听 127.0.0.1；接口要带钥匙才能用。钥匙每次启动重新生成、只在内存里，进程一退就作废；
//   钥匙放在链接的 # 后面（不发给服务器、不进日志），页面存进本端口的 localStorage，每个请求放在 X-Show-Radar 头里发。
//   不用 Cookie：浏览器的 Cookie 不分端口，会被带给本机别的服务；请求头只发给这个页面自己；
//   只认 Host 是 127.0.0.1、localhost 的请求，防 DNS 重绑定；改东西的请求带了 Origin 的，要是本页面；
//   密钥只进不出；不加载外部资源；不记日志。

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as app from '../app.mjs'
import { AppError } from '../app.mjs'

export const DEFAULT_PORT = 7788
const HOST = '127.0.0.1'
// 默认端口被占了往后找，最多找这么多个
const PORT_TRIES = 20
const MAX_BODY = 64 * 1024
// 别的进程在跑一轮时，网页上的“检查各平台”最多等多久
const CHECK_WAIT_MS = 5000
const DIR = path.dirname(fileURLToPath(import.meta.url))
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
}
const HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
}
/** 本机网页自己的地址。只有这一处拼地址，指向的都是 127.0.0.1、localhost，不往外发请求。 */
const local = (host) => `http://${host}`
// 接口要带的请求头，值是钥匙。别的网站的页面要带自定义请求头，浏览器会先问一声（预检），这里不答，请求就发不出来
export const KEY_HEADER = 'x-show-radar'

/**
 * 开本机网页。返回 { url（带钥匙的链接）, port, openBrowser(), close() }。
 * @param {Object} o
 * @param {number} [o.port] 想用的端口
 * @param {boolean} [o.strictPort] 只用这个端口，被占了就报错；不然往后找空的
 * @param {Function} [o.log] 网页上点的那一轮边跑边说的话
 * @param {AbortSignal} [o.signal] 停下时，网页上点的那一轮不再取新的艺人
 */
export async function startWeb({ port = DEFAULT_PORT, strictPort = false, log = () => {}, signal } = {}) {
  // 钥匙不落盘、每次启动换一把：链接会出现在终端、日志、打开浏览器的命令行参数里，漏了也只在这次运行里有用
  const key = crypto.randomBytes(32).toString('hex')
  const server = http.createServer((req, res) => {
    handle(req, res, { key, port: server.address().port, log, signal }).catch((err) => {
      // 读请求正文时对面断开了（关了页面、Ctrl+C 时关连接）：不算出错，悄悄收掉。
      // 只看错误本身：对面断开以后才冒出来的程序错误照样要打出来
      if (err.code === 'ECONNRESET' || err.code === 'ERR_STREAM_PREMATURE_CLOSE') return res.destroy()
      // 走到这里是程序的错，不是用户填错了：照实说，调用栈打在终端里
      console.error(err.stack ?? err.message)
      if (res.destroyed) return
      if (!res.headersSent) json(res, 500, { error: `出错了：${err.message}` })
      else res.end()
    })
  })
  const actual = await listen(server, port, strictPort ? 1 : PORT_TRIES)
  // 钥匙放在 # 后面：浏览器不会把它发给服务器，也不会写进别处的 Referer
  const url = `${local(`${HOST}:${actual}`)}/#key=${key}`
  return {
    url,
    port: actual,
    openBrowser: () => openBrowser(url),
    close: () => new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    }),
  }
}

async function listen(server, port, tries) {
  for (let p = port; p < port + tries && p < 65536; p++) {
    const ok = await new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off('listening', onListening)
        if (err.code === 'EADDRINUSE') resolve(false)
        else if (err.code === 'EACCES') reject(new AppError(`没有权限用 ${p} 号端口（1024 以下要管理员权限）。换一个，比如 --port ${DEFAULT_PORT}`))
        else reject(new AppError(`开不了 ${p} 号端口：${err.code ?? err.message}。换一个试试，比如 --port ${DEFAULT_PORT}`))
      }
      const onListening = () => {
        server.off('error', onError)
        resolve(true)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(p, HOST)
    })
    // 端口写 0 时系统随便给一个，要问它给的是几号
    if (ok) return server.address().port
  }
  if (tries === 1) throw new AppError(`${port} 号端口被占了。换一个，比如 --port ${port + 1}；或者不写 --port，让它自己往后找空的。`)
  throw new AppError(`${port} 到 ${port + tries - 1} 号端口都被占了，用 --port 换一个，比如 --port 8788`)
}

async function handle(req, res, ctx) {
  let url
  try {
    url = new URL(req.url, local(HOST))
  } catch {
    // 请求行写得不像地址：不是这个网页发的，直接拒，不打日志
    return text(res, 400, '地址的写法不对。')
  }
  // DNS 重绑定：别的域名解析到 127.0.0.1 也能连进来，Host 头会露馅。80 号端口时浏览器不写端口
  const allowedHosts = [`${HOST}:${ctx.port}`, `localhost:${ctx.port}`, ...(ctx.port === 80 ? [HOST, 'localhost'] : [])]
  if (!allowedHosts.includes(req.headers.host)) return text(res, 403, '只能用 127.0.0.1 打开。')

  // 页面、脚本、样式里没有要保密的东西，不用钥匙；数据都在接口里
  if (!url.pathname.startsWith('/api/')) {
    const file = req.method === 'GET' && FILES[url.pathname]
    if (!file) return text(res, 404, '没有这个页面。')
    res.writeHead(200, { ...HEADERS, 'Content-Type': file[1] })
    return res.end(fs.readFileSync(path.join(DIR, file[0])))
  }

  if (!sameSecret(req.headers[KEY_HEADER], ctx.key)) {
    return json(res, 401, { error: '链接过期了，用终端里新打印的链接打开。' })
  }
  // 改东西的请求带了 Origin 的，要是本页面（浏览器跨站发的请求一定带）
  const origin = req.headers.origin
  if (req.method !== 'GET' && origin && !allowedHosts.some((h) => origin === local(h))) {
    return json(res, 403, { error: '只接受本页面发来的请求。' })
  }
  try {
    const result = await route(req, url, ctx)
    return json(res, result.status ?? 200, result.body)
  } catch (err) {
    if (err instanceof AppError) return json(res, 400, { error: err.message })
    throw err
  }
}

/** 接口。返回 { status?, body }。 */
async function route(req, url, ctx) {
  let parts
  try {
    parts = url.pathname.split('/').slice(2).map(decodeURIComponent)
  } catch {
    throw new AppError('地址的写法不对。')
  }
  const is = (method, ...names) => req.method === method && parts.length === names.length && names.every((n, i) => n === '*' || n === parts[i])

  if (is('GET', 'state')) return { body: app.state() }
  if (is('POST', 'artists')) {
    const body = await readJson(req)
    return { body: app.follow(body.line) }
  }
  if (is('DELETE', 'artists', '*')) return { body: { removed: app.unfollow(parts[1]) } }
  if (is('POST', 'push', '*')) {
    const body = await readJson(req)
    return { body: await app.savePush(parts[1], body) }
  }
  if (is('POST', 'push', '*', 'test')) {
    const [result] = await app.testPush([parts[1]])
    return { body: result }
  }
  if (is('DELETE', 'push', '*')) return { body: app.removePush(parts[1]) }
  if (is('POST', 'run')) {
    if (app.busyState()) throw new AppError(app.busyState().kind === 'run' ? '正在抓一轮，抓完会自动刷新。' : '正在检查各平台，查完再抓。')
    // 一轮要几分钟到二十几分钟，不等它：网页看 state 里的 busy 知道什么时候抓完
    app.runOnce({ signal: ctx.signal, log: ctx.log }).catch((err) => {
      if (!(err instanceof AppError)) console.error(err.stack ?? err.message)
    })
    return { status: 202, body: { started: true } }
  }
  if (is('POST', 'check')) return { body: await app.check({ signal: ctx.signal, waitMs: CHECK_WAIT_MS, log: ctx.log }) }
  return { status: 404, body: { error: '没有这个接口。' } }
}

async function readJson(req) {
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw new AppError('请求的格式不对。')
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new AppError('填的内容太长了。')
    chunks.push(chunk)
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (body && typeof body === 'object' && !Array.isArray(body)) return body
  } catch {
    // 落到下面
  }
  throw new AppError('请求的格式不对。')
}

/** 比较钥匙，花的时间和对了几位无关。 */
function sameSecret(given, key) {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(key)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function json(res, status, body) {
  res.writeHead(status, { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function text(res, status, body) {
  res.writeHead(status, { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(body)
}

/** 用默认浏览器打开。打不开（服务器上没有桌面）不要紧，终端里有链接。 */
function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // 打不开就算了
  }
}
