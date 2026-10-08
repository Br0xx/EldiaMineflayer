// Small helpers shared by the bench
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const round = (n, digits = 4) => typeof n === 'number' && Number.isFinite(n) ? Number(n.toFixed(digits)) : n
const vec = (v) => v ? [round(v.x, 3), round(v.y, 3), round(v.z, 3)] : null
const hdist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)

// "90" or "90s" -> 90000, "5m" -> 300000, "1h" -> 3600000. A bare number is seconds.
function parseDuration (text) {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(String(text).trim())
  if (!m) throw new Error(`bad duration "${text}" (use 90, 90s, 5m or 1h)`)
  const unit = { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2] ?? 's']
  return Math.round(Number(m[1]) * unit)
}

const stamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, '-')

class Skip extends Error {
  constructor (reason) { super(reason); this.name = 'Skip'; this.reason = reason }
}
// The scenario could not test what it wanted (an obstacle in the way, ...): a skip, unless the server pushed back
class Inconclusive extends Error {
  constructor (reason) { super(reason); this.name = 'Inconclusive'; this.reason = reason }
}

module.exports = { sleep, round, vec, hdist, parseDuration, stamp, Skip, Inconclusive }
