// What the vanilla client does, as numbers (docs/9bflayer: recorded on 9b9t)

// Horizontal distance moved in tick n after pressing forward from rest on a full block (0.6 slipperiness):
// 0.098, 0.1515, 0.1807, ... d(n+1) = d(n) * 0.546 + 0.098
function walkCurve (n) {
  const out = []
  let d = 0.098
  for (let i = 0; i < n; i++) {
    out.push(d)
    d = d * 0.546 + 0.098
  }
  return out
}

// Height above the start after tick n of a jump: 0.42, 0.7532, 1.0013, 1.1661, 1.2492, ...
function jumpCurve (n) {
  const out = []
  let v = 0.42
  let y = 0
  for (let i = 0; i < n; i++) {
    y += v
    out.push(y)
    v = (v - 0.08) * 0.98
  }
  return out
}

// Largest absolute difference of two lists over the length of the shorter, and where
function compare (actual, expected) {
  let max = 0
  let at = -1
  const n = Math.min(actual.length, expected.length)
  for (let i = 0; i < n; i++) {
    const e = Math.abs(actual[i] - expected[i])
    if (e > max) { max = e; at = i }
  }
  return { max, at, compared: n }
}

module.exports = { walkCurve, jumpCurve, compare }
