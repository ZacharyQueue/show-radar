// 邮件通道：用本机的假 SMTP 服务器测一问一答，不联网。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { createEmail, isEmail, message, smtpHostFor } from '../src/notify/email.mjs'
import { inspectChannels } from '../src/notify/index.mjs'

/**
 * 起一个假的 SMTP 服务器。auth 是 EHLO 里报的登录方式；reject 是 { 命令开头: 回复 }，碰到就回这个错。
 * 返回 { connect, received }：received 记下每条命令和信的内容。
 */
async function fakeSmtp({ auth = 'LOGIN PLAIN', reject = {} } = {}) {
  const received = { commands: [], data: '' }
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8')
    socket.write('220 fake.smtp ESMTP ready\r\n')
    let buffer = ''
    let inData = false
    let loginStep = 0
    socket.on('data', (chunk) => {
      buffer += chunk
      let i
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i)
        buffer = buffer.slice(i + 2)
        if (inData) {
          if (line === '.') {
            inData = false
            socket.write('250 OK queued\r\n')
          } else received.data += line + '\r\n'
          continue
        }
        received.commands.push(line)
        const hit = Object.keys(reject).find((k) => line.startsWith(k))
        if (hit) {
          socket.write(`${reject[hit]}\r\n`)
          continue
        }
        if (line.startsWith('EHLO')) socket.write(`250-fake.smtp\r\n250-AUTH ${auth}\r\n250 8BITMIME\r\n`)
        else if (line.startsWith('AUTH PLAIN')) socket.write('235 Authentication successful\r\n')
        else if (line === 'AUTH LOGIN') {
          loginStep = 1
          socket.write('334 VXNlcm5hbWU6\r\n')
        } else if (loginStep === 1) {
          loginStep = 2
          socket.write('334 UGFzc3dvcmQ6\r\n')
        } else if (loginStep === 2) {
          loginStep = 0
          socket.write('235 Authentication successful\r\n')
        } else if (line.startsWith('MAIL FROM') || line.startsWith('RCPT TO')) socket.write('250 OK\r\n')
        else if (line === 'DATA') {
          inData = true
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n')
        } else if (line === 'QUIT') socket.end('221 Bye\r\n')
        else socket.write('502 Unknown\r\n')
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { connect: () => net.connect({ host: '127.0.0.1', port }), received, close: () => server.close() }
}

const decodeWord = (s) => Buffer.from(s.match(/=\?UTF-8\?B\?([^?]+)\?=/)[1], 'base64').toString('utf8')

test('认得出常见邮箱的发信服务器', () => {
  assert.equal(smtpHostFor('12345@qq.com'), 'smtp.qq.com')
  assert.equal(smtpHostFor('a@Foxmail.com'), 'smtp.qq.com')
  assert.equal(smtpHostFor('a@163.com'), 'smtp.163.com')
  assert.equal(smtpHostFor('a@example.org'), null)
  assert.ok(isEmail('a.b+c@qq.com'))
  assert.ok(!isEmail('qq.com') && !isEmail('a@b') && !isEmail('a b@qq.com'))
})

test('AUTH PLAIN 一步登录，发出一封主题和正文都是 UTF-8 的信', async () => {
  const smtp = await fakeSmtp()
  try {
    const mail = createEmail({ user: 'me@qq.com', pass: 'abcdabcdabcdabcd', connect: smtp.connect })
    assert.equal(mail.batch, true, '邮件只收合成的一条')
    await mail.send({ short: '薛之谦·无锡 待开票 10月27日 17:17', text: '10月27日（周二）17:17 开售（大麦）\n无锡奥体', url: 'https://m.damai.cn/x' })
    const auth = smtp.received.commands.find((c) => c.startsWith('AUTH PLAIN'))
    assert.equal(Buffer.from(auth.split(' ')[2], 'base64').toString(), '\0me@qq.com\0abcdabcdabcdabcd')
    assert.ok(smtp.received.commands.includes('MAIL FROM:<me@qq.com>'))
    assert.ok(smtp.received.commands.includes('RCPT TO:<me@qq.com>'), '默认发给自己')
    const [head, body] = smtp.received.data.split('\r\n\r\n')
    assert.equal(decodeWord(head.match(/^Subject: (.*)$/m)[1]), '薛之谦·无锡 待开票 10月27日 17:17')
    const text = Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')
    assert.match(text, /17:17 开售（大麦）\r\n无锡奥体\r\n\r\n链接：https:\/\/m\.damai\.cn\/x/)
  } finally {
    smtp.close()
  }
})

test('服务器只支持 AUTH LOGIN 时分两步登录', async () => {
  const smtp = await fakeSmtp({ auth: 'LOGIN' })
  try {
    await createEmail({ user: 'me@163.com', pass: 'p', to: 'other@qq.com', connect: smtp.connect }).send({ short: 't', text: 'x' })
    assert.deepEqual(smtp.received.commands.slice(1, 4), ['AUTH LOGIN', Buffer.from('me@163.com').toString('base64'), Buffer.from('p').toString('base64')])
    assert.ok(smtp.received.commands.includes('RCPT TO:<other@qq.com>'))
  } finally {
    smtp.close()
  }
})

test('授权码不对时说清是哪一步、该怎么办，错误里不带授权码', async () => {
  const smtp = await fakeSmtp({ reject: { 'AUTH PLAIN': '535 Login fail. Account is abnormal, service is not open, password is incorrect' } })
  try {
    const err = await createEmail({ user: 'me@qq.com', pass: 'SECRETCODE123456', connect: smtp.connect })
      .send({ short: 't', text: 'x' })
      .catch((e) => e)
    assert.match(err.message, /登录这一步回 535/)
    assert.match(err.message, /授权码不是网页登录密码/)
    assert.doesNotMatch(err.message, /SECRETCODE/)
  } finally {
    smtp.close()
  }
})

test('连不上发信服务器时说清楚', async () => {
  const closed = net.createServer()
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve))
  const { port } = closed.address()
  closed.close()
  const err = await createEmail({ user: 'me@qq.com', pass: 'p', connect: () => net.connect({ host: '127.0.0.1', port }) })
    .send({ short: 't', text: 'x' })
    .catch((e) => e)
  assert.match(err.message, /连不上发信服务器|断开了连接/)
})

