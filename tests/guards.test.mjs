// 写死在代码里的限制：请求间隔下限、艺人和别名上限、同时只跑一轮、定时的随机延迟、只许请求白名单里的地址。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAX_ALIASES, MAX_ARTISTS, followArtist, limitArtists, templateHint, unfollowArtist } from '../src/config.mjs'
import { MIN_CHECK_GAP_MS, MIN_FETCH_GAP_MS } from '../src/fetch-log.mjs'
import { MIN_GAP_FLOOR_MS, PUSH_SITES, SOURCE_SITES, createClient, createSourceClient } from '../src/http.mjs'
import { withLock } from '../src/lock.mjs'
import { MAX_JITTER_MS, nextRoundAt, planNextRound } from '../src/schedule.mjs'
import { beijingParts, fromBeijing } from '../src/time.mjs'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'show-radar-test-'))

function timedClient(options) {
  let clock = 0
  const waits = []
  const client = createClient({
    minGapMs: 0,
    ...options,
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms)
      clock += ms
    },
    transport: async () => ({ status: 200, headers: {}, text: '{}' }),
  })
  return { client, waits }
}

test('数据源的请求间隔不低于 2 秒，传更小的值、传 floor: false 都没用', async () => {
  for (const options of [{ site: 'damai', minGapMs: 0 }, { site: 'damai', minGapMs: 500, floor: false }]) {
    const { client, waits } = timedClient(options)
    await client.request({ url: 'https://m.damai.cn/a' })
    await client.request({ url: 'https://m.damai.cn/b' })
    assert.deepEqual(waits, [MIN_GAP_FLOOR_MS])
  }
  const push = timedClient({ site: 'serverchan', minGapMs: 300, floor: false })
  await push.client.request({ url: 'https://sctapi.ftqq.com/a' })
  await push.client.request({ url: 'https://sctapi.ftqq.com/b' })
  assert.deepEqual(push.waits, [300], '推送通道不受下限约束')
})

test(`最多关注 ${MAX_ARTISTS} 位艺人，每位最多 ${MAX_ALIASES} 个别名`, () => {
  const file = path.join(tmp(), 'artists.txt')
  fs.writeFileSync(file, Array.from({ length: MAX_ARTISTS }, (_, i) => `艺人${i}`).join('\n') + '\n')
  assert.throws(() => followArtist('再来一位', file), /最多 50 位/)
  assert.equal(followArtist('艺人1、A、B', file).added, false, '给已经关注的补别名照常')
  assert.throws(() => followArtist('艺人1、C、D、E、F', file), /最多写 5 个别名/)

  const many = Array.from({ length: MAX_ARTISTS + 2 }, (_, i) => ({ key: `艺人${i}`, aliases: i === 0 ? ['1', '2', '3', '4', '5', '6'] : [] }))
  const { artists, warnings } = limitArtists(many)
  assert.equal(artists.length, MAX_ARTISTS)
  assert.equal(artists[0].aliases.length, MAX_ALIASES)
  assert.match(warnings.join('\n'), /这几位没有跟踪：艺人50、艺人51/)

  // 超出时先留已经在跟踪的，截掉新加的：新人手写在最上面，也不会把在跟踪的人停掉
  const withNewcomer = [{ key: '新人', aliases: [] }, ...many.slice(0, MAX_ARTISTS)]
  const tracked = new Set(many.slice(0, MAX_ARTISTS).map((a) => a.key))
  const kept = limitArtists(withNewcomer, tracked)
  assert.ok(!kept.artists.some((a) => a.key === '新人'))
  assert.match(kept.warnings[0], /这几位没有跟踪：新人/)
})

