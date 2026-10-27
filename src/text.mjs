// 名字和城市的归一、别名匹配、致敬场过滤。各数据源共用，保证同一位艺人在哪都按同一套规则认。

/** 去空格和常见分隔符、全角转半角、拉丁字母转小写。繁简不互转，繁体写法要写进别名。 */
export function normalizeName(text) {
  if (text == null) return ''
  return String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s·•・.,\-_'"“”‘’「」『』《》()（）【】\[\]]/g, '')
}

/** 两个名字归一以后是否相同。末尾的“乐队”“乐团”“band”不算：秀动把回春丹录成“回春丹乐队”。 */
export function sameName(a, b) {
  const x = stripBandSuffix(normalizeName(a))
  return x !== '' && x === stripBandSuffix(normalizeName(b))
}

function stripBandSuffix(name) {
  const stripped = name.replace(/(乐队|乐团|樂隊|樂團|band)$/, '')
  return stripped || name
}

/** haystack 里是否包含 names 中的任意一个（归一以后比）。 */
export function containsAnyName(haystack, names) {
  const h = normalizeName(haystack)
  if (!h) return false
  return names.some((name) => {
    const n = normalizeName(name)
    return n !== '' && h.includes(n)
  })
}

/** 艺人的全部名字：主名加别名。 */
export function artistNames(artist) {
  return [artist.key, ...(artist.aliases || [])]
}

/** 城市名归一：去掉开头的“中国”（大麦写“中国澳门”）、“特别行政区”和末尾的“市”。 */
export function normalizeCity(text) {
  if (!text) return null
  let s = String(text).trim().replace(/^中国(?=香港|澳门|台湾|台北|高雄|台中|台南|新北|桃园)/, '').replace(/特别行政区$/, '')
  if (s.length > 2 && s.endsWith('市')) s = s.slice(0, -1)
  if (s.length === 2 && s.endsWith('市')) s = s.slice(0, -1)
  return s || null
}

// 出现就是别人唱的：致敬场、翻唱场
const TRIBUTE_STRONG = ['致敬', 'tribute', '模仿秀', '翻唱', '同款', '非原唱']
// 紧挨着艺人名才算：“邓丽君经典金曲演唱会”“邓丽君怀旧金曲音乐会”“久石让经典作品音乐会”“纪念张国荣”
const TRIBUTE_AFTER_NAME = ['', '经典', '怀旧', '流行'].flatMap((a) => ['金曲', '歌曲', '名曲', '作品'].map((b) => a + b))
const TRIBUTE_BEFORE_NAME = ['纪念', '怀念']
// 标题里连艺人名都没有时，带这些词的也当致敬场
const TRIBUTE_WEAK = ['金曲', '经典', '纪念', '怀念', '怀旧', '原唱']

/**
 * 标题像不像别人唱这位艺人的歌。只在没有艺人 ID 或阵容佐证时用。
 * 艺人自己的巡演也会叫“学友·经典”“出道 25 周年纪念演唱会”，所以“经典”“纪念”单独出现不算；
 * loose 为 true（标题里没有艺人名，只是搜索返回了）时才连这些词也算上。
 */
export function isTributeFor(title, names, { loose = false } = {}) {
  const t = normalizeName(title)
  const has = (w) => t.includes(normalizeName(w))
  if (TRIBUTE_STRONG.some(has)) return true
  if (loose && TRIBUTE_WEAK.some(has)) return true
  return names.some((name) => {
    const n = normalizeName(name)
    if (!n) return false
    return TRIBUTE_AFTER_NAME.some((w) => t.includes(n + normalizeName(w))) || TRIBUTE_BEFORE_NAME.some((w) => t.includes(normalizeName(w) + n))
  })
}

/** 按 UTF-8 字节截断，不截坏汉字。截掉了就在末尾加省略号。 */
export function truncateBytes(text, maxBytes) {
  const s = String(text ?? '')
  if (Buffer.byteLength(s) <= maxBytes) return s
  const ellipsis = '…'
  const budget = maxBytes - Buffer.byteLength(ellipsis)
  let out = ''
  let used = 0
  for (const ch of s) {
    const b = Buffer.byteLength(ch)
    if (used + b > budget) break
    out += ch
    used += b
  }
  return out + ellipsis
}
