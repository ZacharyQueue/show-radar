import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decrypt, encrypt } from '../../src/sources/zwfw-sm4.mjs'

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/gov-national')
// 样本抓取当天（2026-10-26）getsm4key 下发的密钥
const KEY = JSON.parse(fs.readFileSync(path.join(DIR, 'zwfw_portal_getsm4key.json'), 'utf8')).data[0].smKey

const samples = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.raw.json'))
  .map((f) => ({ name: f, raw: JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) }))
  .filter((s) => typeof s.raw.data === 'string')

test('样本密钥是 2026-10-26 那把', () => {
  assert.equal(KEY, 'ea17d76c2ad95a05')
  assert.ok(samples.length >= 15)
})

test('解开每一份真实密文，和存下的解密结果一致', () => {
  for (const { name, raw } of samples) {
    const plain = decrypt(raw.data, KEY)
    const expected = fs.readFileSync(path.join(DIR, name.replace('.raw.json', '.dec.json')), 'utf8').replace(/\n$/, '')
    assert.equal(plain, expected, name)
    assert.deepEqual(JSON.parse(plain), JSON.parse(expected), name)
  }
})

test('把解出来的明文再加密，和服务端给的密文一字不差', () => {
  // ECB、PKCS#7 都是确定的，所以这条能验证加密方向和服务端是同一套算法
  for (const { name, raw } of samples) {
    assert.equal(encrypt(decrypt(raw.data, KEY), KEY), raw.data, name)
  }
})

test('浏览器里存下的那份列表密文也能解开', () => {
  const text = fs.readFileSync(path.join(DIR, 'zwfw_portal_swychd_encrypted_response_sample_2026-10-26.txt'), 'utf8')
  const body = JSON.parse(text.split('\n').find((line) => line.startsWith('{')))
  const page = JSON.parse(decrypt(body.data, KEY))
  assert.ok(Array.isArray(page.list))
  assert.equal(page.pagination.pageSize, 15)
})

test('加密以后解密能还原：中文、空串、正好整块、跨很多块', () => {
  const cases = [
    '',
    '1234567890123456',
    JSON.stringify({ pageSize: '15', pageNum: '1', performanceName: '周杰伦', performancePlace1: '', performingBeginTime: '2026-10-26', performingEndTime: '' }),
    JSON.stringify({ id: '72c1b9af256a45428c69e3607368cf87' }),
    '陳奕迅 G.E.M.邓紫棋 Кино 🎤'.repeat(20),
  ]
  for (const plain of cases) {
    const cipher = encrypt(plain, KEY)
    assert.doesNotMatch(cipher, /[+\r\n]/)
    assert.equal(decrypt(cipher, KEY), plain)
  }
})

test('请求参数的密文和 Python 移植版算出来的一样', () => {
  // 调研时照站点脚本另写过一份 Python 版（不在仓库里），这是它用 ea17d76c2ad95a05 加密下面这段 JSON 的输出
  const plain = '{"pageSize":"15","pageNum":"1","performanceName":"周杰伦","performancePlace1":"","performingBeginTime":"2026-10-26","performingEndTime":""}'
  assert.equal(
    encrypt(plain, KEY),
    '2Z0tjk3OHQBYNSvRaUlcDsRLZNDVnR2qYfuw6CYW4J1TnKD5jJt7VxNdi/mEeFh/0MtHS@xQqSKfJ7LpCsRHa4uSQlJCn/jwizOQqU/OTXgJ@eckjYTRKStCf70suepBl4XUTCHKqnx6u5vrs3rlJZNrNVIhHO6F2jyPWtfe8LTuhTzIDhJ3BO1rTDo8kXYz',
  )
})

test('不是对象的明文先 JSON.stringify，和站点一样', () => {
  const obj = { id: 'abc' }
  assert.equal(encrypt(obj, KEY), encrypt(JSON.stringify(obj), KEY))
})

test('和标准 SM4 不同：站点注释里的测试向量是标准算法的结果，这里对不上', () => {
  // sm4.js 注释写 encrypt_ebc("1234", "1234567890123456") => "woPrxebr8Xvyo1qG8QxAUA=="，那是标准 SM4
  const standard = crypto.getCiphers().includes('sm4-ecb')
    ? (() => {
        const c = crypto.createCipheriv('sm4-ecb', Buffer.from('1234567890123456'), null)
        return Buffer.concat([c.update('1234'), c.final()]).toString('base64')
      })()
    : 'woPrxebr8Xvyo1qG8QxAUA=='
  assert.equal(standard, 'woPrxebr8Xvyo1qG8QxAUA==')
  assert.equal(encrypt('1234', '1234567890123456'), 'ry8R7YUhZ6ZJiUuwmfWnYQ==')
  assert.equal(decrypt('ry8R7YUhZ6ZJiUuwmfWnYQ==', '1234567890123456'), '1234')
})

test('解密前把 @ # ! 换回来，# ! 换回的换行被跳过', () => {
  const cipher = encrypt('{"a":"++++++++++++++++++++++"}', KEY)
  const withBreaks = cipher.slice(0, 8) + '#!' + cipher.slice(8)
  assert.equal(decrypt(withBreaks, KEY), '{"a":"++++++++++++++++++++++"}')
})

test('密钥不对时解出来不是 JSON，不抛错', () => {
  const plain = decrypt(samples[0].raw.data, '0000000000000000')
  assert.throws(() => JSON.parse(plain))
})

test('密钥不是 16 字节、密文坏了时抛错', () => {
  assert.throws(() => encrypt('x', 'short'), /16 字节/)
  assert.throws(() => decrypt('abcd', 'short'), /16 字节/)
  assert.throws(() => decrypt('不是base64', KEY), /Base64/)
  assert.throws(() => decrypt('QUJDREVGRw==', KEY), /16 的倍数/)
})
