// 命令行和本机网页共用的操作（docs/design.md“本机网页”）。
// 每个操作返回数据，出错抛 AppError（message 是给人看的话），自己不打印；怎么显示由调用的一方决定。
// 规矩只写在这里一处：命令行、网页各写一套，迟早对不上。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ARTISTS_FILE,
  DB_FILE,
  FETCH_LOG_FILE,
  LAST_REQUEST_FILE,
  LOCK_FILE,
  MAX_ALIASES,
  MAX_ARTISTS,
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
import { isEmail, smtpHostFor } from './notify/email.mjs'
import { mixedLabel, pickUrl, showLine, showTitle } from './notify/format.mjs'
import { CHANNELS, ENV_OVERRIDABLE_KEYS, createConsoleNotifier, createNotifier, createUnconfiguredNotifier, inspectChannels } from './notify/index.mjs'
import { runReminders } from './remind.mjs'
import { deliver, runRound } from './run.mjs'
import { REMIND_EVERY_MS, planNextRound } from './schedule.mjs'
import { SOURCE_LABELS, SOURCE_ORDER, progress, stageLabel } from './stage.mjs'
import { openStore } from './store.mjs'
import { sameName } from './text.mjs'
import { beijingParts, formatDateRange, formatSaleTime } from './time.mjs'

/** 给人看的错：调用的一方照原话显示，不当成程序出错。 */
export class AppError extends Error {}

// ---------- 艺人 ----------

/** 关注一位艺人，或者给已经关注的补别名。返回 { key, aliases, added, newAliases, notes }。 */
export function follow(line) {
  line = String(line ?? '')
  if (!line.trim()) throw new AppError('名字是空的。')
  let a
  try {
    a = followArtist(line)
  } catch (err) {
    throw new AppError(`没加上：${err.message}。`)
  }
  const notes = []
  if (line.includes(',')) notes.push('半角逗号算名字的一部分，别名要用顿号“、”隔开。')
  syncNow()
  return { ...a, newAliases: a.newAliases ?? [], notes }
}

/** 不再关注。主名、别名、写法不同都认。返回去掉的主名。 */
export function unfollow(name) {
  name = String(name ?? '').trim()
  if (!name) throw new AppError('名字是空的。')
  const removed = unfollowArtist(name)
  if (!removed) throw new AppError(`清单里没有 ${name}。现在关注的：${loadArtists().map((a) => a.key).join('、') || '还没有'}`)
  syncNow()
  return removed
}

/** 改完清单马上同步到状态库（不联网）：取消关注的人，开售提醒和状态立刻不再出现。 */
export function syncNow() {
  withStoreSync((store) => {
    const tracked = new Set(store.activeArtists().map((a) => a.key))
    store.syncArtists(limitArtists(loadArtists(), tracked).artists, Date.now())
  })
}

// ---------- 推送 ----------

/**
 * 各通道要填的几项，按推荐的顺序排。命令行一项项问，网页照着画表单，检查都走 validatePush，规矩只有这一份。
 * help 是“怎么配”写在哪：仓库里的文件和其中一节，网页链到 GitHub 上的这一节，命令行照着说一句。
 * 一项：name 键名，label、hint、example 给人看（example 在网页上是输入框里的灰字），secret 输入时不显示，optional 可以不填，
 * applies(已填的) 返回假时这一项不用问，check(值) 不对时返回要说的话。
 * build(已填的) 把填的转成 secrets.env 里的键值，null 表示删掉这个键；还有要查的，抛 AppError。
 * 字只留填的时候用得上的，怎么拿、为什么写在 help 指的那一节（docs/design.md“本机网页”）。
 */
