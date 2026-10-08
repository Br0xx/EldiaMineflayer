// A local validator for the packet-order rules of the Grim anticheat, run over the stream of packets the bot writes.
// Grim's window semantics (G/checks/impl/packetorder/PacketOrderProcessor.java): a "window" is the run of packets
// between two tick packets. A tick packet is a movement packet that is not the answer to a teleport, or, on
// clients that send tick_end, a tick_end that follows no movement packet. The per-window booleans are cleared on
// every tick packet. keep_alive, chunk_batch_received and resource_pack_receive are exempt ("async"); pong is not.
//
// Rules (Grim check names) covered: BadPacketsA/D/H/J/L/X/Z, AimDuplicateLook, AimModulo360, PacketOrderB/C/E/F/G/H/
// I/J/L/M/N/O, MultiPlace, NoSwingBreak, PositionBreakA/B (an abort with a face is followed by a START with it), PositionPlace, FarBreak, FarPlace, FastBreak (the 6 ticks
// between a FINISH and the next START), WrongBreak (FINISH of another block than the START), InvalidInteractCursor
// (for the entity ids in opts.players), VehicleA, TickTimer (two movements before tick_end), Post.
// The block geometry rules treat a block as its whole cell and the eyes as a box between the sneaking (1.27) and the
// standing (1.62) height above the last position sent, like Grim.
// Known gaps: no Timer budget model (see `ticksPerSecond`), no entity reach/hitbox geometry, no FastBreak by damage,
// entity_action ids are matched by name or the pre-1.21.6 numbering.
//
// usage:  const lint = grimLint(bot)            // throws on the first violation, from inside bot._client.write
//         const lint = grimLint(bot, { report })  // collect instead: report(id, message)
//         lint.violations                         // every violation seen (also when report throws)
//         lint.detach()
const LEGACY_ACTIONS = ['start_sneaking', 'stop_sneaking', 'leave_bed', 'start_sprinting', 'stop_sprinting']
const MOVE = new Set(['position', 'position_look', 'look', 'flying'])
const ASYNC = new Set(['keep_alive', 'chunk_batch_received', 'resource_pack_receive'])
// What Grim's Post check watches for after a movement packet
const POST = new Set(['held_item_slot', 'use_entity', 'attack', 'block_place', 'use_item', 'block_dig', 'entity_action', 'abilities'])

