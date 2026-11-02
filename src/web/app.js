// 本机网页的界面。原生写，不用框架，不加载外部资源。
// 数据都从 GET /api/state 来；改东西走 /api/ 下的接口，规矩在服务端（src/app.mjs），这里只管显示和收集输入。
// 钥匙：终端打印的链接是 /#key=…，# 后面的不会发给服务器。这里先试一下它对不对，对了才存进本端口的 localStorage，
// 再从地址栏去掉，之后每个请求放在 X-Show-Radar 头里带上。localStorage 按端口分开，别的本机服务读不到。
// 先试再存：随便哪个网页都能把人带到 /#key=乱写的，不能让它把存着的好钥匙换掉。

const $ = (id) => document.getElementById(id)

let state = null
// 只在这一页里记着的东西：哪个推送表单开着、填了一半的内容、各通道最近一次测试的结果、正在确认的删除
const ui = { openForm: null, drafts: {}, formError: {}, results: {}, saving: null, confirm: null, checkResult: null, busyBefore: null, pushKey: '' }
let timer = null
const KEY_STORE = 'show-radar-key'
const isKey = (k) => typeof k === 'string' && /^[0-9a-f]{64}$/.test(k)

function storedKey() {
  try {
    const k = localStorage.getItem(KEY_STORE)
    return isKey(k) ? k : null
  } catch {
    return null
  }
}

function storeKey(k) {
  try {
    localStorage.setItem(KEY_STORE, k)
  } catch {
    // 存不进 localStorage（隐私模式、禁用了存储）时，只在这一页里记着
  }
}

// 这一页现在用的钥匙
let key = storedKey()

/** 地址栏里有 #key=… 时：先从地址栏去掉，再试一下，对了才换上、存下。 */
async function adoptLinkKey() {
  const fromLink = new URLSearchParams(location.hash.slice(1)).get('key')
  if (fromLink == null) return
  // 钥匙不留在地址栏里
  history.replaceState(null, '', location.pathname)
  if (!isKey(fromLink) || fromLink === key) return
  const ok = await fetch('/api/state', { headers: { 'X-Show-Radar': fromLink } })
    .then((r) => r.ok)
    .catch(() => false)
  if (!ok) return
  key = fromLink
  storeKey(fromLink)
}

/** 钥匙不对时，看看别的标签页是不是已经存了新的（重新启动以后在别的标签页打开了新链接）。 */
function switchToStoredKey() {
  const k = storedKey()
  if (!k || k === key) return false
  key = k
  return true
}
// “那一轮的说明”最多列这么多条，多的去终端看
const NOTES_SHOWN = 30

// ---------- 请求 ----------

async function api(method, url, body) {
  let res
  try {
    res = await fetch(url, {
      method,
      headers: { 'X-Show-Radar': key ?? '', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new Error('连不上了，终端里的程序可能已经关了。重新启动它，再用新打印的链接打开。')
  }
  let data = null
  try {
    data = await res.json()
  } catch {
    // 不是 JSON，下面按状态码说
  }
  if (res.status === 401) {
    // 别的标签页存了新钥匙：换上，重新来一遍
    if (switchToStoredKey()) {
      unlock()
      return api(method, url, body)
    }
    lock()
  }
  if (!res.ok) throw new Error(data?.error ?? `出错了（${res.status}），刷新一下再试。`)
  return data
}

/** 没有钥匙或钥匙过期了：别的块都藏起来，只说去哪拿新链接。 */
function lock() {
  for (const el of document.querySelectorAll('main > section')) el.hidden = el.id !== 'locked'
  document.querySelector('.top-actions').hidden = true
  $('runline').textContent = ''
  clearTimeout(timer)
}

function unlock() {
  for (const el of document.querySelectorAll('main > section')) el.hidden = el.id === 'locked' || el.id === 'setup'
  document.querySelector('.top-actions').hidden = false
}

async function load() {
  clearTimeout(timer)
  if (!key) return lock()
  try {
    state = await api('GET', '/api/state')
    if (ui.busyBefore?.kind === 'run' && !state.busy) toast('这一轮抓完了。')
    ui.busyBefore = state.busy
    render()
  } catch (err) {
    if (!$('locked').hidden) return
    $('runline').textContent = err.message
  }
  // 在抓的时候勤看，平时半分钟看一次（常驻的那一轮跑完、别的进程改了清单，这里也能跟上）
  timer = setTimeout(load, state?.busy ? 3000 : 30000)
}

// ---------- 小工具 ----------

/** 建元素。文字一律当文字放，不当 HTML 解析。 */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c))
  return el
}

