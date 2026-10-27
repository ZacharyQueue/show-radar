#!/usr/bin/env node
// 命令入口。用法见 docs/design.md“命令”。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import {
  ARTISTS_FILE,
  DB_FILE,
  FETCH_LOG_FILE,
  LAST_REQUEST_FILE,
  LOCK_FILE,
  followArtist,
  limitArtists,
  loadArtists,
  loadSecrets,
  saveSecrets,
  templateHint,
  unfollowArtist,
} from './config.mjs'
import { ApiChangedError, BlockedError, NetworkError } from './errors.mjs'
import { MIN_CHECK_GAP_MS, fetchKey, openFetchLog } from './fetch-log.mjs'
import { MIN_GAP_FLOOR_MS, createSourceClient, msUntilSourceGap, onSourceRequest } from './http.mjs'
import { withLock } from './lock.mjs'
import { parseBarkInput } from './notify/channels.mjs'
import { showLine } from './notify/format.mjs'
import { CHANNELS, createConsoleNotifier, createNotifier, createUnconfiguredNotifier, inspectChannels } from './notify/index.mjs'
import { runRound } from './run.mjs'
import { runReminders } from './remind.mjs'
import { REMIND_EVERY_MS, planNextRound } from './schedule.mjs'
import { openStore } from './store.mjs'
import { SOURCE_LABELS } from './stage.mjs'
import { sameName } from './text.mjs'
import { beijingParts } from './time.mjs'

const HELP = `演出雷达：跟踪关注的艺人在全国的演出，阶段一变就推送。
命令写成 node src/cli.mjs 命令；用安装脚本装在服务器上的，写 show-radar 命令。

  follow 名字[、别名…]      关注一位艺人，别名用顿号隔开，比如 follow 告五人、潘云安
  unfollow 名字              不再关注
  status                     列出每位艺人在跟踪的演出
  setup-push                 选推送通道、填密钥，填完发一条测试消息；也能去掉配好的通道
  test-push                  给配好的每个通道发一条测试消息
  check [--source damai]     每个数据源发一两个请求，看通不通
  run [--dry-run] [--artist 名字] [--source damai]
                             跑一轮抓取。--dry-run 在状态库的副本上跑，只打印要推的消息
  remind [--dry-run]         跑一次开售提醒
  daemon                     一直跑着：按时抓取、每 10 分钟提醒，给没有 systemd 的电脑和 NAS 用
`

// 被要求停下（Ctrl+C、systemd 停服务）时，正在跑的那一轮不再取新的艺人，把已经取到的存下再退出
const stopping = new AbortController()

async function main() {
  const [command = 'help', ...rest] = process.argv.slice(2)
  if ('SHOW_RADAR_LOCAL_ADDRESS' in process.env && !process.env.SHOW_RADAR_LOCAL_ADDRESS.trim()) {
    console.log('SHOW_RADAR_LOCAL_ADDRESS 是空的，没有绑定网卡，请求照常从默认的出口出去。先查一下这台电脑的局域网地址，比如 macOS 运行 ipconfig getifaddr en0，看有没有输出。')
  }
  const flags = parseFlags(rest)
  switch (command) {
    case 'run':
      catchStop()
      return cmdRun(flags)
    case 'remind':
      return cmdRemind(flags)
    case 'check':
      return cmdCheck(flags)
    case 'status':
      return cmdStatus()
    case 'test-push':
      return cmdTestPush()
    case 'setup-push':
      return cmdSetupPush()
    case 'setup-wecom':
      return cmdSetupPush('wecom')
    case 'daemon':
      catchStop()
      return cmdDaemon()
    case 'follow':
      return cmdFollow(rest.filter((a) => !a.startsWith('--')).join(' '))
    case 'unfollow':
      return cmdUnfollow(rest.filter((a) => !a.startsWith('--')).join(' '))
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP)
      return
    default:
      // 打错命令要说出来，退出码也不能是 0：任务计划程序会把它当成成功
      console.log(`没有“${command}”这个命令。\n`)
      console.log(HELP)
      process.exitCode = 1
  }
}

/** 第一次 Ctrl+C 或 SIGTERM：这一轮收尾后退出；第二次：马上退出。 */
function catchStop() {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (stopping.signal.aborted) process.exit(1)
      console.log('收到停止信号：不再取新的艺人，把已经取到的存下再退出。再按一次 Ctrl+C 马上退出。')
      stopping.abort()
    })
  }
}

