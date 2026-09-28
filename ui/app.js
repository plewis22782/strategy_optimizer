// Strategy Optimizer UI. Everything about a strategy (its inputs, roles,
// defaults, search ranges, rules) comes from /api/strategies -- i.e. from
// Strike Canopy's Paper Lab registry -- so a newly registered strategy shows
// up here with no UI change.
'use strict'
const $ = (id) => document.getElementById(id)
const TUNABLE = ['logic', 'risk', 'sizing']
const ROLE_COLOR = { logic: 'var(--logic)', risk: 'var(--risk)', sizing: 'var(--sizing)', cost: 'var(--cost)' }
const ROLE_GROUP = { logic: 'Logic', risk: 'Risk', sizing: 'Sizing', cost: 'Costs (fixed; stress test in extras)', identity: 'Never tuned', schedule: 'Never tuned', ops: 'Never tuned' }
const GROUP_ORDER = ['Logic', 'Risk', 'Sizing', 'Costs (fixed; stress test in extras)', 'Never tuned']
const SEC_PER_PASS_DAY = 4

let meta = { maxThreads: 30 }
let strategies = []
let cur = null // selected strategy
let st = {} // input name -> setting state
let sessions = { usable: [], skipped: [] }
let selRun = null
let runTimer = null
let passCache = { back: [], forward: [] }
let sortCol = 'crit'
let sortDir = -1

const api = async (path, opts) => {
  const r = await fetch(path, opts)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || `${r.status}`)
  return j
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const money = (n) => (n == null || !isFinite(n) ? '—' : `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString()}`)
const fmt = (n, d = 2) => (n == null || !isFinite(n) ? '—' : Number(n).toFixed(d))
const tMin = (t) => +t.slice(0, 2) * 60 + +t.slice(3, 5)
const fmtN = (n) => (n >= 1e12 ? (n / 1e12).toFixed(1) + ' trillion' : n >= 1e9 ? (n / 1e9).toFixed(1) + ' billion' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' million' : Math.round(n).toLocaleString())
const dur = (s) => (s < 90 ? Math.round(s) + ' s' : s < 5400 ? Math.round(s / 60) + ' min' : s < 172800 ? (s / 3600).toFixed(1) + ' h' : Math.round(s / 86400) + ' days')
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim()

// ---------- setup ----------
async function init() {
  $('to').value = new Date().toISOString().slice(0, 10)
  try {
    meta = await api('/api/meta')
    strategies = await api('/api/strategies')
  } catch (e) {
    $('metaLine').textContent = `Could not reach the optimizer API: ${e.message}`
    return
  }
  $('metaLine').textContent = `Strategies from Strike Canopy's Paper Lab registry @ ${meta.strikeCanopyRef} · up to ${meta.maxThreads} threads on Redfish`
  $('threads').max = meta.maxThreads
  $('threads').value = meta.maxThreads
  $('strategy').innerHTML = strategies.map((s) => `<option value="${esc(s.key)}">${esc(s.label)} — ${esc(s.key)}</option>`).join('')
  selectStrategy(strategies[0]?.key)
  loadRuns()
}

function selectStrategy(key) {
  cur = strategies.find((s) => s.key === key)
  if (!cur) return
  st = {}
  for (const [name, p] of Object.entries(cur.params)) st[name] = freshState(name, p)
  $('rules').innerHTML = cur.constraints.length
    ? cur.constraints.map((c) => `${esc(c.a)} ${c.op === '<=' ? '≤' : '&lt;'} ${esc(c.b)}${c.unlessOff ? ' <span class="sub">(when both on)</span>' : ''}`).join('<br>')
    : '<span class="sub">none declared</span>'
  renderInputs()
  loadSessions()
}

function freshState(name, p) {
  const d = cur.defaults[name]
  const s = { optimize: false, value: d }
  if (p.kind === 'number' && p.search) Object.assign(s, { start: p.search.min, step: p.search.step, stop: p.search.max, withOff: p.off != null })
  if (p.kind === 'time' && p.search) Object.assign(s, { from: p.search.from, to: p.search.to, stepMin: p.search.stepMin })
  return s
}

function tunable(p) {
  if (!TUNABLE.includes(p.role)) return false
  if (p.kind === 'number') return !!p.search
  if (p.kind === 'time') return !!p.search
  if (p.kind === 'boolean' || p.kind === 'choice') return p.search !== false
  return false
}

