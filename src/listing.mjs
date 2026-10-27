// 统一记录：每个适配器把平台数据翻译成这个格式，不判断阶段。字段说明见 docs/design.md“统一记录”。

export const SOURCES = ['damai', 'maoyan', 'showstart', 'gov']

// 售票状态，只按平台自己说的翻译，不推断：
//   listed     上架了，平台没说什么时候卖
//   presale    等着开售：大麦“预约”、猫眼“即将开售”、秀动票档开售时间在将来。首开前和二开前都算
//   onsale     正在卖：大麦“热卖”、猫眼“预售”“在售”
//   soldout    缺货、售罄
//   postponed  延期
//   ended      演完了
//   offline    平台说项目下线了（猫眼 code 1002）
export const STATUSES = ['listed', 'presale', 'onsale', 'soldout', 'postponed', 'ended', 'offline']
export const MATCHED_BY = ['id', 'lineup', 'title', 'search']

/**
 * @typedef {Object} Approval
 * @property {string|null} date      批复日期 YYYY-MM-DD
 * @property {string|null} number    文号
 * @property {string|null} approver  审批单位
 * @property {boolean} isChange      变更、增加演员这类
 */

/**
 * @typedef {Object} Listing
 * @property {'damai'|'maoyan'|'showstart'|'gov'} source
 * @property {string} sourceId
 * @property {string} artistKey
 * @property {'ticket'|'approval'} kind
 * @property {string} title
 * @property {string|null} city
 * @property {string|null} venue
 * @property {string|null} dateStart
 * @property {string|null} dateEnd
 * @property {'id'|'lineup'|'title'|'search'} matchedBy
 * @property {boolean} isMixed
 * @property {string|null} status
 * @property {number[]} saleTimes
 * @property {boolean} hasSold
 * @property {number|null} roundHint      介绍里写的“第 N 次销售”的 N
 * @property {number|null} roundHintAt    介绍里列出的开售时间里最晚的一个；它也过了、又冒出更晚的时间，就是第 N+1 轮
 * @property {Approval|null} approval
 * @property {string} url
 */

/** 补上默认值，返回一条统一记录。 */
export function makeListing(fields) {
  const listing = {
    source: fields.source,
    sourceId: String(fields.sourceId),
    artistKey: fields.artistKey,
    kind: fields.kind ?? 'ticket',
    title: fields.title ?? '',
    city: fields.city ?? null,
    venue: fields.venue ?? null,
    dateStart: fields.dateStart ?? null,
    dateEnd: fields.dateEnd ?? fields.dateStart ?? null,
    matchedBy: fields.matchedBy ?? 'search',
    isMixed: Boolean(fields.isMixed),
    status: fields.status ?? null,
    saleTimes: [...new Set((fields.saleTimes ?? []).filter((t) => Number.isFinite(t)))].sort((a, b) => a - b),
    hasSold: Boolean(fields.hasSold),
    roundHint: fields.roundHint ?? null,
    roundHintAt: Number.isFinite(fields.roundHintAt) ? fields.roundHintAt : null,
    approval: fields.approval ?? null,
    url: fields.url ?? '',
  }
  validateListing(listing)
  return listing
}

/** 格式不对就抛错。适配器的测试用它把关。 */
export function validateListing(l) {
  const problems = []
  if (!SOURCES.includes(l.source)) problems.push(`source=${l.source}`)
  if (!l.sourceId) problems.push('sourceId 为空')
  if (!l.artistKey) problems.push('artistKey 为空')
  if (!['ticket', 'approval'].includes(l.kind)) problems.push(`kind=${l.kind}`)
  if (l.kind === 'approval' && !l.approval) problems.push('报批记录缺 approval')
  if (l.kind === 'ticket' && l.status != null && !STATUSES.includes(l.status)) problems.push(`status=${l.status}`)
  if (!MATCHED_BY.includes(l.matchedBy)) problems.push(`matchedBy=${l.matchedBy}`)
  for (const key of ['dateStart', 'dateEnd']) {
    if (l[key] != null && !/^\d{4}-\d{2}-\d{2}$/.test(l[key])) problems.push(`${key}=${l[key]}`)
  }
  if (!Array.isArray(l.saleTimes) || l.saleTimes.some((t) => !Number.isFinite(t))) problems.push('saleTimes 不是毫秒数组')
  if (problems.length) throw new Error(`统一记录不对（${l.source}:${l.sourceId}）：${problems.join('，')}`)
  return l
}