test('别名已经属于另一位艺人时不新加，主名换个写法并进原来那一行', () => {
  const file = path.join(tmp(), 'artists.txt')
  fs.writeFileSync(file, '五月天、MAYDAY\n告五人、潘云安\n')
  assert.throws(() => followArtist('MAYDAY', file), /MAYDAY 已经是 五月天 的名字或别名/)
  assert.throws(() => followArtist('潘云安', file), /潘云安 已经是 告五人 的名字或别名/)
  assert.throws(() => followArtist('阿信、mayday', file), /已经是 五月天/)
  const merged = followArtist('五月天、阿信', file)
  assert.equal(merged.added, false)
  assert.deepEqual(merged.newAliases, ['阿信'])
  assert.equal(followArtist('五月天', file).newAliases.length, 0, '没带新别名')
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 2)
})

test('同时只跑一轮：第二个等第一个跑完；进程死了留下的锁自动清掉', async () => {
  const file = path.join(tmp(), 'run.lock')
  const order = []
  let release
  const first = withLock(file, () => new Promise((resolve) => (release = () => (order.push('first'), resolve()))))
  const second = withLock(file, async () => order.push('second'), { pollMs: 5, log: () => {} })
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(order, [], '第二个在等')
  release()
  await Promise.all([first, second])
  assert.deepEqual(order, ['first', 'second'])
  assert.equal(fs.existsSync(file), false, '跑完锁就放掉')

  // 一个早就不在的进程号留下的锁
  fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }))
  assert.equal(await withLock(file, async () => 'ok', { waitMs: 50, pollMs: 5, log: () => {} }), 'ok')

  // 活着的进程拿着锁，等不到就说清楚
  fs.writeFileSync(file, JSON.stringify({ pid: process.ppid, at: Date.now() }))
  await assert.rejects(withLock(file, async () => {}, { waitMs: 20, pollMs: 5, log: () => {} }), /上一轮还没跑完/)
  fs.rmSync(file)
})

test('常驻模式的时刻：北京时间 3:07、9:07、15:07、21:07，再随机推迟 0 到 20 分钟', () => {
  const at = (h, m) => fromBeijing(2026, 10, 27, h, m)
  assert.equal(nextRoundAt(at(8, 0), () => 0), at(9, 7))
  assert.equal(nextRoundAt(at(9, 7), () => 0), at(15, 7), '正好在点上算下一轮')
  assert.equal(nextRoundAt(at(22, 0), () => 0), fromBeijing(2026, 10, 28, 3, 7), '过了 21:07 是第二天 3:07')
  const late = nextRoundAt(at(8, 0), () => 0.999)
  assert.ok(late > at(9, 7) && late < at(9, 7) + MAX_JITTER_MS)
  assert.equal(beijingParts(nextRoundAt(at(16, 0), () => 0)).hour, 21)
})

/**
 * 去掉注释，字符串、模板、正则原样留着。逐个字符扫：只有在代码里遇到的 // 和 /* 才是注释，
 * 字符串里的 /* 、// 和正则里的引号都不会被当真；模板里的 ${} 按层数接着当代码扫。
 * 静态扫描只是辅助，真正的拦截在 src/http.mjs 发请求之前。
 */