function cmdFollow(line) {
  if (!line.trim()) return fail('用法：follow 名字、别名，比如 follow 告五人、潘云安')
  let a
  try {
    a = followArtist(line)
  } catch (err) {
    return fail(`没加上：${err.message}。`)
  }
  const aliases = a.aliases.length ? `（别名：${a.aliases.join('、')}）` : ''
  if (a.added) console.log(`关注了 ${a.key}${aliases}。下一轮抓取时会发一条汇总，说清各平台找到了什么。`)
  else if (a.newAliases.length) console.log(`给 ${a.key} 补了别名：${a.newAliases.join('、')}。还没找到这位艺人的平台，下一轮用新别名重找。`)
  else console.log(`${a.key} 已经在关注了${aliases}，没有变化。`)
  if (line.includes(',')) console.log('名字里的半角逗号算名字的一部分，没有拆开；要写别名请用顿号“、”。')
  syncNow()
}

function cmdUnfollow(name) {
  if (!name.trim()) return fail('用法：unfollow 名字，比如 unfollow 告五人')
  const removed = unfollowArtist(name.trim())
  if (!removed) return fail(`清单里没有 ${name.trim()}。现在关注的：${loadArtists().map((a) => a.key).join('、') || '还没有'}`)
  console.log(`不再关注 ${removed}，以后不推这位艺人的消息。`)
  syncNow()
}

/** 改完清单马上同步到状态库（不联网）：取消关注的人，开售提醒和 status 立刻不再出现。 */
function syncNow() {
  const store = openStore(DB_FILE)
  try {
    const tracked = new Set(store.activeArtists().map((a) => a.key))
    store.syncArtists(limitArtists(loadArtists(), tracked).artists, Date.now())
  } finally {
    store.close()
  }
}

const SETUP_MENU = [
  ['serverchan', 'Server酱：微信扫码就能用，消息进微信。免费每天 5 条、只显示标题，几条消息会合成一条发'],
  ['wxpusher', 'WxPusher：免费，消息进它自己的 App（安卓、iPhone、电脑都有），不进微信'],
  ['bark', 'Bark：免费，只有 iPhone'],
  ['wecom', '企业微信：消息能进微信，但要固定公网 IP 的服务器和备案过的域名，配置最麻烦'],
]

/** 选通道、填密钥，存进 secrets.env，再用这个通道发一条测试消息。也能去掉一个配好的通道。 */
async function cmdSetupPush(preset) {
  const { ready, partial } = inspectChannels(loadSecrets())
  const configured = [...ready, ...partial]
  const rl = lineReader()
  let id = preset
  let values
  try {
    if (!id) {
      if (ready.length) console.log(`已经配好的：${ready.map((c) => c.name).join('、')}。配了几个就每个都发。`)
      if (partial.length) console.log(`没配全的：${partial.map((c) => c.name).join('、')}。`)
      if (configured.length) console.log('')
      console.log('选推送通道（填数字）：')
      SETUP_MENU.forEach(([, text], i) => console.log(`  ${i + 1}  ${text}`))
      if (configured.length) console.log(`  ${SETUP_MENU.length + 1}  去掉一个已经配过的通道`)
      const answer = await rl.ask('选哪个：')
      if (answer == null) return fail('输入提前结束，什么都没改。')
      const n = Number(answer)
      if (configured.length && n === SETUP_MENU.length + 1) return await removeChannel(rl, configured, ready)
      id = SETUP_MENU[n - 1]?.[0]
      if (!id) return fail('没有这个选项，没保存。')
    }
    values = await askChannel(rl, id)
  } finally {
    rl.close()
  }
  if (!values) return
  saveSecrets(values)
  console.log('保存好了，发一条测试消息试试。')
  await testChannels(CHANNELS.filter((c) => c.id === id))
}

async function removeChannel(rl, configured, ready) {
  configured.forEach((c, i) => console.log(`  ${i + 1}  ${c.name}`))
  const answer = await rl.ask('去掉哪个：')
  if (answer == null) return fail('输入提前结束，什么都没改。')
  const c = configured[Number(answer) - 1]
  if (!c) return fail('没有这个选项，什么都没改。')
  saveSecrets(Object.fromEntries([...c.keys, ...(c.id === 'bark' ? ['BARK_SERVER'] : [])].map((k) => [k, null])))
  const left = ready.filter((r) => r.id !== c.id)
  console.log(`去掉了 ${c.name}。${left.length ? `还在用的：${left.map((r) => r.name).join('、')}。` : '现在一个推送通道都没有了，消息会先存着，再配好以后一起发。'}`)
}

