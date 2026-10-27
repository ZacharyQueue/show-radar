// 打发布包：只带服务器运行要用的文件（src、config、deploy、package.json）。
// 用法：node scripts/pack.mjs，包在 artifacts/ 下。

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beijingParts } from '../src/time.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const p = beijingParts(Date.now())
const pad = (n) => String(n).padStart(2, '0')
const name = `show-radar-${p.year}${pad(p.month)}${pad(p.day)}-${pad(p.hour)}${pad(p.minute)}.tar.gz`
const outDir = path.join(ROOT, 'artifacts')
fs.mkdirSync(outDir, { recursive: true })
const out = path.join(outDir, name)

execFileSync('tar', ['-czf', out, '--exclude', '.DS_Store', 'src', 'config', 'deploy', 'package.json'], {
  cwd: ROOT,
  env: { ...process.env, COPYFILE_DISABLE: '1' },
})
const list = execFileSync('tar', ['-tzf', out]).toString().trim().split('\n')
if (!list.includes('src/cli.mjs')) throw new Error('包里没有 src/cli.mjs')
console.log(`打好了：${out}（${list.length} 个文件，${(fs.statSync(out).size / 1024).toFixed(0)} KB）`)
const dir = `/root/${name.replace('.tar.gz', '')}`
console.log(`就在这台服务器上装，用 root 运行：\nbash ${path.join(ROOT, 'deploy', 'install.sh')} ${out}`)
console.log(`装到别的服务器：上传到它的 /root/ 以后，用 root 运行：\nmkdir -p ${dir} && tar -xzf /root/${name} -C ${dir} && bash ${dir}/deploy/install.sh /root/${name}`)