function nValues(name) {
  const p = cur.params[name]
  const s = st[name]
  if (!s.optimize) return 1
  if (p.kind === 'boolean') return 2
  if (p.kind === 'choice') return p.options.length
  if (p.kind === 'time') {
    const n = Math.floor((tMin(s.to) - tMin(s.from)) / s.stepMin) + 1
    return s.stepMin > 0 && n > 0 ? n : 0
  }
  if (!(s.step > 0) || s.stop < s.start) return 0
  const n = Math.floor((s.stop - s.start) / s.step + 1e-9) + 1
  return n + (s.withOff && p.off != null && !(p.off >= s.start && p.off <= s.stop) ? 1 : 0)
}

function fixedEditor(name, p, s) {
  const dis = s.optimize ? 'disabled' : ''
  if (p.kind === 'boolean') return `<label class="chk"><input type="checkbox" data-fv="${name}" ${s.value ? 'checked' : ''} ${dis}> ${s.value ? 'on' : 'off'}</label>`
  if (p.kind === 'choice') return `<select data-fv="${name}" ${dis}>${p.options.map((o) => `<option ${o === s.value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
  if (p.kind === 'time') return `<input type="time" data-fv="${name}" value="${esc(s.value)}" ${dis}>`
  if (p.kind === 'number') {
    const ro = ['identity', 'schedule', 'ops'].includes(p.role) ? 'disabled' : dis
    const offNote = p.off != null && s.value === p.off && !s.optimize ? ' <span class="sub">off</span>' : ''
    return `<input type="number" step="any" data-fv="${name}" value="${s.value}" ${ro}>${offNote}`
  }
  return `<span class="mono">${esc(Array.isArray(s.value) ? s.value.join(', ') : s.value)}</span>`
}

function rangeEditors(name, p, s) {
  if (!s.optimize) return ['', '', '']
  if (p.kind === 'boolean') return ['<span class="sub">tests on + off</span>', '', '']
  if (p.kind === 'choice') return [`<span class="sub">tests ${p.options.map(esc).join(' / ')}</span>`, '', '']
  if (p.kind === 'time')
    return [
      `<input type="time" data-from="${name}" value="${s.from}">`,
      `<input type="number" data-stepmin="${name}" value="${s.stepMin}" min="1"> <span class="sub">min</span>`,
      `<input type="time" data-to="${name}" value="${s.to}">`
    ]
  const off = p.off != null ? ` <label class="chk" title="also test with this rule off (${p.off})"><input type="checkbox" data-off="${name}" ${s.withOff ? 'checked' : ''}> +off</label>` : ''
  return [
    `<input type="number" step="any" data-start="${name}" value="${s.start}">`,
    `<input type="number" step="any" data-step="${name}" value="${s.step}">`,
    `<input type="number" step="any" data-stop="${name}" value="${s.stop}">${off}`
  ]
}

function renderInputs() {
  const groups = {}
  for (const [name, p] of Object.entries(cur.params)) (groups[ROLE_GROUP[p.role]] ??= []).push([name, p])
  let h = ''
  for (const g of GROUP_ORDER) {
    if (!groups[g]) continue
    h += `<tr class="group"><td colspan="8">${g}</td></tr>`
    for (const [name, p] of groups[g]) {
      const s = st[name]
      const can = tunable(p)
      const [a, b, c] = rangeEditors(name, p, s)
      const n = nValues(name)
      const cls = !can ? 'never' : s.optimize ? '' : 'idle'
      const unit = p.unit && p.unit !== 'none' ? ` <span class="sub">${esc(p.unit)}</span>` : ''
      h += `<tr class="${cls}">
        <td class="c-opt">${can ? `<input type="checkbox" aria-label="optimize ${name}" data-opt="${name}" ${s.optimize ? 'checked' : ''}>` : '<span class="sub">—</span>'}</td>
        <td class="c-name"><span class="role" style="background:${ROLE_COLOR[p.role] || 'var(--never)'}"></span><span class="pname">${name}</span>${unit}</td>
        <td class="doc">${esc(p.doc || '')}</td>
        <td class="in">${fixedEditor(name, p, s)}</td><td class="in">${a}</td><td class="in">${b}</td><td class="in">${c}</td>
        <td class="cnt ${s.optimize && n === 0 ? 'bad' : ''}">${s.optimize ? n : '·'}</td></tr>`
    }
  }
  $('inputs').innerHTML = h
  summary()
}

function buildSpec() {
  const inputs = {}
  for (const [name, p] of Object.entries(cur.params)) {
    const s = st[name]
    if (s.optimize) {
      if (p.kind === 'boolean') inputs[name] = { optimize: true, values: [true, false] }
      else if (p.kind === 'choice') inputs[name] = { optimize: true, values: [...p.options] }
      else if (p.kind === 'time') inputs[name] = { optimize: true, from: s.from, to: s.to, stepMin: +s.stepMin }
      else inputs[name] = { optimize: true, start: +s.start, step: +s.step, stop: +s.stop, withOff: !!(s.withOff && p.off != null) }
    } else if (['number', 'boolean', 'choice', 'time'].includes(p.kind) && JSON.stringify(s.value) !== JSON.stringify(cur.defaults[name])) {
      inputs[name] = { optimize: false, value: p.kind === 'number' ? +s.value : s.value }
    }
  }
  const fwd = $('forward').value
  return {
    strategy: cur.key,
    from: $('from').value,
    to: $('to').value,
    forward: +fwd,
    search: $('search').value,
    criterion: $('criterion').value,
    inputs,
    costStress: $('costStress').checked,
    threads: Math.min(meta.maxThreads, Math.max(1, +$('threads').value || 1)),
    genetic: { population: +$('population').value, maxGenerations: +$('maxGen').value, stallGenerations: +$('stall').value, seed: +$('seed').value },
    note: $('note').value || undefined
  }
}

function summary() {
  if (!cur) return
  let combos = 1
  let nOpt = 0
  const warns = []
  for (const name of Object.keys(cur.params)) {
    if (!st[name].optimize) continue
    nOpt++
    const n = nValues(name)
    if (n === 0) warns.push(`${name}: start / step / stop give no values`)
    combos *= Math.max(1, n)
  }
  const inRange = sessions.usable.filter((d) => d >= $('from').value && d <= $('to').value)
  const f = +$('forward').value
  const nF = f ? Math.max(1, Math.round(inRange.length / f)) : 0
  const nB = inRange.length - nF
  const grid = $('search').value === 'grid' || combos <= (+$('population').value || 64) * 2
  const passes = grid ? combos : Math.min(combos, (+$('population').value || 64) * (+$('maxGen').value || 40))
  if ($('search').value === 'grid' && combos > 20000) warns.push(`A complete grid of ${fmtN(combos)} passes is too big (max 20,000) — use Genetic`)
  if (!nB) warns.push('No usable sessions in this date range')
  const threads = Math.min(meta.maxThreads, Math.max(1, +$('threads').value || 1))
  const fwdPasses = f ? Math.ceil(passes * (grid ? 0.1 : 0.25)) : 0
  const stress = $('costStress').checked ? 2 : 1
  const secs = ((passes * nB + fwdPasses * nF) * SEC_PER_PASS_DAY * stress) / threads
  $('nOpt').textContent = nOpt
  $('combos').textContent = fmtN(combos)
  $('sessSplit').textContent = `${nB} / ${nF}`
  $('passes').textContent = grid ? fmtN(passes) : `up to ${fmtN(passes)}`
  $('eta').textContent = `≤ ${dur(secs)} on ${threads} threads`
  $('warns').innerHTML = warns.map((w) => `<li>${esc(w)}</li>`).join('')
  $('start').disabled = warns.length > 0
}

async function loadSessions() {
  if (!cur) return
  try {
    sessions = await api(`/api/sessions?strategy=${encodeURIComponent(cur.key)}&from=2026-08-01&to=${$('to').value}`)
  } catch {
    sessions = { usable: [], skipped: [] }
  }
  const u = sessions.usable
  $('sessLine').textContent = u.length ? `${u.length} usable sessions (${u[0]} → ${u[u.length - 1]}), ${sessions.skipped.length} skipped` : 'No usable sessions yet'
  $('sessLine').title = sessions.skipped.map((s) => `${s.date}: ${s.why}`).join('\n')
  summary()
}

document.addEventListener('input', (e) => {
  const t = e.target
  const d = t.dataset
  if (d.opt) {
    st[d.opt].optimize = t.checked
    renderInputs()
    return
  }
  if (d.fv) {
    const p = cur.params[d.fv]
    st[d.fv].value = p.kind === 'boolean' ? t.checked : p.kind === 'number' ? +t.value : t.value
    if (p.kind === 'boolean') renderInputs()
    else summary()
    return
  }
  if (d.start) st[d.start].start = +t.value
  if (d.step) st[d.step].step = +t.value
  if (d.stop) st[d.stop].stop = +t.value
  if (d.off) st[d.off].withOff = t.checked
  if (d.from) st[d.from].from = t.value
  if (d.to) st[d.to].to = t.value
  if (d.stepmin) st[d.stepmin].stepMin = +t.value
  if (d.start || d.step || d.stop || d.off || d.from || d.to || d.stepmin) {
    const row = t.closest('tr')
    const name = d.start || d.step || d.stop || d.off || d.from || d.to || d.stepmin
    const n = nValues(name)
    const cell = row && row.querySelector('.cnt')
    if (cell) {
      cell.textContent = n
      cell.classList.toggle('bad', n === 0)
    }
    summary()
  }
})
$('strategy').addEventListener('change', (e) => selectStrategy(e.target.value))
;['from', 'forward', 'search', 'threads', 'population', 'maxGen', 'costStress'].forEach((id) => $(id).addEventListener('change', summary))
$('to').addEventListener('change', loadSessions)
$('scopes').addEventListener('click', (e) => {
  const sc = e.target.dataset?.scope
  if (!sc || !cur) return
  for (const [name, p] of Object.entries(cur.params)) {
    if (sc === 'reset') {
      st[name] = freshState(name, p)
      continue
    }
    if (!tunable(p)) continue
    st[name].optimize =
      sc === 'all' ? true : sc === 'logic' ? p.role === 'logic' : sc === 'risk' ? p.role === 'risk' || p.role === 'sizing' : sc === 'times' ? p.kind === 'time' : sc === 'switches' ? p.kind === 'boolean' || p.kind === 'choice' : false
  }
  renderInputs()
})

$('start').addEventListener('click', async () => {
  $('start').disabled = true
  $('startMsg').textContent = 'Submitting…'
  try {
    const r = await api('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(buildSpec()) })
    $('startMsg').innerHTML = `<span class="good">Queued run #${r.id} (${fmtN(r.combinations)} combinations)</span>`
    await loadRuns()
    openRun(r.id)
  } catch (e) {
    $('startMsg').innerHTML = `<span class="bad">${esc(e.message)}</span>`
  } finally {
    summary()
  }
})

// ---------- runs + results ----------
async function loadRuns() {
  let rows = []
  try {
    rows = await api('/api/runs')
  } catch {
    return
  }
  $('runs').innerHTML = rows.length
    ? rows
        .map(
          (r) => `<tr data-run="${r.id}" class="${selRun === r.id ? 'sel' : ''}"><td class="mono">${r.id}</td><td>${esc(r.strategy)}</td><td>${esc(r.search)}</td><td>${esc(r.criterion)}</td>
      <td><span class="pill ${r.status === 'running' ? 'running' : r.status === 'error' ? 'error' : ''}" title="${esc(r.error || '')}">${esc(r.status)}</span></td>
      <td class="r mono">${r.passes}</td><td class="mono">${r.started_at ? new Date(r.started_at).toLocaleString() : '—'}</td><td class="sub">${esc(r.note || '')}</td></tr>`
        )
        .join('')
    : '<tr><td colspan="8" class="empty">No runs yet — set up a test above and start it.</td></tr>'
}
$('runs').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-run]')
  if (tr) openRun(+tr.dataset.run)
})
$('refreshRuns').addEventListener('click', loadRuns)

