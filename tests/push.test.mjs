// 推送通道：Server酱、WxPusher、Bark、企业微信，合成消息和几个通道一起发。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBark, createServerChan, createWxPusher, parseBarkInput } from '../src/notify/channels.mjs'
import { SHORT_MAX, digestMessage, eventCard, reminderCard, shortTitle, textMessage } from '../src/notify/format.mjs'
import { createNotifier, inspectChannels } from '../src/notify/index.mjs'
import { createWecom } from '../src/notify/wecom.mjs'
import { fromBeijing } from '../src/time.mjs'
import { fakeClient } from './helpers/fake-http.mjs'

const SALE = fromBeijing(2026, 10, 27, 17, 17)
const show = {
  id: 1,
  artistKey: '薛之谦',
  city: '无锡',
  venue: '无锡奥林匹克体育中心体育场',
  dateStart: '2026-11-13',
  dateEnd: '2026-11-22',
  title: '薛之谦“万兽之王”巡回演唱会-无锡站',
  isMixed: false,
  stage: 'sale_pending',
  round: 1,
  everSold: false,
  nextSaleAt: SALE,
  reached: ['listed', 'sale_pending'],
}
const listings = [{ source: 'damai', kind: 'ticket', status: 'presale', url: 'https://m.damai.cn/shows/item.html?itemId=1', saleTimes: [SALE] }]
const announced = { kind: 'sale_announced', round: 1, saleAt: SALE, detail: { saleSources: ['damai'] } }

test('卡片的短标题写上开售时间，正文不带 HTML', () => {
  const card = eventCard(announced, show, listings)
  assert.equal(card.short, '薛之谦·无锡 待开票 10月27日 17:17')
  assert.ok(!card.text.includes('<'))
  assert.match(card.text, /10月27日（周二）17:17 开售（大麦）/)
  assert.equal(reminderCard(show, listings).short, '薛之谦·无锡 17:17 开售')
})

test('短标题超过 32 字时截艺人和城市，阶段和开售时间保持完整', () => {
  const long = { ...show, artistKey: 'Tyler, The Creator and Friends Band' }
  const s = eventCard(announced, long, listings).short
  assert.ok([...s].length <= SHORT_MAX)
  assert.match(s, /… 待开票 10月27日 17:17$/)
  assert.equal(shortTitle('短', ''), '短')
})

test('合成消息：开售时间近的排前面，标题带总条数', () => {
  const later = eventCard({ ...announced, saleAt: SALE + 86400_000 }, { ...show, city: '厦门' }, listings)
  const sooner = eventCard(announced, show, listings)
  const d = digestMessage([textMessage('开始关注 告五人\n现在没有演出'), later, sooner])
  assert.equal(d.short, '薛之谦·无锡 待开票 10月27日 17:17 等3条')
  assert.ok(d.text.indexOf('无锡') < d.text.indexOf('厦门'), '近的在前')
  assert.ok(d.text.indexOf('厦门') < d.text.indexOf('开始关注'), '文字消息排最后')
  assert.equal(d.url, sooner.url)
  assert.equal(digestMessage([sooner]).short, sooner.short, '只有一条时不加条数')
})

