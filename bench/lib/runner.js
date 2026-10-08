// Runs the scenarios in order on one session and builds the report
const fs = require('fs')
const path = require('path')
const { Session } = require('./session')
const { Frame } = require('./frame')
const nav = require('./nav')
const { sleep, round, stamp, Skip, Inconclusive } = require('./util')
const { scenarios: registry, DEFAULT_ORDER } = require('../scenarios')

function select (names) {
  if (!names) return DEFAULT_ORDER.map(n => registry.find(s => s.name === n))
  if (names.length === 1 && names[0] === 'all') return registry.slice()
  return names.map(n => {
    const s = registry.find(s => s.name === n)
    if (!s) throw new Error(`unknown scenario "${n}" (known: ${registry.map(s => s.name).join(', ')})`)
    return s
  })
}

// What a scenario can use
function makeContext (session, frame, sc) {
  const opts = session.opts
  const ctx = {
    session,
    frame,
    opts,
    aborted: false,
    get bot () { return session.bot },
    get nav () {
      if (session.navBot !== session.bot) { session.navBot = session.bot; session.navApi = nav.make(session.bot) }
      return session.navApi
    },
    steer: nav,
    log: (m) => session.log(`  . ${m}`),
    note: (m) => frame.note(m),
    metric: (k, v) => frame.metric(k, v),
    fail: (message, data) => frame.fail(message, data),
    expect (cond, message, data) {
      if (!cond) frame.fail(message, data)
      return !!cond
    },
    skip (reason) { throw new Skip(reason) },
    inconclusive (reason) { throw new Inconclusive(reason) },
    sleep: async (ms) => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (ctx.aborted) throw new Error('aborted')
        if (session.ended && !session.expectEnd && !sc.manageConnection) throw new Error('disconnected')
        await sleep(Math.min(250, end - Date.now()))
      }
    },
    // Resolves in the physics tick where pred() is true, rejects after `ticks` ticks or when the connection ends
    until (pred, { ticks = 200, what = 'a condition' } = {}) {
      const bot = session.bot
      return new Promise((resolve, reject) => {
        let n = 0
        const finish = (fn, v) => {
          bot.removeListener('physicsTick', check)
          session.removeListener('end', onEnd)
          fn(v)
        }
        const onEnd = () => finish(reject, new Error('disconnected'))
        const check = () => {
          if (ctx.aborted) return finish(reject, new Error('aborted'))
          try {
            if (pred()) finish(resolve, true)
            else if (++n >= ticks) finish(reject, new Error(`gave up after ${ticks} ticks waiting for ${what}`))
          } catch (err) {
            finish(reject, err)
          }
        }
        if (session.ended) return reject(new Error('disconnected'))
        bot.on('physicsTick', check)
        session.once('end', onEnd)
      })
    },
    ticks (n) {
      let c = 0
      return ctx.until(() => ++c >= n, { ticks: n + 5, what: `${n} ticks` })
    },
    // Chunk loaded and a few ticks run
    async ready () {
      await ctx.until(() => ctx.bot.entity && ctx.bot.blockAt(ctx.bot.entity.position) != null, { ticks: 600, what: 'the chunk under the bot' })
      await ctx.ticks(10)
    },
    // Standing on the ground and still
    async grounded () {
      await ctx.ready()
      await nav.settle(ctx)
    },
    async command (text) {
      if (!opts.commands) throw new Skip('needs --commands')
      session.log(`  . command: ${text}`)
      ctx.bot.chat(text)
      await ctx.ticks(10)
    },
    async connect () {
      if (session.alive) await session.disconnect('bench: new login')
      return session.connect()
    },
    async reconnect () {
      await session.disconnect('bench: reconnect')
      return session.connect()
    },
    // Back online after a kick or a drop, for scenarios that run for long
    async revive () {
      if (session.alive) return false
      await session.connect()
      return true
    }
  }
  return ctx
}