async function openRun(id) {
  selRun = id
  $('results').hidden = false
  $('passPanel').hidden = true
  clearTimeout(runTimer)
  await refreshRun()
  loadRuns()
}

async function refreshRun() {
  if (selRun == null) return
  const run = await api(`/api/runs/${selRun}`)
  const [back, forward] = await Promise.all([api(`/api/runs/${selRun}/passes?phase=back`), api(`/api/runs/${selRun}/passes?phase=forward`)])
  passCache = { back, forward, run }
  const p = run.progress || {}
  const spec = run.spec
  $('resTitle').textContent = `Run #${run.id} — ${spec.strategy} · ${spec.search} · ${spec.criterion}`
  const tot = p.total || 0
  const pct = tot ? Math.min(100, (100 * (p.evaluated || 0)) / tot) : run.status === 'done' ? 100 : 0
  $('progBar').style.width = `${run.status === 'done' ? 100 : pct}%`
  const reuse = p.reused != null ? ` · ${p.reused} session results reused, ${p.computed} computed` : ''
  $('resProg').textContent =
    `${run.status}${p.phase ? ` · ${p.phase}` : ''}${p.generation != null ? ` · generation ${p.generation + 1}` : ''} · ${p.evaluated ?? 0} passes` +
    (p.best ? ` · best ${fmt(p.best.crit)}` : '') + reuse + (run.error ? ` · ${run.error}` : '')
  const sess = run.sessions
  $('resSess').textContent = sess ? `Back: ${sess.back.length} sessions (${sess.back[0] ?? ''} → ${sess.back[sess.back.length - 1] ?? ''}) · Forward: ${sess.forward.length}${sess.skipped.length ? ` · skipped ${sess.skipped.length}` : ''}` : ''
  $('cancel').hidden = !['running', 'queued'].includes(run.status)
  renderPasses()
  renderActiveTab()
  if (['running', 'queued'].includes(run.status)) runTimer = setTimeout(refreshRun, 3000)
  else loadRuns()
}
$('cancel').addEventListener('click', async () => {
  if (selRun == null) return
  await api(`/api/runs/${selRun}/cancel`, { method: 'POST' })
  refreshRun()
})