const isWebUrl = (url) => typeof url === 'string' && /^https?:\/\//.test(url)

// 说明书在 GitHub 上（项目首页就是 README），地址只写在页脚的“使用说明”里
const REPO = $('docs').href.split('#')[0]

/** 仓库里某个文档某一节在 GitHub 上的地址。doc 是 README.md、docs/deploy.md 这样的路径。 */
function docUrl(doc, section) {
  const page = doc === 'README.md' ? REPO : `${REPO}/blob/main/${doc}`
  return section ? `${page}#${section}` : page
}

const DOC_REF = /^(README\.md|docs\/[\w.-]+\.md)“([^”]+)”$/

/** 提示文字里的网址，和 README.md“常见问题”这样的说明书出处，做成链接。 */
function linkify(text) {
  return String(text)
    .split(/(https?:\/\/[^\s，。、；）]+|(?:README\.md|docs\/[\w.-]+\.md)“[^”]+”)/)
    .map((part, i) => {
      if (i % 2 === 0) return part
      const doc = DOC_REF.exec(part)
      return h('a', { href: doc ? docUrl(doc[1], doc[2]) : part, target: '_blank', rel: 'noopener noreferrer' }, part)
    })
}

/** PUSH_CHANNELS 里的 help（'README.md#邮件'）做成“怎么配”链接。 */
function helpLink(help) {
  const [doc, section] = help.split('#')
  return h('a', { class: 'help', href: docUrl(doc, section), target: '_blank', rel: 'noopener noreferrer' }, '怎么配')
}

