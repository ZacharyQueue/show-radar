// 测试用的假客户端：不联网，按请求返回事先写好的响应。

import { createClient } from '../../src/http.mjs'

/**
 * handler(req) 返回 { status?, headers?, text?, json? }。req 有 method、url、headers、body。
 * 和真的客户端一样，只许请求白名单里的域名；测试里用别的域名，在 hosts 里写上。
 * 返回的客户端多一个 calls 数组，记下每次请求。
 */
export function fakeClient(handler, { site = 'test', hosts = [], now = () => Date.UTC(2026, 9, 26, 2, 0) } = {}) {
  const calls = []
  const client = createClient({
    site,
    hosts,
    minGapMs: 0,
    sleep: async () => {},
    now,
    transport: async (req) => {
      calls.push(req)
      const res = (await handler(req)) ?? {}
      const text = res.text ?? (res.json !== undefined ? JSON.stringify(res.json) : '')
      return { status: res.status ?? 200, headers: res.headers ?? {}, text }
    },
  })
  client.calls = calls
  return client
}
