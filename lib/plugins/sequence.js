module.exports = inject

// One block prediction sequence shared by dig start/stop, use_item_on and use_item. Sent values
// start at 1; abort, release and drop actions send 0 and must not consume a value. Versions
// before 1.19 have no sequence field, so the value is simply not serialized there.
//
// The vanilla client keeps the counter in the level (BlockStatePredictionHandler), so a new world starts it again
// from 0 and the server expects exactly that (Grim: BadPacketsH resets its expectation on a world change). A
// respawn in the same world keeps the count.
function inject (bot) {
  let sequence = 0
  let world = null

  bot._nextSequence = () => ++sequence

  // What names the world in a login / respawn packet: its name from 1.16 on, the dimension id before
  function worldOf (packet) {
    const state = packet.worldState ?? packet
    return String(state.name ?? state.worldName ?? (typeof state.dimension === 'object' ? 'nbt' : state.dimension))
  }

  bot._client.on('login', (packet) => {
    sequence = 0
    world = worldOf(packet)
  })

  bot._client.on('respawn', (packet) => {
    const next = worldOf(packet)
    if (next !== world) sequence = 0
    world = next
  })
}
