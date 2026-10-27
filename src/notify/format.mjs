// 推送的文字。一张卡片同时备好几种写法，各推送通道挑自己用得上的：
//   title、description  企业微信的 textcard：标题 128 字节、描述 512 字节以内，描述是带样式的 HTML
//   short               一行标题，32 字以内，最要紧的放进去。Server酱免费版只显示标题，超过 32 字截断
//   text                不带标签的正文，一行一件事
//   url                 点开去的售票页

import { SOURCE_LABELS, SOURCE_ORDER, roundName, stageLabel, timeline } from '../stage.mjs'
import { formatClock, formatDateRange, formatSaleTime, formatShortSale } from '../time.mjs'
import { truncateBytes } from '../text.mjs'

export const TITLE_MAX = 128
export const DESC_MAX = 512
export const TEXT_MAX = 2000
export const SHORT_MAX = 32

const FALLBACK_URL = 'https://m.damai.cn/'
// 标题里写开售时间的事件
const TIMED_KINDS = new Set(['sale_announced', 'resale_announced', 'sale_changed', 'sale_restored'])

/** 一条事件的卡片。listings 是这场演出名下的记录，用来挑链接。 */
export function eventCard(event, show, listings) {
  const label = eventLabel(event)
  const title = truncateBytes(`${show.artistKey} · ${show.city ?? '城市未定'} · ${label}`, TITLE_MAX)
  const lines = [
    { cls: 'gray', text: whenWhere(show), cut: 1 },
    { cls: 'highlight', text: mainLine(event, show, listings) },
    { cls: 'normal', text: show.isMixed ? `${show.title.includes('音乐节') ? '音乐节' : '拼盘演出'}：${show.title}` : show.title, cut: 0 },
    { cls: 'gray', text: timeline(show).join(' → '), cut: 2 },
  ]
  const saleAt = TIMED_KINDS.has(event.kind) ? event.saleAt : event.kind === 'resumed' ? event.detail?.nextSaleAt : null
  const shortHead = `${show.artistKey}·${show.city ?? '城市未定'}`
  const shortTail = ` ${label}${saleAt ? ` ${formatShortSale(saleAt)}` : ''}`
  return { title, description: fitLines(lines, DESC_MAX), url: pickUrl(event, listings), btntxt: '去看看', ...shortParts(shortHead, shortTail), text: plainText(lines), saleAt: saleAt ?? null }
}

/** 开售前提醒的卡片。 */
export function reminderCard(show, listings) {
  const title = truncateBytes(`${show.artistKey} · ${show.city ?? '城市未定'} · 快开售了`, TITLE_MAX)
  const sources = sourceNames(saleSources(listings, show.nextSaleAt))
  const lines = [
    { cls: 'highlight', text: `${formatSaleTime(show.nextSaleAt)} 开售${sources ? `（${sources}）` : ''}` },
    { cls: 'gray', text: whenWhere(show), cut: 1 },
    { cls: 'normal', text: show.title, cut: 0 },
  ]
  const event = { kind: 'sale_announced', saleAt: show.nextSaleAt, detail: {} }
  const parts = shortParts(`${show.artistKey}·${show.city ?? '城市未定'}`, ` ${formatClock(show.nextSaleAt)} 开售`)
  return { title, description: fitLines(lines, DESC_MAX), url: pickUrl(event, listings), btntxt: '去看看', ...parts, text: plainText(lines), saleAt: show.nextSaleAt }
}

/** 纯文字消息（汇总、健康提醒、周报）也写成卡片的样子，标题取第一行。 */
export function textMessage(text) {
  const [first] = String(text).split('\n')
  return { ...shortParts(first, ''), text: String(text), url: null, saleAt: null }
}

/**
 * 几条消息合成一条，给按条数计费的通道用。开售时间近的排前面，标题写排第一的那条，后面带上总条数。
 * items 是 eventCard、reminderCard、textMessage 的返回。
 */
