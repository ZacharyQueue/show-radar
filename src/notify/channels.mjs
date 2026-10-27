// 不用固定 IP 的推送通道：Server酱、WxPusher、Bark。企业微信在 wecom.mjs。
// 每个通道导出同一个接口：{ name, batch, send(message) }，message 是 format.mjs 写好的卡片：
//   { short, text, url, title?, description? }
// batch 为 true 的通道按条数计费（Server酱免费每天 5 条），一次推送要把几条合成一条再发。

import { createClient } from '../http.mjs'
import { truncateBytes } from '../text.mjs'

/**
 * Server酱。SendKey 有两种：SCT 开头的是 Server酱 Turbo，sctp 开头的是 Server酱³，地址不一样。
 * 免费版每天 5 条，微信里只显示标题，标题超过 32 字截断。
 */
export function createServerChan({ sendKey, client }) {
  const http = client ?? createClient({ site: 'serverchan', minGapMs: 300, floor: false, retry: false })
  const sc3 = String(sendKey).match(/^sctp(\d+)t/i)
  const url = sc3 ? `https://${sc3[1]}.push.ft07.com/send/${encodeURIComponent(sendKey)}.send` : `https://sctapi.ftqq.com/${encodeURIComponent(sendKey)}.send`
  return {
    name: 'Server酱',
    batch: true,
    async send(m) {
      // 正文是 Markdown：一行一段，链接写成可点的
      const desp = truncateBytes([...m.text.split('\n'), m.url ? `[去看看](${m.url})` : null].filter(Boolean).join('\n\n'), 16000)
      const res = await http.request({ method: 'POST', url, form: { title: m.short, desp } })
      const body = res.json()
      if (body.code !== 0) throw pushError('Server酱', body.code, body.message ?? body.info, SERVERCHAN_HINT)
    },
  }
}

const SERVERCHAN_HINT = 'SendKey 填错了，或者今天的免费额度（5 条）用完了。SendKey 在 https://sct.ftqq.com/sendkey 页面复制'

/** WxPusher 极简推送：扫码拿到 SPT 就能发，消息进 WxPusher 自己的 App。 */
export function createWxPusher({ spt, client }) {
  const http = client ?? createClient({ site: 'wxpusher', minGapMs: 600, floor: false, retry: false })
  return {
    name: 'WxPusher',
    batch: false,
    async send(m) {
      const res = await http.request({
        method: 'POST',
        url: 'https://wxpusher.zjiecode.com/api/send/message/simple-push',
        json: { content: truncateBytes(`${m.short}\n\n${m.text}`, 30000), summary: [...m.short].slice(0, 100).join(''), contentType: 1, spt, ...(m.url ? { url: m.url } : {}) },
      })
      const body = res.json()
      if (body.code !== 1000) throw pushError('WxPusher', body.code, body.msg, 'SPT 填错了。SPT 以 SPT_ 开头，扫 https://wxpusher.zjiecode.com/docs/spt.html 上的二维码拿')
    },
  }
}

/** Bark：iPhone 上的推送 App。key 是 App 首页推送地址里的那一段；自建服务器的写 server。 */
export function createBark({ key, server = 'https://api.day.app', client }) {
  const http = client ?? createClient({ site: 'bark', minGapMs: 300, floor: false, retry: false })
  return {
    name: 'Bark',
    batch: false,
    async send(m) {
      // 苹果推送一条最多 4 KB，正文留 3000 字节
      const res = await http.request({
        method: 'POST',
        url: `${server.replace(/\/+$/, '')}/push`,
        json: { device_key: key, title: m.short, body: truncateBytes(m.text, 3000), group: '演出雷达', ...(m.url ? { url: m.url } : {}) },
      })
      const body = res.json()
      if (body.code !== 200) throw pushError('Bark', body.code, body.message, 'key 填错了。打开 Bark App，首页推送地址里 api.day.app/ 后面那一段就是 key')
    },
  }
}

/** Bark App 首页给的是整个地址（https://api.day.app/xxxx/标题），拆出服务器和 key。只填了 key 也行。 */
export function parseBarkInput(input) {
  const s = String(input).trim()
  const m = s.match(/^(https?:\/\/[^/]+)\/([^/?#]+)/)
  if (m) return { server: m[1], key: m[2] }
  return { server: 'https://api.day.app', key: s }
}

function pushError(name, code, message, hint) {
  const err = new Error(`${name}回错误 ${code}：${message ?? '没有说明'}。${hint}`)
  err.code = code
  return err
}
