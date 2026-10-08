// 9b9t sits behind ViaBackwards, which sends some packets (custom item components) that protodef cannot decode.
// The vanilla client decodes them fine: the gap is in minecraft-data's schema, not in the packets. Unguarded, protodef
// throws "Read error for ..." and minecraft-protocol turns that into a client error that drops the bot. Such packets
// are skipped instead and counted. Ported from EBS's protodefGuard.
const path = require('path')
const { createRequire } = require('module')

const SKIPPABLE = ['array size is abnormally large', 'Deserialization error', 'Read error for', 'not reading:']
const GUARD = Symbol.for('9bflayer.protodefGuard')

let skipped = 0

function protodefSkipped () {
  return skipped
}

function compiledProtodefPrototype () {
  // The protodef instance minecraft-protocol (and so this bot) actually uses, which is not necessarily
  // the one a plain require('protodef') from here would find.
  const nmpDir = path.dirname(require.resolve('minecraft-protocol/package.json'))
  const compiler = createRequire(path.join(nmpDir, 'index.js'))('protodef').Compiler
  if (compiler.CompiledProtodef) return compiler.CompiledProtodef.prototype
  try {
    return Object.getPrototypeOf(new compiler.ProtoDefCompiler().compileProtoDefSync())
  } catch {
    return null
  }
}

// Returns false when protodef's internals are not as expected (nothing was patched).
function installProtodefGuard () {
  const proto = compiledProtodefPrototype()
  if (!proto || typeof proto.parsePacketBuffer !== 'function') return false
  if (proto[GUARD]) return true
  const parsePacketBuffer = proto.parsePacketBuffer
  proto.parsePacketBuffer = function (type, buffer, offset = 0) {
    try {
      return parsePacketBuffer.call(this, type, buffer, offset)
    } catch (e) {
      const msg = String(e?.message ?? e)
      if (!SKIPPABLE.some(s => msg.includes(s))) throw e
      skipped++
      // An empty "unknown" packet that claims to have consumed the whole buffer, so no one logs a size mismatch.
      return {
        data: { name: 'unknown', params: {} },
        metadata: { size: buffer.length, name: 'unknown' },
        buffer: Buffer.alloc(0),
        fullBuffer: buffer
      }
    }
  }
  proto[GUARD] = true
  return true
}

module.exports = { installProtodefGuard, protodefSkipped }
