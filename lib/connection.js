'use strict'

// Keeps a bot on a server for days and brings it back when it drops, without the mistakes that get an IP
// throttled: 9b9t sits behind TCPShield, which after ~20 logins an hour from one address starts dropping
// connections with `read ETIMEDOUT` and lets new logins hang without ever spawning, and Xbox answers 429 when
// Microsoft logins come closer than ~15 s. So every login goes through a per-bot hourly budget (kept in a store, so
// a crash loop that restarts the process cannot spend it again) and, for Microsoft accounts, one process-wide
// scheduler that spaces the sign-ins. The numbers are EBS Lab's (BotSession.ts, lab.ts), proven on 9b9t.

const { EventEmitter } = require('events')
const fs = require('fs')
const path = require('path')

const HOUR = 3_600_000

const DEFAULT_RECONNECT = {
  enabled: true,
  // EBS: 10 s, doubling, capped at 5 min
  baseDelayMs: 10_000,
  maxDelayMs: 300_000,
  jitter: 0.2,
  // consecutive failed attempts before giving up (0 = never)
  maxAttempts: 0,
  // from the attempt to the play-state `login` packet; a connection that gets no further is "hung". That is what a
  // throttled IP looks like (TCPShield lets the connection open and never answers), and what hungLoginLimit counts.
  // A connection that is logged in is never hung: the 9b9t queue can hold it far longer than this.
  loginTimeoutMs: 180_000,
  // from `login` to the first `spawn` (the first update_health): reconnects with backoff when it takes longer, and
  // does not count as hung. A queue may wait this long. 0 = no limit
  spawnTimeoutMs: 1_200_000,
  // logins in a row that never got a `login` before the keeper stops: every further attempt keeps the IP throttled
  hungLoginLimit: 3,
  // after that stop, one new try this long later, and again each time it hangs (0 = stop for good)
  hungLoginResumeMs: 3_600_000,
  // a session this long counts as a good connection and resets the backoff
  stableMs: 60_000,
  // EBS waits 5 min after "already connected", a server restart or a rate limit
  longWaitMs: 300_000,
  // "already connected" in a row before assuming a second session owns the account and stopping
  conflictLimit: 3,
  // "invalid session" / "failed to verify username" in a row before stopping: a session-server outage lasts minutes
  // and is not the account's fault, so these wait longWaitMs first
  sessionErrorLimit: 3,
  // let the old connection close before joining the transfer target
  transferDelayMs: 500,
  // transfers within a minute before treating it as a redirect loop
  maxTransfersPerMinute: 3
}

// Kick reasons that retrying cannot fix
const DEFAULT_GIVE_UP_ON = [
  /\bbanned\b|multiplayer\.disconnect\.banned/i,
  /not (white-?listed|on the white-?list)|multiplayer\.disconnect\.not_whitelisted/i,
  /invalid credentials/i,
  /does not own|doesn't own|not own minecraft|child account|2148916233|2148916238/i,
  /outdated (client|server)|incompatible/i,
  /unsupported protocol|not supported, no data|is not supported/i
]
const CONFLICT = /already connected|already logged|already playing|another location|duplicate_login/i
// The server could not verify the session (Mojang's session server down or slow, or a token that the next sign-in
// refreshes): transient
const SESSION = /invalid session|failed to verify username|unverified_username/i
const RESTARTING = /server closed|server restart|restarting|shutting down/i
const RATE_LIMITED = /\b429\b|too many requests/i

// ── Login scheduler ─────────────────────────────────────────────────────────

// One per process: Xbox rate-limits per IP and account, whichever PersistentBot asks.
class LoginScheduler {
  constructor () { this.nextAt = 0 }

