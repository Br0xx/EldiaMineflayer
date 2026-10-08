/* eslint-env mocha */
// Tests the bench itself: its scenarios against the mock server (bench/mock.js) and, when flying-squid is at hand,
// against a real server. Run with:  npx mocha --exit bench/bench.test.js
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { startMock } = require('./mock')
const { runBench } = require('./lib/runner')
const { parseArgs } = require('./lib/args')
const { render, diff } = require('./report')
const { sleep } = require('./lib/util')
const { findSquid, startSquid } = require('./squid')
const { getPort } = require('../test/common/util')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bench-test-'))
const SHAPE = ['name', 'title', 'status', 'durationMs', 'setbacks', 'kicks', 'errors', 'lint', 'alerts', 'watchdog', 'failures', 'notes', 'metrics', 'traces']

function options (mock, version, extra = []) {
  return parseArgs(['--host', '127.0.0.1', '--port', String(mock.port), '--version', version, '--idle', '3s', '--out', tmp(), ...extra])
}

function assertShape (report) {
  assert.ok(report.bench.lib.version && report.bench.startedAt && report.bench.finishedAt)
  assert.ok(report.target.host && report.options)
  for (const k of ['total', 'passed', 'failed', 'skipped', 'setbacks', 'kicks', 'errors', 'lintViolations']) assert.strictEqual(typeof report.summary[k], 'number', k)
  for (const s of report.scenarios) {
    for (const k of SHAPE) assert.ok(k in s, `${s.name} lacks ${k}`)
    assert.ok(['pass', 'fail', 'skipped'].includes(s.status))
    assert.strictEqual(s.setbacks.count, s.setbacks.events.length)
  }
  assert.ok(fs.existsSync(path.join(report.bench.outDir, 'report.json')))
}

// Runs fn once the current scenario has ticked n times (the moment is relative to the scenario, not the clock)
function afterTicks (session, n, fn) {
  const timer = setInterval(() => {
    if (!session.frame || session.frame.ticks < n) return
    clearInterval(timer)
    fn()
  }, 20)
  timer.unref()
}

const mineflayer = require('..')

for (const version of ['1.21.4', '26.2', '26.3'].filter(v => mineflayer.testedVersions.includes(v))) {
  describe(`bench against the mock server (${version})`, function () {
    this.timeout(120 * 1000)
    let mock
    beforeEach(async () => { mock = await startMock({ version }) })
    afterEach(() => mock.close())

    it('login, idle, look, walk and jump pass with no lint violations and no setbacks', async () => {
      const report = await runBench(options(mock, version, ['--scenarios', 'login,idle,look,walk,jump']))
      assertShape(report)
      assert.deepStrictEqual(report.scenarios.map(s => s.name), ['login', 'idle', 'look', 'walk', 'jump'])
      for (const s of report.scenarios) assert.strictEqual(s.status, 'pass', `${s.name}: ${JSON.stringify(s.reasons)}`)
      assert.strictEqual(report.summary.lintViolations, 0)
      assert.strictEqual(report.summary.setbacks, 0)
      const by = Object.fromEntries(report.scenarios.map(s => [s.name, s]))
      assert.ok(by.login.metrics.msToSpawn > 0)
      assert.strictEqual(by.login.metrics.playerLoaded, true)
      assert.ok(by.idle.metrics.movementPackets >= 1)
      assert.ok(by.walk.metrics.walkCurveMaxError < 0.002)
      assert.deepStrictEqual(by.jump.metrics.jumpArcHeights.slice(0, 3), [0.42, 0.7532, 1.0013])
      assert.ok(render(report).includes('5 passed'))
    })
  })
}

describe('bench against the mock server: what it reports when something is wrong', function () {
  this.timeout(120 * 1000)
  const version = '1.21.4'
  let mock
  beforeEach(async () => { mock = await startMock({ version }) })
  afterEach(() => mock.close())

  it('reports a setback with its evidence and fails the scenario', async () => {
    const report = await runBench(options(mock, version, ['--scenarios', 'idle']), {
      onStart: (sc, session) => afterTicks(session, 70, () => mock.setback(0.75))
    })
    const idle = report.scenarios[0]
    assert.strictEqual(idle.status, 'fail')
    assert.strictEqual(idle.setbacks.count, 1)
    const sb = idle.setbacks.events[0]
    assert.ok(Math.abs(sb.distance - 0.75) < 0.01, `distance ${sb.distance}`)
    assert.strictEqual(sb.last5.length, 5)
    assert.ok(sb.last5.every(h => h.pos.length === 3 && h.vel.length === 3 && typeof h.inputs === 'string'))
    assert.strictEqual(idle.traces.length, 1)
    const trace = fs.readFileSync(path.join(report.bench.outDir, idle.traces[0]), 'utf8')
    assert.ok(/!! <<setback: setback 1/.test(trace) && /<< position/.test(trace) && /teleport_confirm/.test(trace) && /tick_end/.test(trace), trace)
    assert.ok(report.summary.failed === 1 && report.summary.setbacks === 1)
    assert.ok(idle.forcedMoves >= 2, 'forcedMove events: the placement and the setback')
  })

  it('reports a grimLint violation in the outgoing stream', async () => {
    const report = await runBench(options(mock, version, ['--scenarios', 'look']), {
      onStart: (sc, session) => afterTicks(session, 30, () => {
        // the same hotbar slot twice in a row (BadPacketsA)
        session.bot._client.write('held_item_slot', { slotId: 3 })
        session.bot._client.write('held_item_slot', { slotId: 3 })
      })
    })
    const look = report.scenarios[0]
    assert.strictEqual(look.status, 'fail')
    assert.ok(look.lint.violations.some(v => v.id === 'BadPacketsA'), JSON.stringify(look.lint))
    assert.ok(look.traces.length > 0)
  })

  it('blocks chat unless --commands is given, and reads Grim-style messages', async () => {
    const report = await runBench(options(mock, version, ['--scenarios', 'idle']), {
      onStart: (sc, session) => afterTicks(session, 50, () => {
        session.bot.chat('hello')
        mock.say('Grim » BenchBot failed Simulation (x2) VL:2')
      })
    })
    const idle = report.scenarios[0]
    assert.strictEqual(idle.status, 'fail')
    assert.ok(idle.failures.some(f => /tried to send chat_message/.test(f.message)), JSON.stringify(idle.failures))
    assert.ok(idle.alerts.some(a => a.self), JSON.stringify(idle.alerts))
    assert.ok([...mock.clients].every(c => !c.mock.packets.includes('chat_message')), 'the chat packet reached the server')
  })

  it('reports a kick and logs in again for the next scenario', async () => {
    const report = await runBench(options(mock, version, ['--scenarios', 'idle,look', '--spacing', '1s']), {
      onStart: (sc, session) => { if (sc.name === 'idle') afterTicks(session, 50, () => mock.kick('flying is not enabled')) }
    })
    assert.strictEqual(report.scenarios[0].status, 'fail')
    assert.strictEqual(report.scenarios[0].kicks.length, 1)
    assert.ok(/flying/.test(report.scenarios[0].kicks[0].reason), JSON.stringify(report.scenarios[0].kicks))
    assert.strictEqual(report.scenarios[1].status, 'pass')
  })
})

