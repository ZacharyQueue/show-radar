// 推送：按 secrets.env 里填了哪些密钥，把几个通道合成一个发送器。run.mjs 和 remind.mjs 只认这里的接口：
//   single、send(message)        有逐条发的通道时 single 为真，send 只发给这些通道
//   batch、sendDigest(message)   有按条数计费的通道（Server酱）时 batch 为真，sendDigest 只发给这些通道，
//                                消息先用 digestMessage 合成一条
//   channels                     各通道，test-push 逐个试用
// 两种通道各发各的：逐条的照样一张张收卡片，合成的那条不会挤掉逐条通道的消息。

import { createBark, createServerChan, createWxPusher } from './channels.mjs'
import { createWecom } from './wecom.mjs'

/** 每个通道要哪几个密钥。全填了才算配好；企业微信缺接收人另外报出来。 */
export const CHANNELS = [
  { id: 'serverchan', name: 'Server酱', keys: ['SERVERCHAN_SENDKEY'], make: (s) => createServerChan({ sendKey: s.SERVERCHAN_SENDKEY }) },
  { id: 'wxpusher', name: 'WxPusher', keys: ['WXPUSHER_SPT'], make: (s) => createWxPusher({ spt: s.WXPUSHER_SPT }) },
  { id: 'bark', name: 'Bark', keys: ['BARK_KEY'], make: (s) => createBark({ key: s.BARK_KEY, server: s.BARK_SERVER || undefined }) },
  {
    id: 'wecom',
    name: '企业微信',
    keys: ['WECOM_CORP_ID', 'WECOM_AGENT_ID', 'WECOM_SECRET', 'WECOM_TO_USER'],
    make: (s, kv) => createWecom({ corpId: s.WECOM_CORP_ID, agentId: s.WECOM_AGENT_ID, secret: s.WECOM_SECRET, toUser: s.WECOM_TO_USER, kv }),
  },
]

/** 所有通道要用的密钥名，loadSecrets 允许环境变量覆盖这些。 */
export const SECRET_KEYS = [...new Set([...CHANNELS.flatMap((c) => c.keys), 'BARK_SERVER'])]

/**
 * 看填了哪些通道。返回 { ready: [配好的通道], partial: [只填了一部分的通道], problems: [给人看的话] }。
 * 只填了一部分的通道不算配好，写进 problems，免得以为配好了却一直收不到。
 */
export function inspectChannels(secrets) {
  const ready = []
  const partial = []
  const problems = []
  for (const c of CHANNELS) {
    const filled = c.keys.filter((k) => secrets[k])
    if (filled.length === c.keys.length) ready.push(c)
    else if (filled.length) {
      partial.push(c)
      problems.push(`${c.name}没配全，还缺 ${c.keys.filter((k) => !secrets[k]).join('、')}。运行 setup-push 补全，或者在里面去掉它`)
    }
  }
  return { ready, partial, problems }
}

/**
 * 按密钥建发送器。没有配好的通道时返回 null。
 * 几个通道都发；有一个发成功就算发出去，发失败的写日志。全都失败才抛错，消息留到下一轮。
 */
export function createNotifier({ secrets, kv, log = console.log }) {
  const { ready } = inspectChannels(secrets)
  if (!ready.length) return null
  const channels = ready.map((c) => c.make(secrets, kv))
  const singles = channels.filter((c) => !c.batch)
  const batches = channels.filter((c) => c.batch)
  async function sendTo(list, message) {
    const results = await Promise.allSettled(list.map((c) => c.send(message)))
    const failed = results.map((r, i) => (r.status === 'rejected' ? `${list[i].name}：${r.reason?.message ?? r.reason}` : null)).filter(Boolean)
    if (failed.length === list.length) throw new Error(failed.join('；'))
    for (const f of failed) log(`这个通道没发出去：${f}`)
  }
  return {
    channels,
    single: singles.length > 0,
    batch: batches.length > 0,
    send: (message) => sendTo(singles, message),
    sendDigest: (message) => sendTo(batches, message),
  }
}

/** 不发出去，只打印。--dry-run 时用，配合状态库的副本，正式的状态库不动。single、batch 跟着配好的通道走，打印出来的就是真会发的样子。 */
export function createConsoleNotifier({ single = true, batch = false, print = console.log } = {}) {
  const show = (prefix) => async (m) => print(`${prefix}【${m.short}】\n${m.text}${m.url ? `\n链接：${m.url}` : ''}\n`)
  return { channels: [], single, batch, send: show(''), sendDigest: show('合成一条：') }
}

/** 还没配推送：打印出来给人看，但算发送失败，消息留在状态库里，配好以后再发。真有消息要发时才提醒一句。 */
export function createUnconfiguredNotifier(print = console.log) {
  const shown = createConsoleNotifier({ print })
  let told = false
  return {
    channels: [],
    single: true,
    batch: false,
    async send(m) {
      if (!told) print('还没配推送：消息先打印在这里，留在状态库里，运行 setup-push 配好以后再发。')
      told = true
      await shown.send(m)
      const err = new Error('还没配推送，消息留到配好以后再发')
      err.code = 'NOT_CONFIGURED'
      throw err
    },
  }
}
