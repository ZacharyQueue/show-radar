// 把统一记录归进一场演出。规则见 docs/design.md“合成演出”。

import { parseBeijing } from './time.mjs'
import { normalizeName } from './text.mjs'

const DAY_MS = 86400_000

/**
 * 在这位艺人已有的演出里找这条记录该归的那一场，找不到返回 null。
 * 条件：同一位艺人、同一个城市、日期有重叠（前后放宽 1 天）。
 * 一边是音乐节或拼盘、一边是专场时，场馆对得上才算：各平台判“多人同台”的口径不一样，秀动会把暖场乐队算进阵容。
 * 报批记录没有阵容，不比这一项。
 * 几场都符合时，场馆对得上的优先，再看“多人同台”一致的，再看开始日期最近的。
 * excludeId 给“没日期的场有了日期、重新归一次”用，排除它自己。
 */
export function findShowForListing(listing, shows, excludeId = null) {
  if (!listing.city || !listing.dateStart) return null
  const range = dateRange(listing)
  if (!range) return null
  const compareMixed = listing.kind === 'ticket'
  const candidates = shows.filter((s) => {
    if (s.id === excludeId) return false
    if (s.artistKey !== listing.artistKey || s.city !== listing.city) return false
    if (s.stage === 'ended') return false
    if (compareMixed && s.isMixed !== listing.isMixed && !venueMatches(s.venue, listing.venue)) return false
    const r = dateRange(s)
    return r != null && r.start <= range.end + DAY_MS && range.start <= r.end + DAY_MS
  })
  if (candidates.length <= 1) return candidates[0] ?? null
  const scored = candidates.map((s) => ({
    s,
    venue: venueMatches(s.venue, listing.venue) ? 0 : 1,
    mixed: s.isMixed === listing.isMixed ? 0 : 1,
    gap: Math.abs(dateRange(s).start - range.start),
  }))
  scored.sort((a, b) => a.venue - b.venue || a.mixed - b.mixed || a.gap - b.gap || a.s.id - b.s.id)
  return scored[0].s
}

export function venueMatches(a, b) {
  const x = normalizeName(a)
  const y = normalizeName(b)
  if (!x || !y) return false
  return x.includes(y) || y.includes(x)
}

function dateRange(x) {
  const start = parseBeijing(x.dateStart)
  if (start == null) return null
  const end = parseBeijing(x.dateEnd ?? x.dateStart) ?? start
  return { start, end: Math.max(start, end) }
}