function dims() {
  return passCache.run?.space?.dims ?? []
}

function renderPasses() {
  const ds = dims()
  const fwdBy = new Map(passCache.forward.map((f) => [Number(f.back_pass_id), f]))
  const stressOn = passCache.back.some((b) => b.stress)
  const cols = [
    ['#', 'id'],
    ['Gen', 'gen'],
    ...ds.map((d) => [d.name, `v:${d.name}`]),
    ['Criterion', 'crit'],
    ['P&L', 'pnl'],
    ['Traded days', 'traded'],
    ['Trades', 'trades'],
    ['Completion', 'comp'],
    ['Max DD', 'dd'],
    ['Profit factor', 'pf'],
    ['Sharpe', 'sharpe'],
    ...(stressOn ? [['P&L at 2× costs', 'stress']] : []),
    ...(passCache.forward.length ? [['Forward P&L', 'fwd']] : [])
  ]
  const val = (b, k) => {
    const m = b.metrics || {}
    if (k === 'id') return +b.id
    if (k === 'gen') return b.generation ?? -1
    if (k.startsWith('v:')) return b.varied?.[k.slice(2)]
    return {
      crit: b.criterion,
      pnl: m.totalPnl,
      traded: m.tradedDays,
      trades: m.flies,
      comp: m.completionRate,
      dd: m.maxDrawdown,
      pf: m.profitFactor,
      sharpe: m.sharpe,
      stress: b.stress?.totalPnl,
      fwd: fwdBy.get(Number(b.id))?.metrics?.totalPnl
    }[k]
  }
  $('passHead').innerHTML = `<tr>${cols
    .map(([h, k]) => `<th class="sort ${['id', 'gen'].includes(k) || k.startsWith('v:') ? '' : 'r'}" data-sort="${esc(k)}">${esc(h)}${sortCol === k ? (sortDir < 0 ? ' ▾' : ' ▴') : ''}</th>`)
    .join('')}</tr>`
  const rows = passCache.back.filter((b) => b.metrics || b.error)
  rows.sort((a, b) => {
    const x = val(a, sortCol)
    const y = val(b, sortCol)
    const nx = x == null || (typeof x === 'number' && !isFinite(x))
    const ny = y == null || (typeof y === 'number' && !isFinite(y))
    if (nx && ny) return 0
    if (nx) return 1
    if (ny) return -1
    return (x > y ? 1 : x < y ? -1 : 0) * sortDir
  })
  const shown = rows.slice(0, 500)
  $('passRows').innerHTML = shown.length
    ? shown
        .map((b) => {
          if (b.error) return `<tr data-pass="${b.id}"><td>${b.id}</td><td colspan="${cols.length - 1}" class="bad">${esc(b.error)}</td></tr>`
          const cells = cols.map(([, k]) => {
            const v = val(b, k)
            if (k === 'id') return `<td>${v}</td>`
            if (k === 'gen') return `<td>${v < 0 ? '—' : v + 1}</td>`
            if (k.startsWith('v:')) return `<td>${esc(typeof v === 'boolean' ? (v ? 'on' : 'off') : v)}</td>`
            if (['pnl', 'dd', 'stress', 'fwd'].includes(k)) return `<td class="r ${k !== 'dd' && v < 0 ? 'bad' : ''}">${money(v)}</td>`
            if (k === 'comp') return `<td class="r">${v == null ? '—' : Math.round(v * 100) + '%'}</td>`
            if (['traded', 'trades'].includes(k)) return `<td class="r">${v ?? '—'}</td>`
            return `<td class="r">${fmt(v)}</td>`
          })
          return `<tr data-pass="${b.id}">${cells.join('')}</tr>`
        })
        .join('')
    : `<tr><td colspan="${cols.length}" class="empty">No finished passes yet.</td></tr>`
}
$('passHead').addEventListener('click', (e) => {
  const k = e.target.closest('th')?.dataset.sort
  if (!k) return
  if (sortCol === k) sortDir = -sortDir
  else {
    sortCol = k
    sortDir = -1
  }
  renderPasses()
})

