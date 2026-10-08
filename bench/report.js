#!/usr/bin/env node
// Pretty-print a bench report, or diff two of them:
//   node bench/report.js out.json
//   node bench/report.js 1.21.4.json 26.2.json      (a = before, b = after; exit 1 if b is worse)
// A directory is read as <dir>/report.json.
const fs = require('fs')
const path = require('path')

const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code) => (s) => useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s)
const c = { red: paint(31), green: paint(32), yellow: paint(33), dim: paint(2), bold: paint(1) }
const STATUS = { pass: c.green('PASS'), fail: c.red('FAIL'), skipped: c.yellow('SKIP') }
const RANK = { pass: 0, skipped: 1, fail: 2 }

const secs = (ms) => `${(ms / 1000).toFixed(1)}s`

function load (file) {
  const f = fs.existsSync(file) && fs.statSync(file).isDirectory() ? path.join(file, 'report.json') : file
  return JSON.parse(fs.readFileSync(f, 'utf8'))
}

function header (r) {
  const t = r.target
  const lib = r.bench.lib
  return `${c.bold('9bFlayer bench')}  ${lib.name} ${lib.version}${lib.commit ? ` (${lib.commit})` : ''}  node ${r.bench.node}  ${r.bench.startedAt}\n` +
    `target  ${t.host}:${t.port}  version ${t.version ?? 'auto'}  auth ${t.auth}  user ${t.username}` +
    (r.options.modify ? '  --modify' : '') + (r.options.commands ? '  --commands' : '')
}

function render (r) {
  const out = [header(r), '']
  const w = Math.max(10, ...r.scenarios.map(s => s.name.length))
  out.push(`${'scenario'.padEnd(w)}  status  ${'time'.padStart(7)}  setbacks  kicks  lint  errors`)
  for (const s of r.scenarios) {
    out.push(`${s.name.padEnd(w)}  ${STATUS[s.status]}    ${secs(s.durationMs).padStart(7)}  ${String(s.setbacks.count).padStart(8)}  ${String(s.kicks.length).padStart(5)}  ${String(s.lint.violations.length).padStart(4)}  ${String(s.errors.length).padStart(6)}${s.status === 'skipped' ? '  ' + c.dim(s.reason) : ''}`)
  }
  const bad = r.scenarios.filter(s => s.status === 'fail')
  for (const s of bad) {
    out.push('', c.red(`${s.name}: ${s.title}`))
    for (const why of s.reasons ?? []) out.push(`  - ${why}`)
    for (const sb of s.setbacks.events.slice(0, 5)) {
      out.push(`  setback at tick ${sb.tick}, ${sb.atMs} ms in: moved ${sb.distance.toFixed(3)} blocks`)
      out.push(c.dim(`    before it: ${sb.last5.map(h => `[${h.tick}] ${h.inputs} y${h.pos[1]} g${h.onGround ? 1 : 0}`).join('  ')}`))
    }
    for (const v of s.lint.violations.slice(0, 5)) out.push(`  lint ${v.id} (tick ${v.tick}): ${v.message.split('  [window')[0]}`)
    for (const k of s.kicks) out.push(`  ${k.kind}: ${k.reason}`)
    for (const e of s.errors.slice(0, 3)) out.push(`  error: ${e.message}`)
    for (const a of s.alerts.filter(a => a.self).slice(0, 3)) out.push(`  alert: ${a.text}`)
    if (s.traces.length) out.push(c.dim(`  traces: ${s.traces.map(t => path.join(r.bench.outDir ?? '', t)).join('\n          ')}`))
  }
  const notes = r.scenarios.filter(s => s.status !== 'fail' && s.notes.length)
  if (notes.length) {
    out.push('', c.bold('notes'))
    for (const s of notes) for (const n of s.notes) out.push(`  ${s.name}: ${n}`)
  }
  const m = r.summary
  out.push('', `${m.passed} passed, ${m.failed ? c.red(m.failed + ' failed') : '0 failed'}, ${m.skipped} skipped of ${m.total}  |  setbacks ${m.setbacks}, kicks ${m.kicks}, lint violations ${m.lintViolations}, errors ${m.errors}  |  ${secs(m.durationMs)}`)
  if (r.bench.outDir) out.push(c.dim(`report: ${path.join(r.bench.outDir, 'report.json')}`))
  return out.join('\n')
}

