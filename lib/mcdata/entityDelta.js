'use strict'
// 26.3 ClientboundMoveEntityPacket delta (rel_entity_move, entity_move_look): the native protodef type
// `entityDelta` that the 26.3 protocol.json references. node-minecraft-protocol 1.68 doesn't have it
// (upstream PR PrismarineJS/node-minecraft-protocol#1538), so overlay.js registers it at load time.
//
// Wire: varint `properties` (bit 0 = onGround, the rest = stepCount), then
//   stepCount <= 0: dX, dY, dZ as i16 (the old flat form), or
//   stepCount  > 0: stepCount x { ticks: varint, dX: i16, dY: i16, dZ: i16 }.
// Value: { onGround, steps: [{ dX, dY, dZ, ticks }] }; the flat form is one step with ticks 0.
module.exports = function entityDelta (protodef) {
  const { PartialReadError } = protodef.utils
  const [readVarInt, writeVarInt, sizeOfVarInt] = protodef.types.varint

  function read (buffer, offset) {
    let cursor = offset
    const props = readVarInt(buffer, cursor)
    cursor += props.size
    const stepCount = props.value >>> 1
    const steps = []
    for (let i = 0; i < Math.max(stepCount, 1); i++) {
      let ticks = 0
      if (stepCount > 0) {
        const t = readVarInt(buffer, cursor)
        ticks = t.value
        cursor += t.size
      }
      if (cursor + 6 > buffer.length) throw new PartialReadError('entityDelta')
      steps.push({ dX: buffer.readInt16BE(cursor), dY: buffer.readInt16BE(cursor + 2), dZ: buffer.readInt16BE(cursor + 4), ticks })
      cursor += 6
    }
    return { value: { onGround: (props.value & 1) !== 0, steps }, size: cursor - offset }
  }

  const flat = steps => steps.length === 1 && !steps[0].ticks
  const properties = ({ onGround, steps }) => (onGround ? 1 : 0) | ((flat(steps) ? 0 : steps.length) << 1)

  function write (value, buffer, offset) {
    offset = writeVarInt(properties(value), buffer, offset)
    for (const step of value.steps) {
      if (!flat(value.steps)) offset = writeVarInt(step.ticks, buffer, offset)
      offset = buffer.writeInt16BE(step.dX, offset)
      offset = buffer.writeInt16BE(step.dY, offset)
      offset = buffer.writeInt16BE(step.dZ, offset)
    }
    return offset
  }

  function sizeOf (value) {
    let size = sizeOfVarInt(properties(value))
    for (const step of value.steps) size += (flat(value.steps) ? 0 : sizeOfVarInt(step.ticks)) + 6
    return size
  }

  return [read, write, sizeOf]
}
