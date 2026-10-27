// 取数记录：每位艺人在每个数据源上最近一次去取的时间，用来守住“1 小时内只取一次”。
// 单独存一个小文件，不放状态库：--dry-run 在状态库的副本上跑，照样发真实请求，也要被这条限制管住。

import fs from 'node:fs'
import path from 'node:path'

/** 同一位艺人在同一个数据源上，两次取数至少隔这么久。写死，配置改不了。 */
export const MIN_FETCH_GAP_MS = 3600_000
/** check 两次至少隔这么久：它每次都是新进程，进程之间没有请求间隔，连着跑会把站点刷爆。 */
export const MIN_CHECK_GAP_MS = 60_000

export function openFetchLog(file) {
  let data = {}
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    data = {}
  }
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data))
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

export const fetchKey = (source, artistKey) => `${source}\u0000${artistKey}`