/**
 * 一行行读输入。管道、一次粘贴好几行时，提前到的行先存着，不丢；输入提前结束时 ask 返回 null。
 * readline 的 question 在这两种情况下会丢行、悄悄退出。
 */
function lineReader() {
  const rl = readline.createInterface({ input: process.stdin, terminal: Boolean(process.stdin.isTTY), output: process.stdin.isTTY ? process.stdout : undefined })
  const lines = []
  const waiting = []
  let closed = false
  rl.on('line', (line) => (waiting.length ? waiting.shift()(line.trim()) : lines.push(line.trim())))
  rl.on('close', () => {
    closed = true
    while (waiting.length) waiting.shift()(null)
  })
  return {
    ask(question) {
      // 终端里让 readline 知道提示是什么：按退格、方向键重画这一行时，问题文字不会被抹掉
      if (process.stdin.isTTY) {
        rl.setPrompt(question)
        rl.prompt()
      } else process.stdout.write(question)
      if (lines.length) return Promise.resolve(lines.shift())
      if (closed) return Promise.resolve(null)
      return new Promise((resolve) => waiting.push(resolve))
    },
    close: () => rl.close(),
  }
}

async function askChannel(rl, id) {
  const ask = async (q) => {
    const answer = await rl.ask(q)
    if (answer == null) throw new EndOfInput()
    return answer
  }
  try {
    return await askChannelValues(ask, id)
  } catch (err) {
    if (err instanceof EndOfInput) return fail('输入提前结束，没保存。')
    throw err
  }
}

class EndOfInput extends Error {}

async function askChannelValues(ask, id) {
  if (id === 'serverchan') {
    const key = await ask('SendKey（在 https://sct.ftqq.com/sendkey 复制，SCT 或 sctp 开头）：')
    if (!/^sct\w+$/i.test(key)) return fail('SendKey 应该是 SCT 或 sctp 开头的一串字母数字，没保存。')
    return { SERVERCHAN_SENDKEY: key }
  }
  if (id === 'wxpusher') {
    const spt = await ask('SPT（扫 https://wxpusher.zjiecode.com/docs/spt.html 上的二维码拿，SPT_ 开头）：')
    if (!/^SPT_\w+$/.test(spt)) return fail('SPT 应该是 SPT_ 开头的一串字母数字，没保存。')
    return { WXPUSHER_SPT: spt }
  }
  if (id === 'bark') {
    const input = await ask('Bark App 首页的推送地址，比如 https://api.day.app/xxxx/，整个粘贴就行：')
    const { server, key } = parseBarkInput(input)
    if (!/^\w+$/.test(key)) return fail('没认出 key，没保存。')
    // 用官方服务器时清掉以前存的自建地址
    return { BARK_KEY: key, BARK_SERVER: server !== 'https://api.day.app' ? server : null }
  }
  console.log('企业微信要先在网页后台建一个自建应用，配好可信域名和可信 IP，步骤见 docs/deploy.md。')
  const corp = await ask('企业 ID（我的企业 → 企业信息 最下面，ww 开头）：')
  const agent = await ask('AgentId（应用管理 → 你建的应用）：')
  const secret = await ask('Secret（同一页，点“查看”后发到企业微信里）：')
  const toUser = await ask('接收人：你自己的成员账号（通讯录 → 点自己 → 账号）：')
  if (!corp || !agent || !secret || !toUser) return fail('有一项是空的，没保存。')
  return { WECOM_CORP_ID: corp, WECOM_AGENT_ID: agent, WECOM_SECRET: secret, WECOM_TO_USER: toUser }
}

async function cmdTestPush() {
  const { ready, problems } = inspectChannels(loadSecrets())
  for (const p of problems) console.log(p)
  if (!ready.length) return fail('还没配推送，先运行 setup-push。')
  await testChannels(ready)
}

