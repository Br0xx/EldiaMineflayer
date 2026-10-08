'use strict'
// Minecraft Java 26.2 (protocol 776) data overlay for minecraft-data.
//
// minecraft-data 3.117.0 already lists 26.2 in protocolVersions.json but ships no
// pc/26.2 data, so require('minecraft-data')('26.2') returns null.  This registers the
// 26.2 data (lib/mcdata/26.2/*.json, from minecraft-data PR #1298 / branch pc_26_2) into
// the loaded minecraft-data module(s).  Everything not shipped here (effects,
// enchantments, instruments, mapIcons, blockLoot, entityLoot, commands)
// is taken from the module's own 26.1 entry (upstream 26.2 has newer blockLoot/entityLoot/commands;
// mineflayer reads none of them).
//
// No-op as soon as the installed minecraft-data itself has a 26.2 entry.
const path = require('path')
const { createRequire } = require('module')

const VERSION = '26.2'
const PROTOCOL = 776
const DATA_VERSION = 4903
const DIR = path.join(__dirname, '26.2')
// files shipped in DIR; any other key is inherited from the module's 26.1 entry
const LOCAL = ['attributes', 'biomes', 'blockCollisionShapes', 'blocks', 'entities', 'foods', 'items',
  'language', 'loginPacket', 'materials', 'particles', 'protocol', 'recipes', 'sounds', 'tints', 'version', 'windows']

function patchOne (req) {
  const mcdata = req('minecraft-data')
  const data = req('minecraft-data/data.js') // same object index.js uses (mutable)
  if (data.pc[VERSION]) return 'upstream' // minecraft-data already ships 26.2 -> nothing to do

  // 1. version tables (present in 3.117.0, added defensively for older builds)
  const list = mcdata.versions.pc
  if (!mcdata.versionsByMinecraftVersion.pc[VERSION]) {
    const entry = { minecraftVersion: VERSION, version: PROTOCOL, dataVersion: DATA_VERSION, usesNetty: true, majorVersion: VERSION, releaseType: 'release' }
    list.unshift(entry) // list is newest-first (supportFeature relies on it)
    mcdata.versionsByMinecraftVersion.pc[VERSION] = entry
    ;(mcdata.postNettyVersionsByProtocolVersion.pc[PROTOCOL] ||= []).push(entry)
  }
  if (!mcdata.supportedVersions.pc.includes(VERSION)) mcdata.supportedVersions.pc.push(VERSION)

  // 2. data entry: inherit 26.1's lazy getters, override the shipped files
  const base = data.pc['26.1']
  if (!base) throw new Error('minecraft-data has no 26.1 entry to inherit from')
  const entry = Object.defineProperties({}, Object.getOwnPropertyDescriptors(base))
  for (const key of LOCAL) {
    const file = path.join(DIR, key + '.json')
    Object.defineProperty(entry, key, { enumerable: true, configurable: true, get: () => require(file) })
  }
  data.pc[VERSION] = entry
  return 'patched'
}

// prismarine-chunk (<= 1.41.0) picks its implementation from a closed table keyed by majorVersion
// ('26.1' -> pc/1.18/chunk) and has no '26.2' key.  Replace the module's cached export with a thin
// wrapper that asks the original first and, only if it reports "no implementation" for 26.2,
// builds the same pc/1.18 chunk (it already handles 26.1+ via version comparisons).
function patchChunk (req) {
  let id
  try { id = req.resolve('prismarine-chunk') } catch { return 'absent' }
  const orig = req('prismarine-chunk')
  if (orig.__patched26_2) return 'already'
  const impl = req('prismarine-chunk/src/pc/1.18/chunk')
  const wrapper = function loader (registryOrVersion) {
    const registry = typeof registryOrVersion === 'string' ? req('prismarine-registry')(registryOrVersion) : registryOrVersion
    if (registry?.version?.type === 'pc' && registry.version.majorVersion === VERSION) {
      const err = console.error
      console.error = () => {} // the original logs the TypeError before rethrowing
      try { return orig(registry) } catch { /* no 26.2 entry upstream yet */ } finally { console.error = err }
      return impl(registry)
    }
    return orig(registryOrVersion)
  }
  Object.assign(wrapper, orig)
  wrapper.__patched26_2 = true
  require.cache[id].exports = wrapper
  return 'patched'
}

// prismarine-physics (the npm package, not the fork's lib/physics copy which is edited in place)
// gates its features by an explicit majorVersion list ending at '26.1'.
function patchPhysicsFeatures (req) {
  let features
  try { features = req('prismarine-physics/lib/features.json') } catch { return 'absent' }
  let n = 0
  for (const f of features) {
    if (f.versions.includes('26.1') && !f.versions.includes(VERSION)) { f.versions.push(VERSION); n++ }
  }
  return n
}

// Patches every distinct minecraft-data copy reachable from the given resolution roots
// (the fork itself plus its protocol/prismarine deps, in case npm left nested copies).
function defaultRoots () {
  const roots = [__dirname]
  for (const dep of ['minecraft-protocol', 'prismarine-registry', 'prismarine-chunk', 'prismarine-block', 'prismarine-item', 'prismarine-windows', 'prismarine-physics']) {
    try { roots.push(path.dirname(require.resolve(dep + '/package.json'))) } catch { /* not installed */ }
  }
  return roots
}

function install (roots = defaultRoots()) {
  const seen = new Set()
  const result = []
  for (const root of roots) {
    let req
    try { req = createRequire(path.join(root, 'noop.js')); req.resolve('minecraft-data') } catch { continue }
    const real = req.resolve('minecraft-data')
    if (seen.has(real)) continue
    seen.add(real)
    result.push({ minecraftData: real, data: patchOne(req), chunk: patchChunk(req), physicsFeatures: patchPhysicsFeatures(req) })
  }
  return result
}

module.exports = { install, VERSION, PROTOCOL }
