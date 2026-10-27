// 北京时间。中国不用夏令时，固定东八区，不读服务器和本机的时区。

const OFFSET_MS = 8 * 3600_000
const DAY_MS = 86400_000
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

/** 毫秒时间戳在北京时间下的年月日时分。 */
export function beijingParts(ms) {
  const d = new Date(ms + OFFSET_MS)
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
  }
}

/** 北京时间的年月日时分秒换成毫秒时间戳。 */
export function fromBeijing(year, month, day, hour = 0, minute = 0, second = 0) {
  return Date.UTC(year, month - 1, day, hour, minute, second) - OFFSET_MS
}

/** 毫秒时间戳 → 'YYYY-MM-DD'（北京时间）。 */
export function beijingDate(ms) {
  const p = beijingParts(ms)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

/** 北京时间当天 0 点的时间戳。 */
export function startOfBeijingDay(ms) {
  return Math.floor((ms + OFFSET_MS) / DAY_MS) * DAY_MS - OFFSET_MS
}

/**
 * 解析不带时区的日期时间字符串，一律当北京时间。
 * 认 2026-10-27、2026/10/27、2026.10.27，后面可跟 17:17 或 17:17:00。解析不了返回 null。
 */
export function parseBeijing(text) {
  if (text == null) return null
  const m = String(text).trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
  if (!m) return null
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = m
  const ms = fromBeijing(+y, +mo, +d, +h, +mi, +s)
  return Number.isNaN(ms) ? null : ms
}

/** 'YYYY-MM-DD' 或能解析的日期 → 'YYYY-MM-DD'，解析不了返回 null。 */
export function toDateString(text) {
  const ms = parseBeijing(text)
  return ms == null ? null : beijingDate(ms)
}

/**
 * 解析平台给的相对说法：“今天17:17”“明天 17:17”“后天10:00”“10月27日 17:17”“10.27 17:17”。
 * 没写年份的月日，取 now 之后最近的那一天。解析不了返回 null。
 */
export function parseRelativeBeijing(text, now) {
  if (!text) return null
  const s = String(text).replace(/\s+/g, ' ').trim()
  const time = s.match(/(\d{1,2})[:：](\d{2})/)
  const hour = time ? +time[1] : 0
  const minute = time ? +time[2] : 0
  const today = beijingParts(now)
  const rel = s.match(/^(今天|明天|后天)/)
  if (rel) {
    const offset = { 今天: 0, 明天: 1, 后天: 2 }[rel[1]]
    return fromBeijing(today.year, today.month, today.day, hour, minute) + offset * DAY_MS
  }
  const ymd = s.match(/^(\d{4})[年\-/.](\d{1,2})[月\-/.](\d{1,2})/)
  if (ymd) return fromBeijing(+ymd[1], +ymd[2], +ymd[3], hour, minute)
  const md = s.match(/^(\d{1,2})[月\-/.](\d{1,2})/)
  if (!md) return null
  let candidate = fromBeijing(today.year, +md[1], +md[2], hour, minute)
  if (candidate < startOfBeijingDay(now)) candidate = fromBeijing(today.year + 1, +md[1], +md[2], hour, minute)
  return candidate
}

/** 开售时间的显示：10月27日（周二）17:17。 */
export function formatSaleTime(ms) {
  const p = beijingParts(ms)
  return `${p.month}月${p.day}日（周${WEEKDAYS[p.weekday]}）${pad(p.hour)}:${pad(p.minute)}`
}

/** 开售时间的短写法，放进推送标题：10月27日 17:17。 */
export function formatShortSale(ms) {
  const p = beijingParts(ms)
  return `${p.month}月${p.day}日 ${pad(p.hour)}:${pad(p.minute)}`
}

/** 只写钟点：17:17。 */
export function formatClock(ms) {
  const p = beijingParts(ms)
  return `${pad(p.hour)}:${pad(p.minute)}`
}

/** 演出日期的显示：11月13日、11月13日—22日、11月28日—12月2日、2026年12月31日—2027年1月1日。 */
export function formatDateRange(start, end) {
  const a = start ? parseBeijing(start) : null
  if (a == null) return ''
  const pa = beijingParts(a)
  const b = end ? parseBeijing(end) : null
  if (b == null || b === a) return `${pa.month}月${pa.day}日`
  const pb = beijingParts(b)
  if (pa.year !== pb.year) return `${pa.year}年${pa.month}月${pa.day}日—${pb.year}年${pb.month}月${pb.day}日`
  if (pa.month !== pb.month) return `${pa.month}月${pa.day}日—${pb.month}月${pb.day}日`
  return `${pa.month}月${pa.day}日—${pb.day}日`
}

function pad(n) {
  return String(n).padStart(2, '0')
}