const timeParts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/** 北京时间的“10月30日 09:07”。 */
function stamp(ms) {
  const p = Object.fromEntries(timeParts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return `${p.month}月${p.day}日 ${p.hour}:${p.minute}`
}

function ago(ms) {
  const min = Math.round((Date.now() - ms) / 60000)
  if (min < 1) return '刚才'
  if (min < 60) return `${min} 分钟前`
  const hours = Math.round(min / 60)
  return hours < 48 ? `${hours} 小时前` : `${Math.round(hours / 24)} 天前`
}

// 提示一直在页面里，靠 shown 这个类升上来、落回去，进出走同一条路
let toastTimer = null
function toast(text, kind = 'ok') {
  const el = $('toast')
  el.textContent = text
  el.className = `toast ${kind} shown`
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('shown'), kind === 'error' ? 8000 : 4000)
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/** “下一轮什么时候去找”：常驻开着就说时间，没开就让人自己点。 */
function nextRoundText() {
  if (state.busy?.kind === 'run') return '正在抓的这一轮会去找'
  if (state.daemon && state.nextRoundAt) return `下一轮 ${stamp(state.nextRoundAt)} 去找`
  return '点上面的“现在抓一轮”去找'
}

// ---------- 画页面 ----------

function render() {
  renderTop()
  renderSetup()
  renderShows()
  renderArtists()
  const pushKey = JSON.stringify(state.push)
  // 推送这块有表单，状态没变就不重画，免得打断正在填的人
  if (pushKey !== ui.pushKey) {
    ui.pushKey = pushKey
    renderPush()
  }
  renderRuns()
}

function renderTop() {
  const bits = []
  if (state.busy?.kind === 'run') bits.push('正在抓一轮，抓完自动刷新')
  else if (state.busy?.kind === 'check') bits.push('正在检查各平台')
  else if (state.daemon) bits.push(state.nextRoundAt ? `下一轮抓取 ${stamp(state.nextRoundAt)}` : '按时抓取中')
  else bits.push('只开了网页，不按时抓取')
  const last = state.runs.find((r) => r.finishedAt)
  if (last && state.busy?.kind !== 'run') bits.push(`上一轮 ${ago(last.finishedAt)}`)
  $('runline').textContent = bits.join(' · ')
  $('runline').dataset.state = state.busy ? 'busy' : state.daemon ? 'on' : 'off'
  const runBtn = $('run-btn')
  runBtn.disabled = Boolean(state.busy) || !state.artists.length
  runBtn.textContent = state.busy?.kind === 'run' ? '正在抓…' : '现在抓一轮'
  runBtn.classList.toggle('busy', state.busy?.kind === 'run')
  runBtn.title = state.artists.length ? '' : '先加艺人'
  const checkBtn = $('check-btn')
  checkBtn.disabled = Boolean(state.busy)
  checkBtn.textContent = state.busy?.kind === 'check' ? '正在检查…' : '检查各平台'
  checkBtn.classList.toggle('busy', state.busy?.kind === 'check')
}

function renderSetup() {
  const steps = [
    { done: state.artists.length > 0, text: '加艺人', href: '#artists' },
    { done: state.push.some((c) => c.state === 'ready'), text: '配推送，收到测试消息', href: '#push' },
    { done: state.runs.some((r) => r.finishedAt), text: '点“现在抓一轮”', href: null },
  ]
  $('setup').hidden = steps.every((s) => s.done)
  // 没做的写序号，做完的换成绿色的勾；“已完成”留给读屏
  $('setup-steps').replaceChildren(
    ...steps.map((s, i) =>
      h(
        'li',
        { class: s.done ? 'done' : '' },
        h('span', { class: 'step-mark', 'aria-hidden': 'true' }, s.done ? null : i + 1),
        s.href && !s.done ? h('a', { href: s.href }, s.text) : h('span', null, s.text),
        s.done ? h('span', { class: 'sr-only' }, '已完成') : null,
      ),
    ),
  )
}

function renderShows() {
  const body = $('shows-body')
  const total = state.artists.reduce((n, a) => n + a.shows.length, 0)
  $('shows-count').textContent = total ? `${total} 场` : ''
  if (!state.artists.length) {
    body.replaceChildren(h('p', { class: 'empty' }, '还没有关注的艺人，先在下面加一位。'))
    return
  }
  body.replaceChildren(
    ...state.artists.map((a) => {
      const found = [...new Set([...a.platforms.map((p) => p.label), ...a.shows.flatMap((s) => s.sources)])]
      let content
      if (!a.checked) content = h('p', { class: 'muted' }, `还没抓过，${nextRoundText()}。`)
      else if (!a.shows.length) {
        content = h('p', { class: 'muted' }, found.length ? '现在没有演出，上架了会推给你。' : '各平台都没找到，试试补一个别名。')
      } else content = h('ul', { class: 'shows' }, a.shows.map(showRow))
      return h(
        'article',
        { class: 'artist' },
        h(
          'div',
          { class: 'artist-head' },
          h('h3', null, a.key),
          a.aliases.length ? h('span', { class: 'muted' }, a.aliases.join('、')) : null,
          found.length ? h('span', { class: 'found' }, `找到：${found.join('、')}`) : null,
        ),
        content,
      )
    }),
  )
}

/** 有售票页的整行做成链接，点哪里都能打开；没有的只是一行字。 */
function showRow(s) {
  const link = isWebUrl(s.url)
  return h(
    'li',
    { class: 'show' },
    h(
      link ? 'a' : 'div',
      link ? { class: 'show-link', href: s.url, target: '_blank', rel: 'noopener noreferrer' } : { class: 'show-link' },
      h('div', { class: 'show-when' }, h('span', { class: 'date' }, s.dates || '日期未定'), h('span', { class: 'city' }, s.city || '城市未定')),
      h('div', { class: 'show-what' }, h('span', { class: 'venue' }, s.venue || s.title || ''), s.sources.length ? h('span', { class: 'muted small' }, s.sources.join('、')) : null),
      h('div', { class: 'show-stage' }, h('span', { class: `badge stage-${s.stage}` }, s.stageLabel), s.nextSale ? h('span', { class: 'sale' }, `${s.nextSale} 开售`) : null),
      link ? h('span', { class: 'go' }, '售票页') : h('span', { class: 'go none' }, '暂无售票页'),
    ),
  )
}

function renderArtists() {
  const { maxArtists } = state.limits
  $('artists-count').textContent = `${state.artists.length} / ${maxArtists} 位`
  const chips = state.artists.map((a) => {
    const confirming = ui.confirm === `artist:${a.key}`
    return h(
      'li',
      { class: `chip${confirming ? ' confirming' : ''}` },
      h('span', { class: 'chip-name' }, a.key),
      a.aliases.length ? h('span', { class: 'muted' }, a.aliases.join('、')) : null,
      confirming
        ? [
            h('button', { type: 'button', class: 'danger small', onclick: () => unfollow(a.key) }, '不再关注'),
            h('button', { type: 'button', class: 'ghost small', onclick: () => setConfirm(null) }, '算了'),
          ]
        : h('button', { type: 'button', class: 'icon', title: `不再关注 ${a.key}`, 'aria-label': `不再关注 ${a.key}`, onclick: () => setConfirm(`artist:${a.key}`) }, '×'),
    )
  })
  const over = state.untracked.map((name) => {
    const confirming = ui.confirm === `artist:${name}`
    return h(
      'li',
      { class: `chip over${confirming ? ' confirming' : ''}` },
      h('span', { class: 'chip-name' }, name),
      h('span', { class: 'muted' }, '没在跟踪'),
      confirming
        ? [
            h('button', { type: 'button', class: 'danger small', onclick: () => unfollow(name) }, '从清单里删掉'),
            h('button', { type: 'button', class: 'ghost small', onclick: () => setConfirm(null) }, '算了'),
          ]
        : h('button', { type: 'button', class: 'icon', title: `从清单里删掉 ${name}`, 'aria-label': `从清单里删掉 ${name}`, onclick: () => setConfirm(`artist:${name}`) }, '×'),
    )
  })
  $('artist-list').replaceChildren(...chips, ...over)
  $('artist-warnings').replaceChildren(...state.warnings.map((w) => h('p', { class: 'msg warn' }, w)))
}

function setConfirm(value) {
  ui.confirm = value
  renderArtists()
  renderPush()
}

function renderPush() {
  const cards = state.push.map(pushCard)
  // 邮件和已经配过的放外面，其余的收起来：先给最该用的
  const main = state.push.map((c, i) => (c.id === 'email' || c.state !== 'none' || ui.openForm === c.id ? cards[i] : null)).filter(Boolean)
  const rest = state.push.map((c, i) => (main.includes(cards[i]) ? null : [c, cards[i]])).filter(Boolean)
  const ready = state.push.filter((c) => c.state === 'ready')
  $('push-count').textContent = ready.length ? `在用：${ready.map((c) => c.name).join('、')}` : '还没配'
  $('push-body').replaceChildren(
    ...main,
    rest.length
      ? h('details', { class: 'more' }, h('summary', null, `其他通道（${rest.map(([c]) => c.name).join('、')}）`), ...rest.map(([, card]) => card))
      : null,
  )
}

function pushCard(c) {
  const [badgeText, badgeKind] = { ready: ['已配好', 'ok'], partial: ['没配全', 'warn'], none: ['没配', 'off'] }[c.state]
  const result = ui.results[c.id]
  const confirming = ui.confirm === `push:${c.id}`
  let actions
  if (ui.openForm === c.id) actions = pushForm(c)
  else if (confirming) {
    actions = h(
      'div',
      { class: 'row' },
      h('span', null, `去掉 ${c.name}？填过的内容会删掉。`),
      h('button', { type: 'button', class: 'danger', onclick: () => removePush(c) }, '去掉'),
      h('button', { type: 'button', class: 'ghost', onclick: () => setConfirm(null) }, '算了'),
    )
  } else {
    actions = h(
      'div',
      { class: 'row' },
      c.state === 'ready' ? h('button', { type: 'button', onclick: (e) => testPush(c, e.currentTarget) }, '发一条测试') : null,
      h('button', { type: 'button', class: c.state === 'none' && c.id === 'email' ? '' : 'ghost', onclick: () => openForm(c.id) }, c.state === 'none' ? '配置' : '重新填'),
      c.state !== 'none' ? h('button', { type: 'button', class: 'ghost', onclick: () => setConfirm(`push:${c.id}`) }, '去掉') : null,
    )
  }
  return h(
    'div',
    { class: `push-card ${c.state}`, id: `push-${c.id}` },
    h('div', { class: 'push-head' }, h('h3', null, c.name), c.id === 'email' ? h('span', { class: 'tag' }, '推荐') : null, h('span', { class: `badge ${badgeKind}` }, badgeText)),
    h('p', { class: 'muted' }, c.intro, c.help ? [' · ', helpLink(c.help)] : null),
    c.summary ? h('p', null, c.summary) : null,
    c.problem ? h('p', { class: 'msg error' }, c.problem) : null,
    result ? h('p', { class: `msg ${result.ok ? 'ok' : 'error'}` }, result.text) : null,
    actions,
  )
}

function openForm(id) {
  ui.openForm = id
  ui.formError[id] = null
  renderPush()
  document.querySelector(`#push-${id} input`)?.focus()
}

function pushForm(c) {
  const draft = (ui.drafts[c.id] ??= {})
  const saving = ui.saving === c.id
  return h(
    'form',
    {
      class: 'push-form',
      autocomplete: 'off',
      onsubmit: (e) => {
        e.preventDefault()
        savePush(c)
      },
    },
    c.fields.map((f) => {
      const id = `f-${c.id}-${f.name}`
      return h(
        'div',
        { class: 'field' },
        h('label', { for: id }, f.label, f.optional ? h('span', { class: 'muted' }, '（选填）') : null),
        withValue(
          h('input', {
            id,
            name: f.name,
            type: f.secret ? 'password' : 'text',
            autocomplete: f.secret ? 'new-password' : 'off',
            spellcheck: 'false',
            placeholder: f.example,
            disabled: saving,
            oninput: (e) => (draft[f.name] = e.target.value),
          }),
          draft[f.name] ?? '',
        ),
        f.hint ? h('p', { class: 'hint' }, linkify(f.hint)) : null,
      )
    }),
    ui.formError[c.id] ? h('p', { class: 'msg error' }, ui.formError[c.id]) : null,
    h(
      'div',
      { class: 'row' },
      h('button', { type: 'submit', class: saving ? 'busy' : null, disabled: saving }, saving ? '正在保存并测试…' : '保存并测试'),
      h('button', { type: 'button', class: 'ghost', disabled: saving, onclick: () => closeForm(c.id) }, '取消'),
    ),
  )
}

/** 填了一半的内容用 .value 放回去，不写成 value 属性：授权码不进页面的 HTML。 */
function withValue(input, value) {
  input.value = value
  return input
}

function closeForm(id) {
  ui.openForm = null
  delete ui.drafts[id]
  renderPush()
}

function renderRuns() {
  // 检查各平台的结果
  const cr = ui.checkResult
  $('check-result').replaceChildren(
    ...(cr
      ? [
          h('h3', null, '检查各平台'),
          cr.error
            ? h('p', { class: 'msg error' }, cr.error)
            : h(
                'ul',
                { class: 'checks' },
                cr.results.map((r) => h('li', null, h('span', { class: `badge ${r.ok ? 'ok' : r.ok == null ? 'off' : 'warn'}` }, r.kind), h('strong', null, r.label), h('span', null, r.detail))),
              ),
          ...(cr.notes ?? []).map((n) => h('p', { class: 'hint' }, linkify(n))),
        ]
      : []),
  )

  // 连着取不到的平台
  $('health').replaceChildren(
    ...state.health
      .filter((x) => x.failRuns > 0)
      .map((x) => h('p', { class: 'msg warn' }, `${x.label} 连着 ${x.failRuns} 轮没取到${x.lastError ? `：${x.lastError}` : ''}。${x.lastOkAt ? `上次取到是 ${stamp(x.lastOkAt)}。` : ''}`)),
  )

  // 这次打开以后跑的那一轮：给人看的话放外面，各平台自己的记录收起来
  const lr = state.lastRound
  const notes = (lr?.notes ?? []).map(readableNote)
  const general = notes.filter((n) => !n.source)
  const bySource = notes.filter((n) => n.source)
  $('last-round').replaceChildren(
    ...(lr?.error ? [h('p', { class: 'msg error' }, `${stamp(lr.startedAt)} 那一轮出错了：${lr.error}`)] : []),
    ...(general.length ? [h('h3', null, `${stamp(lr.startedAt)} 那一轮`), ...noteList(general)] : []),
    ...(bySource.length ? [h('details', { class: 'more' }, h('summary', null, `各平台的记录（${bySource.length} 条）`), noteList(bySource))] : []),
  )

  // 最近几轮
  if (!state.runs.length) {
    $('runs-body').replaceChildren(h('p', { class: 'empty' }, '还没抓过。'))
    return
  }
  $('runs-body').replaceChildren(
    h('h3', null, '最近几轮'),
    h(
      'ul',
      { class: 'run-list' },
      state.runs.map((r) =>
        h(
          'li',
          null,
          h('div', { class: 'run-when' }, stamp(r.startedAt), r.finishedAt ? h('span', { class: 'muted small' }, duration(r.finishedAt - r.startedAt)) : h('span', { class: 'muted small' }, '没跑完')),
          r.stats
            ? h(
                'div',
                { class: 'run-what' },
                Object.entries(r.stats.sources).map(([name, s]) => sourceLine(name, s)),
                h('span', { class: 'pushed' }, r.stats.pushed ? `推了 ${r.stats.pushed} 条` : '没有要推的'),
              )
            : null,
        ),
      ),
    ),
  )
}

/** “[damai] 大麦详情……”这样平台自己记的话，前缀换成平台名，单独收起来。 */
function readableNote(text) {
  const m = /^\[(\w+)\] /.exec(text)
  return m ? { source: m[1], text: `${state.sourceLabels[m[1]] ?? m[1]}：${text.slice(m[0].length)}` } : { source: null, text }
}

function noteList(notes) {
  return [
    h('ul', { class: 'notes' }, notes.slice(0, NOTES_SHOWN).map((n) => h('li', null, linkify(n.text)))),
    notes.length > NOTES_SHOWN ? h('p', { class: 'hint' }, `还有 ${notes.length - NOTES_SHOWN} 条，见终端。`) : null,
  ].filter(Boolean)
}

function duration(ms) {
  const min = Math.round(ms / 60000)
  return min < 1 ? '不到 1 分钟' : `用了 ${min} 分钟`
}

function sourceLine(name, s) {
  const label = state.sourceLabels[name] ?? name
  if (s === '跳过') return h('span', { class: 'src muted' }, `${label} 今天取过了`)
  if (!s.ok) return h('span', { class: 'src bad' }, `${label} 没取到：${s.error ?? '出错'}`)
  const extra = [s.recent?.length ? `${s.recent.length} 位 1 小时内刚取过` : null, s.unfinished?.length ? `${s.unfinished.length} 位留到下一轮` : null].filter(Boolean)
  return h('span', { class: 'src' }, `${label} ${s.artists} 位艺人、${s.listings} 条记录${extra.length ? `（${extra.join('，')}）` : ''}`)
}

// ---------- 操作 ----------

async function follow(e) {
  e.preventDefault()
  const input = $('follow-input')
  const msg = $('follow-msg')
  const button = e.submitter ?? e.target.querySelector('button')
  button.disabled = true
  try {
    const a = await api('POST', '/api/artists', { line: input.value })
    let text
    if (a.added) text = `关注了 ${a.key}，${nextRoundText()}。`
    else if (a.newAliases.length) text = `给 ${a.key} 补了别名：${a.newAliases.join('、')}。`
    else text = `${a.key} 已经在关注了。`
    showMsg(msg, [text, ...a.notes].join(''), 'ok')
    input.value = ''
    await load()
  } catch (err) {
    showMsg(msg, err.message, 'error')
  } finally {
    button.disabled = false
    input.focus()
  }
}

function showMsg(el, text, kind) {
  el.textContent = text
  el.className = `msg ${kind}`
  el.hidden = false
}

async function unfollow(key) {
  ui.confirm = null
  $('follow-msg').hidden = true
  try {
    const { removed } = await api('DELETE', `/api/artists/${encodeURIComponent(key)}`)
    toast(`不再关注 ${removed}。`)
  } catch (err) {
    toast(err.message, 'error')
  }
  await load()
}

async function savePush(c) {
  ui.saving = c.id
  ui.formError[c.id] = null
  renderPush()
  try {
    const r = await api('POST', `/api/push/${c.id}`, ui.drafts[c.id] ?? {})
    if (r.fromEnv?.length) {
      // 环境变量盖过了刚存的值：测试消息用的不是刚填的
      ui.formError[c.id] = `存好了，但环境变量 ${r.fromEnv.join('、')} 会盖过刚存的值。要用刚填的，先去掉这个环境变量。`
      ui.results[c.id] = null
    } else if (r.ok) {
      ui.results[c.id] = { ok: true, text: `存好了，测试消息已发出。${r.message}` }
      ui.openForm = null
      delete ui.drafts[c.id]
    } else {
      // 存好了但测试没发出去：表单留着，改了再试
      ui.formError[c.id] = `存好了，但测试消息没发出去：${r.message}`
      ui.results[c.id] = null
    }
  } catch (err) {
    ui.formError[c.id] = err.message
  } finally {
    ui.saving = null
  }
  ui.pushKey = ''
  await load()
}

async function testPush(c, button) {
  button.disabled = true
  button.classList.add('busy')
  button.textContent = '正在发…'
  try {
    const r = await api('POST', `/api/push/${c.id}/test`)
    ui.results[c.id] = { ok: r.ok, text: r.ok ? `已发出。${r.message}` : `没发出去：${r.message}` }
  } catch (err) {
    ui.results[c.id] = { ok: false, text: err.message }
  }
  renderPush()
}

async function removePush(c) {
  ui.confirm = null
  try {
    const { removed, left, fromEnv } = await api('DELETE', `/api/push/${c.id}`)
    ui.results[c.id] = null
    if (fromEnv.length) toast(`去掉了 ${removed}，但环境变量 ${fromEnv.join('、')} 里还设着，它照样在用。`, 'error')
    else toast(left.length ? `去掉了 ${removed}。` : `去掉了 ${removed}。现在没有推送通道，消息先存着，配好以后一起发。`)
  } catch (err) {
    toast(err.message, 'error')
  }
  ui.pushKey = ''
  await load()
}

async function run() {
  // 点下去马上换成“正在抓”，不等服务端回话
  const button = $('run-btn')
  button.disabled = true
  button.classList.add('busy')
  button.textContent = '正在抓…'
  try {
    await api('POST', '/api/run')
    toast('开始抓了，抓完自动刷新。')
  } catch (err) {
    toast(err.message, 'error')
  }
  await load()
}

async function check() {
  const button = $('check-btn')
  button.disabled = true
  button.classList.add('busy')
  button.textContent = '正在检查…'
  try {
    ui.checkResult = await api('POST', '/api/check')
  } catch (err) {
    ui.checkResult = { error: err.message }
  }
  await load()
  $('runs').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' })
}

// ---------- 开始 ----------

$('follow-form').addEventListener('submit', follow)
$('run-btn').addEventListener('click', run)
$('check-btn').addEventListener('click', check)
// 大标题滚到顶栏下面以后，顶栏换成半透明的材质，小标题浮进顶栏
new IntersectionObserver(([e]) => document.body.classList.toggle('scrolled', !e.isIntersecting), {
  rootMargin: `-${document.querySelector('.bar').offsetHeight}px 0px 0px 0px`,
}).observe(document.querySelector('.hero h1'))
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) load()
})
// 已经开着这一页时再点终端里的链接，浏览器只改 # 后面的部分、不重新加载：在这里接住新钥匙
window.addEventListener('hashchange', async () => {
  if (!new URLSearchParams(location.hash.slice(1)).has('key')) return
  await adoptLinkKey()
  unlock()
  load()
})
// 别的标签页打开了新链接、存了新钥匙：这一页也换上
window.addEventListener('storage', (e) => {
  if (e.key !== KEY_STORE || !isKey(e.newValue) || e.newValue === key) return
  key = e.newValue
  unlock()
  load()
})
adoptLinkKey().then(load)