test('Server酱：Turbo 和 Server酱³ 的地址不一样，标题是短标题', async () => {
  const calls = []
  const client = fakeClient((req) => {
    calls.push(req)
    return { json: { code: 0, message: '' } }
  }, { site: 'serverchan' })
  await createServerChan({ sendKey: 'SCT123abc', client }).send(eventCard(announced, show, listings))
  await createServerChan({ sendKey: 'sctp456tXYZ', client }).send(textMessage('演出雷达周报\n各数据源都正常。'))
  assert.equal(calls[0].url, 'https://sctapi.ftqq.com/SCT123abc.send')
  assert.equal(calls[1].url, 'https://456.push.ft07.com/send/sctp456tXYZ.send')
  const form = new URLSearchParams(calls[0].body)
  assert.equal(form.get('title'), '薛之谦·无锡 待开票 10月27日 17:17')
  assert.match(form.get('desp'), /\[去看看\]\(https:\/\/m\.damai\.cn/)
})

test('Server酱回错误时说清是密钥还是额度', async () => {
  const client = fakeClient(() => ({ json: { code: 40001, message: 'bad pushkey' } }), { site: 'serverchan' })
  await assert.rejects(createServerChan({ sendKey: 'SCTx', client }).send(textMessage('x')), /免费额度/)
})

test('WxPusher 和 Bark 的请求', async () => {
  const calls = []
  const ok = (json) => fakeClient((req) => (calls.push(req), { json }), { site: 'wxpusher' })
  await createWxPusher({ spt: 'SPT_abc', client: ok({ code: 1000, success: true }) }).send(eventCard(announced, show, listings))
  const wx = JSON.parse(calls[0].body)
  assert.equal(calls[0].url, 'https://wxpusher.zjiecode.com/api/send/message/simple-push')
  assert.equal(wx.spt, 'SPT_abc')
  assert.equal(wx.contentType, 1)
  assert.equal(wx.url, listings[0].url)

  await createBark({ key: 'k1', client: ok({ code: 200, message: 'success' }) }).send(eventCard(announced, show, listings))
  const bark = JSON.parse(calls[1].body)
  assert.equal(calls[1].url, 'https://api.day.app/push')
  assert.equal(bark.device_key, 'k1')
  assert.equal(bark.title, '薛之谦·无锡 待开票 10月27日 17:17')

  await assert.rejects(createWxPusher({ spt: 'SPT_x', client: ok({ code: 1001, msg: 'spt error' }) }).send(textMessage('x')), /SPT 填错了/)
})

test('Bark 地址整个粘贴也认得出 key', () => {
  assert.deepEqual(parseBarkInput('https://api.day.app/AbC123/'), { server: 'https://api.day.app', key: 'AbC123' })
  assert.deepEqual(parseBarkInput('https://bark.example.com/AbC123/标题'), { server: 'https://bark.example.com', key: 'AbC123' })
  assert.deepEqual(parseBarkInput(' AbC123 '), { server: 'https://api.day.app', key: 'AbC123' })
})

test('只填了一部分的通道不算配好，并说出缺什么', () => {
  const { ready, problems } = inspectChannels({ SERVERCHAN_SENDKEY: 'SCTx', WECOM_CORP_ID: 'ww1', WECOM_AGENT_ID: '1', WECOM_SECRET: 's' })
  assert.deepEqual(ready.map((c) => c.id), ['serverchan'])
  assert.match(problems[0], /企业微信没配全，还缺 WECOM_TO_USER/)
})

test('企业微信不再默认推给所有人', () => {
  assert.throws(() => createWecom({ corpId: 'c', agentId: 1, secret: 's', kv: { get: () => null, set: () => {} } }), /WECOM_TO_USER/)
})

test('企业微信：卡片发 textcard，合成的几条发文字', async () => {
  const bodies = []
  const client = fakeClient((req) => {
    if (req.url.includes('/gettoken')) return { json: { errcode: 0, access_token: 't', expires_in: 7200 } }
    bodies.push(JSON.parse(req.body))
    return { json: { errcode: 0 } }
  }, { site: 'wecom' })
  const wecom = createWecom({ corpId: 'c', agentId: 1, secret: 's', toUser: 'zhangsan', kv: { get: () => null, set: () => {} }, client })
  await wecom.send(eventCard(announced, show, listings))
  await wecom.send(digestMessage([eventCard(announced, show, listings), textMessage('演出雷达周报')]))
  assert.equal(bodies[0].msgtype, 'textcard')
  assert.equal(bodies[0].touser, 'zhangsan')
  assert.equal(bodies[1].msgtype, 'text')
  assert.match(bodies[1].text.content, /^薛之谦·无锡 待开票 10月27日 17:17 等2条/)
})

test('几个通道一起发：有一个成功就算发出去，全失败才抛错', async () => {
  const logs = []
  const n = createNotifier({ secrets: { WXPUSHER_SPT: 'SPT_x', BARK_KEY: 'k' }, kv: { get: () => null, set: () => {} }, log: (m) => logs.push(m) })
  assert.equal(n.single, true)
  assert.equal(n.batch, false)
  n.channels[0].send = async () => {}
  n.channels[1].send = async () => {
    throw new Error('key 错了')
  }
  await n.send(textMessage('x'))
  assert.match(logs[0], /Bark：key 错了/)
  n.channels[0].send = n.channels[1].send
  await assert.rejects(n.send(textMessage('x')), /WxPusher：key 错了；Bark：key 错了/)
  assert.equal(createNotifier({ secrets: {}, kv: null }), null)
})

test('Server酱和逐条的通道一起配：Server酱只收合成的那条，逐条的照样一张张收', async () => {
  const got = { serverchan: [], bark: [] }
  const n = createNotifier({ secrets: { SERVERCHAN_SENDKEY: 'SCTx', BARK_KEY: 'k' }, kv: { get: () => null, set: () => {} } })
  assert.equal(n.single && n.batch, true)
  n.channels.find((c) => c.name === 'Server酱').send = async (m) => got.serverchan.push(m)
  n.channels.find((c) => c.name === 'Bark').send = async (m) => got.bark.push(m)
  await n.send(eventCard(announced, show, listings))
  await n.sendDigest(digestMessage([eventCard(announced, show, listings)]))
  assert.equal(got.bark.length, 1)
  assert.equal(got.serverchan.length, 1)
})

test('合成标题加“等N条”时从艺人和城市截，开售时间保持完整', () => {
  const long = { ...show, artistKey: '五月天', city: '乌鲁木齐' }
  const card = eventCard({ kind: 'sale_restored', round: 1, saleAt: SALE, detail: {} }, long, listings)
  const d = digestMessage([card, textMessage('演出雷达周报')])
  assert.ok([...d.short].length <= SHORT_MAX)
  assert.match(d.short, /开售时间重新公布 10月27日 17:17 等2条$/)
})