export function digestMessage(items) {
  const sorted = [...items].sort((a, b) => rank(a) - rank(b))
  const [first] = sorted
  // 加“等N条”时从艺人和城市那头截，阶段和开售时间保持完整
  const short = sorted.length === 1 ? first.short : shortTitle(first.shortHead ?? first.short, `${first.shortTail ?? ''} 等${sorted.length}条`)
  const blocks = sorted.map((m) => [m.title ? m.short : null, m.text, m.url ? `链接：${m.url}` : null].filter(Boolean).join('\n'))
  return { short, text: blocks.join('\n\n'), url: sorted.find((m) => m.url)?.url ?? null, saleAt: first.saleAt }
}

function rank(m) {
  if (m.saleAt) return m.saleAt
  return m.title ? Number.MAX_SAFE_INTEGER - 1 : Number.MAX_SAFE_INTEGER
}

/** 短标题连同拆开的两半：合成消息加“等N条”时要从 head 截。 */
function shortParts(head, tail) {
  return { short: shortTitle(head, tail), shortHead: head, shortTail: tail }
}

/** head 放得下就整句，放不下截 head，tail（阶段、开售时间）保持完整。按字算，不按字节。 */
export function shortTitle(head, tail) {
  const h = [...head]
  const t = [...tail]
  if (h.length + t.length <= SHORT_MAX) return head + tail
  const room = SHORT_MAX - t.length - 1
  if (room <= 0) return [...(head + tail)].slice(0, SHORT_MAX - 1).join('') + '…'
  return h.slice(0, room).join('') + '…' + tail
}

function plainText(lines) {
  return lines.filter((l) => l.text).map((l) => l.text).join('\n')
}

/**
 * 新关注艺人的汇总。entries: [{ artistKey, sources: [{ source, found }], shows: [演出] }]
 * found 为 true 表示找到了这位艺人，false 表示平台上没有，null 表示这次没取成。返回按 2000 字节切好的几段。
 */
export function summaryTexts(entries) {
  const blocks = entries.map((e) => {
    const found = e.sources.filter((s) => s.found === true).map((s) => SOURCE_LABELS[s.source])
    const missing = e.sources.filter((s) => s.found === false).map((s) => SOURCE_LABELS[s.source])
    const failed = e.sources.filter((s) => s.found == null).map((s) => SOURCE_LABELS[s.source])
    const parts = []
    if (found.length) parts.push(`${found.join('、')}：找到了`)
    if (missing.length) parts.push(`${missing.join('、')}：没有这位艺人`)
    if (failed.length) parts.push(`${failed.join('、')}：这次没取成，下一轮再试`)
    const lines = [e.artistKey, parts.join('；')]
    const shows = e.shows.filter((s) => s.stage && s.stage !== 'ended')
    if (shows.length) {
      lines.push(`现在有 ${shows.length} 场：`)
      for (const s of shows) lines.push(`· ${showLine(s)}`)
    } else {
      lines.push('现在没有演出，有了会推给你')
    }
    return lines.join('\n')
  })
  const header = `开始关注 ${entries.map((e) => e.artistKey).join('、')}`
  return chunk([header, ...blocks], TEXT_MAX)
}

/** 艺人已经关注着，某个数据源晚了几轮才第一次取到：它独自找到的演出合成一条，不逐张推。 */
export function lateSourcesText(artistKey, sources, shows) {
  const names = sources.map((s) => SOURCE_LABELS[s] ?? s).join('、')
  const lines = [`${names}这次取到了 ${artistKey}：新增 ${shows.length} 场`, ...shows.map((s) => `· ${showLine(s)}`)]
  return truncateBytes(lines.join('\n'), TEXT_MAX)
}

/** 数据源连着取不到，或恢复了。 */
export function healthText({ source, status, reason, failRuns }) {
  const name = SOURCE_LABELS[source] ?? source
  if (status === 'up') return `${name}恢复了，演出信息照常更新。`
  return `${name}已经连着 ${failRuns} 轮取不到数据，原因：${reason}。别的数据源照常，${name}的演出这段时间可能漏推。`
}