module.exports = function grimLint (bot, opts = {}) {
  const version = bot.registry.version
  const hasTickEnd = bot.supportFeature('sendsClientTickEndPacket')
  // PacketOrderC (interact-at/interact pairs) ends with 26.1, which merged the two packets
  const pairedInteract = !bot.supportFeature('attackUsesOwnPacket')
  // PacketOrderH: clients >= 1.21.2 send sneak before sprint, clients < 1.21.2 sprint before sneak
  const sneakFirst = version['>='](hasTickEnd ? '1.21.2' : '99')
  const sneakByAction = version['<']('1.21.6')
  const shiftedActions = version['>=']('26.3')
  const violations = []
  const report = opts.report ?? ((id, msg) => { throw new Error(`[grimLint ${id}] ${msg}`) })

  const w = {}
  let moved = false // a movement packet was written and tick_end has not followed yet
  let sentFlying = false // a movement packet was seen since the last pong
  let post = []
  let teleportNext = false
  let pendingRotation = null // a server player_rotation not answered yet
  let inputsThisTick = 0
  let lastSlot = -1
  let lastSeq = 0
  let lastRot = null
  let pendingUse = null
  const tickTimes = []
  let feet = null // the last position sent
  let windows = 0 // tick packets so far
  let lastFinishWindow = -Infinity
  let lastStart = null // location of the last START
  let abortFace = null // the face of an abort that the next break packet has to repeat
  const players = opts.players ?? new Set()

  const reset = () => Object.assign(w, {
    names: [],
    primary: new Set(),
    sprint: 0,
    sneak: 0,
    place: null,
    swing: false,
    digPkt: false,
    sprintSeen: false,
    sneakSeen: false,
    dropSeen: false,
    entityAt: null,
    swingDue: false,
    useItem: false,
    attacked: false,
    interacted: false
  })
  reset()

  const actionName = (id) => typeof id === 'number' ? LEGACY_ACTIONS[id] ?? String(id) : id
  const bad = (id, msg) => {
    const text = `${msg}  [window: ${w.names.join(' ')}]`
    violations.push({ id, message: text })
    report(id, text)
  }
  const primary = (cls) => {
    const clash = [...w.primary].filter(c => c !== cls || cls === 'release')
    if (clash.length) bad('PacketOrderI/J/M/MultiActionsF', `${cls} after ${clash.join('+')} in one tick`)
    w.primary.add(cls)
  }
  const sequenced = (what, p) => {
    if (p.sequence === undefined) return
    if (p.sequence !== lastSeq + 1) bad('BadPacketsH', `${what} sequence ${p.sequence}, expected ${lastSeq + 1}`)
    lastSeq = p.sequence
  }

  // The eye positions Grim allows for as a box, and the cell of a block
  const eyeBox = () => feet && { minX: feet.x, maxX: feet.x, minY: feet.y + 1.27, maxY: feet.y + 1.62, minZ: feet.z, maxZ: feet.z }
  const cellOf = (l) => ({ minX: l.x, maxX: l.x + 1, minY: l.y, maxY: l.y + 1, minZ: l.z, maxZ: l.z + 1 })
  const insideCell = (e, c) => e.maxX >= c.minX && e.minX <= c.maxX && e.maxY >= c.minY && e.minY <= c.maxY && e.maxZ >= c.minZ && e.minZ <= c.maxZ
  // PositionBreakA / PositionPlace: the eyes must be on the outer side of the clicked face (BlockFace order)
  const wrongSide = (e, c, face) => [e.minY > c.minY, e.maxY < c.maxY, e.minZ > c.minZ, e.maxZ < c.maxZ, e.minX > c.minX, e.maxX < c.maxX][face] ?? false
  // FarBreak / FarPlace: eyes to cell
  function reachOf (e, c) {
    let best = Infinity
    for (const y of [e.minY, e.maxY]) {
      const dx = Math.max(c.minX - e.minX, 0, e.minX - c.maxX)
      const dy = Math.max(c.minY - y, 0, y - c.maxY)
      const dz = Math.max(c.minZ - e.minZ, 0, e.minZ - c.maxZ)
      best = Math.min(best, Math.hypot(dx, dy, dz))
    }
    return best
  }
  function clickGeometry (what, location, face) {
    const e = eyeBox()
    if (!e || !location) return
    const c = cellOf(location)
    if (reachOf(e, c) > 4.5 + 0.05) bad(`Far${what}`, `the block at ${location.x} ${location.y} ${location.z} is ${reachOf(e, c).toFixed(2)} blocks from the eyes`)
    if (!insideCell(e, c) && wrongSide(e, c, face)) bad(what === 'Break' ? 'PositionBreakA' : 'PositionPlace', `face ${face} of ${location.x} ${location.y} ${location.z} is not turned towards the eyes`)
  }

  function tickPacket () {
    windows++
    if (w.digPkt && !w.swing) bad('NoSwingBreak', 'START/FINISH dig without arm_animation in the window')
    if (w.entityAt !== null) bad('PacketOrderC', 'INTERACT_AT without INTERACT in the window')
    reset()
    sentFlying = true
    tickTimes.push(Date.now())
  }

  function feed (name, p) {
    if (ASYNC.has(name)) return
    if (w.swingDue && name !== 'arm_animation') {
      bad('PacketOrderB', `${name} between attack and arm_animation`)
      w.swingDue = false
    }
    if (name === 'pong') {
      if (moved) bad('PacketOrderO', 'pong between the movement packet and tick_end')
      if (sentFlying && post.length) bad('Post', `${post.join(',')} sent after the movement packet and before this pong`)
      post = []
      sentFlying = false
      return
    }
    if (name === 'teleport_confirm') {
      if (p.x !== undefined) {
        // 26.3+: the confirm carries the position and is the whole answer; the next movement packet is a tick's own
        feet = { x: p.x, y: p.y, z: p.z }
        lastRot = { yaw: p.yRot, pitch: p.xRot, teleport: true }
      } else {
        teleportNext = true
      }
      return
    }
    if (name === 'tick_end') {
      if (!moved) {
        // a tick without a movement packet: the rotation is the one before
        if (pendingUse && lastRot && (pendingUse.x !== lastRot.yaw || pendingUse.y !== lastRot.pitch)) {
          bad('BadPacketsJ', `use_item rotation ${pendingUse.x}/${pendingUse.y} differs from the current rotation ${lastRot.yaw}/${lastRot.pitch}`)
        }
        pendingUse = null
        tickPacket()
      }
      moved = false
      inputsThisTick = 0
      return
    }
    if (MOVE.has(name)) {
      if (p.x !== undefined) feet = { x: p.x, y: p.y, z: p.z }
      if (teleportNext) {
        // the reply to a teleport: not a tick packet. It also resets the rotation the next packet is compared with.
        teleportNext = false
        if (p.yaw !== undefined) lastRot = { yaw: p.yaw, pitch: p.pitch, teleport: true }
        return
      }
      // The answer to a server rotation: Rot in the air with no wall contact, exactly the rotation the server set
      // (Grim reads it as the confirmation, not as a tick). Anything else leaves the rotation unanswered.
      if (pendingRotation && name === 'look') {
        const exact = p.yaw === Math.fround(pendingRotation.yaw) && p.pitch === Math.fround(pendingRotation.pitch)
        const inAir = p.flags ? !p.flags.onGround && !p.flags.hasHorizontalCollision : !p.onGround
        pendingRotation = null
        if (exact && inAir) {
          lastRot = { yaw: p.yaw, pitch: p.pitch, teleport: true }
          return
        }
        bad('BadPacketsB', 'the answer to a server rotation must carry exactly that rotation, in the air, with no wall contact')
      }
      if (moved) bad('TickTimer', 'two movement packets before tick_end')
      if (p.pitch !== undefined && Math.abs(p.pitch) > 90) bad('BadPacketsD', `pitch ${p.pitch}`)
      if (p.yaw !== undefined) {
        if (!Number.isFinite(p.yaw) || !Number.isFinite(p.pitch)) bad('CrashC', `non-finite rotation ${p.yaw}/${p.pitch}`)
        if (lastRot && !lastRot.teleport && lastRot.yaw === p.yaw && lastRot.pitch === p.pitch) bad('AimDuplicateLook', 'rotation unchanged')
        if (lastRot && Math.abs(p.yaw - lastRot.yaw) > 320) bad('AimModulo360', `yaw jump ${(p.yaw - lastRot.yaw).toFixed(1)}`)
        if (pendingUse && (pendingUse.x !== p.yaw || pendingUse.y !== p.pitch)) bad('BadPacketsJ', `use_item rotation ${pendingUse.x}/${pendingUse.y} differs from this tick's movement rotation ${p.yaw}/${p.pitch}`)
        lastRot = { yaw: p.yaw, pitch: p.pitch }
      } else if (pendingUse && lastRot && (pendingUse.x !== lastRot.yaw || pendingUse.y !== lastRot.pitch)) {
        bad('BadPacketsJ', `use_item rotation ${pendingUse.x}/${pendingUse.y} differs from the current rotation ${lastRot.yaw}/${lastRot.pitch}`)
      }
      pendingUse = null
      // without tick_end (< 1.21.2) the movement packet alone closes the window
      if (hasTickEnd) moved = true
      tickPacket()
      return
    }
    if (moved) bad('PacketOrderO', `${name} between the movement packet and tick_end`)
    if (sentFlying && POST.has(name) && !(name === 'entity_action' && actionName(p.actionId) === 'leave_bed')) post.push(name)
    w.names.push(name === 'entity_action' ? `${name}:${actionName(p.actionId)}` : name === 'block_dig' ? `${name}:${shiftedActions && p.status > 0 ? p.status - 1 : p.status}` : name)
    switch (name) {
      case 'held_item_slot':
        if (p.slotId === lastSlot) bad('BadPacketsA', `slot ${p.slotId} twice`)
        lastSlot = p.slotId
        if (w.primary.size || w.sprintSeen || w.sneakSeen) bad('PacketOrderE', 'held_item_slot after another action')
        break
      case 'entity_action': {
        const action = actionName(p.actionId)
        const sprint = /sprinting/.test(action)
        const sneak = /sneaking/.test(action)
        if (sprint) {
          if (w.sprint++) bad('BadPacketsX', 'two sprint packets')
          if (!sneakFirst && w.sneakSeen && sneakByAction) bad('PacketOrderH', 'sprint after sneak')
          w.sprintSeen = true
        }
        if (sneak) {
          if (w.sneak++) bad('BadPacketsX', 'two sneak packets')
          if (sneakFirst && w.sprintSeen) bad('PacketOrderH', 'sneak after sprint')
          w.sneakSeen = true
        }
        break
      }
      case 'player_input':
        if (inputsThisTick++) bad('BadPacketsZ', 'two player_input in one tick')
        break
      case 'steer_vehicle':
        if (Math.abs(p.forward) > Math.fround(0.98) || Math.abs(p.sideways) > Math.fround(0.98)) bad('VehicleA', `impossible input ${p.forward} / ${p.sideways}`)
        if (bot.vehicle === null || bot.vehicle === undefined) bad('VehicleB', 'steer_vehicle while not riding')
        break
      case 'block_dig': {
        // 26.3 inserted CHANGE_DESTROY_DIRECTION at 1: the ids after START are one higher (lib/player_action.js)
        const status = shiftedActions && p.status > 0 ? p.status - 1 : p.status
        if (shiftedActions && p.status === 1) bad('BadPacketsL', 'CHANGE_DESTROY_DIRECTION is not something the bot sends')
        if (status === 0 || status === 2) {
          primary('dig')
          w.digPkt = true
          sequenced('dig', p)
          clickGeometry('Break', p.location, p.face)
          // PositionBreakB: after an abort with a face other than DOWN the next break packet is a START with that face
          if (abortFace !== null && (status !== 0 || p.face !== abortFace)) bad('PositionBreakB', `START/FINISH face ${p.face} after an abort with face ${abortFace}`)
          abortFace = null
          if (status === 0) {
            if (windows - lastFinishWindow < 6) bad('FastBreak', `START ${windows - lastFinishWindow} ticks after the FINISH, vanilla waits 5 ticks of destroy delay`)
            lastStart = p.location
          } else {
            if (lastStart && (lastStart.x !== p.location.x || lastStart.y !== p.location.y || lastStart.z !== p.location.z)) bad('WrongBreak', 'FINISH of another block than the START')
            lastFinishWindow = windows
          }
        } else if (status === 1) {
          if (p.sequence !== undefined && p.sequence !== 0) bad('BadPacketsH', 'abort must carry sequence 0')
          if (p.face !== 0) abortFace = p.face
        } else {
          if ((p.sequence !== undefined && p.sequence !== 0) || p.face !== 0 || p.location.x || p.location.y || p.location.z) {
            bad('BadPacketsL', 'non-dig block_dig must be (0,0,0) face 0 seq 0')
          }
          if (status === 5) primary('release')
          if (w.primary.size && (status === 3 || status === 4 || status === 6)) bad('PacketOrderG', 'drop/swap after another action')
          if (status === 3 || status === 4) w.dropSeen = true
          if (status === 6 && w.dropSeen) bad('PacketOrderL', 'swap after drop')
        }
        break
      }
      case 'block_place': {
        primary('use')
        if (p.direction >= 0 && p.direction <= 5) clickGeometry('Place', p.location, p.direction)
        if (w.useItem) bad('PacketOrderN', 'use_item before block_place')
        sequenced('block_place', p)
        const key = JSON.stringify([p.location, p.direction, p.cursorX, p.cursorY, p.cursorZ])
        if (w.place && w.place !== key) bad('MultiPlace', 'two different placements')
        w.place = key
        if (w.attacked) bad('PacketOrderJ', 'block_place after attack')
        if (w.sprintSeen || w.sneakSeen) bad('PacketOrderF', 'action after sprint/sneak')
        break
      }
      case 'use_item':
        primary('use')
        sequenced('use_item', p)
        if (w.attacked && !w.interacted) bad('PacketOrderJ', 'use_item after attack')
        w.useItem = true
        if (p.rotation) pendingUse = p.rotation
        if (w.sprintSeen || w.sneakSeen) bad('PacketOrderF', 'action after sprint/sneak')
        break
      case 'attack':
        primary('attack')
        w.attacked = true
        w.swingDue = true
        if (w.sprintSeen || w.sneakSeen) bad('PacketOrderF', 'attack after sprint/sneak')
        break
      case 'use_entity':
        if (p.mouse === 1) {
          primary('attack')
          w.attacked = true
          w.swingDue = true
          if (w.sprintSeen || w.sneakSeen) bad('PacketOrderF', 'attack after sprint/sneak')
          break
        }
        primary('use')
        if (p.mouse === 2 && players.has(p.target)) {
          const c = { x: p.x ?? p.location?.x, y: p.y ?? p.location?.y, z: p.z ?? p.location?.z }
          if (!(Math.abs(c.x) < 0.3001 && Math.abs(c.z) < 0.3001 && c.y > -0.0001 && c.y < 1.8001)) bad('InvalidInteractCursor', `hit point ${c.x} ${c.y} ${c.z} is outside a player's hitbox`)
        }
        if (w.sprintSeen || w.sneakSeen) bad('PacketOrderF', 'interact after sprint/sneak')
        if (!pairedInteract) {
          w.interacted = true
          if (p.location && players.has(p.target)) {
            const c = p.location
            if (!(Math.abs(c.x) < 0.3001 && Math.abs(c.z) < 0.3001 && c.y > -0.0001 && c.y < 1.8001)) bad('InvalidInteractCursor', `hit point ${c.x} ${c.y} ${c.z} is outside a player's hitbox`)
          }
        } else if (p.mouse === 2) {
          w.entityAt = p.target
        } else {
          if (w.entityAt !== p.target) bad('PacketOrderC', 'INTERACT without matching INTERACT_AT')
          w.entityAt = null
          w.interacted = true
        }
        break
      case 'arm_animation':
        w.swing = true
        w.swingDue = false
        break
      case 'pick_item':
      case 'pick_item_from_block':
      case 'pick_item_from_entity':
        primary('pick')
        break
    }
  }

  const onRotation = (p) => { pendingRotation = p.relativeYaw || p.relativePitch ? null : { yaw: p.yaw, pitch: p.pitch } }
  bot._client.on('player_rotation', onRotation)

  const original = bot._client.write
  bot._client.write = function (name, params) {
    feed(name, params || {})
    return original.apply(this, arguments)
  }
  return {
    feed,
    violations,
    // ticks in the last second, for a rough Timer check (Grim allows ~20 + a 120 ms drift)
    ticksPerSecond: () => tickTimes.filter(t => t > Date.now() - 1000).length,
    detach: () => {
      bot._client.write = original
      bot._client.removeListener('player_rotation', onRotation)
    }
  }
}
