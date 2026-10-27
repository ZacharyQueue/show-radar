// 常驻模式的时刻表：抓取和 systemd 定时器一样，北京时间 3:07、9:07、15:07、21:07 各一轮，再随机推迟一点；开售提醒每 10 分钟一次。
// 为什么是这几个时刻，见 docs/design.md“一轮怎么跑”。

import { beijingParts, fromBeijing } from './time.mjs'

export const ROUND_TIMES = [
  [3, 7],
  [9, 7],
  [15, 7],
  [21, 7],
]
/** 每轮随机推迟 0 到 20 分钟：部署的人多了，不在同一分钟请求同一个站。 */
export const MAX_JITTER_MS = 20 * 60_000
export const REMIND_EVERY_MS = 10 * 60_000

/** now 之后的下一轮，random 是 0 到 1 之间的数。 */
export function nextRoundAt(now, random = Math.random) {
  const p = beijingParts(now)
  for (let day = 0; day < 2; day++) {
    for (const [h, m] of ROUND_TIMES) {
      const at = fromBeijing(p.year, p.month, p.day, h, m) + day * 86400_000
      if (at > now) return at + Math.floor(random() * MAX_JITTER_MS)
    }
  }
  throw new Error('算不出下一轮的时间')
}

/**
 * 常驻模式跑完一轮以后，下一轮什么时候跑。正常按固定时刻；两个固定时刻之间最多补一轮，免得补轮接补轮，变成每小时抓一次：
 *   - 这一轮时间到了、有艺人没取到：半小时后补一轮；
 *   - 有艺人被跳过的那些数据源，这一轮一位都没取到，全是 1 小时内取过的（比如刚预演过）：满 1 小时补一轮。
 *     只看有跳过的数据源：一天只取一次的数据源这一轮取到了，不能挡住别的数据源补轮。
 * state 是上一次的返回（第一轮传 {}），sources 是这一轮 runRound 统计里各数据源的那一项。
 * 返回 { next, regular, followUpUsed }，后两项原样传给下一次。
 */
export function planNextRound(now, sources, { regular = null, followUpUsed = false } = {}, random = Math.random) {
  // 到了固定时刻跑的这一轮：排下一个固定时刻，补轮的名额重新算
  if (regular == null || now >= regular) {
    regular = nextRoundAt(now, random)
    followUpUsed = false
  }
  if (!followUpUsed) {
    let followUp = null
    if (sources.some((s) => s.unfinished?.length)) followUp = now + 30 * 60_000
    else {
      const skipping = sources.filter((s) => s.recent?.length)
      if (skipping.length && skipping.every((s) => !s.artists)) {
        const retryAt = Math.min(...skipping.map((s) => s.retryAt ?? Infinity))
        if (Number.isFinite(retryAt)) followUp = retryAt + 60_000
      }
    }
    if (followUp != null && followUp < regular) return { next: followUp, regular, followUpUsed: true }
  }
  return { next: regular, regular, followUpUsed }
}