// ---------- charts ----------
let activeTab = 'table'
document.querySelectorAll('[role=tab]').forEach((tb) =>
  tb.addEventListener('click', () => {
    document.querySelectorAll('[role=tab]').forEach((o) => o.setAttribute('aria-selected', String(o === tb)))
    activeTab = tb.dataset.t
    for (const k of ['table', 'heat', 'line', 'prog', 'fwd']) $(`tab-${k}`).hidden = k !== activeTab
    renderActiveTab()
  })
)
function fillAxis(sel, pref) {
  const ds = dims()
  const prev = sel.value
  sel.innerHTML = ds.map((d, i) => `<option value="${i}">${esc(d.name)}</option>`).join('')
  sel.value = prev !== '' && +prev < ds.length ? prev : String(Math.min(pref, Math.max(0, ds.length - 1)))
}
function renderActiveTab() {
  if (activeTab === 'heat') {
    fillAxis($('hx'), 0)
    fillAxis($('hy'), 1)
    drawHeat()
  }
  if (activeTab === 'line') {
    fillAxis($('lx'), 0)
    drawLine()
  }
  if (activeTab === 'prog') drawProg()
  if (activeTab === 'fwd') renderFwd()
}
;['hx', 'hy'].forEach((id) => $(id).addEventListener('change', drawHeat))
$('lx').addEventListener('change', drawLine)

