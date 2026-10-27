// 读艺人清单和推送密钥，定下各文件的位置。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SECRET_KEYS } from './notify/index.mjs'
import { sameName } from './text.mjs'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const RUNTIME_DIR = process.env.SHOW_RADAR_RUNTIME || path.join(ROOT, '.runtime')
export const DB_FILE = path.join(RUNTIME_DIR, 'radar.sqlite')
export const SECRETS_FILE = path.join(RUNTIME_DIR, 'secrets.env')
// 艺人清单放在运行目录里，和状态库、密钥在一起：更新代码（git pull、换新的压缩包）不碰它。
// 第一次用时从 config/artists.txt 复制一份底稿
export const ARTISTS_FILE = process.env.SHOW_RADAR_ARTISTS || path.join(RUNTIME_DIR, 'artists.txt')
const ARTISTS_TEMPLATE = path.join(ROOT, 'config', 'artists.txt')
export const FETCH_LOG_FILE = path.join(RUNTIME_DIR, 'fetch-log.json')
export const LOCK_FILE = path.join(RUNTIME_DIR, 'run.lock')
// 最近一次请求数据源的时间。进程被杀也留着，下一个进程开始前从它算起等满 2 秒
export const LAST_REQUEST_FILE = path.join(RUNTIME_DIR, 'last-request')

// 关注的艺人和别名的上限，写死，配置改不了：每多一位艺人、一个别名，各站都要多搜一次
export const MAX_ARTISTS = 50
export const MAX_ALIASES = 5

/**
 * 艺人清单：一行一位，第一个名字是主名，别名用顿号或全角逗号隔开。# 后面是注释。
 * 半角逗号算名字的一部分：“Tyler, The Creator”不拆。同一个主名写了两遍，只留第一遍。
 */
export function parseArtists(text) {
  const seen = new Set()
  const out = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const names = line.split(/[、，]/).map((s) => s.trim()).filter(Boolean)
    const [key, ...aliases] = [...new Set(names)]
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push({ key, aliases })
  }
  return out
}

export function loadArtists(file = ARTISTS_FILE) {
  ensureArtistsFile(file)
  return parseArtists(fs.readFileSync(file, 'utf8'))
}

/**
 * 清单还不存在时，从底稿复制一份。底稿开头那段“这是底稿”的说明（到第一行单独的 # 为止）不复制；
 * 那一段里要是有人写了艺人（不是 # 开头的行），整份照抄，一个名字都不丢。
 */
function ensureArtistsFile(file) {
  if (fs.existsSync(file)) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const template = fs.existsSync(ARTISTS_TEMPLATE) ? fs.readFileSync(ARTISTS_TEMPLATE, 'utf8') : ''
  const lines = template.split(/\r?\n/)
  const cut = lines.findIndex((l) => l.trim() === '#')
  const preambleOnlyComments = cut >= 0 && lines.slice(0, cut).every((l) => !l.trim() || l.trim().startsWith('#'))
  fs.writeFileSync(file, (preambleOnlyComments ? lines.slice(cut + 1) : lines).join('\n'))
}

/**
 * 清单是手改的，可能超出上限：超出的艺人不跟踪，别名只用前几个。返回 { artists, warnings }。
 * tracked 是已经在跟踪的艺人：超出时先留它们，截掉新加的，免得手改一下就把在跟踪的人停掉。
 */
export function limitArtists(list, tracked = new Set()) {
  const warnings = []
  let kept = list
  if (list.length > MAX_ARTISTS) {
    const old = list.filter((a) => tracked.has(a.key))
    const fresh = list.filter((a) => !tracked.has(a.key))
    const keep = new Set([...old, ...fresh].slice(0, MAX_ARTISTS).map((a) => a.key))
    kept = list.filter((a) => keep.has(a.key))
    const dropped = list.filter((a) => !keep.has(a.key)).map((a) => a.key)
    warnings.push(`清单里有 ${list.length} 位艺人，最多跟踪 ${MAX_ARTISTS} 位，这几位没有跟踪：${dropped.join('、')}。先 unfollow 不再关注的，再加新的`)
  }
  const artists = kept.map((a) => {
    if (a.aliases.length <= MAX_ALIASES) return a
    warnings.push(`${a.key} 写了 ${a.aliases.length} 个别名，只用前 ${MAX_ALIASES} 个`)
    return { ...a, aliases: a.aliases.slice(0, MAX_ALIASES) }
  })
  return { artists, warnings }
}

/**
 * 清单里加一行。主名已经在了就把新别名并进去。返回加完的这位艺人，added 表示是不是新加的。
 * 超过 MAX_ARTISTS 位艺人、一位超过 MAX_ALIASES 个别名，不加，抛错说明。
 */
