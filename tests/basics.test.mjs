// 时间、名字归一、艺人清单、请求客户端。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { beijingDate, formatDateRange, formatSaleTime, fromBeijing, parseBeijing, parseRelativeBeijing } from '../src/time.mjs'
import { containsAnyName, isTributeFor, normalizeCity, normalizeName, sameName, truncateBytes } from '../src/text.mjs'
import { parseArtists } from '../src/config.mjs'
import { BlockedError, NetworkError } from '../src/errors.mjs'
import { createClient } from '../src/http.mjs'
import { fakeClient } from './helpers/fake-http.mjs'

test('北京时间：解析和显示', () => {
  assert.equal(parseBeijing('2026-10-27 17:17'), Date.UTC(2026, 9, 27, 9, 17))
  assert.equal(parseBeijing('2026/12/11 20:00'), Date.UTC(2026, 11, 11, 12, 0))
  assert.equal(parseBeijing('2026.11.13'), Date.UTC(2026, 10, 12, 16, 0))
  assert.equal(parseBeijing('不是日期'), null)
  assert.equal(beijingDate(Date.UTC(2026, 9, 26, 17, 0)), '2026-10-27', '北京时间已经过了零点')
  assert.equal(formatSaleTime(1793092620000), '10月27日（周二）17:17')
  assert.equal(formatDateRange('2026-11-13', '2026-11-22'), '11月13日—22日')
  assert.equal(formatDateRange('2026-11-28', '2026-12-02'), '11月28日—12月2日')
  assert.equal(formatDateRange('2026-12-31', '2027-01-01'), '2026年12月31日—2027年1月1日')
  assert.equal(formatDateRange('2026-11-21', '2026-11-21'), '11月21日')
})

test('北京时间：相对说法', () => {
  const now = fromBeijing(2026, 10, 26, 23, 30)
  assert.equal(parseRelativeBeijing('明天17:17', now), fromBeijing(2026, 10, 27, 17, 17))
  assert.equal(parseRelativeBeijing('后天 10:00', now), fromBeijing(2026, 10, 28, 10, 0))
  assert.equal(parseRelativeBeijing('今天20:00', now), fromBeijing(2026, 10, 26, 20, 0))
  assert.equal(parseRelativeBeijing('10月28日 10:00', now), fromBeijing(2026, 10, 28, 10, 0))
  assert.equal(parseRelativeBeijing('1月3日 12:00', now), fromBeijing(2027, 1, 3, 12, 0), '没写年份、月份已过的算明年')
  assert.equal(parseRelativeBeijing('2026年11月4日 11:00', now), fromBeijing(2026, 11, 4, 11, 0))
  assert.equal(parseRelativeBeijing('即将开售', now), null)
})

test('北京时间：换时区结果一样', () => {
  const code = `import('${new URL('../src/time.mjs', import.meta.url).href}').then(t => console.log(t.parseBeijing('2026-10-27 17:17'), t.beijingDate(1793092620000)))`
  const outs = ['UTC', 'America/Los_Angeles', 'Asia/Shanghai'].map((TZ) => execFileSync(process.execPath, ['-e', code], { env: { ...process.env, TZ } }).toString())
  assert.equal(new Set(outs).size, 1)
})

test('名字归一和匹配', () => {
  assert.equal(normalizeName(' 告五人 Accusefive '), '告五人accusefive')
  assert.ok(sameName('MAYDAY', 'mayday'))
  assert.ok(!sameName('五月天', '五月天怪兽'))
  assert.ok(containsAnyName('告五人【Run, Run, Run! 黑夜狂奔】2025专辑巡迴演唱会－武汉', ['告五人']))
  assert.ok(!containsAnyName('陳奕迅 FEAR AND DREAMS', ['陈奕迅']), '繁简不互转')
  assert.ok(isTributeFor('致敬Beyond经典金曲演唱会', ['Beyond']))
  assert.ok(isTributeFor('《甜蜜蜜》邓丽君经典金曲演唱会', ['邓丽君']))
  assert.ok(isTributeFor('纪念张国荣·风继续吹音乐会', ['张国荣']))
  assert.ok(isTributeFor('薛之谦金曲（非原唱）演唱会', ['薛之谦']))
  assert.ok(!isTributeFor('薛之谦“万兽之王”巡回演唱会-无锡站', ['薛之谦']))
  assert.ok(!isTributeFor('张学友“学友·经典”世界巡回演唱会', ['张学友']), '艺人自己的“经典”巡演不算')
  assert.ok(!isTributeFor('五月天出道25周年纪念演唱会', ['五月天']))
  assert.ok(isTributeFor('港台经典金曲演唱会', ['李荣浩'], { loose: true }), '标题没有艺人名时连弱词也算')
  assert.ok(!isTributeFor('2026超级演唱会-石家庄', ['李荣浩'], { loose: true }))
  assert.equal(normalizeCity('无锡市'), '无锡')
  assert.equal(normalizeCity('上海市'), '上海')
  assert.equal(normalizeCity('香港特别行政区'), '香港')
  assert.equal(normalizeCity('北京'), '北京')
})

