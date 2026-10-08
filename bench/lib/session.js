// One bot connection with everything the bench watches on it:
//   - a ring of the packets in both directions with tick markers (lib/trace.js)
//   - lib/tools/grimLint.js over the outgoing stream
//   - setbacks: a server position packet that no login, respawn or scenario asked for
//   - kicks, errors, anticheat-looking chat, stalled ticks
// It writes into the current Frame (the scenario that runs). The bot never chats unless --commands is given.
const path = require('path')
const { EventEmitter } = require('events')
const mineflayer = require('../..')
const grimLint = require('../../lib/tools/grimLint')
const { Frame } = require('./frame')
const { NOISE_IN, brief, formatRecord, window } = require('./trace')
const { sleep, round } = require('./util')

const RING = 8000
const HISTORY = 20
const CHAT_OUT = new Set(['chat', 'chat_message', 'chat_command', 'chat_command_signed'])
// What an anticheat alert in chat looks like (Grim: "Grim » Name failed Simulation (x2) ...")
const ALERT = /\bgrim(ac)?\b|\bviolations?\b|\bsetbacks?\b|\bflagged\b|failed .*\(x\d+\)|\bvl:? ?\d+/i

const textOf = (reason, registry) => {
  try {
    const ChatMessage = require('prismarine-chat')(registry)
    return ChatMessage.fromNotch(reason).toString()
  } catch {
    return typeof reason === 'string' ? reason : JSON.stringify(reason)
  }
}

class Session extends EventEmitter {
  constructor (opts) {
    super()
    this.opts = opts
    this.t0 = Date.now()
    this.seq = 0
    this.tick = 0
    this.ring = []
    this.history = []
    this.pending = []
    this.players = new Set()
    this.bot = null
    this.ended = true
    this.expectEnd = false
    this.generation = 0
    this.lastLoginAt = 0
    this.logins = [] // when each login of this run started
    this.frame = null
    this.between = new Frame('(between scenarios)', this)
    this.dead = new Promise(() => {})
    this.timers = []
    this.expectedTeleports = 0
    this.connectInfo = null
    this.hasTickEnd = false
    this.origin = null
  }

  // Positions in the report are relative to where the bot first stood (unless --absolute): a bug report should
  // not carry the coordinates of anybody's base
  get shift () {
    const o = this.origin ?? { x: 0, y: 0, z: 0 }
    return (x, y, z) => [x - o.x, y - o.y, z - o.z]
  }

  rel (v) { return this.shift(v.x, v.y, v.z).map(n => round(n, 5)) }

  where (v) { return this.shift(v.x, v.y, v.z).map(n => round(n, 2)).join(' ') }

  // Logins made in the last hour: TCPShield (9b9t) starts dropping connections at about 20 an hour from one address
  loginsLastHour () { return this.logins.filter(t => t > Date.now() - 3_600_000).length }

  get alive () { return !!this.bot && !this.ended }
  get f () { return this.frame ?? this.between }

  log (msg) {
    if (this.opts.verbose || /^ {2}[!x] /.test(msg)) console.log(msg)
    this.emit('log', msg)
  }

  // ---- connection -----------------------------------------------------------------------------------------

