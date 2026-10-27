// 适配器和请求客户端只抛这三种错误，run.mjs 按类型决定停哪个数据源、怎么提醒用户。

/** 被平台拦下：验证码、滑块、403、412、429、469。这一轮停掉这个数据源。 */
export class BlockedError extends Error {
  constructor(site, reason) {
    super(`${site} 被拦：${reason}`)
    this.name = 'BlockedError'
    this.site = site
    this.reason = reason
  }
}

/** 接口名、签名或返回格式变了，要改代码。 */
export class ApiChangedError extends Error {
  constructor(site, reason) {
    super(`${site} 接口变了：${reason}`)
    this.name = 'ApiChangedError'
    this.site = site
    this.reason = reason
  }
}

/** 连不上、超时。 */
export class NetworkError extends Error {
  constructor(site, reason) {
    super(`${site} 网络出错：${reason}`)
    this.name = 'NetworkError'
    this.site = site
    this.reason = reason
  }
}