/** 每个通道单独发一条，各自报通没通。 */
async function testChannels(defs) {
  const store = openStore(DB_FILE)
  const secrets = loadSecrets()
  const message = {
    title: '演出雷达 · 测试',
    description: '<div class="highlight">能看到这条，推送就通了</div><div class="gray">以后演出有变化会这样推给你</div>',
    short: '演出雷达：推送通了',
    text: '能看到这条，推送就通了。以后演出有变化会这样推给你。',
    url: 'https://m.damai.cn/',
    btntxt: '知道了',
  }
  let allOk = true
  try {
    for (const def of defs) {
      try {
        await def.make(secrets, store.kv).send(message)
        const where = def.id === 'wecom' || def.id === 'serverchan' ? '微信' : `${def.name} App `
        console.log(`发出去了　${def.name}：去${where}里看看。${def.id === 'serverchan' ? '这条也算今天 5 条免费额度里的一条。' : ''}`)
      } catch (err) {
        allOk = false
        console.log(`没发出去　${def.name}：${err.message}`)
      }
    }
  } finally {
    store.close()
  }
  if (!allOk) process.exitCode = 1
}

/** 跑一轮抓取，返回这一轮的统计；没跑成返回 null。 */
async function cmdRun(flags) {
  const artistList = loadArtists()
  if (!artistList.length) {
    console.log(`艺人清单是空的，先用 follow 加要关注的艺人（清单在 ${ARTISTS_FILE}）。`)
    return null
  }
  let onlyArtist
  if (flags.artist !== undefined) {
    const wanted = flags.artist === true ? '' : String(flags.artist)
    onlyArtist = artistList.find((a) => [a.key, ...a.aliases].some((n) => sameName(n, wanted)))?.key
    if (!onlyArtist) return fail(`清单里没有“${wanted}”。现在关注的：${artistList.map((a) => a.key).join('、')}`)
  }
  const adapters = await pickAdapters(flags.source)
  try {
    return await lockedWithGap(() =>
      withStore(flags, async (store) => {
        const startedAt = Date.now()
        // 状态库里有过的艺人（包括取消关注的）不算误改底稿
        const hint = templateHint(artistList, ARTISTS_FILE, store.knownArtistKeys())
        if (hint) console.log(hint)
        const { artists, warnings } = limitArtists(artistList, new Set(store.activeArtists().map((a) => a.key)))
        for (const w of warnings) console.log(w)
        const fetchLog = openFetchLog(FETCH_LOG_FILE)
        const stats = await runRound({
          store,
          adapters,
          artists,
          notifier: makeNotifier(store, flags),
          onlyArtist,
          forceSlow: Boolean(flags['force-slow']),
          fetchLog,
          signal: stopping.signal,
        })
        console.log(JSON.stringify(stats, null, 2))
        const sources = Object.values(stats.sources).filter((s) => typeof s === 'object')
        const recent = [...new Set(sources.flatMap((s) => s.recent ?? []))]
        if (recent.length) console.log(`1 小时内刚取过，这一轮跳过了：${recent.join('、')}。同一位艺人在同一个平台上 1 小时最多取一次，保护各平台。`)
        if (flags['dry-run']) {
          // 这次预演真正去取了的艺人，满 1 小时以后正式跑才会再取
          const fetched = artists
            .map((a) => ({ key: a.key, at: Math.max(...adapters.map((ad) => fetchLog.get(fetchKey(ad.name, a.key)) ?? -Infinity)) }))
            .filter((x) => x.at >= startedAt)
          if (fetched.length) {
            const latest = Math.max(...fetched.map((x) => x.at))
            console.log(`预演也是真的去各平台取了一次：${fetched.map((x) => x.key).join('、')} 要到 ${stamp(latest + 3600_000)} 以后正式跑才会再取。`)
          }
        }
        return stats
      }),
    )
  } catch (err) {
    if (err.code === 'ABORTED') return null
    throw err
  }
}

/**
 * run 和 check 在锁里跑。开始之前，从上一个进程最后一次请求数据源的时间算起等满 2 秒：
 * 这个时间每次请求都写到磁盘上，上一个进程被杀了也作数。放锁之前也等满 2 秒。
 */
async function lockedWithGap(fn) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  return withLock(
    LOCK_FILE,
    async () => {
      const before = readLastRequest() + MIN_GAP_FLOOR_MS - Date.now()
      if (before > 0) await sleep(Math.min(before, MIN_GAP_FLOOR_MS))
      onSourceRequest((t) => fs.writeFileSync(LAST_REQUEST_FILE, String(t)))
      try {
        return await fn()
      } finally {
        const wait = msUntilSourceGap()
        if (wait > 0) await sleep(wait)
      }
    },
    { signal: stopping.signal },
  )
}