test('主题里的换行去掉，拼不出别的邮件头；正文的 base64 每行不超过 76 个字', () => {
  const raw = message({ from: 'me@qq.com', to: 'me@qq.com', subject: '乐队名\r\nBcc: evil@example.com', body: '长'.repeat(200) })
  const [head, body] = raw.split('\r\n\r\n')
  assert.doesNotMatch(head, /^Bcc:/m)
  assert.equal(decodeWord(head.match(/^Subject: (.*)$/m)[1]), '乐队名 Bcc: evil@example.com')
  assert.ok(body.split('\r\n').every((l) => l.length <= 76))
  assert.ok(!body.split('\r\n').some((l) => l.startsWith('.')), 'base64 里没有点号，不用转义')
})

test('邮件通道的配置检查：邮箱格式、认不出的服务器', () => {
  assert.deepEqual(inspectChannels({ SMTP_USER: 'me@qq.com', SMTP_PASS: 'x' }).ready.map((c) => c.id), ['email'])
  assert.match(inspectChannels({ SMTP_USER: 'me', SMTP_PASS: 'x' }).problems[0], /要写完整的邮箱地址/)
  assert.match(inspectChannels({ SMTP_USER: 'me@example.org', SMTP_PASS: 'x' }).problems[0], /在 SMTP_HOST 里写上/)
  assert.deepEqual(inspectChannels({ SMTP_USER: 'me@example.org', SMTP_PASS: 'x', SMTP_HOST: 'smtp.example.org' }).ready.map((c) => c.id), ['email'])
  assert.match(inspectChannels({ SMTP_USER: 'me@qq.com' }).problems[0], /还缺 SMTP_PASS/)
})

test('服务器接了连接却不说话：超时报错，连接马上关掉，不让进程挂着', async () => {
  let serverSide = null
  const closed = new Promise((resolve) => {
    const server = net.createServer((socket) => {
      serverSide = socket
      socket.on('end', () => {}) // 收到对面的 FIN 也不理，只等对面强行断开
      socket.on('close', () => {
        server.close()
        resolve()
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      createEmail({ user: 'me@qq.com', pass: 'p', connect: () => net.connect({ host: '127.0.0.1', port }), timeouts: { step: 100, data: 100 } })
        .send({ short: 't', text: 'x' })
        .catch((err) => assert.match(err.message, /连接这一步，发信服务器 0 秒没有回应/))
    })
  })
  await closed
  assert.ok(serverSide, '连接被关掉了')
})

test('合成的那条正文里已经带着链接时，信末不再补一个', async () => {
  const smtp = await fakeSmtp()
  try {
    const mail = createEmail({ user: 'me@qq.com', pass: 'p', connect: smtp.connect })
    await mail.send({ short: 'A 等2条', text: 'A\n链接：https://m.damai.cn/A\n\nB\n链接：https://m.damai.cn/B', url: 'https://m.damai.cn/A' })
    const body = Buffer.from(smtp.received.data.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8')
    assert.equal(body.match(/m\.damai\.cn\/A/g).length, 1)
    assert.ok(body.trimEnd().endsWith('https://m.damai.cn/B'))
  } finally {
    smtp.close()
  }
})

test('环境变量里碰巧有 SMTP_HOST 这类名字，不会盖过 secrets.env 里的邮件设置', async () => {
  const { loadSecrets } = await import('../src/config.mjs')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'show-radar-env-')), 'secrets.env')
  fs.writeFileSync(file, 'SMTP_USER=me@qq.com\nSMTP_PASS=p\n')
  const saved = { SMTP_HOST: process.env.SMTP_HOST, SMTP_USER: process.env.SMTP_USER }
  process.env.SMTP_HOST = 'smtp.company.example'
  process.env.SMTP_USER = 'other@company.example'
  try {
    const s = loadSecrets(file)
    assert.equal(s.SMTP_HOST, undefined)
    assert.equal(s.SMTP_USER, 'me@qq.com')
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  }
})
