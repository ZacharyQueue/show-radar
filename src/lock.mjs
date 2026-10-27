// 同时只跑一轮：在运行目录建锁文件，写进进程号。别的进程等它跑完再开始，免得两个进程同时请求一个站点。
// 不靠 flock：macOS 和 Windows 没有。进程被杀留下的锁，看进程号已经不在了就清掉。

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const STALE_MS = 2 * 3600_000 // 一轮再慢也跑不了两小时，超过就当是卡死了留下的
// 进程号会被复用：Docker 里每次都是 1 号，Windows 回收得快。锁里再写一个这次运行独有的记号，记号对得上才算自己的锁
const TOKEN = randomUUID()
// 进程号对得上、却是别的用户的进程（EPERM），多半是进程号被复用了。超过一轮的最长时间（systemd 给 40 分钟）就当陈旧
const FOREIGN_STALE_MS = 45 * 60_000

/**
 * 拿到锁再跑 fn，跑完放掉。拿不到就每隔 pollMs 看一次，最多等 waitMs：比一轮最长的时间还长，正常排队一定等得到。
 * 等的时候收到停止信号（signal），不再等，抛 code 为 ABORTED 的错。
 */
export async function withLock(file, fn, { waitMs = 45 * 60_000, pollMs = 3000, log = console.log, sleep = defaultSleep, now = Date.now, signal } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const start = now()
  let told = false
  for (;;) {
    if (signal?.aborted) {
      const err = new Error('收到停止信号，还没开始就不跑了')
      err.code = 'ABORTED'
      throw err
    }
    if (tryCreate(file, now)) break
    if (isStale(file, now)) {
      fs.rmSync(file, { force: true })
      continue
    }
    if (now() - start >= waitMs) throw new Error(`等了 ${Math.round(waitMs / 60_000)} 分钟，上一轮还没跑完：${holder(file)}。先看看它在做什么（服务器上运行 systemctl status show-radar-run），不要删锁`)
    if (!told) {
      log('上一轮还在跑，等它跑完再开始。')
      told = true
    }
    await sleep(pollMs)
  }
  const release = () => {
    try {
      if (JSON.parse(fs.readFileSync(file, 'utf8')).token === TOKEN) fs.rmSync(file, { force: true })
    } catch {
      // 锁已经不在了，或者被别人清掉了
    }
  }
  process.once('exit', release)
  try {
    return await fn()
  } finally {
    release()
    process.removeListener('exit', release)
  }
}

function tryCreate(file, now) {
  try {
    const fd = fs.openSync(file, 'wx')
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: now(), token: TOKEN }))
    fs.closeSync(fd)
    return true
  } catch (err) {
    if (err.code === 'EEXIST') return false
    throw err
  }
}

function isStale(file, now) {
  let info
  try {
    info = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    // 读不出来：可能别的进程刚建、还没写完。过了一分钟还读不出来，才当是坏掉的锁
    try {
      return now() - fs.statSync(file).mtimeMs > 60_000
    } catch {
      return false
    }
  }
  if (!Number.isInteger(info.pid) || now() - info.at > STALE_MS) return true
  // 进程号是自己的，记号却不是：上一次运行留下的（重启后进程号正好一样）
  if (info.pid === process.pid) return info.token !== TOKEN
  try {
    process.kill(info.pid, 0)
    return false
  } catch (err) {
    if (err.code === 'ESRCH') return true
    // EPERM：进程在，是别的用户的
    return now() - info.at > FOREIGN_STALE_MS
  }
}

function holder(file) {
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8'))
    return `进程 ${info.pid}，${Math.round((Date.now() - info.at) / 60_000)} 分钟前开始`
  } catch {
    return '读不出锁里的信息'
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