export const PUSH_CHANNELS = [
  {
    id: 'email',
    intro: '用自己的邮箱给自己发信，免费',
    help: 'README.md#邮件',
    fields: [
      { name: 'user', label: '发信邮箱', example: '12345@qq.com', check: (v) => (isEmail(v) ? null : '邮箱地址的格式不对') },
      { name: 'pass', label: '授权码', hint: '在邮箱设置里开启 SMTP 服务后拿到，不是登录密码', secret: true, check: (v) => (v ? null : '授权码是空的') },
      { name: 'to', label: '收信邮箱', hint: '不填就发给自己', optional: true, check: (v) => (isEmail(v) ? null : '收信邮箱的格式不对') },
      {
        name: 'host',
        label: '发信服务器',
        hint: 'QQ、163、126、Foxmail 邮箱不用填',
        example: 'smtp.example.com',
        optional: true,
        applies: (input) => !smtpHostFor(input.user),
        empty: '认不出这个邮箱的发信服务器，要填上',
        check: (v) => (/^[\w.-]+\.[a-z]{2,}$/i.test(v) ? null : '发信服务器的写法不对'),
      },
    ],
    build: (input) => {
      const known = smtpHostFor(input.user)
      if (!known && !input.host) throw new AppError('认不出这个邮箱的发信服务器，要填上。没保存。')
      return { SMTP_USER: input.user, SMTP_PASS: input.pass, MAIL_TO: input.to || null, SMTP_HOST: known ? null : input.host }
    },
  },
  {
    id: 'serverchan',
    intro: '消息进微信，免费版每天 5 条',
    help: 'README.md#推送通道',
    fields: [
      { name: 'sendKey', label: 'SendKey', hint: '在 https://sct.ftqq.com/sendkey 复制', check: (v) => (/^sct\w+$/i.test(v) ? null : 'SendKey 应该是 SCT 或 sctp 开头的一串字母数字') },
    ],
    build: (input) => ({ SERVERCHAN_SENDKEY: input.sendKey }),
  },
  {
    id: 'wxpusher',
    intro: '消息进 WxPusher App，免费',
    help: 'README.md#推送通道',
    fields: [
      { name: 'spt', label: 'SPT', hint: '扫 https://wxpusher.zjiecode.com/docs/spt.html 上的二维码拿', check: (v) => (/^SPT_\w+$/.test(v) ? null : 'SPT 应该是 SPT_ 开头的一串字母数字') },
    ],
    build: (input) => ({ WXPUSHER_SPT: input.spt }),
  },
  {
    id: 'bark',
    intro: 'iPhone 专用，免费',
    help: 'README.md#推送通道',
    fields: [
      {
        name: 'url',
        label: '推送地址',
        hint: 'Bark App 首页的地址，整个粘贴',
        example: 'https://api.day.app/xxxx/',
        // 地址里带着设备 key，拿到就能给这台 iPhone 发消息
        secret: true,
        check: (v) => (/^\w+$/.test(parseBarkInput(v).key) ? null : '没认出 key'),
      },
    ],
    build: (input) => {
      const { server, key } = parseBarkInput(input.url)
      // 用官方服务器时清掉以前存的自建地址
      return { BARK_KEY: key, BARK_SERVER: server !== 'https://api.day.app' ? server : null }
    },
  },
  {
    id: 'wecom',
    intro: '消息进微信，要固定 IP 的服务器和备案过的域名',
    help: 'docs/deploy.md#企业微信',
    fields: [
      { name: 'corpId', label: '企业 ID', hint: '“我的企业”页最下面，ww 开头' },
      { name: 'agentId', label: 'AgentId', hint: '在你建的应用页面上' },
      { name: 'secret', label: 'Secret', hint: '应用页面上点“查看”，会发到企业微信里', secret: true },
      { name: 'toUser', label: '接收人', hint: '你自己的成员账号' },
    ],
    build: (input) => ({ WECOM_CORP_ID: input.corpId, WECOM_AGENT_ID: input.agentId, WECOM_SECRET: input.secret, WECOM_TO_USER: input.toUser }),
  },
].map((c) => ({ ...c, name: CHANNELS.find((d) => d.id === c.id).name }))

/** 去掉一个通道时，除了必填的几项还要一起清掉的。 */
const EXTRA_KEYS = { bark: ['BARK_SERVER'], email: ['MAIL_TO', 'SMTP_HOST'] }

/**
 * 各通道现在的样子，带上要填的几项（不带检查规则）。密钥只说配没配好，从不给值；邮箱地址不算密钥，照写，方便认出是哪个。
 * 返回 [{ id, name, intro, help, fields, state: 'ready'|'partial'|'none', problem, summary }]。
 */