const finite = (b) => b.criterion != null && isFinite(b.criterion)
const label = (v) => (typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v))
function colorFor(t) {
  // red (worst) -> amber -> green (best)
  const h = 8 + t * 142
  return `hsl(${h}, 58%, ${38 + t * 12}%)`
}

function blank(c, msg) {
  const x = c.getContext('2d')
  x.clearRect(0, 0, c.width, c.height)
  x.fillStyle = css('--faint')
  x.font = '14px IBM Plex Sans, sans-serif'
  x.fillText(msg, 20, 30)
}

function drawHeat() {
  const c = $('heat')
  const ds = dims()
  if (ds.length < 2) return blank(c, 'Needs at least two optimized inputs.')
  const xi = +$('hx').value
  const yi = +$('hy').value
  if (xi === yi) return blank(c, 'Pick two different inputs.')
  const X = ds[xi]
  const Y = ds[yi]
  const cell = new Map()
  for (const b of passCache.back.filter(finite)) {
    const k = `${label(b.varied[X.name])}|${label(b.varied[Y.name])}`
    cell.set(k, Math.max(cell.get(k) ?? -Infinity, b.criterion))
  }
  const vals = [...cell.values()]
  const lo = Math.min(...vals)
  const hi = Math.max(...vals)
  const x = c.getContext('2d')
  const W = c.width
  const H = c.height
  const L = 90
  const B = 46
  const T = 8
  const R = 12
  x.clearRect(0, 0, W, H)
  const cw = (W - L - R) / X.values.length
  const ch = (H - T - B) / Y.values.length
  X.values.forEach((xv, i) =>
    Y.values.forEach((yv, j) => {
      const v = cell.get(`${label(xv)}|${label(yv)}`)
      x.fillStyle = v == null ? css('--line2') : colorFor(hi > lo ? (v - lo) / (hi - lo) : 1)
      x.fillRect(L + i * cw + 1, T + (Y.values.length - 1 - j) * ch + 1, Math.max(1, cw - 2), Math.max(1, ch - 2))
    })
  )
  x.fillStyle = css('--mute')
  x.font = '11px IBM Plex Mono, monospace'
  x.textAlign = 'center'
  const every = Math.ceil(X.values.length / 16)
  X.values.forEach((v, i) => i % every === 0 && x.fillText(label(v), L + i * cw + cw / 2, H - B + 15))
  x.fillText(X.name, L + (W - L - R) / 2, H - 8)
  x.textAlign = 'right'
  const everyY = Math.ceil(Y.values.length / 14)
  Y.values.forEach((v, j) => j % everyY === 0 && x.fillText(label(v), L - 8, T + (Y.values.length - 1 - j) * ch + ch / 2 + 4))
  x.save()
  x.translate(14, T + (H - T - B) / 2)
  x.rotate(-Math.PI / 2)
  x.textAlign = 'center'
  x.fillText(Y.name, 0, 0)
  x.restore()
}