function stripComments(source) {
  const n = source.length
  // 这些关键字后面的 / 是正则开头，不是除号
  const KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'void', 'delete', 'throw', 'yield', 'await', 'else', 'do', 'instanceof', 'new'])
  let i = 0
  function code(insideTemplate) {
    let out = ''
    let last = '' // 上一个不是空白的字符
    let word = '' // 上一个标识符
    let depth = 0
    while (i < n) {
      const c = source[i]
      const d = source[i + 1]
      if (insideTemplate) {
        if (c === '{') depth++
        else if (c === '}') {
          if (depth === 0) return out
          depth--
        }
      }
      if (c === '/' && d === '/') {
        while (i < n && source[i] !== '\n') i++
        continue
      }
      if (c === '/' && d === '*') {
        const end = source.indexOf('*/', i + 2)
        const stop = end < 0 ? n : end + 2
        out += source.slice(i, stop).replace(/[^\n]/g, ' ')
        i = stop
        continue
      }
      if (c === "'" || c === '"') {
        let j = i + 1
        while (j < n && source[j] !== c && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1
        out += source.slice(i, j + 1)
        i = j + 1
        last = c
        word = ''
        continue
      }
      if (c === '`') {
        out += template()
        last = '`'
        word = ''
        continue
      }
      if (c === '/' && (last === '' || '(,=:[!&|?{};+-*%<>~^'.includes(last) || KEYWORDS.has(word))) {
        // 正则字面量：读到不在字符类里、没转义的 /
        let j = i + 1
        let inClass = false
        while (j < n && source[j] !== '\n') {
          if (source[j] === '\\') j += 2
          else {
            if (source[j] === '[') inClass = true
            else if (source[j] === ']') inClass = false
            else if (source[j] === '/' && !inClass) break
            j++
          }
        }
        out += source.slice(i, j + 1)
        i = j + 1
        last = '/'
        word = ''
        continue
      }
      out += c
      i++
      if (/[\w$]/.test(c)) word = /[\w$]/.test(source[i - 2] ?? '') ? word + c : c
      else if (!/\s/.test(c)) word = ''
      if (!/\s/.test(c)) last = c
    }
    return out
  }
  function template() {
    let out = '`'
    i++
    while (i < n && source[i] !== '`') {
      if (source[i] === '\\') {
        out += source.slice(i, i + 2)
        i += 2
      } else if (source[i] === '$' && source[i + 1] === '{') {
        i += 2
        out += '${' + code(true) + '}'
        i++
      } else {
        out += source[i]
        i++
      }
    }
    i++
    return out + '`'
  }
  return code(false)
}

