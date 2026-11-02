// 取数记录：每位艺人在每个数据源上最近一次去取的时间，用来守住“1 小时内只取一次”。
// 单独存一个小文件，不放状态库：--dry-run 在状态库的副本上跑，照样发真实请求，也要被这条限制管住。

import fs from 'node:fs'
import path from 'node:path'
import { nameKey } from './text.mjs'

/** 同一位艺人在同一个数据源上，两次取数至少隔这么久。写死，配置改不了。 */
export const MIN_FETCH_GAP_MS = 3600_000
/** check 两次至少隔这么久：它每次都是新进程，进程之间没有请求间隔，连着跑会把站点刷爆。 */
export const MIN_CHECK_GAP_MS = 60_000

export function openFetchLog(file) {
  let data = {}
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    // 第 2 版按归一的名字记，原样读；没有版本号的是按原样名字记的旧文件，读进来时换成新键。
    // 只换一次：归一不是每次都得到同一个结果（“XX Band乐队”去一次尾巴是“xxband”，再去一次是“xx”）
    data = raw?.v === 2 ? { ...raw.at } : migrate(raw)
  } catch {
    data = {}
  }
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ v: 2, at: data }))
  }
  return {
    get: (key) => (Number.isFinite(data[key]) ? data[key] : null),
    set(key, at) {
      data[key] = at
      save()
    },
  }
}

/** 内存版，测试用。 */
export function memoryFetchLog() {
  const m = new Map()
  return { get: (key) => m.get(key) ?? null, set: (key, at) => m.set(key, at) }
}

/**
 * 按归一以后的名字记：去掉“Foo”再关注“foo”，还是同一位艺人，不能借换个写法再取一遍。
 * sameName 认作同一位的名字，这里得到同一个键。
 */
export const fetchKey = (source, artistKey) => `${source}\u0000${nameKey(artistKey)}`

/**
 * 以前按原样的名字记的键，改成归一以后的。撞到一起的留不晚于现在的最近那次：
 * 将来的时间（时钟拨过）会被当成没取过，不能让它盖过真实的那次。
 */
function migrate(raw, now = Date.now()) {
  const out = {}
  const pick = (a, b) => (a == null ? b : a <= now && b <= now ? Math.max(a, b) : a <= now ? a : b <= now ? b : Math.max(a, b))
  for (const [key, at] of Object.entries(raw ?? {})) {
    if (!Number.isFinite(at)) continue
    const i = key.indexOf('\u0000')
    const k = i < 0 ? key : fetchKey(key.slice(0, i), key.slice(i + 1))
    out[k] = pick(out[k], at)
  }
  return out
}