export function followArtist(line, file = ARTISTS_FILE) {
  const [entry] = parseArtists(line)
  if (!entry) throw new Error('名字是空的')
  ensureArtistsFile(file)
  const text = fs.readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)
  // 主名写法不同（大小写、末尾的“乐队”）也算同一位，并进原来那一行
  const i = lines.findIndex((l) => {
    const key = parseArtists(l)[0]?.key
    return key != null && sameName(key, entry.key)
  })
  // 新写的名字已经是别的艺人的名字或别名：不新加，免得同一位艺人跟踪两份、推两遍
  for (const other of parseArtists(text)) {
    if (i >= 0 && sameName(other.key, parseArtists(lines[i])[0].key)) continue
    const hit = [entry.key, ...entry.aliases].find((n) => [other.key, ...other.aliases].some((m) => sameName(n, m)))
    if (hit) throw new Error(`${hit} 已经是 ${other.key} 的名字或别名。要给 ${other.key} 补别名，写 follow ${other.key}、新别名`)
  }
  const tooMany = (n) => new Error(`${entry.key} 最多写 ${MAX_ALIASES} 个别名，加上这次一共 ${n} 个。挑最常见的写法留着`)
  if (i >= 0) {
    const old = parseArtists(lines[i])[0]
    const fresh = [entry.key, ...entry.aliases].filter((n) => n !== old.key && !old.aliases.includes(n))
    const merged = { key: old.key, aliases: [...old.aliases, ...fresh] }
    if (merged.aliases.length > MAX_ALIASES) throw tooMany(merged.aliases.length)
    lines[i] = [merged.key, ...merged.aliases].join('、')
    writeLines(file, lines)
    return { ...merged, added: false, newAliases: fresh }
  }
  if (entry.aliases.length > MAX_ALIASES) throw tooMany(entry.aliases.length)
  const count = parseArtists(text).length
  if (count >= MAX_ARTISTS) throw new Error(`已经关注了 ${count} 位艺人，最多 ${MAX_ARTISTS} 位。先用 unfollow 去掉不再关注的`)
  writeLines(file, [...lines.filter((l, idx) => l !== '' || idx < lines.length - 1), [entry.key, ...entry.aliases].join('、')])
  return { ...entry, added: true }
}

/** 清单里删掉这位艺人。主名、别名都认，写法不同（大小写、末尾的“乐队”）也认。返回删掉的主名，没找到返回 null。 */
export function unfollowArtist(name, file = ARTISTS_FILE) {
  ensureArtistsFile(file)
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  const hit = (l) => {
    const a = parseArtists(l)[0]
    return a && [a.key, ...a.aliases].some((n) => sameName(n, name))
  }
  const target = lines.find(hit)
  if (!target) return null
  writeLines(
    file,
    lines.filter((l) => l !== target),
  )
  return parseArtists(target)[0].key
}

/**
 * 有人在第一次运行以后还去改底稿 config/artists.txt：改了不生效，说一声真清单在哪。
 * 底稿里有、真清单里没有、状态库里也没见过（known）的名字，才提示：用 unfollow 去掉的不算。
 */
export function templateHint(list, file = ARTISTS_FILE, known = new Set()) {
  if (path.resolve(file) === path.resolve(ARTISTS_TEMPLATE) || !fs.existsSync(ARTISTS_TEMPLATE)) return null
  const seen = [...list.map((a) => a.key), ...known]
  const missing = parseArtists(fs.readFileSync(ARTISTS_TEMPLATE, 'utf8')).filter((t) => !seen.some((k) => sameName(k, t.key)))
  if (!missing.length) return null
  return `config/artists.txt 里写了 ${missing.map((a) => a.key).join('、')}，但那只是第一次运行时复制用的底稿，改它不生效。真正的清单在 ${file}，用 follow 加`
}

/** 写推送密钥，别的行保留；值是 null 的键删掉。文件只给自己读写。 */
export function saveSecrets(values, file = SECRETS_FILE) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : []
  const keys = new Set(Object.keys(values))
  const kept = lines.filter((l) => !keys.has(l.split('=')[0].trim()) && l !== '')
  const added = Object.entries(values).filter(([, v]) => v != null)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, [...kept, ...added.map(([k, v]) => `${k}=${v}`)].join('\n') + '\n', { mode: 0o600 })
  fs.chmodSync(file, 0o600)
}

function writeLines(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const text = lines.join('\n').replace(/\n*$/, '\n')
  fs.writeFileSync(file, text)
}

/** secrets.env：KEY=VALUE 一行一个，# 开头是注释。同名环境变量优先。 */
export function loadSecrets(file = SECRETS_FILE) {
  const out = {}
  if (fs.existsSync(file)) {
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const i = line.indexOf('=')
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
    }
  }
  for (const key of SECRET_KEYS) {
    if (process.env[key]) out[key] = process.env[key]
  }
  return out
}