function readLastRequest() {
  try {
    const t = Number(fs.readFileSync(LAST_REQUEST_FILE, 'utf8'))
    return Number.isFinite(t) ? t : -Infinity
  } catch {
    return -Infinity
  }
}

async function cmdRemind(flags) {
  await withStore(flags, async (store) => {
    const sent = await runReminders({ store, notifier: makeNotifier(store, flags, { quiet: true }) })
    if (sent) console.log(flags['dry-run'] ? `会发 ${sent} 条开售提醒` : `发了 ${sent} 条开售提醒`)
  })
}

/**
 * 一直跑着：抓取按时刻表，开售提醒每 10 分钟，两件事各走各的，抓取再慢也不耽误提醒。
 * 每次都重读艺人清单和推送密钥，改了不用重启。
 */
async function cmdDaemon() {
  const log = (msg) => console.log(`${stamp(Date.now())} ${msg}`)
  log('常驻模式：抓取在北京时间 3:07、9:07、15:07、21:07 前后各一轮，开售提醒每 10 分钟一次。按 Ctrl+C 停止。')
  await Promise.all([roundLoop(log), remindLoop(log)])
  log('停了。')
}

/** 抓取的循环。什么时候跑下一轮见 schedule.mjs 的 planNextRound。 */
async function roundLoop(log) {
  let plan = {}
  while (!stopping.signal.aborted) {
    let stats = null
    try {
      stats = await cmdRun({})
    } catch (err) {
      log(`这一轮出错了，下一轮照常：${err.message}`)
    }
    if (stopping.signal.aborted) return
    const sources = Object.values(stats?.sources ?? {}).filter((s) => typeof s === 'object')
    plan = planNextRound(Date.now(), sources, plan)
    log(`下一轮抓取：${stamp(plan.next)}`)
    await sleepUntil(plan.next)
  }
}

async function remindLoop(log) {
  while (!stopping.signal.aborted) {
    try {
      await cmdRemind({})
    } catch (err) {
      log(`开售提醒出错了，10 分钟后再试：${err.message}`)
    }
    await sleepUntil(Date.now() + REMIND_EVERY_MS)
  }
}

/** 睡到某个时刻，被要求停下时提前醒。最多睡一分钟就醒来看一眼：电脑睡眠、改了系统时间，醒来都能接上。 */
async function sleepUntil(at) {
  while (Date.now() < at && !stopping.signal.aborted) {
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        stopping.signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, Math.max(1000, Math.min(at - Date.now(), 60_000)))
      stopping.signal.addEventListener('abort', done, { once: true })
    })
  }
}

