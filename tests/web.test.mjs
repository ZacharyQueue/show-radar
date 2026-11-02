// 本机网页：钥匙、Host、Origin、密钥只进不出；命令行和网页共用的推送填写规矩和艺人清单。不联网。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

// 运行目录在导入之前定下来：config.mjs 导入时就读环境变量
const RT = fs.mkdtempSync(path.join(os.tmpdir(), 'show-radar-web-'))
process.env.SHOW_RADAR_RUNTIME = RT
fs.writeFileSync(path.join(RT, 'artists.txt'), '')
const { startWeb } = await import('../src/web/server.mjs')
const app = await import('../src/app.mjs')
const { loadSecrets, saveSecrets } = await import('../src/config.mjs')

let web
let key

before(async () => {
  web = await startWeb({ port: 0 })
  key = new URLSearchParams(new URL(web.url).hash.slice(1)).get('key')
})

after(async () => {
  await web.close()
})

/** 发一个请求。Host 头 fetch 改不了，所以用 node:http。 */
function request(method, pathname, { headers = {}, body, port = web.port } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try {
          json = JSON.parse(text)
        } catch {
          // 不是 JSON
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json })
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body))
    req.end()
  })
}

/** 带着钥匙，照本页面的样子发。 */
const call = (method, pathname, body) =>
  request(method, pathname, {
    headers: { 'X-Show-Radar': key, Origin: `http://127.0.0.1:${web.port}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body,
  })
const getState = async () => (await call('GET', '/api/state')).json

test('钥匙：放在链接的 # 后面，接口要在请求头里带上；不用 Cookie，不落盘，每次启动都换', async () => {
  assert.match(web.url, new RegExp(`^http://127\\.0\\.0\\.1:${web.port}/#key=[0-9a-f]{64}$`))
  // 页面本身没有要保密的东西，谁都能拿；数据在接口里
  const page = await request('GET', '/')
  assert.equal(page.status, 200)
  assert.equal(page.headers['set-cookie'], undefined)
  for (const file of ['/app.js', '/app.css']) assert.equal((await request('GET', file)).status, 200)
  const noKey = await request('GET', '/api/state')
  assert.equal(noKey.status, 401)
  assert.match(noKey.json.error, /链接过期了/)
  assert.equal((await request('GET', '/api/state', { headers: { 'X-Show-Radar': '1' } })).status, 401)
  assert.equal((await request('GET', '/api/state', { headers: { Cookie: `show_radar_${web.port}=${key}` } })).status, 401, 'Cookie 不算数')
  assert.equal((await call('GET', '/api/state')).status, 200)
  assert.ok(!fs.readdirSync(RT).some((f) => fs.readFileSync(path.join(RT, f), 'utf8').includes(key)), '钥匙没写进运行目录')

  const other = await startWeb({ port: 0 })
  try {
    const otherKey = new URLSearchParams(new URL(other.url).hash.slice(1)).get('key')
    assert.notEqual(otherKey, key, '另起一个就是另一把钥匙')
    const stale = await request('GET', '/api/state', { port: other.port, headers: { 'X-Show-Radar': key } })
    assert.equal(stale.status, 401, '上一次运行的钥匙进不来')
  } finally {
    await other.close()
  }
})

test('写了端口就只用这个端口，被占了说清楚；没写才往后找', async () => {
  await assert.rejects(startWeb({ port: web.port, strictPort: true }), /号端口被占了。换一个/)
  const next = await startWeb({ port: web.port })
  try {
    assert.notEqual(next.port, web.port)
  } finally {
    await next.close()
  }
})

test('只认 127.0.0.1 和 localhost 的 Host：别的域名解析过来也进不来', async () => {
  const evil = await request('GET', '/api/state', { headers: { Host: `evil.example:${web.port}`, 'X-Show-Radar': key } })
  assert.equal(evil.status, 403)
  assert.equal((await request('GET', '/', { headers: { Host: `evil.example:${web.port}` } })).status, 403, '页面也不给')
  const local = await request('GET', '/api/state', { headers: { Host: `localhost:${web.port}`, 'X-Show-Radar': key } })
  assert.equal(local.status, 200)
})

test('改东西的请求：没带钥匙、Origin 是别的网站，都拒绝', async () => {
  const noKey = await request('POST', '/api/artists', { headers: { 'Content-Type': 'application/json' }, body: { line: '告五人' } })
  assert.equal(noKey.status, 401)
  const foreign = await request('POST', '/api/artists', {
    headers: { 'X-Show-Radar': key, Origin: 'http://evil.example', 'Content-Type': 'application/json' },
    body: { line: '告五人' },
  })
  assert.equal(foreign.status, 403)
  assert.equal(fs.readFileSync(path.join(RT, 'artists.txt'), 'utf8').trim(), '', '被拒的请求什么都没改')
  const notJson = await request('POST', '/api/artists', { headers: { 'X-Show-Radar': key }, body: 'line=x' })
  assert.equal(notJson.status, 400)
  const huge = await call('POST', '/api/artists', { line: 'x'.repeat(70 * 1024) })
  assert.equal(huge.status, 400)
})

test('页面带着内容安全策略，不加载外部资源', async () => {
  const page = await request('GET', '/')
  assert.match(page.headers['content-security-policy'], /default-src 'none'; script-src 'self'/)
  assert.equal(page.headers['x-frame-options'], 'DENY')
  for (const file of ['index.html', 'app.js', 'app.css']) {
    const text = fs.readFileSync(new URL(`../src/web/${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(text, /<script[^>]+src="https?:|<link[^>]+href="https?:|@import|url\(\s*["']?https?:/, `${file} 引了外部资源`)
  }
  assert.equal((await request('GET', '/nope')).status, 404)
  assert.equal((await call('GET', '/api/nope')).json.error, '没有这个接口。')
})

test('网页上加艺人、去掉艺人，和命令行改的是同一份清单', async () => {
  const added = await call('POST', '/api/artists', { line: '告五人、Accusefive' })
  assert.equal(added.status, 200)
  assert.equal(added.json.added, true)
  assert.deepEqual(added.json.aliases, ['Accusefive'])
  assert.match(fs.readFileSync(path.join(RT, 'artists.txt'), 'utf8'), /告五人、Accusefive/)
  assert.deepEqual(
    (await getState()).artists.map((a) => [a.key, a.checked]),
    [['告五人', false]],
  )
  const dup = await call('POST', '/api/artists', { line: 'Accusefive' })
  assert.equal(dup.status, 400)
  assert.match(dup.json.error, /已经是 告五人 的名字或别名/)
  const removed = await call('DELETE', `/api/artists/${encodeURIComponent('accusefive')}`)
  assert.equal(removed.json.removed, '告五人')
  assert.equal((await call('DELETE', `/api/artists/${encodeURIComponent('告五人')}`)).status, 400)
  const malformed = await call('DELETE', '/api/artists/%E0%A4%A')
  assert.equal(malformed.status, 400)
  assert.equal(malformed.json.error, '地址的写法不对。')
})

test('点 × 去掉的是主名一字不差的那一行，不是别名撞上的别的行', async () => {
  fs.writeFileSync(path.join(RT, 'artists.txt'), '陈奕迅、Eason\nEason\n')
  // 手改的清单里“Eason”和“陈奕迅”的别名算同一位：只跟踪前面那一行，说清楚
  const state = await getState()
  assert.deepEqual(state.artists.map((a) => a.key), ['陈奕迅'])
  assert.deepEqual(state.untracked, ['Eason'])
  assert.match(state.warnings[0], /Eason 和 陈奕迅 算同一位艺人，只跟踪 陈奕迅。删掉 Eason/)
  const r = await call('DELETE', `/api/artists/${encodeURIComponent('Eason')}`)
  assert.equal(r.json.removed, 'Eason')
  assert.equal(fs.readFileSync(path.join(RT, 'artists.txt'), 'utf8').trim(), '陈奕迅、Eason')
  fs.writeFileSync(path.join(RT, 'artists.txt'), '')
})

test('有人直接改了 artists.txt：网页照文件显示，不用等下一轮同步', async () => {
  fs.writeFileSync(path.join(RT, 'artists.txt'), '告五人\n五月天、Mayday\n')
  const state = await getState()
  assert.deepEqual(
    state.artists.map((a) => [a.key, a.aliases, a.checked]),
    [
      ['告五人', [], false],
      ['五月天', ['Mayday'], false],
    ],
  )
  assert.deepEqual(state.untracked, [])
  fs.writeFileSync(path.join(RT, 'artists.txt'), '')
})

test('密钥只进不出：state 里只说配没配好，不给值', async () => {
  fs.writeFileSync(path.join(RT, 'secrets.env'), 'SMTP_USER=me@qq.com\nSMTP_PASS=abcdabcdabcdabcd\nSERVERCHAN_SENDKEY=SCTsecretkey123\nWECOM_CORP_ID=ww1\n')
  const res = await call('GET', '/api/state')
  assert.doesNotMatch(res.text, /abcdabcdabcdabcd|SCTsecretkey123/)
  const byId = Object.fromEntries(res.json.push.map((c) => [c.id, c]))
  assert.equal(byId.email.state, 'ready')
  assert.equal(byId.email.summary, 'me@qq.com 发给自己')
  assert.equal(byId.serverchan.state, 'ready')
  assert.equal(byId.wecom.state, 'partial')
  assert.equal(byId.wecom.problem, '没配全，重新填一遍')
  assert.equal(res.json.push[0].id, 'email', '邮件排第一')
  assert.ok(res.json.push.every((c) => c.fields.every((f) => !('check' in f))), '检查规则留在服务端')

  const bad = await call('POST', '/api/push/serverchan', { sendKey: 'abc' })
  assert.equal(bad.status, 400)
  assert.match(bad.json.error, /SendKey 应该是/)
  assert.match(fs.readFileSync(path.join(RT, 'secrets.env'), 'utf8'), /SCTsecretkey123/, '填错了不改原来的')

  const gone = await call('DELETE', '/api/push/email')
  assert.equal(gone.json.removed, '邮件')
  assert.deepEqual(gone.json.left, ['Server酱'])
  assert.deepEqual(gone.json.fromEnv, [])
  assert.doesNotMatch(fs.readFileSync(path.join(RT, 'secrets.env'), 'utf8'), /SMTP_/)
  assert.equal((await call('DELETE', '/api/push/nope')).status, 400)
})

test('填的值里带换行写不进 secrets.env：不能借它多写一行 SMTP_HOST，把授权码送到别处', async () => {
  fs.writeFileSync(path.join(RT, 'secrets.env'), 'SMTP_USER=me@qq.com\nSMTP_PASS=abcdabcdabcdabcd\n')
  const r = await call('POST', '/api/push/wecom', { corpId: 'ww1', agentId: '1', secret: 's', toUser: 'me\nSMTP_HOST=evil.example' })
  assert.equal(r.status, 400)
  assert.match(r.json.error, /换行或看不见的控制字符/)
  assert.doesNotMatch(fs.readFileSync(path.join(RT, 'secrets.env'), 'utf8'), /evil|WECOM/)
  // 第二道防线：直接调 saveSecrets 也不行
  assert.throws(() => saveSecrets({ WECOM_TO_USER: 'me\rSMTP_HOST=evil.example' }), /换行或控制字符/)
  // 认得出的邮箱不看 SMTP_HOST：手改了文件也送不到别处
  const { CHANNELS } = await import('../src/notify/index.mjs')
  const email = CHANNELS.find((c) => c.id === 'email')
  assert.equal(email.make({ SMTP_USER: 'me@qq.com', SMTP_PASS: 'x', SMTP_HOST: 'smtp.evil.example' }).host, 'smtp.qq.com')
  assert.equal(email.make({ SMTP_USER: 'me@example.org', SMTP_PASS: 'x', SMTP_HOST: 'smtp.example.org' }).host, 'smtp.example.org')
})

test('开头或结尾本来就是引号的密钥，存进去读回来不变', () => {
  for (const pass of ['abc"', "'abc", '"', '"abc"', 'a=b#c']) {
    saveSecrets({ SMTP_PASS: pass })
    assert.equal(loadSecrets().SMTP_PASS, pass)
  }
  saveSecrets({ SMTP_PASS: null })
})

test('去掉企业微信时，存着的 access_token 一起清掉；环境变量里还有密钥时说清楚', async () => {
  const { openStore } = await import('../src/store.mjs')
  const db = path.join(RT, 'radar.sqlite')
  let store = openStore(db)
  store.kv.set('wecom.token', JSON.stringify({ token: 'T', expiresAt: Date.now() + 7e6 }))
  store.close()
  saveSecrets({ WECOM_CORP_ID: 'ww1', WECOM_AGENT_ID: '1', WECOM_SECRET: 's', WECOM_TO_USER: 'me' })
  assert.deepEqual(app.removePush('wecom').fromEnv, [])
  store = openStore(db)
  assert.equal(store.kv.get('wecom.token'), null)
  store.close()

  saveSecrets({ BARK_KEY: 'k' })
  process.env.BARK_KEY = 'fromenv'
  try {
    const r = app.removePush('bark')
    assert.deepEqual(r.fromEnv, ['BARK_KEY'])
    assert.ok(r.left.includes('Bark'))
  } finally {
    delete process.env.BARK_KEY
  }
})

test('Bark 自建服务器的地址里带着用户名密码时，state 只给主机名', async () => {
  fs.writeFileSync(path.join(RT, 'secrets.env'), 'BARK_KEY=abc\nBARK_SERVER=https://admin:pw@bark.example.com\n')
  const res = await call('GET', '/api/state')
  assert.doesNotMatch(res.text, /admin|pw@|"abc"/)
  assert.equal(res.json.push.find((c) => c.id === 'bark').summary, '自建服务器 bark.example.com')
  assert.equal(res.json.push.find((c) => c.id === 'bark').fields[0].secret, true, '地址里带着设备 key，输入时不显示')
})

test('请求行写得不像地址：直接 400，不当成程序出错', async () => {
  const reply = await new Promise((resolve, reject) => {
    const socket = net.connect(web.port, '127.0.0.1', () => socket.write('GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'))
    let data = ''
    socket.on('data', (c) => (data += c))
    socket.on('end', () => resolve(data))
    socket.on('error', reject)
  })
  assert.match(reply, /^HTTP\/1\.1 400/)
})

test('清单是空的时“现在抓一轮”不请求任何平台，说清先加艺人', async () => {
  fs.writeFileSync(path.join(RT, 'artists.txt'), '')
  const r = await call('POST', '/api/run')
  assert.equal(r.status, 202)
  let state
  for (let i = 0; i < 50; i++) {
    state = await getState()
    if (!state.busy) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(state.busy, null)
  assert.match(state.lastRound.notes[0], /艺人清单是空的/)
})

test('推送填写的规矩只有一份：命令行一项项问，网页整张表单交，结果一样', () => {
  assert.deepEqual(app.validatePush('email', { user: ' me@qq.com ', pass: 'p' }), { SMTP_USER: 'me@qq.com', SMTP_PASS: 'p', MAIL_TO: null, SMTP_HOST: null })
  assert.deepEqual(app.validatePush('email', { user: 'me@example.org', pass: 'p', host: 'smtp.example.org', to: 'you@qq.com' }), {
    SMTP_USER: 'me@example.org',
    SMTP_PASS: 'p',
    MAIL_TO: 'you@qq.com',
    SMTP_HOST: 'smtp.example.org',
  })
  // QQ 邮箱填了发信服务器也不用，免得把授权码送到别处
  assert.equal(app.validatePush('email', { user: 'me@qq.com', pass: 'p', host: 'smtp.evil.example' }).SMTP_HOST, null)
  assert.throws(() => app.validatePush('email', { user: 'me@example.org', pass: 'p' }), /认不出这个邮箱的发信服务器/)
  assert.throws(() => app.validatePush('email', { user: 'me@qq.com' }), /授权码是空的，没保存/)
  assert.throws(() => app.validatePush('email', { user: 'me@qq.com', pass: 'p', to: 'x' }), /收信邮箱的格式不对/)
  assert.deepEqual(app.validatePush('bark', { url: 'https://bark.example.com/abc123/' }), { BARK_KEY: 'abc123', BARK_SERVER: 'https://bark.example.com' })
  assert.deepEqual(app.validatePush('bark', { url: 'https://api.day.app/abc123/' }), { BARK_KEY: 'abc123', BARK_SERVER: null })
  assert.throws(() => app.validatePush('wecom', { corpId: 'ww1', agentId: '1', secret: 's' }), /有一项是空的/)
  assert.throws(() => app.validatePush('nope', {}), /没有这个推送通道/)

  // 命令行逐项检查时，发信服务器只在认不出邮箱后缀时才问
  const email = app.PUSH_CHANNELS.find((c) => c.id === 'email')
  const host = email.fields.find((f) => f.name === 'host')
  assert.equal(host.applies({ user: 'me@qq.com' }), false)
  assert.equal(app.checkPushField(host, '', { user: 'me@qq.com' }), null)
  assert.equal(app.checkPushField(host, 'bad host', { user: 'me@example.org' }), '发信服务器的写法不对')
  // 认不出的邮箱，发信服务器空着当场就说，不等到最后
  assert.match(app.checkPushField(host, '', { user: 'me@example.org' }), /认不出这个邮箱的发信服务器/)
  const user = email.fields.find((f) => f.name === 'user')
  assert.match(app.checkPushField(user, 'me@qq.com\u0000', {}), /控制字符/)
})

test('手改的清单里两行算同一位：已经在跟踪的那行优先，别名撞上也算', async () => {
  const { limitArtists, parseArtists } = await import('../src/config.mjs')
  // 后一行的别名撞上前一行的主名，也是同一位
  const a = limitArtists(parseArtists('Foo\nBar、Foo'))
  assert.deepEqual(a.artists.map((x) => x.key), ['Foo'])
  assert.match(a.warnings[0], /Bar 和 Foo 算同一位艺人/)
  // 在跟踪的是后面那行：留它，不管顺序
  const b = limitArtists(parseArtists('回春丹\n回春丹乐队'), new Set(['回春丹乐队']))
  assert.deepEqual(b.artists.map((x) => x.key), ['回春丹乐队'])
  assert.match(b.warnings[0], /回春丹 和 回春丹乐队 算同一位艺人，只跟踪 回春丹乐队/)
})

test('开售提醒先按清单同步，但清单是空的（误删、写到一半）不同步，免得停掉所有人', async () => {
  const { openStore } = await import('../src/store.mjs')
  const db = path.join(RT, 'radar.sqlite')
  fs.writeFileSync(path.join(RT, 'artists.txt'), '甲\n乙\n')
  app.syncNow()
  fs.writeFileSync(path.join(RT, 'artists.txt'), '')
  await app.remindOnce({ log: () => {} })
  let store = openStore(db)
  assert.deepEqual(store.activeArtists().map((a) => a.key).sort(), ['乙', '甲'].sort())
  store.close()
  // 清单里删了乙：下一次提醒之前就停掉
  fs.writeFileSync(path.join(RT, 'artists.txt'), '甲\n')
  await app.remindOnce({ log: () => {} })
  store = openStore(db)
  assert.deepEqual(store.activeArtists().map((a) => a.key), ['甲'])
  store.close()
  fs.writeFileSync(path.join(RT, 'artists.txt'), '')
  app.syncNow()
})

test('环境变量里还留着这个通道的部分密钥时，去掉它要说清楚', () => {
  saveSecrets({ WECOM_CORP_ID: 'ww1', WECOM_AGENT_ID: '1', WECOM_TO_USER: 'me' })
  process.env.WECOM_SECRET = 'fromenv'
  try {
    assert.deepEqual(app.removePush('wecom').fromEnv, ['WECOM_SECRET'])
  } finally {
    delete process.env.WECOM_SECRET
  }
})

test('secrets.env：手写的 export 前缀也认；键名不对、值里有控制字符都不存', () => {
  fs.writeFileSync(path.join(RT, 'secrets.env'), 'export BARK_KEY=handwritten\n')
  assert.equal(loadSecrets().BARK_KEY, 'handwritten')
  saveSecrets({ BARK_KEY: 'new' })
  const text = fs.readFileSync(path.join(RT, 'secrets.env'), 'utf8')
  assert.doesNotMatch(text, /export/, '换掉手写的那行，不留两行')
  assert.equal(loadSecrets().BARK_KEY, 'new')
  assert.throws(() => saveSecrets({ bark_key: 'x' }), /不是密钥的键名/)
  assert.throws(() => saveSecrets({ BARK_KEY: 'a\x1bb' }), /换行或控制字符/)
  saveSecrets({ BARK_KEY: null })
})

test('check 收到停止信号时没开始就说一声，不打调用栈', async () => {
  await assert.rejects(app.check({ signal: AbortSignal.abort() }), (err) => err instanceof app.AppError && /收到停止信号，没开始检查/.test(err.message))
})

test('推送总开关：暂停、恢复都走同一个开关，网页状态里看得到', async () => {
  const paused = await call('POST', '/api/pause')
  assert.equal(paused.status, 200)
  assert.ok(paused.json.pausedAt > 0)
  assert.equal((await getState()).pushPausedAt, paused.json.pausedAt)
  assert.equal(app.pushPausedAt(), paused.json.pausedAt, '命令行看到的是同一个开关')
  assert.equal((await call('POST', '/api/pause')).json.pausedAt, paused.json.pausedAt, '再按一次暂停，暂停的时刻不变')
  const resumed = await call('DELETE', '/api/pause')
  assert.equal(resumed.status, 200)
  assert.equal(resumed.json.delivered, 0, '没有攒着的消息')
  assert.equal((await getState()).pushPausedAt, null)
})
