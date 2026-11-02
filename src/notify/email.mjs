// 邮件通道：用用户自己的邮箱给自己发信。不用装软件：QQ 邮箱的信在微信里打开“QQ邮箱提醒”就能收，
// 别的邮箱用手机自带的邮件 App。发信走 SMTP，465 端口直接 SSL，用 Node 自带的 node:tls，不加依赖。
// 和 Server酱 一样只收合成的一条（batch）：一轮一封，免得十几封塞满收件箱。

import { randomUUID } from 'node:crypto'
import tls from 'node:tls'

// 常见邮箱按后缀找发信服务器，都是 465 端口的 SSL。别的邮箱在 SMTP_HOST 里写
const KNOWN_HOSTS = {
  'qq.com': 'smtp.qq.com',
  'foxmail.com': 'smtp.qq.com',
  'vip.qq.com': 'smtp.qq.com',
  '163.com': 'smtp.163.com',
  '126.com': 'smtp.126.com',
}

/** 按邮箱后缀找发信服务器，认不出返回 null。 */
export function smtpHostFor(address) {
  const domain = String(address).split('@')[1]?.toLowerCase()
  return KNOWN_HOSTS[domain] ?? null
}

export function isEmail(text) {
  return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(String(text))
}

/**
 * @param {Object} o
 * @param {string} o.user 发信邮箱（完整地址），也是 SMTP 登录名
 * @param {string} o.pass 授权码，不是网页登录密码
 * @param {string} [o.to] 收信邮箱，默认发给自己
 * @param {string} [o.host] 发信服务器，默认按邮箱后缀找
 * @param {Function} [o.connect] 测试时替换真实连接：() => socket
 * @param {Object} [o.timeouts] 测试时改短：{ step, data }
 */
export function createEmail({ user, pass, to = user, host = smtpHostFor(user), connect, timeouts }) {
  if (!host) throw new Error(`认不出 ${user} 的发信服务器，在 SMTP_HOST 里写上（一般是 smtp. 加邮箱后缀）`)
  const open = connect ?? (() => tls.connect({ host, port: 465, servername: host }))
  return {
    name: '邮件',
    batch: true,
    // 授权码会交给这台服务器，测试里核对用
    host,
    async send(m) {
      // 合成的那条正文里每块已经带着自己的链接，不再在信末补一个，免得看着像最后那条的链接
      const body = m.url && !m.text.includes(m.url) ? `${m.text}\n\n链接：${m.url}` : m.text
      await sendMail({ open, user, pass, to, subject: m.short, body, timeouts })
    },
  }
}

// 每一步等多久。发完信那一步单独放宽：服务器可能在做内容检查，回得慢；当成失败的话下一轮会重发一封一样的
const TIMEOUTS = { step: 20_000, data: 180_000 }

/** 一问一答地跑完一次 SMTP 会话：EHLO、登录、MAIL FROM、RCPT TO、DATA、QUIT。 */
export async function sendMail({ open, user, pass, to, subject, body, timeouts = TIMEOUTS }) {
  const socket = open()
  const replies = replyReader(socket, timeouts.step)
  let ok = false
  try {
    await replies.next(220, '连接')
    const ehlo = await command(socket, replies, 'EHLO localhost', 250, '打招呼')
    // 优先 AUTH PLAIN，一步登录；不支持再用 AUTH LOGIN
    if (/AUTH[ =][^\n]*\bPLAIN\b/i.test(ehlo)) {
      await command(socket, replies, `AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`, 235, '登录')
    } else {
      await command(socket, replies, 'AUTH LOGIN', 334, '登录')
      await command(socket, replies, b64(user), 334, '登录')
      await command(socket, replies, b64(pass), 235, '登录')
    }
    await command(socket, replies, `MAIL FROM:<${user}>`, 250, '发件人')
    await command(socket, replies, `RCPT TO:<${to}>`, [250, 251], '收件人')
    await command(socket, replies, 'DATA', 354, '开始发信')
    await command(socket, replies, `${message({ from: user, to, subject, body })}\r\n.`, 250, '发信', timeouts.data)
    ok = true
    socket.write('QUIT\r\n')
  } finally {
    replies.close()
    if (ok) {
      // 正常收尾：等服务器回 221 断开；它不断开，几秒后强行关掉，不让进程挂着
      socket.end()
      setTimeout(() => socket.destroy(), 5000).unref()
    } else {
      // 出错、超时：直接关掉。只 end() 的话，对面不说话也不断开，连接会一直挂着，进程退不出
      socket.destroy()
    }
  }
}