  // Resolves when a login may start; the next one is held back `spacingMs` after it. Rejects if aborted.
  take (spacingMs, signal) {
    if (!(spacingMs > 0)) return Promise.resolve()
    if (signal?.aborted) return Promise.reject(codedError('aborted', 'aborted'))
    const now = Date.now()
    const prev = this.nextAt
    const at = Math.max(now, prev)
    const end = at + spacingMs
    this.nextAt = end
    return new Promise((resolve, reject) => {
      // a login that never happens gives its slot back (unless somebody queued behind it)
      const onAbort = () => {
        clearTimeout(timer)
        if (this.nextAt === end) this.nextAt = prev
        reject(codedError('aborted', 'aborted'))
      }
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, at - now)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  // After a 429 nobody should log in for a while
  penalize (ms) { this.nextAt = Math.max(this.nextAt, Date.now() + ms) }

  reset () { this.nextAt = 0 }
}

const scheduler = new LoginScheduler()

// Login timestamps per 'host:port', shared by every PersistentBot of the process: TCPShield counts per IP, not per
// account, so ten bots with a budget of 6 each would still be 60 logins an hour.
const hostLedger = new Map()

// ── Stores for the login timestamps ─────────────────────────────────────────

function memoryStore () {
  let saved = null
  return { load: () => saved, save: (state) => { saved = state } }
}

// Keeps the state in a JSON file ({ [key]: state }), so several bots can share one file. Best effort: a file that
// cannot be read or written means an empty history, never a crash.
function fileStore (file, { key = 'default' } = {}) {
  const readAll = () => {
    try {
      const all = JSON.parse(fs.readFileSync(file, 'utf8'))
      return all && typeof all === 'object' && !Array.isArray(all) ? all : {}
    } catch { return {} }
  }
  return {
    load () { return readAll()[key] ?? null },
    save (state) {
      try {
        const all = readAll()
        all[key] = state
        fs.mkdirSync(path.dirname(file), { recursive: true })
        // rename is atomic, so a crash mid-write leaves the old file
        const tmp = `${file}.${process.pid}.tmp`
        fs.writeFileSync(tmp, JSON.stringify(all))
        fs.renameSync(tmp, file)
      } catch { /* the history is only a safety net */ }
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function codedError (message, code) {
  return Object.assign(new Error(message), { code })
}

// Kick reasons arrive as a JSON string, a chat component or (1.20.3+) NBT
function reasonText (reason) {
  if (reason == null) return ''
  if (typeof reason === 'string') {
    const trimmed = reason.trim()
    if (/^[{["]/.test(trimmed)) {
      try { return reasonText(JSON.parse(trimmed)) } catch { /* plain text */ }
    }
    return trimmed
  }
  if (Array.isArray(reason)) return reason.map(reasonText).join('')
  if (typeof reason === 'object') {
    if (typeof reason.type === 'string' && 'value' in reason) return reasonText(simplifyNbt(reason))
    const parts = []
    if (typeof reason.translate === 'string') parts.push(reason.translate)
    if (typeof reason.text === 'string') parts.push(reason.text)
    if (Array.isArray(reason.with)) parts.push(...reason.with.map(reasonText))
    if (Array.isArray(reason.extra)) parts.push(...reason.extra.map(reasonText))
    return parts.filter(Boolean).join(' ')
  }
  return String(reason)
}

function simplifyNbt (tag) {
  if (tag == null || typeof tag !== 'object') return tag
  switch (tag.type) {
    case 'compound': return Object.fromEntries(Object.entries(tag.value).map(([k, v]) => [k, simplifyNbt(v)]))
    case 'list': return (tag.value?.value ?? []).map(v => simplifyNbt({ type: tag.value.type, value: v }))
    default: return tag.value
  }
}

function matches (pattern, text) {
  return pattern instanceof RegExp ? pattern.test(text) : text.toLowerCase().includes(String(pattern).toLowerCase())
}

function resolveOptions (options) {
  const { reconnect, onBot, ...botOptions } = options
  if (botOptions.client) throw new TypeError('createPersistentBot makes a new client for every connection; "client" is not supported')
  const given = reconnect === false ? { enabled: false } : (reconnect ?? {})
  const microsoft = botOptions.auth === 'microsoft'
  const budget = {
    perHour: 6, // EBS Lab: TCPShield blocked its IP after ~30 logins in a night
    perHostPerHour: 20, // ...and EBS Lab's relogs started to time out at about 20 an hour from one IP
    minSpacingMs: microsoft ? 15_000 : 0,
    windowMs: HOUR,
    ...given.loginBudget
  }
  return {
    botOptions,
    onBot,
    config: {
      ...DEFAULT_RECONNECT,
      ...given,
      loginBudget: budget,
      giveUpOn: [...DEFAULT_GIVE_UP_ON, ...(given.giveUpOn ?? [])],
      store: given.store ?? memoryStore()
    }
  }
}

// ── PersistentBot ───────────────────────────────────────────────────────────

class PersistentBot extends EventEmitter {
  constructor (options = {}) {
    super()
    const { botOptions, onBot, config } = resolveOptions(options)
    this._botOptions = botOptions
    this._onBot = onBot
    this._config = config
    this._hostKey = `${String(botOptions.host ?? 'localhost').toLowerCase()}:${botOptions.port ?? 25565}`
    this.bot = null
    this.state = 'connecting'
    this._gen = 0
    this._timer = null
    this._abort = null
    this._active = false // the current bot has a connection that has not ended
    this._stopping = false
    this._stoppedEmitted = false
    this._stop = null // { cause, message }
    this._waiters = []
    this._failures = 0
    this._conflicts = 0
    this._sessionErrors = 0
    this._hungLogins = 0
    this._transfers = []
    this._nextTarget = null
    this._nextAttemptAt = null
    this._onlineAt = null
    this._counters = { logins: 0, attempts: 0, kicks: 0, hungLogins: 0, transfers: 0 }
    this._last = { error: null, kick: null, end: null }
    this._logins = this._loadLogins()
    // listeners are attached after the constructor returns; the first attempt must come after them
    process.nextTick(() => this._begin())
  }

  // Counters and the last things that went wrong
  get stats () {
    return {
      ...this._counters,
      hungLoginsInARow: this._hungLogins,
      loginsLastHour: this._recentLogins().length,
      lastError: this._last.error,
      lastKick: this._last.kick,
      lastEnd: this._last.end,
      nextAttemptAt: this._nextAttemptAt,
      onlineSince: this._onlineAt
    }
  }

  // Resolves with the bot once it has spawned (at once if it is online); rejects with code 'stopped' or 'timeout'
  whenOnline ({ timeoutMs } = {}) {
    if (this.state === 'online' && this._active) return Promise.resolve(this.bot)
    if (this.state === 'stopped') return Promise.reject(codedError(`stopped: ${this._stop?.message ?? 'stopped'}`, 'stopped'))
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null }
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          this._waiters = this._waiters.filter(w => w !== waiter)
          reject(codedError(`not online within ${timeoutMs} ms`, 'timeout'))
        }, timeoutMs)
      }
      this._waiters.push(waiter)
    })
  }

  // Runs a task against the current bot (waiting for it to be online, unless `wait: false`). It rejects with
  // code 'disconnected' as soon as that bot ends, and `signal` aborts at the same moment so the task can clean up.
  async run (task, { wait = true } = {}) {
    if (!wait && !(this.state === 'online' && this._active)) throw codedError('bot is not online', 'disconnected')
    const bot = await this.whenOnline()
    if (!this._active || this.bot !== bot) throw codedError('bot disconnected before the task started', 'disconnected')
    const controller = new AbortController()
    let onEnd
    const ended = new Promise((resolve, reject) => {
      onEnd = () => { controller.abort(); reject(codedError('bot disconnected during the task', 'disconnected')) }
      bot.once('end', onEnd)
    })
    try {
      return await Promise.race([Promise.resolve().then(() => task(bot, controller.signal)), ended])
    } finally {
      bot.removeListener('end', onEnd)
    }
  }

  // Stops for good: cancels a pending retry or sign-in and ends the bot. 'stopped' follows its 'end'.
  stop (reason = 'stopped') {
    if (this._stopping || this._stoppedEmitted) return
    this._stopping = true
    this._stop = { cause: 'stopped', message: String(reason) }
    this._cancelPending()
    this._setState('stopped')
    this._nextAttemptAt = null
    if (this._active) {
      this._hardEnd(this.bot, 'stop')
      // the dead connection might never report its end
      setTimeout(() => this._finalize(), 2000).unref()
    } else {
      process.nextTick(() => this._finalize())
    }
  }

  // Skips the wait and logs in now. The budget still applies (`ignoreBudget` overrides it, for a person who
  // asked), and so does the Microsoft spacing. Restarts a stopped bot. Returns false if a connection is up or
  // being made.
  reconnectNow ({ ignoreBudget = false } = {}) {
    if (this.state === 'connecting' || this.state === 'online') return false
    if (this.state === 'stopped') {
      if (!this._stoppedEmitted) return false
      this._stopping = false
      this._stoppedEmitted = false
      this._stop = null
      this._failures = this._conflicts = this._sessionErrors = this._hungLogins = 0
    }
    this._cancelPending()
    this._nextAttemptAt = null
    this._attempt({ ignoreBudget }).catch(err => this._fail(err))
    return true
  }

  // ── Login history ─────────────────────────────────────────────────────────

  _loadLogins () {
    try {
      const state = this._config.store.load()
      const since = Date.now() - this._config.loginBudget.windowMs
      const valid = (list) => (Array.isArray(list) ? list : []).filter(t => Number.isFinite(t) && t > since)
      const merged = new Set([...(hostLedger.get(this._hostKey) ?? []), ...valid(state?.hosts?.[this._hostKey])])
      hostLedger.set(this._hostKey, [...merged].sort((a, b) => a - b))
      return valid(state?.logins).sort((a, b) => a - b)
    } catch { return [] }
  }

  _recentHostLogins (now = Date.now()) {
    const since = now - this._config.loginBudget.windowMs
    return (hostLedger.get(this._hostKey) ?? []).filter(t => t > since)
  }

  _recentLogins (now = Date.now()) {
    const since = now - this._config.loginBudget.windowMs
    return this._logins.filter(t => t > since)
  }

  // Records a login (or the slot for one) and returns its timestamp
  _noteLogin () {
    const now = Date.now()
    this._logins = [...this._recentLogins(now), now]
    this._saveLogins([...this._recentHostLogins(now), now])
    return now
  }

  // Gives a recorded slot back: the login it was for never happened
  _releaseLogin (stamp) {
    if (stamp == null) return
    const without = (list) => {
      const i = list.lastIndexOf(stamp)
      return i < 0 ? list : [...list.slice(0, i), ...list.slice(i + 1)]
    }
    this._logins = without(this._logins)
    this._saveLogins(without(hostLedger.get(this._hostKey) ?? []))
  }

  _saveLogins (host) {
    hostLedger.set(this._hostKey, host)
    try { this._config.store.save({ logins: this._logins, hosts: { [this._hostKey]: host } }) } catch { /* in-memory history still counts */ }
  }

  // When the budgets have room for another login: the one of this bot and the one of the host, whichever is later
  _budget (now = Date.now()) {
    const { perHour, perHostPerHour, windowMs } = this._config.loginBudget
    const room = (recent, limit) => limit > 0 && recent.length >= limit ? recent[recent.length - limit] + windowMs - now : 0
    const own = this._recentLogins(now)
    const host = this._recentHostLogins(now)
    const ownMs = room(own, perHour)
    const hostMs = room(host, perHostPerHour)
    if (hostMs > ownMs) return { ms: hostMs, reason: 'hostBudget', loginsLastHour: host.length, perHour: perHostPerHour }
    return { ms: ownMs, reason: 'budget', loginsLastHour: own.length, perHour }
  }

  // Milliseconds until the budget has room for another login
  _budgetWaitMs (now = Date.now()) {
    return this._budget(now).ms
  }

  // ── Scheduling ────────────────────────────────────────────────────────────

  _begin () {
    if (this._stopping) return
    // a restart that finds the budget spent (the store remembers) waits instead of logging in
    const wait = this._budgetWaitMs()
    if (wait > 0) this._plan(0, { reason: 'initial' })
    else this._attempt({}).catch(err => this._fail(err))
  }

  // Waits `delayMs` (longer if the budget needs it), then tries again
  _plan (delayMs, { reason, transfer = false, waitingReason = null }) {
    this._cancelPending()
    const now = Date.now()
    const budget = transfer ? { ms: 0 } : this._budget(now)
    const budgetBound = budget.ms > delayMs
    const wait = Math.max(delayMs, budget.ms)
    this._nextAttemptAt = now + wait
    this._setState('waiting')
    if (budgetBound || waitingReason) {
      const info = budgetBound ? budget : this._budget(now)
      this.emit('waiting', {
        until: this._nextAttemptAt,
        delayMs: wait,
        reason: budgetBound ? budget.reason : waitingReason,
        loginsLastHour: info.loginsLastHour,
        perHour: info.perHour
      })
    } else {
      this.emit('reconnecting', { attempt: this._failures, delayMs: wait, at: this._nextAttemptAt, reason })
    }
    this._timer = setTimeout(() => {
      this._timer = null
      this._nextAttemptAt = null
      this._attempt({ transfer }).catch(err => this._fail(err))
    }, wait)
  }

  _cancelPending () {
    clearTimeout(this._timer)
    this._timer = null
    this._abort?.abort()
    this._abort = null
    this._gen++
  }

  async _attempt ({ ignoreBudget = false, transfer = false }) {
    if (this._stopping) return
    const gen = ++this._gen
    this._setState('connecting')
    if (!ignoreBudget && !transfer && this._budgetWaitMs() > 0) {
      this._plan(0, { reason: 'budget' })
      return
    }
    // The slot is taken now, before the wait for the scheduler: bots started in the same turn, and Microsoft bots
    // queued behind each other, must see each other's logins. A transfer is no login.
    let stamp = transfer ? null : this._noteLogin()
    const controller = new AbortController()
    this._abort = controller
    try {
      await scheduler.take(this._config.loginBudget.minSpacingMs, controller.signal)
    } catch {
      this._releaseLogin(stamp) // cancelled by stop() or a newer attempt: no login was made
      return
    }
    if (gen !== this._gen || this._stopping) {
      this._releaseLogin(stamp)
      return
    }
    this._abort = null
    if (stamp != null) {
      // The others may have used the budget while this one waited: look again, without counting the slot being asked
      // for (nothing runs between this and the login, so the answer holds)
      this._releaseLogin(stamp)
      if (!ignoreBudget && this._budgetWaitMs() > 0) {
        this._plan(0, { reason: 'budget' })
        return
      }
      stamp = this._noteLogin()
    }
    this._launch({ transfer, stamp })
  }

  // ── One connection ────────────────────────────────────────────────────────

  // `stamp`: the budget slot taken for this login (null for a transfer, which is another TCP connection of the same
  // player and not a login the budget should pay for)
  _launch ({ transfer, stamp }) {
    const opts = { ...this._botOptions }
    const target = this._nextTarget
    this._nextTarget = null
    if (target) Object.assign(opts, target)

    const state = {
      kick: null,
      error: null,
      hung: false,
      spawnTimedOut: false,
      configError: false,
      watchdogMs: null,
      transfer: null,
      userEnded: false,
      loggedIn: false,
      spawned: false,
      signingIn: false,
      loginTimer: null,
      spawnTimer: null,
      stableTimer: null
    }
    const userOnMsaCode = opts.onMsaCode
    opts.onMsaCode = (data) => {
      // the sign-in waits for a person; the login clock starts once it is done
      state.signingIn = true
      clearTimeout(state.loginTimer)
      this.emit('msaCode', data)
      return userOnMsaCode?.(data)
    }

    let bot
    try {
      bot = require('./loader').createBot(opts)
    } catch (err) {
      // No connection was made, so no login was spent; and it is the options (an unsupported version, a bad value)
      // that are wrong, which waiting does not fix
      this._releaseLogin(stamp)
      this._active = false
      state.configError = true
      this._last.error = { message: String(err?.message ?? err), at: Date.now() }
      this._emitError(err)
      this._decideAndSchedule({ state, text: String(err?.message ?? err), reason: 'config', wasOnline: false, onlineMs: 0 })
      return
    }
    if (!transfer) this._counters.attempts++
    this.bot = bot
    this._active = true
    this._wire(bot, state)
    this._armLoginTimer(bot, state)
    this.emit('bot', bot)
    try { this._onBot?.(bot) } catch (err) { this._emitError(err) }
  }

  _armLoginTimer (bot, state) {
    clearTimeout(state.loginTimer)
    const ms = this._config.loginTimeoutMs
    if (!(ms > 0) || state.signingIn) return
    state.loginTimer = setTimeout(() => {
      if (this.bot !== bot || state.loggedIn) return
      state.hung = true
      this._hardEnd(bot, 'loginTimeout')
    }, ms)
    state.loginTimer.unref?.()
  }

  // Logged in, waiting to spawn (a queue). Not a sign of throttling, so it is not "hung".
  _armSpawnTimer (bot, state) {
    clearTimeout(state.spawnTimer)
    const ms = this._config.spawnTimeoutMs
    if (!(ms > 0)) return
    state.spawnTimer = setTimeout(() => {
      if (this.bot !== bot || state.spawned) return
      state.spawnTimedOut = true
      this._hardEnd(bot, 'spawnTimeout')
    }, ms)
    state.spawnTimer.unref?.()
  }

  _wire (bot, state) {
    const client = bot._client
    // a plain bot.end() from the user is final; our own ends go through _hardEnd and leave this flag alone
    const end = bot.end
    bot.end = (reason) => {
      if (this.bot === bot) state.userEnded = true
      return end.call(bot, reason)
    }

    client.on('connect', () => {
      state.signingIn = false
      if (!state.loggedIn) this._armLoginTimer(bot, state)
    })
    client.on('transfer', (packet) => this._onTransfer(bot, state, packet))
    bot.on('watchdog', (silentMs) => { state.watchdogMs = silentMs })
    bot.on('kicked', (reason) => {
      state.kick = reasonText(reason) || 'kicked'
      this._counters.kicks++
      this._last.kick = { reason: state.kick, at: Date.now() }
    })
    bot.on('error', (err) => {
      state.error = err
      this._last.error = { message: String(err?.message ?? err), code: err?.code, at: Date.now() }
      this._emitError(err)
      // Auth and DNS failures happen before any socket exists, and no 'end' follows them
      if (!client.socket && this.bot === bot) this._hardEnd(bot, 'error')
    })
    bot.on('login', () => {
      this._counters.logins++
      if (this.bot === bot && !state.loggedIn) {
        // the server got as far as the play state: it is not throttling this connection
        state.loggedIn = true
        clearTimeout(state.loginTimer)
        this._hungLogins = 0
        if (!state.spawned) this._armSpawnTimer(bot, state)
      }
      this.emit('login', bot)
    })
    bot.on('spawn', () => {
      if (this.bot !== bot) return
      if (!state.spawned) this._onFirstSpawn(bot, state)
      this.emit('spawn', bot)
    })
    bot.on('end', (reason) => this._onEnd(bot, state, reason))
  }

  _onFirstSpawn (bot, state) {
    state.spawned = true
    clearTimeout(state.loginTimer)
    clearTimeout(state.spawnTimer)
    this._hungLogins = 0
    this._onlineAt = Date.now()
    this._setState('online')
    // a login that is kicked a second later must not reset the backoff
    state.stableTimer = setTimeout(() => { this._failures = 0; this._conflicts = 0; this._sessionErrors = 0 }, this._config.stableMs)
    state.stableTimer.unref?.()
    const waiters = this._waiters
    this._waiters = []
    for (const w of waiters) { clearTimeout(w.timer); w.resolve(bot) }
  }

  _onTransfer (bot, state, packet) {
    if (this.bot !== bot || state.transfer) return
    state.transfer = { host: packet.host, port: packet.port }
    this._counters.transfers++
    this.emit('transfer', { host: packet.host, port: packet.port })
    // the vanilla client closes the old connection itself
    this._hardEnd(bot, 'transfer', 1000)
  }

  // Ends our own connection. end() alone waits for a dead socket to flush, so the socket is destroyed too.
  _hardEnd (bot, reason, graceMs = 0) {
    const client = bot?._client
    if (!client) return
    client.end(reason)
    if (!client.socket) return
    if (graceMs > 0) setTimeout(() => client.socket?.destroy(), graceMs).unref()
    else client.socket.destroy()
  }

  _onEnd (bot, state, endReason) {
    if (this.bot !== bot || !this._active) return
    this._active = false
    clearTimeout(state.loginTimer)
    clearTimeout(state.spawnTimer)
    clearTimeout(state.stableTimer)
    const wasOnline = this._onlineAt != null
    const onlineMs = wasOnline ? Date.now() - this._onlineAt : 0
    this._onlineAt = null

    let text
    if (state.kick) text = state.kick
    else if (state.userEnded) text = String(endReason ?? 'ended by the user')
    else if (endReason === 'watchdog') text = `watchdog: no packets for ${state.watchdogMs ?? '?'} ms`
    else if (endReason === 'loginTimeout') text = `loginTimeout: no login within ${this._config.loginTimeoutMs} ms`
    else if (endReason === 'spawnTimeout') text = `spawnTimeout: no spawn within ${this._config.spawnTimeoutMs} ms of the login`
    else if (state.error && ['socketClosed', 'error', undefined].includes(endReason)) text = String(state.error.message ?? state.error)
    else text = String(endReason ?? 'socketClosed')
    this._last.end = { reason: text, at: Date.now() }

    this._decideAndSchedule({ state, text, reason: endReason, wasOnline, onlineMs })
  }

  // ── Decisions ─────────────────────────────────────────────────────────────

  _decideAndSchedule ({ state, text, reason, wasOnline, onlineMs }) {
    const decision = this._decide({ state, text, wasOnline, onlineMs })
    if (decision.action === 'stop') {
      this.emit('end', text, { ...decision, at: null, endReason: reason })
      this._stop = this._stop ?? { cause: decision.cause, message: decision.message }
      this._setState('stopped')
      this._finalize()
      return
    }
    // the budget can hold the retry back longer than the backoff
    const transfer = decision.cause === 'transfer'
    const budget = transfer ? { ms: 0 } : this._budget()
    const delayMs = Math.max(decision.delayMs, budget.ms)
    const { waitingReason, ...shown } = decision
    this.emit('end', text, { ...shown, delayMs, at: Date.now() + delayMs, blockedBy: budget.ms > decision.delayMs ? budget.reason : null, endReason: reason })
    this._plan(decision.delayMs, { reason: decision.cause, transfer, waitingReason })
  }

  _decide ({ state, text, wasOnline, onlineMs }) {
    const config = this._config
    const stop = (cause, message) => ({ action: 'stop', cause, message: message ?? text, delayMs: 0 })

    if (this._stopping) return stop('stopped', this._stop?.message)
    if (state.userEnded) return stop('user')
    if (state.configError) return stop('config', `cannot create the bot, check the options: ${text}`)
    if (state.transfer) {
      const now = Date.now()
      this._transfers = this._transfers.filter(t => t > now - 60_000)
      this._transfers.push(now)
      if (this._transfers.length <= config.maxTransfersPerMinute) {
        this._nextTarget = state.transfer
        return { action: 'retry', cause: 'transfer', delayMs: config.transferDelayMs }
      }
      // two servers handing the player to each other
      this._transfers = []
      return this._timed('wait', 'transfer-loop', config.longWaitMs)
    }
    if (!config.enabled) return stop('reconnect-disabled')

    if (onlineMs >= config.stableMs) this._failures = this._conflicts = this._sessionErrors = 0
    if (state.hung) {
      this._hungLogins++
      this._counters.hungLogins++
      const limit = config.hungLoginLimit
      if (limit > 0 && this._hungLogins >= limit) {
        if (config.hungLoginResumeMs > 0) {
          // one try per resume: a single further hang sends it back to waiting
          this._hungLogins = limit - 1
          return { action: 'wait', cause: 'throttled', delayMs: config.hungLoginResumeMs, waitingReason: 'throttled' }
        }
        return stop('throttled', `${this._hungLogins} logins in a row never reached the play state: the server isn't letting this connection in (probably throttled). Stopped reconnecting; try again later.`)
      }
    }

    let verdict = null
    if (typeof config.classify === 'function') {
      try { verdict = config.classify(text, { kicked: state.kick != null, error: state.error ?? null, wasOnline, onlineMs, hung: state.hung }) } catch (err) { this._emitError(err) }
    }
    if (verdict === 'stop') return stop('classify')
    let action = verdict === 'retry' || verdict === 'wait' ? verdict : null
    let cause = action ? 'classify' : 'network'
    if (!action) {
      if (config.giveUpOn.some(p => matches(p, text))) return stop('give-up', `gave up: ${text}`)
      if (CONFLICT.test(text)) {
        // the server may not have noticed the old connection yet; three in a row means someone else is logged in
        if (++this._conflicts > config.conflictLimit) return stop('conflict', `another session keeps the account (${text}); not logging in again so it is not kicked`)
        action = 'wait'
        cause = 'conflict'
      } else if (SESSION.test(text)) {
        // the session server may be down for a few minutes; the same answer three times in a row is the account
        if (++this._sessionErrors > config.sessionErrorLimit) return stop('session', `the session could not be verified ${this._sessionErrors} times in a row (${text}); check the account's sign-in`)
        action = 'wait'
        cause = 'session'
      } else if (RATE_LIMITED.test(text)) {
        action = 'wait'
        cause = 'rate-limit'
        scheduler.penalize(config.longWaitMs)
      } else if (RESTARTING.test(text)) {
        action = 'wait'
        cause = 'server-restart'
      } else {
        action = 'retry'
        if (state.hung) cause = 'hung-login'
        else if (state.spawnTimedOut) cause = 'spawn-timeout'
        else if (reasonIsWatchdog(text)) cause = 'watchdog'
        else if (state.kick != null) cause = 'kicked'
      }
    }

    this._failures++
    if (config.maxAttempts > 0 && this._failures > config.maxAttempts) return stop('max-attempts', `gave up after ${config.maxAttempts} reconnect attempts: ${text}`)
    return this._timed(action, cause, action === 'wait' ? config.longWaitMs : 0)
  }

  _timed (action, cause, floorMs) {
    const config = this._config
    const exp = config.baseDelayMs * 2 ** Math.max(0, this._failures - 1)
    let delayMs = Math.min(config.maxDelayMs, exp)
    const jitter = Math.min(1, Math.max(0, config.jitter))
    delayMs = Math.max(floorMs, Math.round(delayMs * (1 + (Math.random() * 2 - 1) * jitter)))
    return { action, cause, delayMs }
  }

  // ── State and events ──────────────────────────────────────────────────────

  _setState (state) {
    if (this.state === state) return
    const previous = this.state
    this.state = state
    this.emit('state', state, previous)
  }

  _finalize () {
    if (this._stoppedEmitted) return
    this._stoppedEmitted = true
    this._setState('stopped')
    this._nextAttemptAt = null
    const { cause, message } = this._stop ?? { cause: 'stopped', message: 'stopped' }
    for (const w of this._waiters.splice(0)) { clearTimeout(w.timer); w.reject(codedError(`stopped: ${message}`, 'stopped')) }
    this.emit('stopped', message, cause)
  }

  // An 'error' event nobody listens to would throw; a connection keeper must not take the process down
  _emitError (err) {
    if (this.listenerCount('error') > 0) this.emit('error', err instanceof Error ? err : new Error(String(err)))
  }

  _fail (err) {
    this._emitError(err)
  }
}

function reasonIsWatchdog (text) {
  return text.startsWith('watchdog:')
}

function createPersistentBot (options) {
  return new PersistentBot(options)
}

module.exports = {
  createPersistentBot,
  PersistentBot,
  fileStore,
  memoryStore,
  LoginScheduler,
  scheduler,
  hostLedger,
  reasonText,
  DEFAULT_GIVE_UP_ON,
  DEFAULT_RECONNECT
}