function describe (frame) {
  const why = []
  if (frame.setbacks.length) why.push(`${frame.setbacks.length} setback${frame.setbacks.length > 1 ? 's' : ''}`)
  if (frame.kicks.length) why.push(`${frame.kicks.length} kick/disconnect`)
  if (frame.errors.length) why.push(`${frame.errors.length} error${frame.errors.length > 1 ? 's' : ''}`)
  if (frame.violations.length) why.push(`${frame.violations.length} grimLint violation${frame.violations.length > 1 ? 's' : ''} (${[...new Set(frame.violations.map(v => v.id))].join(', ')})`)
  if (frame.watchdog.some(w => w.fatal)) why.push('watchdog tripped')
  if (frame.alerts.some(a => a.self)) why.push('anticheat alert naming the bot')
  for (const f of frame.failures) why.push(f.message)
  return why
}

function writeTraces (outDir, frame, session) {
  const files = []
  const offset = frame.startedAt - session.t0
  for (const inc of frame.incidents) {
    if (!inc.lines) session.finalize(inc)
    const file = `${frame.name}-${String(inc.n).padStart(2, '0')}-${inc.kind}.trace.txt`
    const head = [
      `scenario ${frame.name}, ${inc.kind}: ${inc.label}`,
      `tick ${inc.tick}, ${((inc.t - offset) / 1000).toFixed(3)} s into the scenario`
    ]
    const sb = frame.setbacks.find(s => s.incident === inc.n)
    if (sb) {
      head.push('', `setback of ${sb.distance.toFixed(4)} blocks, from ${JSON.stringify(sb.from)} to ${JSON.stringify(sb.to)}, teleport id ${sb.teleportId}`, 'the bot\'s last ticks before it (tick, position, velocity, ground, inputs, yaw/pitch):')
      for (const h of sb.last5) head.push(`  tick ${h.tick}  pos ${JSON.stringify(h.pos)}  vel ${JSON.stringify(h.vel)}  ground ${h.onGround ? 1 : 0}  keys ${h.inputs}  rot ${h.yaw}/${h.pitch}${h.sprinting ? '  sprinting' : ''}`)
    }
    head.push('', '>> sent by the bot, << received. "!!" is the moment of the incident', '')
    fs.writeFileSync(path.join(outDir, file), head.concat(inc.lines).join('\n') + '\n')
    files.push(file)
  }
  return files
}

function buildEntry (sc, frame, status, reason, session, outDir) {
  const traces = writeTraces(outDir, frame, session)
  const reasons = status === 'fail' ? describe(frame) : []
  const buckets = [...frame.buckets.entries()].sort((a, b) => a[0] - b[0]).map(([minute, v]) => ({ minute, ...v }))
  return {
    name: sc.name,
    title: sc.title,
    status,
    reason: status === 'skipped' ? reason : undefined,
    reasons: reasons.length ? reasons : undefined,
    durationMs: frame.elapsed,
    ticks: frame.ticks,
    setbacks: { count: frame.setbacks.length, events: frame.setbacks },
    kicks: frame.kicks,
    errors: frame.errors,
    lint: { violations: frame.violations },
    alerts: frame.alerts,
    watchdog: frame.watchdog,
    serverRotations: frame.serverRotations,
    forcedMoves: frame.forcedMoves,
    failures: frame.failures,
    notes: frame.notes,
    metrics: frame.metrics,
    perMinute: buckets,
    traces,
    tracesOmitted: frame.incidentsDropped || undefined
  }
}