/** 拼信的内容：主题和发件人名字按 RFC 2047 编码，正文 UTF-8 纯文字、base64 编码（base64 里没有点号，不用转义）。 */
export function message({ from, to, subject, body }) {
  const headers = [
    `From: ${encodeWord('演出雷达')} <${from}>`,
    `To: <${to}>`,
    `Subject: ${encodeWord(oneLine(subject))}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@show-radar>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ]
  const encoded = b64(body.replace(/\r?\n/g, '\r\n')).replace(/.{1,76}/g, '$&\r\n').trimEnd()
  return `${headers.join('\r\n')}\r\n\r\n${encoded}`
}

/** 平台数据里的艺人名、城市名可能带换行，拼进邮件头之前去掉，免得拼出别的头。 */
function oneLine(text) {
  return String(text).replace(/[\r\n]+/g, ' ').trim()
}

function encodeWord(text) {
  return `=?UTF-8?B?${b64(text)}?=`
}

function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64')
}

async function command(socket, replies, line, expect, step, timeoutMs) {
  socket.write(`${line}\r\n`)
  return replies.next(expect, step, timeoutMs)
}

// 常见回复码的提示，和服务器原话一起给：同一个码在不同步骤意思不一样，原话里常有真正的原因
const HINTS = {
  535: { 登录: '多半是邮箱或授权码不对，或者邮箱的 SMTP 服务没打开。授权码不是网页登录密码' },
  550: { 收件人: '收信地址可能不对', 发件人: '可能是发得太频繁，被暂时限制了' },
  554: { 发信: '邮箱服务商可能把这封信当成了垃圾信，过一会儿再试' },
}

/**
 * 读服务器的回复。一条回复可能有好几行（“250-…”接着“250 …”），读到最后一行才算完。
 * next(expect, step) 等下一条回复，回复码不对就抛错，错误里写哪一步、提示和服务器的原话。错误里不带发出去的内容：登录那几行里有授权码。
 */
function replyReader(socket, stepTimeoutMs) {
  let buffer = ''
  let lines = []
  const queue = []
  let waiting = null
  let failure = null

  const deliver = () => {
    while (waiting && (queue.length || failure)) {
      const { resolve, reject, timer } = waiting
      waiting = null
      clearTimeout(timer)
      if (queue.length) resolve(queue.shift())
      else reject(failure)
    }
  }
  socket.setEncoding?.('utf8')
  socket.on('data', (chunk) => {
    buffer += chunk
    let i
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).replace(/\r$/, '')
      buffer = buffer.slice(i + 1)
      lines.push(line)
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        queue.push({ code: Number(line.slice(0, 3)), text: lines.join('\n') })
        lines = []
      }
    }
    deliver()
  })
  socket.on('error', (err) => {
    failure = new Error(`连不上发信服务器：${err.message}`)
    deliver()
  })
  socket.on('close', () => {
    failure ??= new Error('发信服务器断开了连接')
    deliver()
  })

  return {
    next(expect, step, timeoutMs = stepTimeoutMs) {
      const ok = [].concat(expect)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting = null
          reject(new Error(`${step}这一步，发信服务器 ${Math.round(timeoutMs / 1000)} 秒没有回应`))
        }, timeoutMs)
        waiting = {
          resolve: (reply) => {
            if (ok.includes(reply.code)) return resolve(reply.text)
            const hint = HINTS[reply.code]?.[step]
            reject(new Error(`${step}这一步回 ${reply.code}：${hint ? `${hint}。` : ''}服务器原话：${reply.text.slice(0, 160)}`))
          },
          reject,
          timer,
        }
        deliver()
      })
    },
    close() {
      if (waiting) clearTimeout(waiting.timer)
      waiting = null
    },
  }
}