export function pushChannels() {
  const secrets = loadSecrets()
  const { ready, partial } = inspectChannels(secrets)
  return PUSH_CHANNELS.map(({ id, name, intro, help, fields }) => {
    const def = CHANNELS.find((c) => c.id === id)
    const state = ready.includes(def) ? 'ready' : partial.includes(def) ? 'partial' : 'none'
    const complete = def.keys.every((k) => secrets[k])
    const problem = state !== 'partial' ? null : complete ? def.check?.(secrets) ?? null : '没配全，重新填一遍'
    let summary = null
    if (state === 'ready' && id === 'email') summary = `${secrets.SMTP_USER} 发给${secrets.MAIL_TO && secrets.MAIL_TO !== secrets.SMTP_USER ? ` ${secrets.MAIL_TO}` : '自己'}`
    // 只写主机名：自建服务器的地址里可能带着用户名和密码
    if (state === 'ready' && id === 'bark' && secrets.BARK_SERVER) summary = `自建服务器 ${hostOf(secrets.BARK_SERVER)}`
    return {
      id,
      name,
      intro,
      help,
      fields: fields.map((f) => ({ name: f.name, label: f.label, hint: f.hint ?? null, example: f.example ?? null, secret: Boolean(f.secret), optional: Boolean(f.optional) })),
      state,
      problem,
      summary,
    }
  })
}

function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return '（地址写法不对）'
  }
}

/**
 * 查一项填得对不对，不对返回要说的话（不带“没保存”）。
 * 有 applies 的项，用得上时就必须填（optional 只是告诉网页“多数人不用填”）。
 */
export function checkPushField(field, value, input = {}) {
  if (field.applies && !field.applies(input)) return null
  // 一行一个键：值里带换行就能在 secrets.env 里多写出一行
  if (/[\x00-\x1f\x7f]/.test(value)) return `${field.label}里有换行或看不见的控制字符`
  if (!value) return field.optional && !field.applies ? null : field.empty ?? field.check?.('') ?? '有一项是空的'
  return field.check?.(value) ?? null
}

/**
 * 检查要存的推送设置，返回写进 secrets.env 的键值（null 表示删掉这个键）。不对就抛 AppError。
 * input 是 { 键名: 值 }，键名见 PUSH_CHANNELS 里各通道的 fields。
 */
export function validatePush(id, input = {}) {
  const channel = PUSH_CHANNELS.find((c) => c.id === id)
  if (!channel) throw new AppError(`没有这个推送通道：${id}`)
  const values = Object.fromEntries(channel.fields.map((f) => [f.name, String(input?.[f.name] ?? '').trim()]))
  for (const f of channel.fields) {
    const problem = checkPushField(f, values[f.name], values)
    if (problem) throw new AppError(`${problem}，没保存。`)
  }
  return channel.build(values)
}

/**
 * 同名环境变量盖过 secrets.env 的那几个键（见 ENV_OVERRIDABLE_KEYS）。
 * 设了的话，文件里改了、删了都不起作用，要告诉人去环境变量里改。
 */
function shadowedByEnv(keys) {
  return keys.filter((k) => ENV_OVERRIDABLE_KEYS.includes(k) && process.env[k])
}

/**
 * 存一个通道的设置，再用它发一条测试消息。返回测试的结果 { id, name, ok, message, fromEnv }。
 * fromEnv 是环境变量里也设了、会盖过刚存的值的键：测试消息用的其实是环境变量里的那个。
 */
export async function savePush(id, input) {
  const values = validatePush(id, input)
  saveSecrets(values)
  const [result] = await testPush([id])
  return { ...result, fromEnv: shadowedByEnv(Object.keys(values).filter((k) => values[k] != null)) }
}

/**
 * 去掉一个通道。返回 { removed: 名字, left: [还在用的名字], fromEnv: [还留在环境变量里的键] }。
 * 环境变量里也设了这个通道的密钥时，文件里删了它照样在用，fromEnv 告诉人去哪里删。
 */
export function removePush(id) {
  const def = CHANNELS.find((c) => c.id === id)
  if (!def) throw new AppError(`没有这个推送通道：${id}`)
  saveSecrets(Object.fromEntries([...def.keys, ...(EXTRA_KEYS[id] ?? [])].map((k) => [k, null])))
  // 企业微信换来的 access_token 存在状态库里，通道去掉了它也不该留着
  if (id === 'wecom') withStoreSync((store) => store.kv.set('wecom.token', null))
  const { ready } = inspectChannels(loadSecrets())
  return { removed: def.name, left: ready.map((c) => c.name), fromEnv: shadowedByEnv([...def.keys, ...(EXTRA_KEYS[id] ?? [])]) }
}

const TEST_MESSAGE = {
  title: '演出雷达 · 测试',
  description: '<div class="highlight">能看到这条，推送就通了</div><div class="gray">以后演出有变化会这样推给你</div>',
  short: '演出雷达：推送通了',
  text: '能看到这条，推送就通了。以后演出有变化会这样推给你。',
  url: 'https://m.damai.cn/',
  btntxt: '知道了',
}

