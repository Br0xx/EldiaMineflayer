// A local validator for the packet-order rules of the Grim anticheat, run over the stream of packets the bot writes.
// Grim's window semantics (G/checks/impl/packetorder/PacketOrderProcessor.java): a "window" is the run of packets
// between two tick packets. A tick packet is a movement packet that is not the answer to a teleport, or, on
// clients that send tick_end, a tick_end that follows no movement packet. The per-window booleans are cleared on
// every tick packet. keep_alive, chunk_batch_received and resource_pack_receive are exempt ("async"); pong is not.
//
// Rules (Grim check names) covered: BadPacketsA/D/H/J/L/X/Z, AimDuplicateLook, AimModulo360, PacketOrderB/C/E/F/G/H/
// I/J/L/M/N/O, MultiPlace, NoSwingBreak, PositionBreakB (abort face), TickTimer (two movements before tick_end), Post.
// Known gaps: no Timer budget model (see `ticksPerSecond`), no reach/hitbox geometry, entity_action ids are matched
// by name or the pre-1.21.6 numbering.
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

  function tickPacket () {
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
      teleportNext = true
      return
    }
    if (name === 'tick_end') {
      if (!moved) tickPacket()
      moved = false
      inputsThisTick = 0
      return
    }
    if (MOVE.has(name)) {
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
        if (pendingUse && (pendingUse.x !== p.yaw || pendingUse.y !== p.pitch)) bad('BadPacketsJ', "use_item rotation differs from this tick's movement rotation")
        lastRot = { yaw: p.yaw, pitch: p.pitch }
      } else if (pendingUse && lastRot && (pendingUse.x !== lastRot.yaw || pendingUse.y !== lastRot.pitch)) {
        bad('BadPacketsJ', 'use_item rotation differs from the current rotation')
      }
      pendingUse = null
      // without tick_end (< 1.21.2) the movement packet alone closes the window
      if (hasTickEnd) moved = true
      tickPacket()
      return
    }
    if (moved) bad('PacketOrderO', `${name} between the movement packet and tick_end`)
    if (sentFlying && POST.has(name) && !(name === 'entity_action' && actionName(p.actionId) === 'leave_bed')) post.push(name)
    w.names.push(name === 'entity_action' ? `${name}:${actionName(p.actionId)}` : name === 'block_dig' ? `${name}:${p.status}` : name)
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
      case 'block_dig':
        if (p.status === 0 || p.status === 2) {
          primary('dig')
          w.digPkt = true
          sequenced('dig', p)
        } else if (p.status === 1) {
          if (p.sequence !== undefined && p.sequence !== 0) bad('BadPacketsH', 'abort must carry sequence 0')
          if (p.face !== 0 && !w.primary.has('dig')) bad('PositionBreakB', `abort face ${p.face}`)
        } else {
          if ((p.sequence !== undefined && p.sequence !== 0) || p.face !== 0 || p.location.x || p.location.y || p.location.z) {
            bad('BadPacketsL', 'non-dig block_dig must be (0,0,0) face 0 seq 0')
          }
          if (p.status === 5) primary('release')
          if (w.primary.size && (p.status === 3 || p.status === 4 || p.status === 6)) bad('PacketOrderG', 'drop/swap after another action')
          if (p.status === 3 || p.status === 4) w.dropSeen = true
          if (p.status === 6 && w.dropSeen) bad('PacketOrderL', 'swap after drop')
        }
        break
      case 'block_place': {
        primary('use')
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
        if (w.sprintSeen || w.sneakSeen) bad('PacketOrderF', 'interact after sprint/sneak')
        if (!pairedInteract) {
          w.interacted = true
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