function drawLine() {
  const c = $('line')
  const ds = dims()
  if (!ds.length) return blank(c, 'No optimized inputs in this run.')
  const D = ds[+$('lx').value]
  const pts = passCache.back.filter(finite).map((b) => ({ i: D.values.findIndex((v) => label(v) === label(b.varied[D.name])), y: b.criterion }))
  if (!pts.length) return blank(c, 'No finished passes yet.')
  const lo = Math.min(...pts.map((p) => p.y))
  const hi = Math.max(...pts.map((p) => p.y))
  const x = c.getContext('2d')
  const W = c.width
  const H = c.height
  const L = 70
  const B = 40
  const T = 10
  const R = 12
  x.clearRect(0, 0, W, H)
  const px = (i) => L + ((i + 0.5) / D.values.length) * (W - L - R)
  const py = (y) => T + (1 - (hi > lo ? (y - lo) / (hi - lo) : 0.5)) * (H - T - B)
  x.strokeStyle = css('--line')
  x.beginPath()
  x.moveTo(L, T)
  x.lineTo(L, H - B)
  x.lineTo(W - R, H - B)
  x.stroke()
  x.fillStyle = css('--accent')
  x.globalAlpha = 0.35
  for (const p of pts) x.fillRect(px(p.i) - 2, py(p.y) - 2, 4, 4)
  x.globalAlpha = 1
  const best = D.values.map((_, i) => Math.max(-Infinity, ...pts.filter((p) => p.i === i).map((p) => p.y)))
  x.strokeStyle = css('--accent')
  x.lineWidth = 2
  x.beginPath()
  let started = false
  best.forEach((y, i) => {
    if (!isFinite(y)) return
    started ? x.lineTo(px(i), py(y)) : x.moveTo(px(i), py(y))
    started = true
  })
  x.stroke()
  x.lineWidth = 1
  x.fillStyle = css('--mute')
  x.font = '11px IBM Plex Mono, monospace'
  x.textAlign = 'center'
  const every = Math.ceil(D.values.length / 16)
  D.values.forEach((v, i) => i % every === 0 && x.fillText(label(v), px(i), H - B + 15))
  x.fillText(D.name, L + (W - L - R) / 2, H - 6)
  x.textAlign = 'right'
  x.fillText(fmt(hi), L - 6, T + 10)
  x.fillText(fmt(lo), L - 6, H - B)
}

