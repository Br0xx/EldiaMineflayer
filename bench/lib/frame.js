// What one scenario collects while it runs. The session writes into the current frame; the runner turns it into
// the scenario's entry in the report.
const MAX_INCIDENTS = 12

class Frame {
  constructor (name, session) {
    this.name = name
    this.session = session
    this.startedAt = Date.now()
    this.setbacks = []
    this.kicks = []
    this.errors = []
    this.violations = []
    this.alerts = []
    this.watchdog = []
    this.failures = []
    this.notes = []
    this.metrics = {}
    this.incidents = []
    this.incidentsDropped = 0
    this.serverRotations = 0
    this.forcedMoves = 0
    this.buckets = new Map()
    this.ticks = 0
  }

  get elapsed () { return Date.now() - this.startedAt }

  bump (kind) {
    const minute = Math.floor(this.elapsed / 60000)
    if (!this.buckets.has(minute)) this.buckets.set(minute, {})
    const b = this.buckets.get(minute)
    b[kind] = (b[kind] ?? 0) + 1
  }

  // A trace window around "now", written to a file when the scenario ends
  incident (kind, label) {
    if (this.incidents.length >= MAX_INCIDENTS) {
      this.incidentsDropped++
      return null
    }
    const inc = this.session.openIncident(kind, label)
    inc.n = this.incidents.length + 1
    this.incidents.push(inc)
    return inc
  }

  note (text) { this.notes.push(text); this.session.log(`  . ${text}`) }

  metric (name, value) { this.metrics[name] = value }

  addSetback (s) {
    this.bump('setbacks')
    const inc = this.incident('setback', `setback ${this.setbacks.length + 1}: moved ${s.distance.toFixed(3)} blocks`)
    this.setbacks.push({ ...s, atMs: this.elapsed, incident: inc?.n ?? null })
    this.session.log(`  ! setback of ${s.distance.toFixed(3)} blocks at tick ${s.tick}`)
  }

  addKick (kind, reason) {
    this.bump('kicks')
    const inc = this.incident('kick', `${kind}: ${reason}`)
    this.kicks.push({ kind, reason, atMs: this.elapsed, tick: this.session.tick, incident: inc?.n ?? null })
    this.session.log(`  ! ${kind}: ${reason}`)
  }

  addError (message) {
    this.bump('errors')
    this.errors.push({ message: String(message), atMs: this.elapsed })
    this.session.log(`  ! error: ${message}`)
  }

  addViolation (id, message) {
    this.bump('violations')
    const inc = this.incident('lint', `grimLint ${id}`)
    this.violations.push({ id, message, tick: this.session.tick, atMs: this.elapsed, incident: inc?.n ?? null })
    this.session.log(`  ! grimLint ${id}: ${message}`)
  }

  addAlert (text, self) {
    this.bump('alerts')
    this.alerts.push({ text, self, atMs: this.elapsed, tick: this.session.tick })
    this.session.log(`  ! server message that looks like an anticheat alert: ${text}`)
  }

  addWatchdog (kind, ms, fatal) {
    this.bump('watchdog')
    this.watchdog.push({ kind, ms, fatal, atMs: this.elapsed })
    this.session.log(`  ! watchdog ${kind} ${ms} ms`)
  }

  fail (message, data) {
    const inc = this.incident('fail', message)
    this.failures.push({ message, data, atMs: this.elapsed, tick: this.session.tick, incident: inc?.n ?? null })
    this.session.log(`  x ${message}`)
  }
}

module.exports = { Frame }
