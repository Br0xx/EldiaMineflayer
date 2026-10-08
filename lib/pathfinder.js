// mineflayer-pathfinder without its "kind of cheaty" stop. Ported from EBS's pathfinderNoSnap.
//
// When the pathfinder reaches a goal (or stops), its fullStop() zeroes the bot's horizontal velocity and, if the bot
// is more than 0.2 off the block centre, moves it straight onto the centre:
//
//     // Kind of cheaty, but the server will not tell the difference
//     bot.entity.velocity.x = 0 ... bot.entity.position.x = blockX
//
// Grim does tell the difference: a vanilla player can't stop dead or slide half a block in one tick, so every
// arrival earned a setback on 9b9t. This loads a private copy of the installed pathfinder whose fullStop only
// releases the keys; the bot coasts to a stop like a player (about 0.15 blocks past the point at walking speed).
// node_modules is left untouched. If the function isn't found (a different pathfinder version) it throws instead
// of guessing.
//
//   const { pathfinder, Movements, goals } = require('9bflayer/pathfinder').loadPathfinder()
const fs = require('fs')
const path = require('path')
const Module = require('module')

const FULL_STOP = /function fullStop \(\) \{\n[\s\S]*?\n {2}\}\n/
const cache = new Map()

// `fromRequire` is where mineflayer-pathfinder is looked up from: a require function (e.g. the caller's own
// `require`), or a path/URL of a file or directory. Defaults to the main script, else the working directory.
function loadPathfinder (fromRequire) {
  let resolve
  if (typeof fromRequire === 'function') {
    resolve = (id) => fromRequire.resolve(id)
  } else {
    let from = fromRequire ?? require.main?.filename ?? process.cwd()
    if (from.startsWith('file:')) from = new URL(from).pathname
    from = path.resolve(from)
    // createRequire treats a path as a file; a directory needs the trailing separator
    if (fs.existsSync(from) && fs.statSync(from).isDirectory()) from += path.sep
    resolve = (id) => Module.createRequire(from).resolve(id)
  }
  const file = resolve('mineflayer-pathfinder')
  if (cache.has(file)) return cache.get(file)

  const source = fs.readFileSync(file, 'utf8')
  if (!FULL_STOP.test(source) || !source.includes('Kind of cheaty')) {
    throw new Error(`mineflayer-pathfinder at ${file} has no fullStop() as expected; check the patch for this version`)
  }
  const patched = source.replace(FULL_STOP, 'function fullStop () {\n    bot.clearControlStates()\n  }\n')
  const mod = new Module(`${file}#no-snap`, null)
  mod.filename = file // so its own require('./lib/...') and dependencies resolve next to the original
  mod.paths = Module._nodeModulePaths(path.dirname(file))
  mod._compile(patched, file)
  cache.set(file, mod.exports)
  return mod.exports
}

module.exports = { loadPathfinder }