function drawProg() {
  const c = $('prog')
  const pts = passCache.back.filter(finite).sort((a, b) => a.id - b.id)
  if (!pts.length) return blank(c, 'No finished passes yet.')
  const lo = Math.min(...pts.map((p) => p.criterion))
  const hi = Math.max(...pts.map((p) => p.criterion))
  const maxGen = Math.max(0, ...pts.map((p) => p.generation ?? 0))
  const x = c.getContext('2d')
  const W = c.width
  const H = c.height
  const L = 70
  const B = 30
  const T = 10
  const R = 12
  x.clearRect(0, 0, W, H)
  x.strokeStyle = css('--line')
  x.beginPath()
  x.moveTo(L, T)
  x.lineTo(L, H - B)
  x.lineTo(W - R, H - B)
  x.stroke()
  pts.forEach((p, i) => {
    x.fillStyle = css('--accent')
    x.globalAlpha = 0.25 + 0.75 * ((p.generation ?? 0) / Math.max(1, maxGen))
    const X = L + (i / Math.max(1, pts.length - 1)) * (W - L - R)
    const Y = T + (1 - (hi > lo ? (p.criterion - lo) / (hi - lo) : 0.5)) * (H - T - B)
    x.fillRect(X - 1.5, Y - 1.5, 3, 3)
  })
  x.globalAlpha = 1
  x.fillStyle = css('--mute')
  x.font = '11px IBM Plex Mono, monospace'
  x.textAlign = 'right'
  x.fillText(fmt(hi), L - 6, T + 10)
  x.fillText(fmt(lo), L - 6, H - B)
  x.textAlign = 'center'
  x.fillText(`pass (1 → ${pts.length})`, L + (W - L - R) / 2, H - 8)
}

function renderFwd() {
  const byId = new Map(passCache.back.map((b) => [Number(b.id), b]))
  const rows = passCache.forward.filter((f) => f.metrics).sort((a, b) => (b.criterion ?? -Infinity) - (a.criterion ?? -Infinity))
  $('fwdRows').innerHTML = rows.length
    ? rows
        .map((f) => {
          const b = byId.get(Number(f.back_pass_id)) || {}
          const vary = Object.entries(f.varied || {}).map(([k, v]) => `${k}=${label(v)}`).join(' ')
          return `<tr data-pass="${f.id}"><td>${f.back_pass_id}</td><td>${esc(vary)}</td><td class="r">${fmt(b.criterion)}</td><td class="r">${money(b.metrics?.totalPnl)}</td>
            <td class="r">${fmt(f.criterion)}</td><td class="r ${f.metrics.totalPnl < 0 ? 'bad' : ''}">${money(f.metrics.totalPnl)}</td><td class="r">${f.metrics.flies}</td></tr>`
        })
        .join('')
    : '<tr><td colspan="7" class="empty">No forward results (no forward period, or the back test is still running).</td></tr>'
}

// ---------- pass drill-in ----------
async function openPass(id) {
  const p = await api(`/api/passes/${id}`)
  $('passPanel').hidden = false
  $('events').hidden = true
  $('passTitle').textContent = `Pass #${p.id} (${p.phase})`
  const vary = Object.entries(p.varied || {}).map(([k, v]) => `<b>${esc(k)}</b> = ${esc(label(v))}`).join(' · ')
  const m = p.metrics || {}
  $('passParams').innerHTML = `${vary || '<span class="sub">defaults</span>'}<br><span class="sub">P&amp;L ${money(m.totalPnl)} · traded ${m.tradedDays ?? 0}/${m.days ?? 0} sessions · max DD ${money(m.maxDrawdown)} · criterion ${fmt(p.criterion)}</span>`
  $('passDays').innerHTML = p.days
    .map((d) => `<tr data-day="${d.date}" data-pid="${p.id}"><td>${d.date}</td><td>${esc(d.outcome || '')}</td><td class="r ${d.pnl < 0 ? 'bad' : ''}">${money(d.pnl)}</td><td class="r">${d.result?._std?.trades ?? '—'}</td></tr>`)
    .join('')
  $('passPanel').scrollIntoView({ behavior: 'smooth', block: 'start' })
}
$('passRows').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-pass]')
  if (tr) openPass(+tr.dataset.pass)
})
$('fwdRows').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-pass]')
  if (tr) openPass(+tr.dataset.pass)
})
$('passDays').addEventListener('click', async (e) => {
  const tr = e.target.closest('tr[data-day]')
  if (!tr) return
  const box = $('events')
  box.hidden = false
  box.textContent = `Replaying ${tr.dataset.day}…`
  try {
    const d = await api(`/api/passes/${tr.dataset.pid}/replay?date=${tr.dataset.day}`, { method: 'POST' })
    box.textContent =
      `${tr.dataset.day}: ${d.outcome}  ${money(d.pnl)}\n\n` +
      (d.events.length ? d.events.map((ev) => `${ev.t}  ${ev.kind.padEnd(9)} ${money(ev.cash).padStart(9)}  ${ev.detail}`).join('\n') : '(no trades)')
  } catch (err) {
    box.textContent = `Replay failed: ${err.message}`
  }
})

init()