/** 周报。 */
export function weeklyText({ artistCount, showCount, pushedCount, health }) {
  const lines = [`演出雷达周报`, `关注 ${artistCount} 位艺人，正在跟踪 ${showCount} 场演出，这周推了 ${pushedCount} 条。`]
  const bad = health.filter((h) => !h.ok)
  lines.push(bad.length ? `取不到数据的：${bad.map((h) => `${SOURCE_LABELS[h.source] ?? h.source}（${h.reason}）`).join('、')}。` : '各数据源都正常。')
  return truncateBytes(lines.join('\n'), TEXT_MAX)
}

export function showLine(show) {
  const parts = [show.city ?? '城市未定', formatDateRange(show.dateStart, show.dateEnd), stageLabel(show.stage, show.round)]
  if (show.nextSaleAt && (show.stage === 'sale_pending' || show.stage === 'resale_pending')) parts.push(`${formatSaleTime(show.nextSaleAt)} 开售`)
  return parts.filter(Boolean).join(' ')
}

function eventLabel(event) {
  switch (event.kind) {
    case 'approved':
      return '已报批'
    case 'listed':
      return event.detail?.soldout ? '已上架（售罄）' : event.detail?.waiting ? '已上架（等下一轮）' : '已上架'
    case 'sale_announced':
      return event.detail?.nextBatch ? '下一批开售' : '待开票'
    case 'sale_restored':
      return '开售时间重新公布'
    case 'sale_withdrawn':
      return '开售时间撤了'
    case 'resumed':
      return '恢复售票'
    case 'resale_announced':
      return roundName(event.round)
    case 'sale_changed':
      return '开售时间改了'
    case 'onsale_missed':
      return event.detail?.soldout ? '已开售并售罄' : '已开售'
    case 'restock':
      return '又有票了'
    case 'postponed':
      return '延期'
    case 'offline':
      return '下架'
    default:
      return event.kind
  }
}

function mainLine(event, show, listings) {
  const d = event.detail ?? {}
  switch (event.kind) {
    case 'sale_announced':
    case 'resale_announced':
    case 'sale_restored': {
      const sources = sourceNames(d.saleSources)
      return `${formatSaleTime(event.saleAt)} 开售${sources ? `（${sources}）` : ''}`
    }
    case 'sale_withdrawn':
      return `原定 ${formatSaleTime(event.saleAt)} 的开售撤了，时间待定`
    case 'resumed': {
      const from = d.from === 'postponed' ? '延期' : '下架'
      if (d.nextSaleAt) return `${from}以后又挂出来了，${formatSaleTime(d.nextSaleAt)} 开售`
      const sources = sourceNames(d.sources)
      return `${from}以后又挂出来了${sources ? `，${sources}在卖` : ''}`
    }
    case 'sale_changed':
      return `改到 ${formatSaleTime(event.saleAt)} 开售，原来是 ${formatSaleTime(d.previousSaleAt)}`
    case 'onsale_missed': {
      if (d.soldout) return '两轮抓取之间就开售、卖完了，这次没赶上，有二开会推给你'
      const sources = sourceNames(d.sources)
      return `已经在卖了${sources ? `（${sources}）` : ''}，这次没赶上预告`
    }
    case 'restock': {
      const sources = sourceNames(d.sources)
      return `${sources || '平台上'}又有票了`
    }
    case 'listed':
      if (d.soldout) return '已经售罄，有二开会推给你'
      if (d.waiting) return '开过票了，在等下一轮，时间还没公布'
      return '开售时间还没公布'
    case 'approved': {
      const a = listings.find((l) => l.kind === 'approval')?.approval
      return a ? `文旅部批准${a.date ? `：${a.date}` : ''}${a.approver ? `（${a.approver}）` : ''}` : '文旅部批准了这场演出'
    }
    case 'postponed':
      return '演出延期了'
    case 'offline':
      return '售票页下架了，可能取消或改期'
    default:
      return stageLabel(show.stage, show.round)
  }
}

function whenWhere(show) {
  return [formatDateRange(show.dateStart, show.dateEnd), show.venue].filter(Boolean).join(' · ')
}