async function runOne (sc, session, opts, outDir, hooks) {
  const frame = new Frame(sc.name, session)
  session.frame = frame
  session.frameStart = frame.startedAt
  const ctx = makeContext(session, frame, sc)
  session.log(`\n== ${sc.name}: ${sc.title}`)
  hooks.onStart?.(sc, session)
  let status = 'pass'
  let reason
  let timer
  let onEnd
  try {
    if (sc.modify && !opts.modify) throw new Skip('needs --modify (it changes the world)')
    if (sc.commands && !opts.commands) throw new Skip('needs --commands')
    if (!sc.manageConnection && !session.alive) {
      try {
        await session.connect()
        frame.note('connected for this scenario')
      } catch (err) {
        frame.fail(`could not log in: ${err.message}`)
        throw new Skip(`could not log in: ${err.message}`)
      }
    }
    const abort = new Promise((resolve, reject) => {
      onEnd = () => { if (!session.expectEnd && !sc.manageConnection) reject(new Error(`disconnected: ${session.kickReason ?? 'connection ended'}`)) }
      session.on('end', onEnd)
    })
    abort.catch(() => {})
    const limit = typeof sc.timeout === 'function' ? sc.timeout(opts) : opts.timeout
    const timeout = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`scenario timed out after ${Math.round(limit / 1000)} s`)), limit) })
    timeout.catch(() => {})
    if (!sc.manageConnection) await ctx.ready()
    await Promise.race([sc.run(ctx), abort, timeout])
  } catch (err) {
    ctx.aborted = true
    if (err instanceof Skip) {
      status = 'skipped'
      reason = err.reason
    } else if (err instanceof Inconclusive) {
      // the world got in the way; it is a failure only if the server pushed back
      if (describe(frame).length) frame.fail(err.reason)
      else { status = 'skipped'; reason = err.reason }
    } else if (!/^(disconnected|aborted)/.test(err.message)) {
      frame.fail(`${err.message}`, { stack: String(err.stack).split('\n').slice(0, 6) })
    } else if (!frame.kicks.length) {
      frame.fail(err.message)
    }
  } finally {
    clearTimeout(timer)
    if (onEnd) session.removeListener('end', onEnd)
    ctx.aborted = true
    try {
      if (session.alive) {
        session.bot.clearControlStates()
        if (session.bot.currentWindow) session.bot.closeWindow(session.bot.currentWindow)
      }
    } catch { /* gone */ }
  }
  if (status !== 'skipped' && describe(frame).length) status = 'fail'
  // the last incidents get their five ticks, if the bot is still ticking
  if (session.alive) await sleep(300)
  session.flushIncidents(true)
  session.frame = null
  const entry = buildEntry(sc, frame, status, reason, session, outDir)
  return entry
}

function libInfo () {
  const root = path.join(__dirname, '..', '..')
  const pkg = require(path.join(root, 'package.json'))
  let commit = null
  try {
    commit = require('child_process').execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch { /* not a git checkout */ }
  return { name: pkg.name, version: pkg.version, mineflayerBase: pkg.mineflayerBase, commit }
}

async function runBench (opts, hooks = {}) {
  const session = new Session(opts)
  const outDir = path.resolve(opts.out ?? path.join(__dirname, '..', 'out', stamp()))
  fs.mkdirSync(outDir, { recursive: true })
  const list = select(opts.scenarios)
  const report = {
    bench: { format: 1, startedAt: new Date().toISOString(), node: process.version, lib: libInfo(), outDir },
    target: { host: opts.host, port: opts.port, version: opts.version, auth: opts.auth, username: opts.username },
    options: { modify: opts.modify, commands: opts.commands, radius: opts.radius, duration: opts.duration, idle: opts.idle },
    scenarios: []
  }
  let loginFailures = 0
  try {
    for (const sc of list) {
      if (loginFailures >= 2) {
        report.scenarios.push({ name: sc.name, title: sc.title, status: 'skipped', reason: 'could not log in', durationMs: 0, setbacks: { count: 0, events: [] }, kicks: [], errors: [], lint: { violations: [] }, alerts: [], watchdog: [], failures: [], notes: [], metrics: {}, traces: [] })
        continue
      }
      const entry = await runOne(sc, session, opts, outDir, hooks)
      if (entry.failures.some(f => /^could not log in/.test(f.message))) loginFailures++
      else if (session.alive) loginFailures = 0
      report.scenarios.push(entry)
      report.summary = summarize(report)
      fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ ...report, partial: true }, null, 2))
      hooks.onScenario?.(entry)
      await sleep(300)
    }
  } finally {
    await session.disconnect('bench finished')
  }
  report.bench.finishedAt = new Date().toISOString()
  report.summary = summarize(report)
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2))
  if (opts.json) fs.writeFileSync(opts.json, JSON.stringify(report, null, 2))
  return report
}

function summarize (report) {
  const s = { total: report.scenarios.length, passed: 0, failed: 0, skipped: 0, setbacks: 0, kicks: 0, errors: 0, lintViolations: 0 }
  for (const e of report.scenarios) {
    s[{ pass: 'passed', fail: 'failed', skipped: 'skipped' }[e.status]]++
    s.setbacks += e.setbacks.count
    s.kicks += e.kicks.length
    s.errors += e.errors.length
    s.lintViolations += e.lint.violations.length
  }
  s.durationMs = report.scenarios.reduce((n, e) => n + e.durationMs, 0)
  s.durationMs = round(s.durationMs, 0)
  return s
}

module.exports = { runBench, summarize, select }
