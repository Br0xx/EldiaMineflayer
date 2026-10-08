'use strict'
// Data for Minecraft versions that minecraft-data (3.117.0) lists in protocolVersions.json but ships no
// pc/<version> data for, so require('minecraft-data')('26.3') would return null. Each version below has its
// files in lib/mcdata/<version>/*.json (from the unmerged minecraft-data PRs, see docs/9bflayer/research) and
// is registered into every loaded minecraft-data module. Keys not shipped (effects, enchantments,
// instruments, mapIcons, blockLoot, entityLoot, commands, and for 26.3 also attributes, biomes,
// loginPacket, ...) come from the `base` version's entry, so the lazy getters stay lazy.
//
// Also:
// - prismarine-chunk (<= 1.41) has no chunk class for these versions; its export is wrapped to use pc/1.18.
// - 26.3's protocol.json uses the native type `entityDelta`, which minecraft-protocol 1.68 lacks; it is
//   added to the serializer's type tables (see entityDelta.js).
//
// A version is skipped as soon as the installed minecraft-data ships it itself.
const fs = require('fs')
const path = require('path')
const { createRequire } = require('module')

const VERSIONS = [
  { version: '26.2', protocol: 776, dataVersion: 4903, base: '26.1' },
  { version: '26.3', protocol: 777, dataVersion: 5023, base: '26.2' }
]
const SHIPPED = new Map(VERSIONS.map(v => [v.version, v]))

function patchOne (req) {
  const mcdata = req('minecraft-data')
  const data = req('minecraft-data/data.js') // same object index.js uses (mutable)
  const result = {}
  for (const v of VERSIONS) {
    if (data.pc[v.version]) { // 'upstream': minecraft-data ships it, 'installed': this overlay did already
      result[v.version] = data.pc[v.version].__overlay ? 'installed' : 'upstream'
      continue
    }

    // version tables (present in 3.117.0, added defensively for older builds)
    if (!mcdata.versionsByMinecraftVersion.pc[v.version]) {
      const entry = { minecraftVersion: v.version, version: v.protocol, dataVersion: v.dataVersion, usesNetty: true, majorVersion: v.version, releaseType: 'release' }
      mcdata.versions.pc.unshift(entry) // newest first (supportFeature relies on it)
      mcdata.versionsByMinecraftVersion.pc[v.version] = entry
      ;(mcdata.postNettyVersionsByProtocolVersion.pc[v.protocol] ||= []).push(entry)
    }
    if (!mcdata.supportedVersions.pc.includes(v.version)) mcdata.supportedVersions.pc.push(v.version)

    // data entry: the base version's lazy getters, overridden by the shipped files
    const base = data.pc[v.base]
    if (!base) { result[v.version] = 'no ' + v.base + ' base'; continue } // an older minecraft-data some other package brought along
    const entry = Object.defineProperties({}, Object.getOwnPropertyDescriptors(base))
    const dir = path.join(__dirname, v.version)
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      const filePath = path.join(dir, file)
      Object.defineProperty(entry, file.slice(0, -5), { enumerable: true, configurable: true, get: () => require(filePath) })
    }
    Object.defineProperty(entry, '__overlay', { value: true })
    data.pc[v.version] = entry
    result[v.version] = 'patched'
  }
  return result
}

// prismarine-chunk's table is closed and keyed by majorVersion. Replace the module's cached export with a
// wrapper that asks the original first and, only if it has no implementation for a shipped version, builds the
// pc/1.18 chunk (it already branches on version comparisons for 26.1+).
function patchChunk (req) {
  let id
  try { id = req.resolve('prismarine-chunk') } catch { return 'absent' }
  const orig = req('prismarine-chunk')
  if (orig.__patchedOverlay) return 'already'
  const impl = req('prismarine-chunk/src/pc/1.18/chunk')
  const wrapper = function loader (registryOrVersion) {
    const registry = typeof registryOrVersion === 'string' ? req('prismarine-registry')(registryOrVersion) : registryOrVersion
    if (registry?.version?.type === 'pc' && SHIPPED.has(registry.version.majorVersion)) {
      const err = console.error
      console.error = () => {} // the original logs the TypeError before rethrowing
      try { return orig(registry) } catch { /* no entry upstream yet */ } finally { console.error = err }
      return impl(registry)
    }
    return orig(registryOrVersion)
  }
  Object.assign(wrapper, orig)
  wrapper.__patchedOverlay = true
  require.cache[id].exports = wrapper
  return 'patched'
}

// minecraft-protocol builds its serializers from datatypes/minecraft.js (interpreted) and
// datatypes/compiler-minecraft.js (compiled) when the first packet of a version is created: add `entityDelta`
// to both before that.
function patchNative (req) {
  let types, compiler, protodef
  try {
    types = req('minecraft-protocol/src/datatypes/minecraft')
    compiler = req('minecraft-protocol/src/datatypes/compiler-minecraft')
    protodef = req('protodef')
  } catch { return 'absent' }
  if (types.entityDelta) return 'present'
  const fns = require('./entityDelta')(protodef)
  types.entityDelta = fns
  compiler.Read.entityDelta = ['native', fns[0]]
  compiler.Write.entityDelta = ['native', fns[1]]
  compiler.SizeOf.entityDelta = ['native', fns[2]]
  return 'patched'
}

// Every distinct minecraft-data copy reachable from the fork and its protocol/prismarine deps.
function defaultRoots () {
  const roots = [__dirname]
  for (const dep of ['minecraft-protocol', 'prismarine-registry', 'prismarine-chunk', 'prismarine-block', 'prismarine-item', 'prismarine-windows']) {
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
    result.push({ minecraftData: real, data: patchOne(req), chunk: patchChunk(req), native: patchNative(req) })
  }
  return result
}

module.exports = { install, VERSIONS: VERSIONS.map(v => v.version) }
