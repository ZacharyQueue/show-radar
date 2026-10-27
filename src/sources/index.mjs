// 数据源登记。每个适配器是一个模块，导出下面这些东西，run.mjs 只认这个接口。
//
//   name            'damai' | 'maoyan' | 'showstart' | 'gov'
//   label           给用户看的名字：大麦、猫眼、秀动
//   clientOptions   建请求客户端的参数，至少有 site，可以有 userAgent、minGapMs，可选数据源还有 hosts
//   needsArtistId   要不要先找平台艺人 ID
//   everyRun        每轮都取；false 表示一天只取一次
//
//   async resolveArtist(artist, ctx) → { id, name } | null | undefined
//       按主名和别名找平台艺人 ID，名字归一后完全相同才认。找不到返回 null；
//       这一轮没查成（出错了但不想停掉整个数据源）返回 undefined，下一轮再查。
//   async fetchArtist(artist, ctx) → Listing[]
//       取这位艺人在全国的演出，翻译成统一记录（src/listing.mjs）。
//   async check(ctx) → { ok, detail, error? }
//       发一两个请求看通不通，给 `cli.mjs check` 用。出错时可以抛，也可以返回 ok:false 并带上原来的错误对象。
//
// artist = { key, aliases: string[], ids: { damai?, maoyan?, showstart? } }
// ctx = { client, now: () => 毫秒, log: (msg) => void, kv: { get(key), set(key, value) },
//         previous: (sourceId) => 上一轮存下的统一记录 | null }
// previous 用来省请求：上一轮取过详情、这一轮列表上看没变的，可以不再取详情，沿用上一轮的字段。
//
// 出错只抛 src/errors.mjs 里的三种。被拦抛 BlockedError，接口或签名变了抛 ApiChangedError。

import fs from 'node:fs'
import * as damai from './damai.mjs'
import * as maoyan from './maoyan.mjs'
import * as showstart from './showstart.mjs'

// 可选的数据源：文件在就加载，不在就没有。文件在、加载出错照常报错，不悄悄跳过。
const optional = []
if (fs.existsSync(new URL('./gov.mjs', import.meta.url))) optional.push(await import('./gov.mjs'))

export const ADAPTERS = [damai, maoyan, showstart, ...optional]

export function adapterByName(name) {
  return ADAPTERS.find((a) => a.name === name)
}
