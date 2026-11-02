#!/usr/bin/env node
// 命令入口。用法见 docs/design.md“命令”。
// 这里只管问和打印，操作和规矩都在 app.mjs，网页用的是同一份。

import readline from 'node:readline/promises'
import { Writable } from 'node:stream'
import * as app from './app.mjs'
import { AppError, PUSH_CHANNELS, checkPushField, stamp } from './app.mjs'
import { loadSecrets } from './config.mjs'
import { inspectChannels } from './notify/index.mjs'

const HELP = `演出雷达：跟踪关注的艺人在全国的演出，阶段一变就推送。
命令写成 node src/cli.mjs 命令；用安装脚本装在服务器上的，写 show-radar 命令。

  start [--port 7788] [--no-open]
                             在自己的电脑上用：一直跑着按时抓取，同时打开本机网页，在网页里加艺人、配推送
  web [--port 7788] [--no-open]
                             只打开本机网页看状态、改配置，不按时抓取（已经用 systemd 或 daemon 跑着的用这个）
  follow 名字[、别名…]      关注一位艺人，别名用顿号隔开，比如 follow 告五人、潘云安
  unfollow 名字              不再关注
  status                     列出每位艺人在跟踪的演出
  setup-push                 选推送通道、填密钥，填完发一条测试消息；也能去掉配好的通道
  test-push                  给配好的每个通道发一条测试消息
  pause                      暂停推送：照常抓取，什么都不发
  resume                     恢复推送，马上补发攒下的、还有用的消息
  check [--source damai]     每个数据源发一两个请求，看通不通
  run [--dry-run] [--artist 名字] [--source damai] [--force-slow]
                             跑一轮抓取。--dry-run 在状态库的副本上跑，只打印要推的消息；
                             --force-slow 不等 9 点，今天还没查过文旅部的艺人也查
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
    case 'start':
      catchStop()
      return cmdStart(flags, { daemon: true })
    case 'web':
      catchStop()
      return cmdStart(flags, { daemon: false })
    case 'run':
      catchStop()
      return cmdRun(flags)
    case 'remind':
      return cmdRemind(flags)
    case 'check':
      catchStop('查完手上这个平台就停')
      return cmdCheck(flags)
    case 'status':
      return cmdStatus()
    case 'test-push':
      return cmdTestPush()
    case 'pause':
      return cmdPause()
    case 'resume':
      return cmdResume()
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

/** 第一次 Ctrl+C 或 SIGTERM：手上这件事收尾后退出；第二次：马上退出。 */
function catchStop(what = '不再取新的艺人，把已经取到的存下再退出') {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (stopping.signal.aborted) process.exit(1)
      console.log(`收到停止信号：${what}。再按一次 Ctrl+C 马上退出。`)
      stopping.abort()
    })
  }
}

/** start：常驻抓取，同时开本机网页；web：只开网页。都等到 Ctrl+C 才退出。 */
async function cmdStart(flags, { daemon }) {
  const { DEFAULT_PORT, startWeb } = await import('./web/server.mjs')
  const log = (msg) => console.log(`${stamp(Date.now())} ${msg}`)
  const port = flags.port === undefined ? undefined : Number(flags.port)
  // 只写了 --port 没写数字时 flags.port 是 true，Number(true) 是 1，不能当成 1 号端口
  if (port !== undefined && (flags.port === true || !(Number.isInteger(port) && port > 0 && port < 65536))) return fail('--port 要写 1 到 65535 之间的数字，比如 --port 7788')
  // 网页上点的那一轮也听 Ctrl+C：先存下已经取到的再退出。
  // 写了 --port 就只用这个端口（SSH 端口转发要两头一样），没写才往后找空的
  const web = await startWeb({ port, strictPort: port !== undefined, log, signal: stopping.signal })
  if (port === undefined && web.port !== DEFAULT_PORT) console.log(`${DEFAULT_PORT} 号端口被占了，用的是 ${web.port}。`)
  console.log(`本机网页：${web.url}`)
  console.log('链接带着钥匙，不要发给别人。')
  // 启动的这一会儿已经按了 Ctrl+C：不开浏览器，直接收掉
  if (!flags['no-open'] && !stopping.signal.aborted) web.openBrowser()
  if (stopping.signal.aborted) {
    // 什么都没开始做
  } else if (daemon) {
    log('按时抓取开着，按 Ctrl+C 停止。')
    await app.daemon({ log, signal: stopping.signal })
  } else {
    console.log('只开了网页，不会按时抓取。按 Ctrl+C 关掉。')
    await new Promise((resolve) => (stopping.signal.aborted ? resolve() : stopping.signal.addEventListener('abort', resolve, { once: true })))
  }
  // 网页上点的那一轮还在跑：等它把取到的存下
  if (app.busyState()) log('等网页上点的那一轮收尾，把取到的存下……')
  await app.idle()
  await web.close()
  log('停了。')
}

function cmdFollow(line) {
  if (!line.trim()) return fail('用法：follow 名字、别名，比如 follow 告五人、潘云安')
  const a = app.follow(line)
  const aliases = a.aliases.length ? `（别名：${a.aliases.join('、')}）` : ''
  if (a.added) console.log(`关注了 ${a.key}${aliases}。下一轮抓取时会发一条汇总，说清各平台找到了什么。`)
  else if (a.newAliases.length) console.log(`给 ${a.key} 补了别名：${a.newAliases.join('、')}。还没找到这位艺人的平台，下一轮用新别名重找。`)
  else console.log(`${a.key} 已经在关注了${aliases}，没有变化。`)
  for (const n of a.notes) console.log(n)
}

function cmdUnfollow(name) {
  if (!name.trim()) return fail('用法：unfollow 名字，比如 unfollow 告五人')
  const removed = app.unfollow(name)
  console.log(`不再关注 ${removed}，以后不推这位艺人的消息。`)
}

/** 选通道、填密钥，存进 secrets.env，再用这个通道发一条测试消息。也能去掉一个配好的通道。 */
async function cmdSetupPush(preset) {
  const { ready, partial } = inspectChannels(loadSecrets())
  const configured = [...ready, ...partial]
  const rl = lineReader()
  let id = preset
  let input
  try {
    if (!id) {
      if (ready.length) console.log(`已经配好的：${ready.map((c) => c.name).join('、')}。配了几个就每个都发。`)
      if (partial.length) console.log(`没配全的：${partial.map((c) => c.name).join('、')}。`)
      if (configured.length) console.log('')
      console.log('选推送通道（填数字）：')
      PUSH_CHANNELS.forEach((c, i) => console.log(`  ${i + 1}  ${c.name}${i === 0 ? '（推荐）' : ''}：${c.intro}`))
      if (configured.length) console.log(`  ${PUSH_CHANNELS.length + 1}  去掉一个已经配过的通道`)
      const answer = await rl.ask('选哪个：')
      if (answer == null) return fail('输入提前结束，什么都没改。')
      const n = Number(answer)
      if (configured.length && n === PUSH_CHANNELS.length + 1) return await removeChannel(rl, configured)
      id = PUSH_CHANNELS[n - 1]?.id
      if (!id) return fail('没有这个选项，没保存。')
    }
    input = await askChannel(rl, id)
  } finally {
    rl.close()
  }
  if (!input) return
  app.validatePush(id, input)
  console.log('保存好就发一条测试消息试试。')
  const result = await app.savePush(id, input)
  printTest(result)
  if (result.fromEnv.length) fail(`注意：环境变量 ${result.fromEnv.join('、')} 里也设了，它会盖过刚存的值，测试消息用的也是它。要用刚填的，把环境变量去掉。`)
}

async function removeChannel(rl, configured) {
  configured.forEach((c, i) => console.log(`  ${i + 1}  ${c.name}`))
  const answer = await rl.ask('去掉哪个：')
  if (answer == null) return fail('输入提前结束，什么都没改。')
  const c = configured[Number(answer) - 1]
  if (!c) return fail('没有这个选项，什么都没改。')
  const { removed, left, fromEnv } = app.removePush(c.id)
  if (fromEnv.length) return fail(`去掉了 secrets.env 里的 ${removed} 设置，但环境变量 ${fromEnv.join('、')} 里还有，它照样在用。要停用，在那里去掉。`)
  console.log(`去掉了 ${removed}。${left.length ? `还在用的：${left.join('、')}。` : '现在一个推送通道都没有了，消息会先存着，再配好以后一起发。'}`)
}

/** 按 app.mjs 里这个通道的几项一项项问，填错了马上说。返回填好的 { 键名: 值 }，没填完返回 null。 */
async function askChannel(rl, id) {
  const channel = PUSH_CHANNELS.find((c) => c.id === id)
  const [doc, section] = channel.help.split('#')
  console.log(`怎么配见 ${doc}“${section}”。`)
  const input = {}
  for (const f of channel.fields) {
    if (f.applies && !f.applies(input)) continue
    const hint = [f.hint, f.example && `比如 ${f.example}`].filter(Boolean).join('，')
    if (f.secret) console.log(`${f.label}${hint ? `：${hint}。` : ''}输入时屏幕上不显示。`)
    const answer = await rl.ask(f.secret ? `${f.label}：` : `${f.label}${hint ? `（${hint}）` : ''}：`, { secret: f.secret })
    if (answer == null) return fail('输入提前结束，没保存。')
    const problem = checkPushField(f, answer, input)
    if (problem) return fail(`${problem}，没保存。`)
    input[f.name] = answer
  }
  return input
}

/**
 * 一行行读输入。管道、一次粘贴好几行时，提前到的行先存着，不丢；输入提前结束时 ask 返回 null。
 * readline 的 question 在这两种情况下会丢行、悄悄退出。
 */
function lineReader() {
  const tty = Boolean(process.stdin.isTTY)
  // 终端里输入授权码时不回显：readline 的回显都走这个输出，muted 时吞掉
  let muted = false
  const output = new Writable({
    write(chunk, encoding, done) {
      if (!muted) process.stdout.write(chunk, encoding)
      done()
    },
  })
  // readline 按终端宽度折行重画：不告诉它宽度，长提示一按退格就画乱
  Object.defineProperty(output, 'columns', { get: () => process.stdout.columns })
  const onResize = () => output.emit('resize')
  if (tty) process.stdout.on('resize', onResize)
  // historySize 0：不然在下一个问题按 ↑，刚输入的授权码会原样显示出来
  const rl = readline.createInterface({ input: process.stdin, terminal: tty, output: tty ? output : undefined, historySize: 0 })
  const lines = []
  const waiting = []
  let closed = false
  rl.on('line', (line) => {
    if (muted) {
      muted = false
      process.stdout.write('\n')
    }
    return waiting.length ? waiting.shift()(line.trim()) : lines.push(line.trim())
  })
  rl.on('close', () => {
    closed = true
    while (waiting.length) waiting.shift()(null)
  })
  return {
    ask(question, { secret = false } = {}) {
      // 终端里让 readline 知道提示是什么：按退格、方向键重画这一行时，问题文字不会被抹掉
      if (tty) {
        rl.setPrompt(question)
        rl.prompt()
      } else process.stdout.write(question)
      if (lines.length) return Promise.resolve(lines.shift())
      if (closed) return Promise.resolve(null)
      // 真要等输入时才静音：提前粘贴进来的那行已经显示过了，这时静音会把下一个问题和输入也吞掉
      muted = tty && secret
      return new Promise((resolve) => waiting.push(resolve))
    },
    close: () => {
      process.stdout.off('resize', onResize)
      rl.close()
    },
  }
}

async function cmdTestPush() {
  const { ready, problems } = inspectChannels(loadSecrets())
  for (const p of problems) console.log(p)
  if (!ready.length) return fail('还没配推送，先运行 setup-push。')
  for (const r of await app.testPush()) printTest(r)
}

function printTest(r) {
  console.log(`${r.ok ? '发出去了' : '没发出去'}　${r.name}：${r.message}`)
  if (!r.ok) process.exitCode = 1
}

/** 跑一轮抓取。 */
async function cmdRun(flags) {
  const { stats, summary } = await app.runOnce({
    dryRun: Boolean(flags['dry-run']),
    artist: flags.artist === undefined ? undefined : flags.artist === true ? '' : String(flags.artist),
    source: flags.source === true ? '' : flags.source,
    forceSlow: Boolean(flags['force-slow']),
    signal: stopping.signal,
    log: console.log,
  })
  if (stats) console.log(JSON.stringify(stats, null, 2))
  for (const line of summary) console.log(line)
}

async function cmdRemind(flags) {
  if (flags['dry-run']) console.log('预演：在状态库的副本上跑，只打印要推的消息，正式的状态库不动。')
  const sent = await app.remindOnce({ dryRun: Boolean(flags['dry-run']) })
  if (sent) console.log(flags['dry-run'] ? `会发 ${sent} 条开售提醒` : `发了 ${sent} 条开售提醒`)
}

async function cmdDaemon() {
  const log = (msg) => console.log(`${stamp(Date.now())} ${msg}`)
  log('常驻模式：抓取在北京时间 9:07、21:07 前后各一轮，开售提醒每 10 分钟一次。按 Ctrl+C 停止。')
  await app.daemon({ log, signal: stopping.signal })
  log('停了。')
}

async function cmdCheck(flags) {
  // 查完一个打印一个：代理没关时一个平台要等十几秒，不能让人对着空屏幕
  const print = (r) => console.log(r.ok == null ? `跳过　${r.label}：${r.detail}` : `${r.kind}　${r.label}：${r.detail}（${r.requests} 次请求）`)
  const { allOk, notes, push } = await app.check({ source: flags.source === true ? '' : flags.source, signal: stopping.signal, onResult: print })
  for (const n of notes) console.log(n)
  for (const p of push.problems) console.log(`推送：${p}`)
  console.log(push.ready.length ? `推送：${push.ready.join('、')} 已配置，用 test-push 发一条试试` : '推送：还没配，运行 setup-push')
  process.exitCode = allOk ? 0 : 1
}

function cmdPause() {
  const { pausedAt } = app.pausePush()
  console.log(`推送暂停了（${stamp(pausedAt)} 起）。照常抓取，消息先攒着；运行 resume 恢复，会补发还有用的。`)
}

async function cmdResume() {
  const { delivered } = await app.resumePush({ log: console.log })
  if (delivered == null) console.log('推送恢复了。正有一轮在跑，攒下的消息它抓完就发。')
  else console.log(delivered ? `推送恢复了，补发了 ${delivered} 条。` : '推送恢复了，没有要补发的。')
}

function cmdStatus() {
  const pausedAt = app.pushPausedAt()
  if (pausedAt) console.log(`推送暂停中（${stamp(pausedAt)} 起），照常抓取。运行 resume 恢复。`)
  const artists = app.status()
  if (!artists.length) console.log('还没跑过抓取，或者还没关注艺人。先 follow，再 run。')
  for (const a of artists) {
    const ids = a.platforms.map((p) => `${p.label} ${p.id}${p.name ? `（${p.name}）` : ''}`)
    console.log(`\n${a.key}${a.aliases.length ? `（${a.aliases.join('、')}）` : ''}　${ids.join('，') || '还没找到平台 ID'}`)
    if (!a.shows.length) console.log('  没有在跟踪的演出')
    for (const s of a.shows) {
      console.log(`  · ${s.line}`)
      console.log(`    ${[s.name, s.venue].filter(Boolean).join(' · ')}`)
    }
  }
}

function parseFlags(args) {
  const out = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('--')) continue
    // --artist=告五人 这种写法也认：不认的话会当成没写，一轮去取所有艺人
    const eq = a.indexOf('=')
    if (eq > 2) {
      out[a.slice(2, eq)] = a.slice(eq + 1)
      continue
    }
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

function fail(message) {
  console.log(message)
  process.exitCode = 1
  return null
}

main().catch((err) => {
  // 给人看的错照原话说，不打调用栈
  if (err instanceof AppError) console.log(err.message)
  else console.error(err.stack ?? err.message)
  process.exitCode = 1
})