  async connect () {
    const o = this.opts
    const spacing = o.spacing ?? (o.auth === 'microsoft' ? 15000 : 2000)
    const wait = this.lastLoginAt + spacing - Date.now()
    if (this.lastLoginAt && wait > 0) {
      this.log(`  . waiting ${Math.ceil(wait / 1000)} s between logins`)
      await sleep(wait)
    }
    this.lastLoginAt = Date.now()
    this.logins.push(this.lastLoginAt)
    const gen = ++this.generation
    this.ended = false
    this.expectEnd = false
    this.kickRecorded = false
    this.kickReason = null
    this.history = []
    this.players.clear()
    this.placedAtTick = undefined
    this.expectedTeleports = 0 // the placement after login is announced by the play-state login packet
    this.lastTickAt = 0
    this.stall = null
    const info = this.connectInfo = { startedAt: Date.now() }
    const since = () => Date.now() - info.startedAt

    const bot = mineflayer.createBot({
      host: o.host,
      port: o.port,
      username: o.username,
      auth: o.auth,
      version: o.version ?? false,
      hideErrors: true,
      profilesFolder: o.profiles ?? (o.auth === 'microsoft' ? path.join(__dirname, '..', '.auth') : undefined),
      onMsaCode: (code) => console.log(`\nmicrosoft sign-in: open ${code.verification_uri} and enter ${code.user_code}\n`)
    })
    this.bot = bot
    let rejectDead
    this.dead = new Promise((resolve, reject) => { rejectDead = reject })
    this.dead.catch(() => {})
    bot.once('inject_allowed', () => { if (gen === this.generation) this.attach(bot) })
    bot.once('login', () => { info.loginMs = since() })
    bot.once('spawn', () => { info.spawnMs = since() })
    bot.once('chunkColumnLoad', () => { info.firstChunkMs = since() })
    bot.once('forcedMove', () => { info.firstForcedMoveMs = since() })
    bot.on('forcedMove', () => { this.f.forcedMoves++ })
    bot.on('kicked', (reason) => {
      this.kickReason = bot.kickReason ?? textOf(reason, bot.registry)
      this.kickRecorded = true
      if (!this.expectEnd) this.f.addKick('kicked', this.kickReason)
    })
    bot.on('error', (err) => { if (!this.expectEnd) this.f.addError(err?.message ?? err) })
    bot.on('watchdog', (ms) => this.f.addWatchdog('lib-watchdog', ms, true))

    const settled = new Promise((resolve, reject) => {
      bot.once('spawn', resolve)
      bot.once('end', (reason) => reject(new Error(`disconnected before spawn: ${this.kickReason ?? reason}`)))
    })
    bot.on('end', (reason) => {
      if (gen !== this.generation) return
      this.ended = true
      this.stopTimers()
      if (!this.expectEnd) {
        if (!this.kickRecorded) this.f.addKick('end', String(reason))
        rejectDead(new Error(`disconnected: ${this.kickReason ?? reason}`))
      }
      this.emit('end', reason)
    })
    let timer
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`no spawn within ${o.loginTimeout / 1000} s`)), o.loginTimeout)
    })
    try {
      await Promise.race([settled, timeout])
    } catch (err) {
      this.expectEnd = true
      try { bot.end('bench: login failed') } catch { /* gone */ }
      throw err
    } finally {
      clearTimeout(timer)
      settled.catch(() => {})
    }
    return info
  }

  async disconnect (reason = 'bench done') {
    const bot = this.bot
    if (!bot || this.ended) return
    this.expectEnd = true
    const ended = new Promise(resolve => bot.once('end', resolve))
    try { bot.end(reason) } catch { /* gone */ }
    await Promise.race([ended, sleep(3000)])
    this.ended = true
    this.stopTimers()
  }

  stopTimers () {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
  }

  // ---- instruments ----------------------------------------------------------------------------------------

  attach (bot) {
    const client = bot._client
    this.hasTickEnd = bot.supportFeature('sendsClientTickEndPacket')
    // The library reports teleports itself (and says which one it asked for); an older one is read off the packets
    this.hooked = typeof bot.tickCount === 'number'
    if (this.hooked) {
      bot.on('teleport', (t) => this.onTeleport({ to: this.shift(t.position.x, t.position.y, t.position.z), teleportId: t.id }, t.requested))
      bot.on('actionRejected', (r) => this.f.note(`${r.action} refused: ${r.code}${r.detail ? ` (${r.detail})` : ''}`))
    }
    if (this.opts.lint !== false) this.lint = grimLint(bot, { players: this.players, report: (id, msg) => this.f.addViolation(id, msg) })
    const original = client.write
    const session = this
    client.write = function (name, params) {
      if (CHAT_OUT.has(name) && !session.opts.commands) {
        session.f.fail(`the bot tried to send ${name} (blocked: the bench never talks without --commands)`)
        return false
      }
      session.onOut(name, params)
      return original.apply(this, arguments)
    }
    client.on('packet', (data, meta) => this.onIn(meta.name, data, meta.state))

    bot.on('physicsTick', () => this.onPhysicsTick(bot))
    bot.on('messagestr', (msg) => {
      if (!ALERT.test(msg)) return
      this.f.addAlert(msg.slice(0, 240), msg.toLowerCase().includes(this.opts.username.toLowerCase()))
    })
    bot.on('entitySpawn', (e) => { if (e.type === 'player' && e.id !== bot.entity?.id) this.players.add(e.id) })

    let last = Date.now()
    this.timers.push(setInterval(() => {
      const now = Date.now()
      const lag = now - last - 500
      last = now
      if (lag > 1000) this.f.addWatchdog('loop-lag', lag, false)
      if (this.lastTickAt && !this.stall && now - this.lastTickAt > 1500) this.stall = this.lastTickAt
    }, 500))
    this.timers.at(-1).unref?.()
  }

  push (dir, name, info, noise, extra) {
    const rec = { seq: ++this.seq, t: Date.now() - this.t0, tick: this.tick, dir, name, info, noise, ...extra }
    this.ring.push(rec)
    if (this.ring.length > RING * 1.25) this.ring = this.ring.slice(-RING)
    return rec
  }

  onOut (name, params) {
    const rec = this.push('out', name, brief('out', name, params, this.shift), false)
    if (name === 'tick_end' && this.hasTickEnd) this.tick++
    this.emit('out', rec, params)
  }

  onIn (name, data, state) {
    const own = name === 'entity_velocity' && data?.entityId === this.bot?.entity?.id
    const quietState = state && state !== 'play' && !['disconnect', 'finish_configuration'].includes(name)
    const noise = (NOISE_IN.has(name) && !own) || quietState
    if (name === 'position' && !this.origin && (!state || state === 'play')) {
      this.origin = this.opts.absolute ? { x: 0, y: 0, z: 0 } : { x: Math.floor(data.x), y: Math.floor(data.y), z: Math.floor(data.z) }
    }
    const rec = this.push('in', name, noise ? '' : brief('in', name, data, this.shift), noise)
    if (state && state !== 'play') return
    if (this.hooked) {
      if (name === 'player_rotation') this.f.serverRotations++
    } else if (name === 'login' || name === 'respawn') this.expectedTeleports++
    else if (name === 'position') this.onTeleport(this.teleportOf(data))
    else if (name === 'player_rotation') this.f.serverRotations++
    this.emit('in', rec, data)
  }

  // Where a raw position packet puts the bot, relative to the origin (a relative axis is added to the last position)
  teleportOf (p) {
    const prev = this.history.at(-1)
    const e = this.bot.entity
    const base = prev ? prev.pos : e?.position ? this.rel(e.position) : [0, 0, 0]
    const o = this.origin ?? { x: 0, y: 0, z: 0 }
    const fl = p.flags
    const rel = typeof fl === 'number' ? { x: fl & 1, y: fl & 2, z: fl & 4 } : { x: fl?.x, y: fl?.y, z: fl?.z }
    return { to: [rel.x ? base[0] + p.x : p.x - o.x, rel.y ? base[1] + p.y : p.y - o.y, rel.z ? base[2] + p.z : p.z - o.z], teleportId: p.teleportId }
  }

  // `requested` is the library's verdict (login, respawn, dimension change); without it the login and respawn packets
  // were counted in onIn. A scenario's expectTeleport() counts either way.
  onTeleport ({ to, teleportId }, requested = null) {
    const prev = this.history.at(-1)
    const e = this.bot.entity
    const base = prev ? prev.pos : e?.position ? this.rel(e.position) : [0, 0, 0]
    if (requested === true || this.expectedTeleports > 0) {
      if (requested !== true) this.expectedTeleports--
      this.placedAtTick = this.tick
      this.emit('teleport', { expected: true, to })
      return
    }
    const distance = Math.hypot(to[0] - base[0], to[1] - base[1], to[2] - base[2])
    // Some servers write the placement twice at login (flying-squid does): the same spot again within a second
    if (distance < 0.01 && this.placedAtTick !== undefined && this.tick - this.placedAtTick <= 20) {
      this.f.note('the server repeated the placement teleport at login (same position): not counted')
      this.placedAtTick = this.tick
      return
    }
    this.f.addSetback({
      tick: this.tick,
      distance,
      from: base,
      to,
      teleportId,
      last5: this.history.slice(-5)
    })
    this.emit('teleport', { expected: false, to, distance })
  }

  onPhysicsTick (bot) {
    if (!this.hasTickEnd) this.tick++
    const e = bot.entity
    if (this.stall) {
      const ms = Date.now() - this.stall
      this.f.addWatchdog('tick-stall', ms, ms >= 3000)
      this.stall = null
    }
    this.lastTickAt = Date.now()
    this.f.ticks++
    this.history.push({
      tick: this.tick,
      pos: this.rel(e.position),
      vel: [round(e.velocity.x, 5), round(e.velocity.y, 5), round(e.velocity.z, 5)],
      onGround: !!e.onGround,
      inputs: Object.keys(bot.controlState).filter(k => bot.controlState[k]).join('+') || 'none',
      yaw: round(e.yaw * 180 / Math.PI, 2),
      pitch: round(e.pitch * 180 / Math.PI, 2),
      sprinting: !!bot.entity.sprinting || !!bot.sprinting
    })
    if (this.history.length > HISTORY) this.history.shift()
    this.flushIncidents(false)
  }

  // A scenario triggers a server teleport on purpose (a command): don't count it as a setback
  expectTeleport (n = 1) { this.expectedTeleports += n }

  // ---- incidents: a trace window around a moment -----------------------------------------------------------

  openIncident (kind, label) {
    const marker = this.push('out', `<<${kind}: ${label}>>`, '', false, { marker: true })
    const inc = { kind, label, seq: marker.seq, tick: this.tick, t: marker.t, lines: null }
    this.pending.push(inc)
    return inc
  }

  flushIncidents (all) {
    if (!this.pending.length) return
    const keep = []
    for (const inc of this.pending) {
      if (all || this.tick >= inc.tick + 5) this.finalize(inc)
      else keep.push(inc)
    }
    this.pending = keep
  }

  finalize (inc) {
    const offset = (this.frameStart ?? this.t0) - this.t0
    const { head, tail } = window(this.ring, inc.seq, { tick: inc.tick })
    inc.lines = [
      ...head.map(r => formatRecord(r, offset)),
      '---------- after ----------',
      ...tail.map(r => formatRecord(r, offset))
    ]
  }
}

module.exports = { Session }
