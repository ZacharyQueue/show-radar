// 推送的文字和企业微信发送。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DESC_MAX, TITLE_MAX, eventCard, healthText, reminderCard, summaryTexts, weeklyText } from '../src/notify/format.mjs'
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
  reached: ['approved', 'listed', 'sale_pending'],
}
const listings = [
  { source: 'gov', kind: 'approval', url: 'https://gov.example/x', saleTimes: [], approval: { date: '2026-10-09', approver: '江苏省文化和旅游厅' } },
  { source: 'maoyan', kind: 'ticket', status: 'presale', url: 'https://show.maoyan.com/detail/512082', saleTimes: [SALE] },
  { source: 'damai', kind: 'ticket', status: 'presale', url: 'https://m.damai.cn/shows/item.html?itemId=1089011559335', saleTimes: [SALE] },
]

test('待开票卡片', () => {
  const card = eventCard({ kind: 'sale_announced', round: 1, saleAt: SALE, detail: { saleSources: ['damai', 'maoyan'] } }, show, listings)
  assert.equal(card.title, '薛之谦 · 无锡 · 待开票')
  assert.match(card.description, /10月27日（周二）17:17 开售（大麦、猫眼）/)
  assert.match(card.description, /11月13日—22日 · 无锡奥林匹克体育中心体育场/)
  assert.match(card.description, /已报批 → 已上架 → 待开票/)
  assert.equal(card.url, 'https://m.damai.cn/shows/item.html?itemId=1089011559335')
})

test('二开、改时间、又有票了、报批的卡片', () => {
  const LATER = SALE + 86400_000
  const onlyMaoyan = listings.map((l) => (l.source === 'maoyan' ? { ...l, saleTimes: [LATER] } : l))
  const resale = eventCard({ kind: 'resale_announced', round: 2, saleAt: LATER, detail: { saleSources: ['maoyan'] } }, { ...show, stage: 'resale_pending', round: 2, everSold: true }, onlyMaoyan)
  assert.equal(resale.title, '薛之谦 · 无锡 · 二开')
  assert.equal(resale.url, 'https://show.maoyan.com/detail/512082', '链接用开售时间对得上的那条记录')
  const changed = eventCard({ kind: 'sale_changed', round: 1, saleAt: SALE, detail: { previousSaleAt: SALE - 86400_000 } }, show, listings)
  assert.match(changed.description, /改到 10月27日（周二）17:17 开售，原来是 10月26日（周一）17:17/)
  const restock = eventCard({ kind: 'restock', round: 1, saleAt: 0, detail: { sources: ['damai'] } }, show, listings)
  assert.match(restock.description, /大麦又有票了/)
  const approved = eventCard({ kind: 'approved', round: 0, saleAt: 0, detail: {} }, { ...show, stage: 'approved' }, listings.slice(0, 1))
  assert.match(approved.description, /文旅部批准：2026-10-09（江苏省文化和旅游厅）/)
  assert.equal(approved.url, 'https://gov.example/x')
})

test('卡片不超过字节上限，HTML 标签完整', () => {
  const long = { ...show, venue: '很长的场馆名'.repeat(40), title: '很长的演出名'.repeat(60) }
  const card = eventCard({ kind: 'sale_announced', round: 1, saleAt: SALE, detail: { saleSources: ['damai'] } }, long, listings)
  assert.ok(Buffer.byteLength(card.description) <= DESC_MAX)
  assert.ok(Buffer.byteLength(card.title) <= TITLE_MAX)
  assert.match(card.description, /10月27日（周二）17:17 开售/, '开售时间那行不截')
  assert.equal((card.description.match(/<div/g) ?? []).length, (card.description.match(/<\/div>/g) ?? []).length)
})

test('开售提醒卡片', () => {
  const card = reminderCard(show, listings)
  assert.equal(card.title, '薛之谦 · 无锡 · 快开售了')
  assert.match(card.description, /17:17 开售（大麦、猫眼）/)
})

test('新关注汇总、健康提醒、周报', () => {
  const [text] = summaryTexts([
    {
      artistKey: '薛之谦',
      sources: [
        { source: 'damai', found: true },
        { source: 'maoyan', found: true },
        { source: 'showstart', found: false },
      ],
      shows: [show, { ...show, id: 2, city: '厦门', stage: 'soldout', nextSaleAt: null, dateStart: '2026-10-31', dateEnd: '2026-11-08' }],
    },
  ])
  assert.match(text, /^开始关注 薛之谦/)
  assert.match(text, /大麦、猫眼：找到了；秀动：没有这位艺人/)
  assert.match(text, /现在有 2 场/)
  assert.match(text, /· 无锡 11月13日—22日 待开票 10月27日（周二）17:17 开售/)
  assert.match(healthText({ source: 'damai', status: 'down', reason: '被平台拦下（HTTP 403）', failRuns: 3 }), /大麦已经连着 3 轮取不到数据/)
  assert.match(weeklyText({ artistCount: 3, showCount: 5, pushedCount: 2, health: [{ source: 'damai', ok: true }] }), /各数据源都正常/)
})

test('汇总太长时切成几段', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ artistKey: `艺人${i}`, sources: [{ source: 'damai', found: true }], shows: [show] }))
  const texts = summaryTexts(many)
  assert.ok(texts.length > 1)
  for (const t of texts) assert.ok(Buffer.byteLength(t) <= 2000)
})

test('企业微信：取令牌、发卡片、令牌失效重取', async () => {
  const kv = new Map()
  let tokenCalls = 0
  let sends = 0
  const client = fakeClient((req) => {
    if (req.url.includes('/gettoken')) {
      tokenCalls++
      return { json: { errcode: 0, access_token: `t${tokenCalls}`, expires_in: 7200 } }
    }
    sends++
    if (sends === 1) return { json: { errcode: 42001, errmsg: 'access_token expired' } }
    sent.push({ body: JSON.parse(req.body), url: req.url })
    return { json: { errcode: 0, errmsg: 'ok' } }
  }, { site: 'wecom' })
  const sent = []
  const wecom = createWecom({ corpId: 'c', agentId: '1000002', secret: 's', toUser: 'zhangsan', kv: { get: (k) => kv.get(k) ?? null, set: (k, v) => kv.set(k, v) }, client, now: () => 0 })
  await wecom.sendCard({ title: 't', description: 'd', url: 'https://a/', btntxt: '去看看' })
  assert.equal(tokenCalls, 2)
  assert.equal(sent[0].body.msgtype, 'textcard')
  assert.equal(sent[0].body.agentid, 1000002)
  assert.ok(sent[0].url.includes('access_token=t2'))
  await wecom.sendText('hi')
  assert.equal(tokenCalls, 2, '令牌存着复用')
  assert.deepEqual(sent[1].body.text, { content: 'hi' })
})

test('企业微信：IP 不可信时说清怎么改', async () => {
  const client = fakeClient((req) => (req.url.includes('/gettoken') ? { json: { errcode: 0, access_token: 't', expires_in: 7200 } } : { json: { errcode: 60020, errmsg: 'not allow to access from your ip' } }), { site: 'wecom' })
  const wecom = createWecom({ corpId: 'c', agentId: 1, secret: 's', toUser: 'zhangsan', kv: { get: () => null, set: () => {} }, client })
  await assert.rejects(wecom.sendText('x'), /企业可信IP/)
})