describe('bench against the mock server: the world features', function () {
  this.timeout(180 * 1000)
  const version = '1.21.4'
  let mock
  before(async () => { mock = await startMock({ version }) })
  after(() => mock.close())

  it('finds the step, stairs, water, containers and the edge to sneak at', async () => {
    const report = await runBench(options(mock, version, ['--scenarios', 'sneak,stairs,step,water,container,inventory']))
    assertShape(report)
    for (const s of report.scenarios) assert.strictEqual(s.status, 'pass', `${s.name}: ${JSON.stringify(s.reasons ?? s.reason)}`)
    const by = Object.fromEntries(report.scenarios.map(s => [s.name, s]))
    assert.ok(by.sneak.metrics.edgeOvershoot <= 0.31, 'the sneak scenario found no edge')
    assert.strictEqual(by.container.metrics.opened, 3)
    assert.ok(by.container.metrics.containers.every(c => c.shulkersRead === 1), 'shulker contents not read')
  })

  it('reconnects once; a short soak runs and counts per minute', async () => {
    const report = await runBench(options(mock, version, ['--scenarios', 'reconnect,soak', '--spacing', '1s', '--duration', '20s']))
    for (const s of report.scenarios) assert.strictEqual(s.status, 'pass', `${s.name}: ${JSON.stringify(s.reasons)}`)
    const soak = report.scenarios[1]
    assert.ok(soak.metrics.cycles >= 1)
    assert.strictEqual(soak.metrics.setbacksPerMinute, 0)
  })
})

describe('bench report', function () {
  this.timeout(60 * 1000)
  it('prints a report and diffs two runs', async () => {
    const mock = await startMock({})
    try {
      const a = await runBench(options(mock, '1.21.4', ['--scenarios', 'idle']))
      const b = await runBench(options(mock, '1.21.4', ['--scenarios', 'idle']), { onStart: (sc, session) => afterTicks(session, 70, () => mock.setback(0.5)) })
      assert.ok(render(b).includes('setback'))
      const same = diff(a, a)
      assert.strictEqual(same.regressed, false)
      const worse = diff(a, b)
      assert.strictEqual(worse.regressed, true)
      assert.ok(/setbacks 0 -> 1/.test(worse.text))
      assert.strictEqual(diff(b, a).regressed, false)
    } finally {
      mock.close()
    }
  })

  it('parses the command line', () => {
    const o = parseArgs(['--host', 'h', '--port', '1', '--auth', 'microsoft', '--duration', '2m', '--modify', '--scenarios', 'walk,jump'])
    assert.strictEqual(o.duration, 120000)
    assert.strictEqual(o.modify, true)
    assert.deepStrictEqual(o.scenarios, ['walk', 'jump'])
    assert.throws(() => parseArgs(['--nope']), /unknown option/)
    assert.throws(() => parseArgs(['--auth', 'x']), /auth/)
  })
})

describe('bench against flying-squid', function () {
  this.timeout(180 * 1000)
  before(function () { if (!findSquid()) this.skip() })
  it('runs the movement scenarios on a real server (no anticheat there)', async () => {
    const port = await getPort()
    const squid = await startSquid({ port })
    try {
      const report = await runBench(parseArgs(['--host', '127.0.0.1', '--port', String(port), '--version', '1.21.4', '--idle', '3s', '--out', tmp(), '--scenarios', 'login,idle,look,walk,jump,sprint']))
      assertShape(report)
      for (const s of report.scenarios) assert.strictEqual(s.status, 'pass', `${s.name}: ${JSON.stringify(s.reasons)}`)
      assert.strictEqual(report.summary.lintViolations, 0)
      await sleep(100)
    } finally {
      squid.close()
    }
  })
})