/** --dry-run 时在状态库的副本上跑，跑完删掉，正式的状态库一点不动。 */
async function withStore(flags, fn) {
  if (!flags['dry-run']) {
    const store = openStore(DB_FILE)
    try {
      return await fn(store)
    } finally {
      store.close()
    }
  }
  const copy = path.join(os.tmpdir(), `show-radar-dry-${process.pid}.sqlite`)
  if (fs.existsSync(DB_FILE)) {
    const real = openStore(DB_FILE)
    try {
      real.db.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`)
    } finally {
      real.close()
    }
  }
  const store = openStore(copy)
  console.log('预演：在状态库的副本上跑，只打印要推的消息，正式的状态库不动。')
  try {
    return await fn(store)
  } finally {
    store.close()
    for (const f of [copy, `${copy}-wal`, `${copy}-shm`]) fs.rmSync(f, { force: true })
  }
}

async function cmdCheck(flags) {
  const adapters = await pickAdapters(flags.source)
  await lockedWithGap(async () => {
    // check 每次是新进程，进程之间没有请求间隔，所以同一个数据源两次 check 之间也要隔开
    const fetchLog = openFetchLog(FETCH_LOG_FILE)
    const kv = memoryKv()
    let allOk = true
    for (const adapter of adapters) {
      const label = adapter.label ?? SOURCE_LABELS[adapter.name] ?? adapter.name
      const last = fetchLog.get(`check.${adapter.name}`)
      if (last != null && last <= Date.now() && Date.now() - last < MIN_CHECK_GAP_MS) {
        console.log(`跳过　${label}：${Math.ceil((MIN_CHECK_GAP_MS - (Date.now() - last)) / 1000)} 秒以后再 check，同一个平台两次至少隔 1 分钟。`)
        continue
      }
      fetchLog.set(`check.${adapter.name}`, Date.now())
      const client = createSourceClient(adapter.clientOptions)
      const ctx = { client, now: Date.now, log: () => {}, kv, previous: () => null }
      const kindOf = (err) =>
        err instanceof BlockedError ? '被拦' : err instanceof ApiChangedError ? '接口变了' : err instanceof NetworkError ? '连不上' : '出错'
      try {
        const r = await adapter.check(ctx)
        const kind = r.ok ? '通' : r.error ? kindOf(r.error) : '不通'
        console.log(`${kind}　${label}：${r.detail}（${client.requestCount} 次请求）`)
        if (!r.ok) allOk = false
      } catch (err) {
        allOk = false
        console.log(`${kindOf(err)}　${label}：${err.message}（${client.requestCount} 次请求）`)
      }
    }
    if (!allOk) {
      console.log('有平台没通。电脑开着代理或加速器的全局模式、TUN 模式时，请求会从境外出去，先关掉再试；一直被拦，见 docs/deploy.md“常见问题”。')
    }
    const { ready, problems } = inspectChannels(loadSecrets())
    for (const p of problems) console.log(`推送：${p}`)
    console.log(ready.length ? `推送：${ready.map((c) => c.name).join('、')} 已配置，用 test-push 发一条试试` : '推送：还没配，运行 setup-push')
    process.exitCode = allOk ? 0 : 1
  })
}

function cmdStatus() {
  const store = openStore(DB_FILE)
  try {
    const artists = store.activeArtists()
    if (!artists.length) console.log('还没跑过抓取，或者还没关注艺人。先 follow，再 run。')
    for (const a of artists) {
      const ids = Object.entries(a.ids)
        .filter(([, id]) => id)
        .map(([src, id]) => `${SOURCE_LABELS[src] ?? src} ${id}${a.idNames[src] && a.idNames[src] !== a.key ? `（${a.idNames[src]}）` : ''}`)
      console.log(`\n${a.key}${a.aliases.length ? `（${a.aliases.join('、')}）` : ''}　${ids.join('，') || '还没找到平台 ID'}`)
      const shows = store.showsForArtist(a.key).filter((s) => s.stage && s.stage !== 'ended')
      if (!shows.length) console.log('  没有在跟踪的演出')
      for (const s of shows) console.log(`  · ${showLine(s)}　${s.venue ?? ''}`)
    }
  } finally {
    store.close()
  }
}

/** quiet：开售提醒每 10 分钟跑一次，没配全的通道不每次都念一遍。 */
function makeNotifier(store, flags, { quiet = false } = {}) {
  const secrets = loadSecrets()
  const { ready, problems } = inspectChannels(secrets)
  if (flags['dry-run']) {
    const batch = ready.some((c) => c.id === 'serverchan')
    return createConsoleNotifier({ batch, single: !batch || ready.some((c) => c.id !== 'serverchan') })
  }
  if (!quiet) for (const p of problems) console.log(`推送：${p}`)
  return createNotifier({ secrets, kv: store.kv }) ?? createUnconfiguredNotifier()
}

async function pickAdapters(source) {
  const { ADAPTERS } = await import('./sources/index.mjs')
  if (!source) return ADAPTERS
  const picked = ADAPTERS.filter((a) => a.name === source)
  if (!picked.length) throw new Error(`没有这个数据源：${source}。可选：${ADAPTERS.map((a) => a.name).join('、')}`)
  return picked
}

function parseFlags(args) {
  const out = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = args[i + 1]
    if (next != null && !next.startsWith('--')) {
      out[key] = next
      i++
    } else {
      out[key] = true
    }
  }
  return out
}

function memoryKv() {
  const m = new Map()
  return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v == null ? null : String(v)) }
}

function stamp(ms) {
  const p = beijingParts(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${p.month}月${p.day}日 ${pad(p.hour)}:${pad(p.minute)}`
}

function fail(message) {
  console.log(message)
  process.exitCode = 1
  return null
}

main().catch((err) => {
  console.error(err.stack ?? err.message)
  process.exitCode = 1
})
