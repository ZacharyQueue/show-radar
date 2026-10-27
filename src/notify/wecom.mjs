// 企业微信自建应用发消息。只能从服务器上发：企业微信只认后台配好的可信 IP，别处调会回 60020。

import { createHash } from 'node:crypto'
import { createClient } from '../http.mjs'
import { truncateBytes } from '../text.mjs'

const API = 'https://qyapi.weixin.qq.com/cgi-bin'
const TOKEN_KV = 'wecom.token'
// 令牌失效类错误码：重取一次令牌再发
const TOKEN_ERRORS = new Set([40001, 40014, 42001])

const HINTS = {
  60020: '企业微信不认这台机器的 IP。到企业微信后台“应用管理 → 你建的应用 → 企业可信IP”里填服务器的 IP',
  40013: '企业 ID 填错了，重新运行 setup-push 填对',
  40001: 'Secret 填错了，重新运行 setup-push 填对',
  40056: 'AgentId 填错了，重新运行 setup-push 填对',
  81013: '接收人不在应用的可见范围里，或者成员账号填错了。到企业微信后台把自己加进应用的可见范围，再核对“通讯录”里自己的账号',
  301002: 'Secret 和 AgentId 不是同一个应用的。Secret 要在你建的那个应用页面上点“查看”拿',
  45009: '企业微信的调用次数用完了，等一会儿再发',
}

/**
 * @param {Object} o
 * @param {string} o.corpId
 * @param {string|number} o.agentId
 * @param {string} o.secret
 * @param {string} o.toUser 接收人的成员账号，几个人用 | 隔开。必填：不默认推给 @all，免得拿公司的企业微信配时推给全公司
 * @param {{get, set}} o.kv 存令牌
 * @param {Function} [o.now]
 * @param {Object} [o.client] 测试时传假客户端
 */
export function createWecom({ corpId, agentId, secret, toUser, kv, now = Date.now, client }) {
  if (!toUser) throw new Error('企业微信缺接收人 WECOM_TO_USER：填自己的成员账号，在企业微信后台“通讯录”里点自己能看到')
  const http = client ?? createClient({ site: 'wecom', minGapMs: 300, floor: false, retry: false })
  // 令牌缓存认凭证：换了企业 ID 或 Secret，旧令牌不再用。只存哈希，不存 Secret
  const credential = createHash('sha256').update(`${corpId}:${secret}`).digest('hex').slice(0, 16)

  async function token(force = false) {
    if (!force) {
      const saved = parseJson(kv.get(TOKEN_KV))
      if (saved?.token && saved.credential === credential && saved.expiresAt - 300_000 > now()) return saved.token
    }
    const res = await http.request({ url: `${API}/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secret)}` })
    const body = res.json()
    if (body.errcode) throw wecomError(body)
    kv.set(TOKEN_KV, JSON.stringify({ token: body.access_token, credential, expiresAt: now() + body.expires_in * 1000 }))
    return body.access_token
  }

  async function send(message) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = await token(attempt > 0)
      const res = await http.request({
        method: 'POST',
        url: `${API}/message/send?access_token=${encodeURIComponent(t)}`,
        json: { touser: toUser, agentid: Number(agentId), ...message },
      })
      const body = res.json()
      if (!body.errcode) return body
      if (!TOKEN_ERRORS.has(body.errcode) || attempt > 0) throw wecomError(body)
    }
  }

  const sendCard = ({ title, description, url, btntxt }) => send({ msgtype: 'textcard', textcard: { title, description, url, btntxt } })
  const sendText = (content) => send({ msgtype: 'text', text: { content } })
  return {
    name: '企业微信',
    batch: false,
    // 一张卡片发 textcard；纯文字和合成的几条发文字消息，企业微信文字消息 2048 字节以内
    send(m) {
      if (m.title && m.description) return sendCard(m)
      // 正文第一行就是标题的（汇总、周报）不再重复标题
      const head = m.text.startsWith(m.short.replace(/…$/, '')) ? null : m.short
      return sendText(truncateBytes([head, m.text, m.url ? `链接：${m.url}` : null].filter(Boolean).join('\n\n'), 2000))
    },
    sendCard,
    sendText,
  }
}

function wecomError(body) {
  const hint = HINTS[body.errcode]
  const err = new Error(`企业微信回错误 ${body.errcode}：${hint ?? body.errmsg}`)
  err.code = body.errcode
  return err
}

function parseJson(s) {
  try {
    return s ? JSON.parse(s) : null
  } catch {
    return null
  }
}