// Flatten numbers (and short numeric lists) of a metrics object
function flat (o, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(o ?? {})) {
    if (typeof v === 'number') out[prefix + k] = v
    else if (typeof v === 'boolean' || typeof v === 'string') out[prefix + k] = v
    else if (Array.isArray(v) && v.every(x => typeof x === 'number') && v.length <= 12) v.forEach((x, i) => { out[`${prefix}${k}[${i}]`] = x })
  }
  return out
}

function diff (a, b) {
  const out = [`${c.bold('A')} ${a.target.version ?? 'auto'} ${a.bench.lib.version}${a.bench.lib.commit ? ' ' + a.bench.lib.commit : ''}  ${a.target.host}:${a.target.port}  ${a.bench.startedAt}`,
    `${c.bold('B')} ${b.target.version ?? 'auto'} ${b.bench.lib.version}${b.bench.lib.commit ? ' ' + b.bench.lib.commit : ''}  ${b.target.host}:${b.target.port}  ${b.bench.startedAt}`, '']
  let regressed = false
  const names = [...new Set([...a.scenarios.map(s => s.name), ...b.scenarios.map(s => s.name)])]
  for (const name of names) {
    const sa = a.scenarios.find(s => s.name === name)
    const sb = b.scenarios.find(s => s.name === name)
    if (!sa || !sb) {
      out.push(`${name}: only in ${sa ? 'A' : 'B'}`)
      continue
    }
    const lines = []
    if (sa.status !== sb.status) {
      const worse = RANK[sb.status] > RANK[sa.status]
      if (worse && sb.status === 'fail') regressed = true
      lines.push(`${worse ? c.red('worse') : c.green('better')}: ${sa.status} -> ${sb.status}${sb.reason ? ` (${sb.reason})` : ''}`)
    }
    if (sa.setbacks.count !== sb.setbacks.count) {
      if (sb.setbacks.count > sa.setbacks.count) regressed = true
      lines.push(`setbacks ${sa.setbacks.count} -> ${sb.setbacks.count}`)
    }
    if (sa.kicks.length !== sb.kicks.length) lines.push(`kicks ${sa.kicks.length} -> ${sb.kicks.length}`)
    const ids = (s) => new Set(s.lint.violations.map(v => v.id))
    const ia = ids(sa)
    const ib = ids(sb)
    for (const id of ib) if (!ia.has(id)) { lines.push(c.red(`+ lint ${id}`)); regressed = true }
    for (const id of ia) if (!ib.has(id)) lines.push(c.green(`- lint ${id}`))
    const fa = new Set(sa.failures.map(f => f.message))
    const fb = new Set(sb.failures.map(f => f.message))
    for (const f of fb) if (!fa.has(f)) lines.push(c.red(`+ ${f}`))
    for (const f of fa) if (!fb.has(f)) lines.push(c.green(`- ${f}`))
    const ma = flat(sa.metrics)
    const mb = flat(sb.metrics)
    for (const k of Object.keys({ ...ma, ...mb })) {
      const x = ma[k]
      const y = mb[k]
      if (x === y) continue
      if (typeof x === 'number' && typeof y === 'number') {
        const rel = x === 0 ? Infinity : Math.abs(y - x) / Math.abs(x)
        if (Math.abs(y - x) > 1e-3 && rel > 0.05) lines.push(c.dim(`${k}: ${x} -> ${y}`))
      } else if (typeof x !== 'object' && typeof y !== 'object') {
        lines.push(c.dim(`${k}: ${x} -> ${y}`))
      }
    }
    out.push(`${sb.status === sa.status && !lines.length ? c.dim(name.padEnd(12) + ' same') : name}`)
    for (const l of lines) out.push(`  ${l}`)
  }
  out.push('', regressed ? c.red('B is worse than A') : 'B is not worse than A')
  return { text: out.join('\n'), regressed }
}

module.exports = { render, diff, load }

if (require.main === module) {
  const files = process.argv.slice(2).filter(a => !a.startsWith('--'))
  if (files.length < 1 || files.length > 2 || process.argv.includes('--help')) {
    console.error('usage: node bench/report.js report.json [other.json]')
    process.exit(2)
  }
  try {
    if (files.length === 1) console.log(render(load(files[0])))
    else {
      const d = diff(load(files[0]), load(files[1]))
      console.log(d.text)
      process.exitCode = d.regressed ? 1 : 0
    }
  } catch (err) {
    console.error(err.message)
    process.exit(2)
  }
}