test('按字节截断不截坏汉字', () => {
  assert.equal(truncateBytes('一二三四五', 10), '一二…')
  assert.equal(truncateBytes('短', 10), '短')
})

test('艺人清单', () => {
  const list = parseArtists('# 注释\n薛之谦\n五月天、MAYDAY，Mayday\n\n草东没有派对、草東沒有派對 # 繁体也写上\n薛之谦\nTyler, The Creator\n')
  assert.deepEqual(list, [
    { key: '薛之谦', aliases: [] },
    { key: '五月天', aliases: ['MAYDAY', 'Mayday'] },
    { key: '草东没有派对', aliases: ['草東沒有派對'] },
    { key: 'Tyler, The Creator', aliases: [] },
  ])
  assert.ok(sameName('Tyler The Creator', 'Tyler, The Creator'), '半角逗号不拆，比名字时也不算')
})

test('请求客户端：间隔、Cookie、被拦、重试', async () => {
  let clock = 0
  const waits = []
  let calls = 0
  const client = createClient({
    site: 'x',
    hosts: ['a'],
    minGapMs: 2500,
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms)
      clock += ms
    },
    transport: async (req) => {
      calls++
      if (req.url.endsWith('/flaky') && calls === 3) throw new Error('ECONNRESET')
      if (req.url.endsWith('/blocked')) return { status: 469, headers: {}, text: '你的操作太快了' }
      if (req.url.endsWith('/challenge')) return { status: 200, headers: {}, text: '{"ret":["RGV587_ERROR::SM::哎哟喂,被挤爆啦"]}' }
      if (req.url.endsWith('/redirect')) return { status: 302, headers: { location: 'https://mtop.damai.cn/_____tmd_____/punish?x=1' }, text: '' }
      return { status: 200, headers: { 'set-cookie': ['_m_h5_tk=abc_123; Path=/', 'other=1'] }, text: JSON.stringify({ cookie: req.headers.cookie ?? null }) }
    },
  })
  const first = (await client.request({ url: 'https://a/1' })).json()
  assert.equal(first.cookie, null)
  const second = (await client.request({ url: 'https://a/2' })).json()
  assert.equal(second.cookie, '_m_h5_tk=abc_123; other=1')
  assert.deepEqual(waits, [2500])
  const third = await client.request({ url: 'https://a/flaky' })
  assert.equal(third.status, 200, '网络错误重试一次')
  await assert.rejects(client.request({ url: 'https://a/blocked' }), BlockedError)
  await assert.rejects(client.request({ url: 'https://a/challenge' }), BlockedError)
  await assert.rejects(client.request({ url: 'https://a/redirect' }), BlockedError)
})

test('请求客户端：一直连不上抛 NetworkError', async () => {
  const client = fakeClient(
    () => {
      throw new Error('ETIMEDOUT')
    },
    { hosts: ['a'] },
  )
  await assert.rejects(client.request({ url: 'https://a/' }), NetworkError)
  assert.equal(client.calls.length, 2)
})

test('请求客户端：JSON 和表单正文', async () => {
  const client = fakeClient((req) => ({ json: { body: req.body, type: req.headers['content-type'] } }), { hosts: ['a'] })
  assert.deepEqual((await client.request({ method: 'POST', url: 'https://a/', json: { a: 1 } })).json(), { body: '{"a":1}', type: 'application/json;charset=UTF-8' })
  assert.equal((await client.request({ method: 'POST', url: 'https://a/', form: { data: 'x+y@' } })).json().body, 'data=x%2By%40')
})