/** 测试消息发出去以后，告诉人去哪里看。 */
const TEST_SENT = {
  email: '去邮箱看看。',
  serverchan: '去微信看看。这条占今天 5 条免费额度中的 1 条。',
  wxpusher: '去 WxPusher App 看看。',
  bark: '去 Bark App 看看。',
  wecom: '去微信看看。',
}

/**
 * 给几个通道各发一条测试消息，各自报通没通。ids 不给就是所有配好的。
 * 返回 [{ id, name, ok, message }]；一个都没配好时抛 AppError。
 */
export async function testPush(ids) {
  const secrets = loadSecrets()
  const { ready } = inspectChannels(secrets)
  const defs = ids ? CHANNELS.filter((c) => ids.includes(c.id)) : ready
  if (!defs.length) throw new AppError(ids ? `没有这个推送通道：${ids.join('、')}` : '还没配推送，先配一个通道。')
  return withStoreAsync({}, async (store) => {
    const results = []
    for (const def of defs) {
      if (!ready.includes(def)) {
        results.push({ id: def.id, name: def.name, ok: false, message: '还没配好，先把这个通道填完整。' })
        continue
      }
      try {
        await def.make(secrets, store.kv).send(TEST_MESSAGE)
        results.push({ id: def.id, name: def.name, ok: true, message: TEST_SENT[def.id] ?? '' })
      } catch (err) {
        results.push({ id: def.id, name: def.name, ok: false, message: err.message })
      }
    }
    return results
  })
}

// ---------- 抓取 ----------

// 这个进程里正在做的那件要请求数据源的事：一轮抓取或一次检查。
// 常驻的那一轮、网页上点的“现在抓一轮”“检查各平台”不能同时跑；进程之间照旧靠 run.lock 排队
let busy = null
// 这个进程里最近跑完的一轮，网页上显示它说了什么
let lastRound = null

/** 现在在做什么：{ kind: 'run'|'check', startedAt }，没在做返回 null。 */
export function busyState() {
  return busy && { kind: busy.kind, startedAt: busy.startedAt }
}

/** 等这个进程里正在做的那一轮或那次检查做完。停下之前用：一轮要把取到的存下才算完。 */
export async function idle() {
  while (busy) await busy.promise.catch(() => {})
}

async function exclusive(kind, fn) {
  if (busy) throw new AppError(busy.kind === 'run' ? '正在抓一轮，抓完再试。' : '正在检查各平台，查完再试。')
  const entry = { kind, startedAt: Date.now() }
  busy = entry
  try {
    entry.promise = fn()
    return await entry.promise
  } finally {
    if (busy === entry) busy = null
  }
}

/**
 * 跑一轮抓取。返回 { stats, notes, summary }；清单是空的、没开始就被叫停，stats 是 null。
 * 跑的过程中要说的话边跑边交给 log（命令行马上打印）；跑完才说的总结放在 summary 里，不交给 log，
 * 让命令行打在统计数字后面，免得被统计挤出屏幕。notes 是两样合在一起，网页用。
 * @param {Object} o
 * @param {boolean} [o.dryRun] 在状态库的副本上跑，只打印要推的消息
 * @param {string} [o.artist] 只跑这一位（主名、别名都认）
 * @param {string} [o.source] 只跑这一个数据源
 * @param {boolean} [o.forceSlow] 不看时段，一天只取一次的数据源也取
 * @param {AbortSignal} [o.signal] 被要求停下时，不再取新的艺人
 * @param {Function} [o.log] 边跑边说的话
 */
export function runOnce(o = {}) {
  return exclusive('run', async () => {
    const startedAt = Date.now()
    const notes = []
    const summary = []
    const note = (text) => {
      notes.push(text)
      o.log?.(text)
    }
    const tell = (text) => {
      notes.push(text)
      summary.push(text)
    }
    try {
      const stats = await runInner(o, note, tell)
      lastRound = { startedAt, finishedAt: Date.now(), dryRun: Boolean(o.dryRun), stats, notes, error: null }
      return { stats, notes, summary }
    } catch (err) {
      lastRound = { startedAt, finishedAt: Date.now(), dryRun: Boolean(o.dryRun), stats: null, notes, error: err.message }
      throw err
    }
  })
}