test('代码里只许出现白名单里的地址和接口，不碰下单、库存、登录', async () => {
  const ALLOWED_HOSTS = new Set([
    // 数据源
    'm.damai.cn',
    'mtop.damai.cn',
    'show.maoyan.com',
    'm.dianping.com',
    'www.showstart.com',
    // 推送通道
    'qyapi.weixin.qq.com',
    'sctapi.ftqq.com',
    'sct.ftqq.com',
    'wxpusher.zjiecode.com',
    'api.day.app',
  ])
  // 推送通道里拼出来的地址：Server酱³ 的地址里有用户编号，只认这一处
  const DYNAMIC_OK = new Set(['notify/channels.mjs:https://${sc3[1]}.push.ft07.com'])
  const ALLOWED_MTOP = new Set(['mtop.damai.wireless.search.search', 'mtop.damai.item.detail.getdetail'])
  const FORBIDDEN_PATH = /order|buy|cart|pay|login|passport|captcha|subpage|sku|stock/i
  // 可选的数据源适配器自己声明域名（ENDPOINT_HOSTS），只对它自己那个文件放行
  const ownHosts = {}
  for (const f of fs.readdirSync(path.join(SRC, 'sources'))) {
    if (!f.endsWith('.mjs') || f === 'index.mjs') continue
    const mod = await import(new URL(`../src/sources/${f}`, import.meta.url))
    ownHosts[path.join('sources', f)] = new Set(mod.ENDPOINT_HOSTS ?? [])
  }
  const files = fs.readdirSync(SRC, { recursive: true }).filter((f) => f.endsWith('.mjs'))
  const bad = []
  let seen = 0
  for (const f of files) {
    const code = stripComments(fs.readFileSync(path.join(SRC, f), 'utf8'))
    for (const m of code.matchAll(/https?:\/\/([a-zA-Z0-9.-]+)([^\s'"`)]*)/g)) {
      seen++
      if (!ALLOWED_HOSTS.has(m[1]) && !ownHosts[f]?.has(m[1])) bad.push(`${f}：没列进白名单的地址 ${m[0]}`)
      else if (FORBIDDEN_PATH.test(m[2])) bad.push(`${f}：像下单、库存、登录的地址 ${m[0]}`)
    }
    // 用模板或加号拼出来的域名，静态看不出是哪里，一律报出来，除非列进 DYNAMIC_OK
    for (const m of code.matchAll(/https?:\/\/\$\{[^}]*\}[^\s'"`/]*/g)) if (!DYNAMIC_OK.has(`${f}:${m[0]}`)) bad.push(`${f}：拼出来的地址 ${m[0]}`)
    for (const m of code.matchAll(/['"`]https?:\/\/['"`]\s*\+/g)) bad.push(`${f}：拼出来的地址 ${m[0]}`)
    // 只写了路径的接口（秀动、猫眼的写法）也查
    for (const m of code.matchAll(/['"`](\/[^'"`\s]*)['"`]/g)) if (FORBIDDEN_PATH.test(m[1].replace(/\$\{[^}]*\}/g, ''))) bad.push(`${f}：像下单、库存、登录的路径 ${m[1]}`)
    for (const m of code.matchAll(/['"`](mtop\.[\w.]+)['"`]/gi)) {
      if (m[1] !== 'mtop.damai.cn' && !ALLOWED_MTOP.has(m[1].toLowerCase())) bad.push(`${f}：没列进白名单的接口 ${m[1]}`)
    }
  }
  assert.ok(seen >= 15, `扫到的网址太少（${seen} 个），注释可能剥过头了`)
  assert.deepEqual(bad, [])
})

test('剥注释不会吃掉代码：字符串里的 /* 和 //、正则里的引号都不算注释', () => {
  const code = stripComments(
    [
      "const H = { accept: 'text/html, */*' }",
      "const URL1 = 'https://evil.example.com/order'",
      '// https://in.comment/order',
      'x() // 末尾的注释 https://c/',
      "/* lead */ export const A = 'https://evil-a.example.com/order'",
      '/*',
      ' * 多行',
      " */ export const B = 'https://evil-b.example.com/x'",
      "export const J = 'see // https://evil-j.example.com/x'",
      "const R = s.replace(/^[\"']|[\"']$/g, '') + 'https://evil-r.example.com/'",
      'const D = a / b // 除号后面的注释',
      "function f(u) { return /^https?:\\/\\//.test(u) ? u : 'https://evil-1.example/order' }",
      "const T = `pre ${b + `//`} https://evil-4.example/x`",
    ].join('\n'),
  )
  for (const host of ['evil.example.com', 'evil-a.example.com', 'evil-b.example.com', 'evil-j.example.com', 'evil-r.example.com', 'evil-1.example', 'evil-4.example']) assert.ok(code.includes(host), host)
  assert.doesNotMatch(code, /in\.comment|末尾的注释|多行|lead|除号后面/)
})

test('请求客户端在发出去之前查网址：域名白名单、下单库存登录、大麦接口名', async () => {
  const sent = []
  const client = (site, extra = {}) =>
    createClient({ site, minGapMs: 0, sleep: async () => {}, transport: async (req) => (sent.push(req.url), { status: 200, headers: {}, text: '{}' }), ...extra })
  await assert.rejects(client('damai').request({ url: 'https://evil.example.com/a' }), /不许请求的地址/)
  await assert.rejects(client('damai').request({ url: 'https://mtop.damai.cn/h5/mtop.alibaba.detail.subpage.getdetail/1.0/' }), /下单、库存|大麦接口/)
  await assert.rejects(client('damai').request({ url: 'https://mtop.damai.cn/h5/mtop.damai.other.api/1.0/' }), /不许请求的大麦接口/)
  await assert.rejects(client('showstart').request({ method: 'POST', url: 'https://www.showstart.com/api/web/order/create' }), /下单、库存/)
  await client('damai').request({ url: 'https://mtop.damai.cn/h5/mtop.damai.item.detail.getdetail/1.0/?data=1' })
  await client('maoyan').request({ url: 'https://m.dianping.com/myshow/ajax/performances/0;st=0;k=New%20Order;p=1' })
  await client('bark').request({ url: 'https://bark.my-home.example/push' })
  await client('gov', { hosts: ['gov.example'] }).request({ url: 'https://gov.example/q' })
  await assert.rejects(client('gov', { hosts: ['gov.example'] }).request({ url: 'https://other.example/q' }), /不许请求的地址/)
  assert.equal(sent.length, 4, '被拦下的一个都没发出去')
})

test('每个数据源的请求都在白名单检查之下，clientOptions 塞不进测试用的口子', async () => {
  const { ADAPTERS } = await import('../src/sources/index.mjs')
  for (const a of ADAPTERS) {
    assert.ok(!PUSH_SITES.has(a.clientOptions.site), `${a.name} 用了推送通道的名字`)
    assert.ok(SOURCE_SITES.has(a.clientOptions.site) || a.clientOptions.hosts?.length, `${a.name} 的请求没有白名单检查`)
    assert.doesNotThrow(() => createSourceClient(a.clientOptions))
  }
  assert.throws(() => createSourceClient({ site: 'bark', hosts: ['x.example'] }), /推送通道的名字/)
  assert.throws(() => createSourceClient({ site: 'damai', sleep: async () => {} }), /不认这些项：sleep/)
})

test('猫眼搜索词里带 / 和 ; 不会被当成下单接口', async () => {
  const client = createClient({ site: 'maoyan', minGapMs: 0, sleep: async () => {}, transport: async () => ({ status: 200, headers: {}, text: '{}' }) })
  for (const name of ['PTP/Pay money To my Pain', '中文名/English', 'A;order', 'Cart%Stock']) {
    await client.request({ url: `https://m.dianping.com/myshow/ajax/performances/0;st=0;k=${encodeURIComponent(name)};p=1;s=30;tft=0?cityId=10` })
  }
  await assert.rejects(client.request({ url: 'https://m.dianping.com/myshow/ajax/%6Frder/1' }), /下单、库存/)
})

test('频率下限的数值写死，降低要改这里', () => {
  assert.equal(MIN_GAP_FLOOR_MS, 2000)
  assert.equal(MIN_FETCH_GAP_MS, 3600_000)
  assert.equal(MIN_CHECK_GAP_MS, 60_000)
  assert.equal(MAX_ARTISTS, 50)
  assert.equal(MAX_ALIASES, 5)
})

test('锁：进程号对得上、记号对不上的，是上次运行留下的，当陈旧清掉', async () => {
  const file = path.join(tmp(), 'run.lock')
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now(), token: 'old-run' }))
  assert.equal(await withLock(file, async () => 'ok', { waitMs: 50, pollMs: 5, log: () => {} }), 'ok')
})

test('艺人清单不存在时，从 config/artists.txt 复制一份底稿再加', () => {
  const file = path.join(tmp(), 'rt', 'artists.txt')
  followArtist('告五人、潘云安', file)
  const text = fs.readFileSync(file, 'utf8')
  assert.match(text, /^# 关注的艺人/)
  assert.match(text, /告五人、潘云安\n$/)
})

test('常驻模式：两个固定时刻之间最多补一轮，不会变成每小时抓一次', () => {
  const at = (h, m) => fromBeijing(2026, 10, 27, h, m)
  const none = () => 0
  // 8:30 预演过：8:40 起的第一轮全部跳过，9:07 那轮也跳过 → 满 1 小时（9:31）补一轮；补的那轮取到了 → 回到固定时刻
  const skipped = [{ artists: 0, recent: ['甲'], retryAt: at(9, 30) }]
  let plan = planNextRound(at(8, 40), skipped, {}, none)
  assert.equal(plan.next, at(9, 7), '固定时刻比补轮早，先等固定时刻')
  plan = planNextRound(at(9, 8), skipped, plan, none)
  assert.equal(plan.next, at(9, 31))
  plan = planNextRound(at(9, 33), [{ artists: 1 }], plan, none)
  assert.equal(plan.next, at(15, 7))

  // 一部分被跳过、一部分取到：不补轮，免得两组交替触发
  plan = planNextRound(at(10, 0), [{ artists: 3, recent: ['乙'], retryAt: at(10, 40) }], {}, none)
  assert.equal(plan.next, at(15, 7))

  // 时间到了没取完：半小时后补一轮；补的那轮又没取完，也不再补，等固定时刻
  plan = planNextRound(at(9, 32), [{ artists: 30, unfinished: ['丙'] }], {}, none)
  assert.equal(plan.next, at(10, 2))
  plan = planNextRound(at(10, 27), [{ artists: 20, unfinished: ['丁'], recent: ['甲'], retryAt: at(10, 30) }], plan, none)
  assert.equal(plan.next, at(15, 7))
  plan = planNextRound(at(15, 30), [{ artists: 5, unfinished: ['丁'] }], plan, none)
  assert.equal(plan.next, at(16, 0), '到了下一个固定时刻，补轮的名额重新算')
})

test('等锁时收到停止信号就不再等', async () => {
  const file = path.join(tmp(), 'run.lock')
  fs.writeFileSync(file, JSON.stringify({ pid: process.ppid, at: Date.now() }))
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), 20)
  await assert.rejects(withLock(file, async () => {}, { pollMs: 5, log: () => {}, signal: ctrl.signal }), (err) => err.code === 'ABORTED')
})

test('unfollow 主名、别名、换个写法都认；底稿改了不生效时说清真清单在哪', () => {
  const file = path.join(tmp(), 'artists.txt')
  fs.writeFileSync(file, '五月天、MAYDAY\n回春丹乐队\n')
  assert.equal(unfollowArtist('mayday', file), '五月天')
  assert.equal(unfollowArtist('回春丹', file), '回春丹乐队')
  assert.equal(unfollowArtist('没有这个人', file), null)
  assert.equal(fs.readFileSync(file, 'utf8').trim(), '')
  assert.equal(templateHint([], file), null, '仓库里的底稿只有注释，不提示')
})

test('setup-push 用管道一次喂几行也不丢；输入提前结束说清没保存', async () => {
  const { spawnSync } = await import('node:child_process')
  const rt = tmp()
  const run = (input) =>
    spawnSync(process.execPath, ['--no-warnings', path.join(SRC, 'cli.mjs'), 'setup-push'], { input, encoding: 'utf8', env: { ...process.env, SHOW_RADAR_RUNTIME: rt } })
  fs.writeFileSync(path.join(rt, 'secrets.env'), 'BARK_KEY=k1\nWECOM_CORP_ID=ww1\n')
  const removed = run('5\n2\n')
  assert.match(removed.stdout, /去掉了 企业微信。还在用的：Bark/)
  assert.doesNotMatch(fs.readFileSync(path.join(rt, 'secrets.env'), 'utf8'), /WECOM/)
  const cut = run('1\n')
  assert.match(cut.stdout, /输入提前结束，没保存/)
  assert.equal(cut.status, 1)
  const bad = run('1\nabc\n')
  assert.match(bad.stdout, /SendKey 应该是/)
})

test('常驻模式：一天只取一次的数据源这一轮取到了，别的数据源全被跳过时照样补轮', () => {
  const at = (h, m) => fromBeijing(2026, 10, 27, h, m)
  const sources = [
    { artists: 0, recent: ['乙'], retryAt: at(9, 30) },
    { artists: 0, recent: ['乙'], retryAt: at(9, 30) },
    { artists: 10 },
  ]
  const plan = planNextRound(at(9, 8), sources, { regular: at(9, 7) }, () => 0)
  assert.equal(plan.next, at(9, 31))
})
