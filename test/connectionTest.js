/* eslint-env mocha */

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const mc = require('minecraft-protocol')
const mineflayer = require('../')
const { fileStore, scheduler, hostLedger } = require('../lib/connection')
const { sleep } = require('../lib/promise_utils')
const { getPort } = require('./common/util')
const { nameToMcOfflineUUID } = require('minecraft-protocol/src/datatypes/uuid')

const VERSION = '1.21.4'
const registry = require('prismarine-registry')(VERSION)

// Fast timings, no randomness: the real defaults are minutes
const FAST = { baseDelayMs: 60, maxDelayMs: 1000, jitter: 0, loginBudget: { perHour: 100 } }

// A server whose behaviour on join is up to the test. `onJoin(client, joinNumber)`.
async function startServer (onJoin, serverOptions = {}) {
  const port = await getPort()
  const server = mc.createServer({ 'online-mode': false, version: VERSION, port, ...serverOptions })
  server.joins = []
  server.on('playerJoin', (client) => {
    server.joins.push(Date.now())
    client.on('error', () => {})
    onJoin(client, server.joins.length)
  })
  await new Promise(resolve => server.on('listening', resolve))
  server.port = port
  return server
}

function spawnClient (client) {
  const login = registry.loginPacket
  login.entityId = 0
  client.write('login', login)
  client.write('update_health', { health: 20, food: 20, foodSaturation: 5 })
}

function kick (client, text = 'lag') {
  client.end(text)
}

function persistent (server, extra = {}, reconnect = {}) {
  const pb = mineflayer.createPersistentBot({
    username: 'keeper',
    host: '127.0.0.1',
    port: server.port,
    version: VERSION,
    auth: 'offline',
    ...extra,
    reconnect: { ...FAST, ...reconnect }
  })
  pb.events = []
  for (const name of ['reconnecting', 'waiting', 'end', 'stopped', 'login', 'spawn', 'transfer']) {
    pb.on(name, (...args) => pb.events.push([name, ...args]))
  }
  pb.on('error', () => {})
  return pb
}

// A custom auth function: signs in as an offline account, after `before` has run. What a Microsoft sign-in would do.
function customAuth (before) {
  return (client, options) => {
    client.username = options.username
    client.uuid = nameToMcOfflineUUID(client.username)
    before(client, options, () => options.connect(client))
  }
}

async function until (condition, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for: ' + condition)
    await sleep(20)
  }
}

const once = (emitter, name) => new Promise(resolve => emitter.once(name, (...args) => resolve(args)))