/**
 * 挑链接：按记录挑，不按数据源挑。同一平台上原场和加场是两个项目，链接要指向这次开售的那个。
 * 开售类事件用开售时间对得上的那条；又有票了、已开售用正在卖的那条；都没有再用还在卖的售票页，最后用报批页。
 */
export function pickUrl(event, listings) {
  const byOrder = (a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source)
  const withUrl = listings.filter((l) => l.url).sort(byOrder)
  const tickets = withUrl.filter((l) => l.kind === 'ticket')
  const saleAt = event.detail?.nextSaleAt ?? (SALE_EVENT_KINDS.has(event.kind) ? event.saleAt : null)
  const minute = (t) => Math.round(t / 60_000)
  const bySale = saleAt ? tickets.find((l) => (l.saleTimes ?? []).some((x) => minute(x) === minute(saleAt))) : null
  const onsale = tickets.find((l) => l.status === 'onsale')
  const live = tickets.find((l) => !['offline', 'ended'].includes(l.status))
  return (bySale ?? onsale ?? live ?? withUrl[0])?.url || FALLBACK_URL
}

const SALE_EVENT_KINDS = new Set(['sale_announced', 'resale_announced', 'sale_changed', 'sale_restored', 'sale_withdrawn'])

function saleSources(listings, t) {
  if (t == null) return []
  const minute = Math.round(t / 60_000)
  return SOURCE_ORDER.filter((src) => listings.some((l) => l.source === src && (l.saleTimes ?? []).some((x) => Math.round(x / 60_000) === minute)))
}

function sourceNames(sources) {
  return (sources ?? []).map((s) => SOURCE_LABELS[s] ?? s).join('、')
}

/** 把几行拼成卡片描述，超长时按 cut 从小到大截：先截标题行，再截场馆那行，再截时间线。 */
function fitLines(lines, maxBytes) {
  let current = lines.filter((l) => l.text)
  const render = () => current.map((l) => `<div class="${l.cls}">${escapeHtml(l.text)}</div>`).join('')
  const shrink = (line) => {
    const over = Buffer.byteLength(render()) - maxBytes
    const budget = Buffer.byteLength(escapeHtml(line.text)) - over
    const text = budget > 9 ? truncateEscaped(line.text, budget) : ''
    // 截不动就整行去掉，保证循环能结束
    return text && text !== line.text ? { ...line, text } : null
  }
  for (const order of [0, 1, 2]) {
    if (Buffer.byteLength(render()) <= maxBytes) break
    current = current.map((l) => (l.cut === order ? shrink(l) : l)).filter(Boolean)
  }
  // 还超就截最长的那行，保证标签完整
  while (Buffer.byteLength(render()) > maxBytes && current.length) {
    const longest = current.reduce((a, b) => (Buffer.byteLength(escapeHtml(b.text)) > Buffer.byteLength(escapeHtml(a.text)) ? b : a))
    current = current.map((l) => (l === longest ? shrink(l) : l)).filter(Boolean)
  }
  return render()
}

/** 按转义以后的字节数截断，末尾加省略号。 */
function truncateEscaped(text, maxBytes) {
  const ellipsis = '…'
  if (Buffer.byteLength(escapeHtml(text)) <= maxBytes) return text
  const budget = maxBytes - Buffer.byteLength(ellipsis)
  let out = ''
  let used = 0
  for (const ch of text) {
    const b = Buffer.byteLength(escapeHtml(ch))
    if (used + b > budget) break
    out += ch
    used += b
  }
  return out + ellipsis
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function chunk(blocks, maxBytes) {
  const out = []
  let cur = ''
  for (const b of blocks) {
    const next = cur ? `${cur}\n\n${b}` : b
    if (Buffer.byteLength(next) > maxBytes && cur) {
      out.push(cur)
      cur = truncateBytes(b, maxBytes)
    } else {
      cur = truncateBytes(next, maxBytes)
    }
  }
  if (cur) out.push(cur)
  return out
}