async function runInner({ dryRun = false, artist, source, forceSlow = false, signal }, note, tell) {
  const artistList = loadArtists()
  if (!artistList.length) {
    note('艺人清单是空的，先加艺人：网页上加，或者运行 follow 名字。')
    return null
  }
  let onlyArtist
  if (artist !== undefined) {
    onlyArtist = artistList.find((a) => [a.key, ...a.aliases].some((n) => sameName(n, String(artist))))?.key
    if (!onlyArtist) throw new AppError(`清单里没有“${artist}”。现在关注的：${artistList.map((a) => a.key).join('、')}`)
  }
  const adapters = await pickAdapters(source)
  try {
    return await lockedWithGap({ signal, log: note }, () =>
      withStoreAsync({ dryRun }, async (store) => {
        if (dryRun) note('预演：在状态库的副本上跑，只打印要推的消息，正式的状态库不动。')
        const startedAt = Date.now()
        // 状态库里有过的艺人（包括取消关注的）不算误改底稿
        const hint = templateHint(artistList, ARTISTS_FILE, store.knownArtistKeys())
        if (hint) note(hint)
        const { artists, warnings } = limitArtists(artistList, new Set(store.activeArtists().map((a) => a.key)))
        warnings.forEach((w) => note(w))
        const fetchLog = openFetchLog(FETCH_LOG_FILE)
        const notifier = makeNotifier(store, { dryRun, log: note })
        const stats = await runRound({ store, adapters, artists, notifier, onlyArtist, forceSlow, fetchLog, signal, log: note })
        const sources = Object.values(stats.sources).filter((s) => typeof s === 'object')
        const recent = [...new Set(sources.flatMap((s) => s.recent ?? []))]
        if (recent.length) tell(`1 小时内刚取过，这一轮跳过：${recent.join('、')}。`)
        if (dryRun) {
          // 这次预演真正去取了的艺人，满 1 小时以后正式跑才会再取
          const fetched = artists
            .map((a) => ({ key: a.key, at: Math.max(...adapters.map((ad) => fetchLog.get(fetchKey(ad.name, a.key)) ?? -Infinity)) }))
            .filter((x) => x.at >= startedAt)
          if (fetched.length) {
            const latest = Math.max(...fetched.map((x) => x.at))
            tell(`预演也是真的去各平台取了一次：${fetched.map((x) => x.key).join('、')} 要到 ${stamp(latest + 3600_000)} 以后正式跑才会再取。`)
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
 * 跑一次开售提醒，返回提醒了几场。
 * 先按清单同步一下（不联网）：有人直接从 artists.txt 删了艺人，下一轮抓取之前也不再提醒他的演出。
 */
export async function remindOnce({ dryRun = false, log } = {}) {
  return withStoreAsync({ dryRun }, async (store) => {
    const list = loadArtists()
    // 清单是空的不同步：多半是文件被误删、写到一半，同步了会停掉所有人、作废还没推的消息。
    // 真要清空，用 unfollow 一位位去掉，那边会同步
    if (list.length) store.syncArtists(limitArtists(list, new Set(store.activeArtists().map((a) => a.key))).artists, Date.now())
    return runReminders({ store, notifier: makeNotifier(store, { dryRun, quiet: true, log }), ...(log ? { log } : {}) })
  })
}

// ---------- 推送总开关 ----------

/** 暂停推送：照常抓取、照常记录，什么都不发。已经暂停的，暂停时刻不变。返回 { pausedAt }。 */
export function pausePush() {
  return withStoreSync((store) => {
    if (store.pushPausedAt() == null) store.setPushPausedAt(Date.now())
    return { pausedAt: store.pushPausedAt() }
  })
}

/**
 * 恢复推送，马上补发攒下的、还有用的。返回 { delivered }：补发了几条。
 * 正有一轮在跑时（这个进程里，或者别的进程拿着锁）是 null：交给那一轮收尾时发，免得两边各发一遍。
 */
export async function resumePush({ log = () => {} } = {}) {
  withStoreSync((store) => store.setPushPausedAt(null))
  if (busy) return { delivered: null }
  try {
    const delivered = await withLock(
      LOCK_FILE,
      () => withStoreAsync({}, (store) => deliver({ store, notifier: makeNotifier(store, { log }), now: Date.now, log })),
      { waitMs: 0, log: () => {} },
    )
    return { delivered }
  } catch (err) {
    if (err.code === 'BUSY') return { delivered: null }
    throw err
  }
}

/** 推送暂停的时刻，没暂停是 null。 */
export function pushPausedAt() {
  return withStoreSync((store) => store.pushPausedAt())
}

/**
 * 每个数据源发一两个请求，看通不通。同一个数据源两次至少隔 1 分钟。
 * 返回 { results: [{ source, label, kind, ok, detail, requests }], allOk, notes, skipped, push: { ready, problems } }。
 * ok 是 null 表示这次跳过了。skipped 是被叫停、没查的数据源。waitMs：别的进程在跑一轮时最多等多久，网页上不能让人干等半小时。
 * onResult：每查完一个数据源就交出它的结果，命令行马上打印，不让人对着空屏幕等一两分钟。log：等锁时说的话。
 */
export function check({ source, signal, waitMs, onResult, log } = {}) {
  return exclusive('check', async () => {
    const adapters = await pickAdapters(source)
    try {
      return await lockedWithGap({ signal, waitMs, log }, async () => {
        // check 每次是新进程，进程之间没有请求间隔，所以同一个数据源两次 check 之间也要隔开
        const fetchLog = openFetchLog(FETCH_LOG_FILE)
        const kv = memoryKv()
        const results = []
        const skipped = []
        for (const adapter of adapters) {
          // 被要求停下时，没查的数据源不查了
          if (signal?.aborted) {
            skipped.push(adapter.label ?? SOURCE_LABELS[adapter.name] ?? adapter.name)
            continue
          }
          const label = adapter.label ?? SOURCE_LABELS[adapter.name] ?? adapter.name
          const last = fetchLog.get(`check.${adapter.name}`)
          const add = (r) => {
            results.push(r)
            onResult?.(r)
          }
          if (last != null && last <= Date.now() && Date.now() - last < MIN_CHECK_GAP_MS) {
            const wait = Math.ceil((MIN_CHECK_GAP_MS - (Date.now() - last)) / 1000)
            add({ source: adapter.name, label, kind: '跳过', ok: null, detail: `1 分钟内刚查过，${wait} 秒后再查。`, requests: 0 })
            continue
          }
          fetchLog.set(`check.${adapter.name}`, Date.now())
          const client = createSourceClient(adapter.clientOptions)
          const ctx = { client, now: Date.now, log: () => {}, kv, previous: () => null }
          try {
            const r = await adapter.check(ctx)
            const kind = r.ok ? '通' : r.error ? kindOf(r.error) : '不通'
            add({ source: adapter.name, label, kind, ok: Boolean(r.ok), detail: r.detail, requests: client.requestCount })
          } catch (err) {
            add({ source: adapter.name, label, kind: kindOf(err), ok: false, detail: err.message, requests: client.requestCount })
          }
        }
        const allOk = results.every((r) => r.ok !== false) && !skipped.length
        const notes = skipped.length ? [`收到停止信号，没查：${skipped.join('、')}。`] : []
        if (results.some((r) => r.ok === false)) notes.push('有平台没通。开着代理或加速器的，先关掉再试；还是不通，见 README.md“常见问题”。')
        const { ready, problems } = inspectChannels(loadSecrets())
        return { results, allOk, notes, skipped, push: { ready: ready.map((c) => c.name), problems } }
      })
    } catch (err) {
      if (err.code === 'BUSY') throw new AppError('另一个程序正在抓一轮，等它跑完再检查。')
      if (err.code === 'ABORTED') throw new AppError('收到停止信号，没开始检查。')
      throw err
    }
  })
}

function kindOf(err) {
  return err instanceof BlockedError ? '被拦' : err instanceof ApiChangedError ? '接口变了' : err instanceof NetworkError ? '连不上' : '出错'
}

// ---------- 常驻 ----------

// 常驻模式在不在这个进程里跑、排好的下一轮在什么时候。网页上显示
let daemonOn = false
let nextRoundAt = null

/**
 * 一直跑着：抓取按时刻表，开售提醒每 10 分钟，两件事各走各的，抓取再慢也不耽误提醒。
 * 每次都重读艺人清单和推送密钥，改了不用重启。signal 停下时两个循环都退出。
 */
export async function daemon({ log, signal }) {
  const sleepUntil = sleeper(signal)
  async function roundLoop() {
    let plan = {}
    while (!signal.aborted) {
      let stats = null
      try {
        if (busy?.kind === 'run') {
          // 到点时网页上点的那一轮正在跑：就算这一轮，不再接着跑一遍
          stats = (await busy.promise.catch(() => null))?.stats ?? null
        } else {
          await idle()
          const result = await runOnce({ signal, log })
          stats = result.stats
          // 跑完才说的总结（1 小时内刚取过、要等到几点）也写进日志，不然常驻模式下看不出这一轮为什么什么都没取
          for (const line of result.summary) log(line)
        }
      } catch (err) {
        log(`这一轮出错了，下一轮照常：${err.message}`)
      }
      if (signal.aborted) return
      const sources = Object.values(stats?.sources ?? {}).filter((s) => typeof s === 'object')
      plan = planNextRound(Date.now(), sources, plan)
      nextRoundAt = plan.next
      log(`下一轮抓取：${stamp(plan.next)}`)
      await sleepUntil(plan.next)
    }
  }
  async function remindLoop() {
    while (!signal.aborted) {
      try {
        const sent = await remindOnce({ log })
        if (sent) log(`发了 ${sent} 条开售提醒`)
      } catch (err) {
        log(`开售提醒出错了，10 分钟后再试：${err.message}`)
      }
      await sleepUntil(Date.now() + REMIND_EVERY_MS)
    }
  }
  daemonOn = true
  try {
    await Promise.all([roundLoop(), remindLoop()])
  } finally {
    daemonOn = false
    nextRoundAt = null
  }
}

/** 睡到某个时刻，被要求停下时提前醒。最多睡一分钟就醒来看一眼：电脑睡眠、改了系统时间，醒来都能接上。 */
function sleeper(signal) {
  return async function sleepUntil(at) {
    while (Date.now() < at && !signal.aborted) {
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', done)
          resolve()
        }
        const timer = setTimeout(done, Math.max(1000, Math.min(at - Date.now(), 60_000)))
        signal.addEventListener('abort', done, { once: true })
      })
    }
  }
}

// ---------- 查看 ----------

/**
 * 每位艺人在跟踪的演出。返回
 * [{ key, aliases, checked, platforms: [{ source, label, id, name }], shows: [{ id, city, venue, title, dates, stage, stageLabel, nextSale, line, sources, url }] }]。
 * checked 是 false 表示还没抓过；url 是 null 表示还没有售票页。
 */
export function status() {
  return withStoreSync(statusOf)
}

function statusOf(store) {
  return store.activeArtists().map((a) => ({
    key: a.key,
    aliases: a.aliases,
    checked: store.hasAnyBaseline(a.key),
    platforms: Object.entries(a.ids)
      .filter(([, id]) => id)
      .map(([src, id]) => ({ source: src, label: SOURCE_LABELS[src] ?? src, id, name: a.idNames[src] && a.idNames[src] !== a.key ? a.idNames[src] : null })),
    shows: store
      .showsForArtist(a.key)
      .filter((s) => s.stage && s.stage !== 'ended')
      .map((s) => {
        const listings = store.listingsOfShow(s.id)
        return {
          id: s.id,
          city: s.city,
          venue: s.venue,
          title: s.title,
          // 音乐节、拼盘演出：网页挂成小标签，命令行用带标签的 name
          mixed: mixedLabel(s),
          name: showTitle(s),
          dates: formatDateRange(s.dateStart, s.dateEnd),
          stage: s.stage,
          stageLabel: stageLabel(s.stage, s.round),
          nextSale: s.nextSaleAt && (s.stage === 'sale_pending' || s.stage === 'resale_pending') ? formatSaleTime(s.nextSaleAt) : null,
          line: showLine(s),
          // 只列卖票的平台。文旅部在时间线的“报批”那一格
          sources: SOURCE_ORDER.filter((src) => listings.some((l) => l.source === src && l.kind === 'ticket')).map((src) => SOURCE_LABELS[src]),
          steps: trackOf(s, listings),
          url: listings.some((l) => l.url) ? pickUrl({ kind: 'listed' }, listings) : null,
        }
      }),
  }))
}

/** 时间线四格。“报批”那格带上批复日期，网页上鼠标停在上面能看到。 */
function trackOf(show, listings) {
  const steps = progress(show)
  const approvedOn = listings.map((l) => l.approval?.date).filter(Boolean).sort().at(-1)
  if (approvedOn && steps[0].state === 'done') steps[0].title = `${formatDateRange(approvedOn)}批复`
  return steps
}

/**
 * 网页一次拿全的状态。不含任何密钥。只读，不改状态库。
 * 艺人按清单文件来：有人直接改了 artists.txt，下一轮抓取同步之前，网页上也照文件显示。
 */
export function state() {
  const listed = loadArtists()
  return withStoreSync((store) => {
    const known = new Map(statusOf(store).map((a) => [a.key, a]))
    const { artists: allowed, warnings } = limitArtists(listed, new Set(known.keys()))
    const artists = allowed.map((a) => {
      const k = known.get(a.key)
      // 还没抓过的（刚加的、停用后又加回来的）：状态库里旧的演出和平台 ID 下一轮重新建底，先不显示
      return k?.checked ? { ...k, aliases: a.aliases } : { key: a.key, aliases: a.aliases, checked: false, platforms: [], shows: [] }
    })
    return {
      artists,
      // 清单里有、却没在跟踪的：超过上限的，和别的行算同一位的。为什么写在 warnings 里
      untracked: listed.filter((a) => !allowed.some((x) => x.key === a.key)).map((a) => a.key),
      warnings,
      push: pushChannels(),
      pushPausedAt: store.pushPausedAt(),
      runs: store.recentRuns(6),
      health: SOURCE_ORDER.map((src) => store.getHealth(src))
        .filter((h) => h.lastOkAt != null || h.failRuns > 0)
        .map((h) => ({ source: h.source, label: SOURCE_LABELS[h.source], failRuns: h.failRuns, lastError: h.lastError, lastOkAt: h.lastOkAt })),
      busy: busyState(),
      lastRound,
      daemon: daemonOn,
      nextRoundAt,
      limits: { maxArtists: MAX_ARTISTS, maxAliases: MAX_ALIASES },
      sourceLabels: SOURCE_LABELS,
      artistsFile: ARTISTS_FILE,
    }
  })
}

// ---------- 共用的小工具 ----------

/**
 * 推送用的发送器。预演时只打印，样子跟着配好的通道走。
 * 没配全的通道先说一声（log）；quiet 时不说：开售提醒每 10 分钟跑一次，不每次都念一遍。
 */
function makeNotifier(store, { dryRun = false, quiet = false, log } = {}) {
  const secrets = loadSecrets()
  const { ready, problems } = inspectChannels(secrets)
  if (dryRun) {
    // 只收合成一条的（Server酱、邮件）打印合成的那条
    const digestOnly = new Set(['serverchan', 'email'])
    const batch = ready.some((c) => digestOnly.has(c.id))
    return createConsoleNotifier({ batch, single: !batch || ready.some((c) => !digestOnly.has(c.id)), ...(log ? { print: log } : {}) })
  }
  if (!quiet && log) for (const p of problems) log(`推送：${p}`)
  // 某个通道没发出去、还没配推送，这些话也走调用的一方的 log：常驻模式下带上时间，网页上也看得到
  return createNotifier({ secrets, kv: store.kv, ...(log ? { log } : {}) }) ?? createUnconfiguredNotifier(log)
}

async function pickAdapters(source) {
  const { ADAPTERS } = await import('./sources/index.mjs')
  if (source == null) return ADAPTERS
  const picked = ADAPTERS.filter((a) => a.name === source)
  if (!picked.length) throw new AppError(`没有这个数据源：${source}。可选：${ADAPTERS.map((a) => a.name).join('、')}`)
  return picked
}

/**
 * run 和 check 在锁里跑。开始之前，从上一个进程最后一次请求数据源的时间算起等满 2 秒：
 * 这个时间每次请求都写到磁盘上，上一个进程被杀了也作数。放锁之前也等满 2 秒。
 */
async function lockedWithGap({ signal, waitMs, log }, fn) {
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
    { signal, ...(waitMs != null ? { waitMs } : {}), ...(log ? { log } : {}) },
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

function withStoreSync(fn) {
  const store = openStore(DB_FILE)
  try {
    return fn(store)
  } finally {
    store.close()
  }
}

/** dryRun 时在状态库的副本上跑，跑完删掉，正式的状态库一点不动。 */
async function withStoreAsync({ dryRun = false }, fn) {
  if (!dryRun) {
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
  try {
    return await fn(store)
  } finally {
    store.close()
    for (const f of [copy, `${copy}-wal`, `${copy}-shm`]) fs.rmSync(f, { force: true })
  }
}

function memoryKv() {
  const m = new Map()
  return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v == null ? null : String(v)) }
}

/** 北京时间的“10月30日 09:07”。 */
export function stamp(ms) {
  const p = beijingParts(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${p.month}月${p.day}日 ${pad(p.hour)}:${pad(p.minute)}`
}