describe('9bflayer connection', function () {
  this.timeout(10 * 1000)
  const servers = []
  const bots = []
  const track = (pb) => { bots.push(pb); return pb }
  const serve = async (...args) => { const s = await startServer(...args); servers.push(s); return s }

  beforeEach(() => { scheduler.reset(); hostLedger.clear() })
  afterEach(async () => {
    for (const pb of bots.splice(0)) pb.stop('test over')
    for (const s of servers.splice(0)) s.close()
  })

  it('reconnects after a server kick, backing off 60 ms then 120 ms', async () => {
    const server = await serve((client, n) => {
      if (n <= 2) return kick(client, 'lag')
      spawnClient(client)
    })
    const pb = track(persistent(server))
    const bots = []
    pb.on('bot', bot => bots.push(bot))
    await once(pb, 'spawn')

    assert.strictEqual(pb.state, 'online')
    assert.strictEqual(server.joins.length, 3)
    assert.strictEqual(bots.length, 3, "'bot' fires for every connection")
    assert.strictEqual(pb.bot, bots[2], 'pb.bot is the current bot')
    const delays = pb.events.filter(e => e[0] === 'reconnecting').map(e => e[1].delayMs)
    assert.deepStrictEqual(delays, [60, 120])
    const ends = pb.events.filter(e => e[0] === 'end')
    assert.strictEqual(ends.length, 2)
    assert.strictEqual(ends[0][1], 'lag')
    assert.strictEqual(ends[0][2].action, 'retry')
    assert.ok(ends[0][2].at > Date.now() - 1000)
    assert.strictEqual(pb.stats.kicks, 2)
    assert.strictEqual(pb.stats.lastKick.reason, 'lag')
    assert.strictEqual(pb.stats.attempts, 3)
  })

  it('calls options.onBot before the bot connects, so plugins can be loaded', async () => {
    const server = await serve((client) => spawnClient(client))
    let seen = null
    let loaded = false
    const pb = track(persistent(server, {
      onBot (bot) {
        seen = bot
        bot.loadPlugin(() => { loaded = true })
      }
    }))
    await once(pb, 'spawn')
    assert.strictEqual(seen, pb.bot)
    assert.ok(loaded)
  })

  it('does not start a login the budget would exceed, and says when a slot opens', async () => {
    const server = await serve((client) => kick(client, 'lag'))
    const pb = track(persistent(server, {}, { loginBudget: { perHour: 2, windowMs: 700 } }))
    const [info] = await once(pb, 'waiting')
    await sleep(150)
    assert.strictEqual(server.joins.length, 2, 'two logins used the budget')
    assert.strictEqual(info.reason, 'budget')
    assert.strictEqual(pb.state, 'waiting')
    assert.strictEqual(info.perHour, 2)
    assert.strictEqual(pb.stats.nextAttemptAt, info.until)
    // the slot opens when the first login leaves the window (the login is noted just before the server sees it)
    const sinceFirst = info.until - server.joins[0]
    assert.ok(sinceFirst > 400 && sinceFirst <= 700, `until ${sinceFirst} ms after the first login`)

    await sleep(info.until - Date.now() + 250)
    assert.ok(server.joins.length >= 3, 'logs in again once the window has room')
    assert.ok(server.joins[2] >= info.until - 10)
  })

  it('spaces logins that share the Microsoft scheduler, across bots', async () => {
    const server = await serve((client) => spawnClient(client))
    // offline accounts, but with the spacing a Microsoft account gets
    const a = track(persistent(server, { username: 'spacedA' }, { loginBudget: { perHour: 10, minSpacingMs: 400 } }))
    const b = track(persistent(server, { username: 'spacedB' }, { loginBudget: { perHour: 10, minSpacingMs: 400 } }))
    const c = track(persistent(server, { username: 'spacedC' }, { loginBudget: { perHour: 10, minSpacingMs: 400 } }))
    // when each login starts (the server sees it later, by a varying amount)
    const starts = []
    for (const pb of [a, b, c]) pb.on('bot', () => starts.push(Date.now()))
    await Promise.all([a, b, c].map(pb => pb.whenOnline()))
    assert.strictEqual(starts.length, 3)
    const gaps = starts.slice(1).map((t, i) => t - starts[i])
    for (const gap of gaps) assert.ok(gap >= 380, `gap ${gap} ms`)
  })

  it('defaults to 15 s spacing for microsoft and none for offline', () => {
    const { PersistentBot } = mineflayer
    const probe = (auth) => {
      const pb = new PersistentBot({ username: 'x', host: '127.0.0.1', port: 1, auth, reconnect: { enabled: false } })
      pb.stop()
      return pb._config.loginBudget
    }
    assert.strictEqual(probe('microsoft').minSpacingMs, 15000)
    assert.strictEqual(probe('microsoft').perHour, 6)
    assert.strictEqual(probe('offline').minSpacingMs, 0)
    assert.strictEqual(new PersistentBot({ username: 'x', port: 1, reconnect: false })._config.enabled, false)
  })

  it('stop() cancels a pending retry', async () => {
    const server = await serve((client) => kick(client))
    const pb = track(persistent(server, {}, { baseDelayMs: 400 }))
    await once(pb, 'reconnecting')
    assert.strictEqual(pb.state, 'waiting')
    pb.stop('done')
    assert.strictEqual(pb.state, 'stopped')
    await once(pb, 'stopped')
    await sleep(700)
    assert.strictEqual(server.joins.length, 1, 'no login after stop()')
    assert.strictEqual(pb.stats.nextAttemptAt, null)
    await assert.rejects(pb.whenOnline(), { code: 'stopped' })
  })

  it('stop() while waiting for a login slot gives the slot back and never connects', async () => {
    const server = await serve((client) => spawnClient(client))
    const spacing = { loginBudget: { perHour: 10, minSpacingMs: 600 } }
    track(persistent(server, { username: 'first' }, spacing))
    const second = track(persistent(server, { username: 'second' }, spacing))
    await until(() => server.joins.length === 1)
    assert.strictEqual(second.state, 'connecting', 'second is queued behind the first')
    second.stop()
    await once(second, 'stopped')
    const third = track(persistent(server, { username: 'third' }, spacing))
    await third.whenOnline()
    assert.strictEqual(server.joins.length, 2, 'the stopped bot never joined')
    assert.ok(server.joins[1] - server.joins[0] < 1100, 'the cancelled slot was reused')
  })

  it('stop() during a slow sign-in destroys the late socket', async () => {
    const server = await serve((client) => spawnClient(client))
    const pb = track(persistent(server, {
      auth: customAuth((client, options, connect) => { setTimeout(connect, 300) })
    }))
    await sleep(50)
    pb.stop()
    await once(pb, 'stopped')
    await sleep(600)
    assert.strictEqual(server.joins.length, 0)
  })

  it('the watchdog ends a connection that went silent, and the bot reconnects', async () => {
    const server = await serve((client, n) => {
      // the first connection says nothing after this: no packets, no keep-alives, and the socket stays open
      spawnClient(client)
      if (n > 1) client.write('update_health', { health: 20, food: 20, foodSaturation: 5 })
    }, { keepAlive: false })
    const pb = track(persistent(server, { watchdog: { silenceMs: 400 } }))
    const [text, decision] = await once(pb, 'end')
    assert.ok(text.startsWith('watchdog:'), text)
    assert.strictEqual(decision.action, 'retry')
    assert.strictEqual(decision.cause, 'watchdog')
    assert.strictEqual(decision.endReason, 'watchdog')
    assert.ok(pb.stats.lastEnd.reason.startsWith('watchdog'))
    await once(pb, 'spawn')
    assert.strictEqual(server.joins.length, 2)
  })

  it('tracks bot.lastPacketAt and does not fire while packets arrive', async () => {
    const server = await serve((client) => {
      spawnClient(client)
      const timer = setInterval(() => { try { client.write('update_health', { health: 20, food: 20, foodSaturation: 5 }) } catch {} }, 100)
      client.on('end', () => clearInterval(timer))
    }, { keepAlive: false })
    const bot = mineflayer.createBot({ username: 'quiet', host: '127.0.0.1', port: server.port, version: VERSION, watchdog: { silenceMs: 350 } })
    bot.on('error', () => {})
    let watchdogs = 0
    bot.on('watchdog', () => watchdogs++)
    await once(bot, 'spawn')
    const first = bot.lastPacketAt
    assert.ok(first > Date.now() - 2000)
    await sleep(700)
    assert.ok(bot.lastPacketAt > first, 'lastPacketAt moves')
    assert.strictEqual(watchdogs, 0)
    bot.end()
    await once(bot, 'end')
  })

  it('the watchdog forgives its own event loop stalling', async () => {
    const server = await serve((client) => {
      spawnClient(client)
      const timer = setInterval(() => { try { client.write('update_health', { health: 20, food: 20, foodSaturation: 5 }) } catch {} }, 50)
      client.on('end', () => clearInterval(timer))
    }, { keepAlive: false })
    const bot = mineflayer.createBot({ username: 'stalled', host: '127.0.0.1', port: server.port, version: VERSION, watchdog: { silenceMs: 300 } })
    bot.on('error', () => {})
    let watchdogs = 0
    bot.on('watchdog', () => watchdogs++)
    await once(bot, 'spawn')
    // the whole process freezes for longer than silenceMs; the packets that arrived meanwhile are read afterwards
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800)
    await sleep(300)
    assert.strictEqual(watchdogs, 0)
    bot.end()
    await once(bot, 'end')
  })

  it('the watchdog can be switched off', async () => {
    const server = await serve((client) => spawnClient(client), { keepAlive: false })
    const bot = mineflayer.createBot({ username: 'nowatch', host: '127.0.0.1', port: server.port, version: VERSION, watchdog: false })
    bot.on('error', () => {})
    let watchdogs = 0
    bot.on('watchdog', () => watchdogs++)
    await once(bot, 'spawn')
    await sleep(300)
    assert.strictEqual(watchdogs, 0)
    bot.end()
    await once(bot, 'end')
  })

  it('stops on a ban and does not log in again', async () => {
    const server = await serve((client) => kick(client, 'You are permanently banned from this server'))
    const pb = track(persistent(server))
    const [message, cause] = await once(pb, 'stopped')
    await sleep(300)
    assert.strictEqual(server.joins.length, 1)
    assert.strictEqual(cause, 'give-up')
    assert.match(message, /banned/)
    assert.strictEqual(pb.state, 'stopped')
    assert.strictEqual(pb.events.find(e => e[0] === 'end')[2].action, 'stop')
  })

  it('classify() overrides the built-in decision, and giveUpOn adds patterns', async () => {
    const server = await serve((client) => kick(client, 'banned by mistake'))
    const retrying = track(persistent(server, {}, { classify: (text) => text.includes('mistake') ? 'retry' : undefined }))
    await once(retrying, 'reconnecting')
    assert.strictEqual(retrying.state, 'waiting', 'a custom classify beats the ban pattern')
    retrying.stop()

    const server2 = await serve((client) => kick(client, 'Maintenance window'))
    const custom = track(persistent(server2, {}, { giveUpOn: ['maintenance'] }))
    const [, cause] = await once(custom, 'stopped')
    assert.strictEqual(cause, 'give-up')

    const server3 = await serve((client) => kick(client, 'lag'))
    const stopper = track(persistent(server3, {}, { classify: () => 'stop' }))
    const [, cause3] = await once(stopper, 'stopped')
    assert.strictEqual(cause3, 'classify')
  })

  it("waits long on 'already connected' and gives up if it keeps happening", async () => {
    const server = await serve((client) => kick(client, 'You are already connected to this proxy!'))
    const pb = track(persistent(server, {}, { longWaitMs: 100, conflictLimit: 2 }))
    const [, cause] = await once(pb, 'stopped')
    assert.strictEqual(cause, 'conflict')
    assert.strictEqual(server.joins.length, 3, 'two waits, then the third conflict stops')
    const waits = pb.events.filter(e => e[0] === 'reconnecting')
    assert.ok(waits.every(e => e[1].delayMs >= 100 && e[1].reason === 'conflict'))
  })

  it('stops after hungLoginLimit logins in a row that never spawn (hungLoginResumeMs: 0)', async () => {
    // joins, but never sends the login packet: what a throttled connection looks like
    const server = await serve(() => {})
    const pb = track(persistent(server, {}, { loginTimeoutMs: 200, hungLoginResumeMs: 0 }))
    const [message, cause] = await once(pb, 'stopped')
    await sleep(300)
    assert.strictEqual(cause, 'throttled')
    assert.match(message, /3 logins in a row never spawned.*probably throttled/)
    assert.strictEqual(server.joins.length, 3, 'no fourth attempt')
    assert.strictEqual(pb.stats.hungLogins, 3)
    assert.strictEqual(pb.stats.kicks, 0, 'a hang is not a kick')
    const ends = pb.events.filter(e => e[0] === 'end')
    assert.ok(ends[0][1].startsWith('loginTimeout'))
    assert.strictEqual(ends[0][2].cause, 'hung-login')
  })

  it('after the throttled stop it resumes with one try per hungLoginResumeMs', async () => {
    const server = await serve(() => {})
    const pb = track(persistent(server, {}, { loginTimeoutMs: 400, hungLoginResumeMs: 500 }))
    await until(() => pb.events.some(e => e[0] === 'waiting' && e[1].reason === 'throttled'))
    const first = pb.events.find(e => e[0] === 'waiting')[1]
    assert.strictEqual(pb.state, 'waiting')
    assert.strictEqual(server.joins.length, 3)
    assert.ok(first.delayMs >= 500 && first.until > Date.now(), 'until says when the one resume happens')
    assert.strictEqual(pb.stats.nextAttemptAt, first.until)
    assert.ok(!pb.events.some(e => e[0] === 'stopped'), 'not stopped: it will resume')
    const end = pb.events.filter(e => e[0] === 'end').pop()[2]
    assert.strictEqual(end.cause, 'throttled')

    // one more try, which hangs again and sends it back to waiting; not three more
    await until(() => server.joins.length === 4)
    await until(() => pb.events.filter(e => e[0] === 'waiting' && e[1].reason === 'throttled').length === 2)
    await sleep(100)
    assert.strictEqual(server.joins.length, 4)
    assert.strictEqual(pb.state, 'waiting')

    // stop() ends it for good
    pb.stop()
    await once(pb, 'stopped')
    await sleep(700)
    assert.strictEqual(server.joins.length, 4)
  })

  it('resumes into a normal session when the retry spawns', async () => {
    const server = await serve((client, n) => { if (n === 4) spawnClient(client) })
    const pb = track(persistent(server, {}, { loginTimeoutMs: 400, hungLoginResumeMs: 300 }))
    await until(() => pb.state === 'online', 6000)
    assert.strictEqual(server.joins.length, 4)
    assert.strictEqual(pb.stats.hungLoginsInARow, 0)
  })

  it('a spawn resets the hung-login count', async () => {
    // hang, hang, spawn and get kicked, hang, hang, spawn: never three hangs in a row
    const server = await serve((client, n) => {
      if (n === 3) { spawnClient(client); setTimeout(() => kick(client, 'lag'), 50); return }
      if (n === 6) return spawnClient(client)
    })
    const pb = track(persistent(server, {}, { loginTimeoutMs: 200, baseDelayMs: 20 }))
    await until(() => server.joins.length === 6 && pb.state === 'online')
    assert.strictEqual(pb.stats.hungLogins, 4)
    assert.strictEqual(pb.stats.hungLoginsInARow, 0)
    assert.strictEqual(pb.state, 'online')
  })

  it('does not time out a login while the Microsoft code is waiting for a person', async () => {
    const server = await serve((client) => spawnClient(client))
    let codes = 0
    const pb = track(persistent(server, {
      auth: customAuth((client, options, connect) => {
        options.onMsaCode({ user_code: 'ABC' })
        setTimeout(connect, 500)
      }),
      onMsaCode: () => { codes++ }
    }, { loginTimeoutMs: 200 }))
    await pb.whenOnline()
    assert.strictEqual(codes, 1)
    assert.strictEqual(pb.events.filter(e => e[0] === 'end').length, 0, 'no login timeout during the sign-in')
  })

  it('shares a per-host budget between bots, and says hostBudget', async () => {
    const server = await serve((client) => kick(client, 'lag'))
    const budget = { perHour: 100, perHostPerHour: 3, windowMs: 800 }
    const a = track(persistent(server, { username: 'hostA' }, { loginBudget: budget }))
    const b = track(persistent(server, { username: 'hostB' }, { loginBudget: budget }))
    await until(() => [a, b].some(pb => pb.events.some(e => e[0] === 'waiting')))
    await until(() => [a, b].every(pb => pb.state === 'waiting'))
    await sleep(150)
    const info = [...a.events, ...b.events].find(e => e[0] === 'waiting')[1]
    assert.strictEqual(info.reason, 'hostBudget')
    assert.strictEqual(info.perHour, 3)
    assert.strictEqual(info.loginsLastHour, 3)
    assert.strictEqual(server.joins.length, 3, 'three logins in all, whichever bot made them')
    assert.ok(a.stats.loginsLastHour + b.stats.loginsLastHour === 3)
    // it opens again when the window has room
    await until(() => server.joins.length > 3, 3000)
    assert.ok(server.joins[3] >= server.joins[0] + 800 - 150)
  })

  it('keeps the host budget in the store too, so a restart does not forget it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), '9bflayer-conn-'))
    const file = path.join(dir, 'logins.json')
    const server = await serve((client) => kick(client))
    const budget = { perHour: 100, perHostPerHour: 2, windowMs: 60_000 }
    const first = track(persistent(server, {}, { loginBudget: budget, store: fileStore(file, { key: 'keeper' }) }))
    await once(first, 'waiting')
    first.stop()
    await once(first, 'stopped')
    assert.strictEqual(server.joins.length, 2)

    hostLedger.clear() // a new process
    const second = track(persistent(server, { username: 'someoneElse' }, { loginBudget: budget, store: fileStore(file, { key: 'keeper' }) }))
    const [info] = await once(second, 'waiting')
    await sleep(200)
    assert.strictEqual(info.reason, 'hostBudget')
    assert.strictEqual(server.joins.length, 2)
    fs.rmSync(dir, { recursive: true })
  })

  it('keeps the login history in a store that survives a restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), '9bflayer-conn-'))
    const file = path.join(dir, 'logins.json')
    const server = await serve((client) => kick(client))
    const budget = { perHour: 2, windowMs: 60_000 }
    const first = track(persistent(server, {}, { loginBudget: budget, store: fileStore(file, { key: 'keeper' }) }))
    await once(first, 'waiting')
    assert.strictEqual(server.joins.length, 2)
    first.stop()
    await once(first, 'stopped')
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).keeper.logins.length, 2)

    // a new process: same store, same budget
    const second = track(persistent(server, {}, { loginBudget: budget, store: fileStore(file, { key: 'keeper' }) }))
    const [info] = await once(second, 'waiting')
    await sleep(200)
    assert.strictEqual(info.reason, 'budget')
    assert.strictEqual(info.loginsLastHour, 2)
    assert.strictEqual(server.joins.length, 2, 'the restart did not spend more logins')
    assert.strictEqual(second.stats.loginsLastHour, 2)

    // another bot's key in the same file has its own history
    const other = track(persistent(server, { username: 'other' }, { loginBudget: budget, store: fileStore(file, { key: 'other' }) }))
    await sleep(200)
    assert.ok(server.joins.length > 2)
    other.stop()
    fs.rmSync(dir, { recursive: true })
  })

  it('fileStore tolerates a missing or corrupt file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), '9bflayer-conn-'))
    const file = path.join(dir, 'sub', 'logins.json')
    const store = fileStore(file)
    assert.strictEqual(store.load(), null)
    store.save({ logins: [1] })
    assert.deepStrictEqual(store.load(), { logins: [1] })
    fs.writeFileSync(file, '{not json')
    assert.strictEqual(store.load(), null)
    store.save({ logins: [2] })
    assert.deepStrictEqual(store.load(), { logins: [2] })
    fs.rmSync(dir, { recursive: true })
  })

  it('ignores the budget for reconnectNow({ ignoreBudget }) only', async () => {
    const server = await serve((client) => kick(client))
    const pb = track(persistent(server, {}, { loginBudget: { perHour: 1, windowMs: 60_000 } }))
    await once(pb, 'waiting')
    const again = once(pb, 'waiting')
    assert.strictEqual(pb.reconnectNow(), true)
    await again
    assert.strictEqual(server.joins.length, 1, 'the budget still holds')
    pb.reconnectNow({ ignoreBudget: true })
    await sleep(200)
    assert.strictEqual(server.joins.length, 2)
  })

  it('a bot.end() from the user stops the keeper', async () => {
    const server = await serve((client) => spawnClient(client))
    const pb = track(persistent(server))
    const bot = await pb.whenOnline()
    bot.end('bye')
    const [message, cause] = await once(pb, 'stopped')
    assert.strictEqual(cause, 'user')
    assert.strictEqual(message, 'bye')
    await sleep(300)
    assert.strictEqual(server.joins.length, 1)
  })

  it('run() rejects with code disconnected when the bot ends mid-task', async () => {
    const clients = []
    const server = await serve((client) => { clients.push(client); spawnClient(client) })
    const pb = track(persistent(server))
    await pb.whenOnline()
    let aborted = false
    const task = pb.run(async (bot, signal) => {
      signal.addEventListener('abort', () => { aborted = true })
      await sleep(2000)
    })
    await sleep(100)
    kick(clients[0], 'lag')
    await assert.rejects(task, { code: 'disconnected' })
    assert.ok(aborted)
    // and once the bot is back, run() works again
    const result = await pb.run(async bot => bot.username)
    assert.strictEqual(result, 'keeper')
    assert.strictEqual(server.joins.length, 2)
  })

  it('run({ wait: false }) rejects at once while offline', async () => {
    const server = await serve((client) => kick(client))
    const pb = track(persistent(server, {}, { baseDelayMs: 2000 }))
    await once(pb, 'reconnecting')
    await assert.rejects(pb.run(async () => 1, { wait: false }), { code: 'disconnected' })
    await assert.rejects(pb.whenOnline({ timeoutMs: 50 }), { code: 'timeout' })
  })

  it('survives connection errors without an error listener', async () => {
    const port = await getPort() // nothing listens
    const pb = mineflayer.createPersistentBot({
      username: 'lonely',
      host: '127.0.0.1',
      port,
      version: VERSION,
      auth: 'offline',
      reconnect: { ...FAST, maxAttempts: 2 }
    })
    track(pb)
    const [message, cause] = await once(pb, 'stopped')
    assert.strictEqual(cause, 'max-attempts')
    assert.match(message, /ECONNREFUSED/)
    assert.match(pb.stats.lastError.message, /ECONNREFUSED/)
    assert.strictEqual(pb.stats.attempts, 3)
  })

  it('treats a failed sign-in (error, no socket) as a failed attempt', async () => {
    let tries = 0
    const server = await serve((client) => spawnClient(client))
    const pb = track(persistent(server, {
      auth: customAuth((client, options, connect) => {
        tries++
        if (tries === 1) setImmediate(() => client.emit('error', new Error('Xbox said no')))
        else connect()
      })
    }))
    await once(pb, 'spawn')
    assert.strictEqual(tries, 2)
    assert.match(pb.events.find(e => e[0] === 'end')[1], /Xbox said no/)
  })

  it('a 429 pushes the shared login scheduler back', async () => {
    const server = await serve((client) => spawnClient(client))
    let tries = 0
    const pb = track(persistent(server, {
      auth: customAuth((client, options, connect) => {
        tries++
        if (tries === 1) setImmediate(() => client.emit('error', new Error('Request failed with status code 429 Too Many Requests')))
        else connect()
      })
    }, { longWaitMs: 5000 }))
    const [, decision] = await once(pb, 'end')
    assert.strictEqual(decision.cause, 'rate-limit')
    assert.strictEqual(decision.action, 'wait')
    assert.ok(decision.delayMs >= 5000)
    assert.ok(scheduler.nextAt > Date.now() + 4000)
  })

  describe('transfer', () => {
    it('follows a transfer packet to the new host without spending the login budget', async () => {
      const target = await serve((client) => spawnClient(client))
      const source = await serve((client) => {
        spawnClient(client)
        setTimeout(() => client.write('transfer', { host: '127.0.0.1', port: target.port }), 100)
      })
      const pb = track(persistent(source, {}, { transferDelayMs: 50, loginBudget: { perHour: 1, windowMs: 60_000 } }))
      await once(pb, 'spawn')
      const [info] = await once(pb, 'transfer')
      assert.strictEqual(info.port, target.port)
      await once(pb, 'spawn')
      assert.strictEqual(target.joins.length, 1)
      assert.strictEqual(pb.stats.transfers, 1)
      assert.strictEqual(pb.stats.kicks, 0)
      assert.strictEqual(pb.stats.attempts, 1, 'not a new login')
      assert.strictEqual(pb.stats.loginsLastHour, 1)
      assert.strictEqual(pb.events.find(e => e[0] === 'end')[2].cause, 'transfer')
    })

    it('stops a redirect loop from spinning', async () => {
      const server = await serve((client) => {
        spawnClient(client)
        client.write('transfer', { host: '127.0.0.1', port: server.port })
      })
      const pb = track(persistent(server, {}, { transferDelayMs: 10, longWaitMs: 5000 }))
      await until(() => pb.state === 'waiting' && pb.events.some(e => e[0] === 'reconnecting' && e[1].reason === 'transfer-loop'))
      assert.strictEqual(server.joins.length, 4, 'three transfers are followed, the fourth is not')
    })
  })
})
