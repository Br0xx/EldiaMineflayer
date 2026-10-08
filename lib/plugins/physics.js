const { Vec3 } = require('vec3')
const assert = require('assert')
const math = require('../math')
const conv = require('../conversions')
const { performance } = require('perf_hooks')
const { createDoneTask, createTask } = require('../promise_utils')
const entityActionId = require('../entity_action')

const { Physics, PlayerState } = require('../physics/engine')

module.exports = inject

const PI = Math.PI
const PI_2 = Math.PI * 2
const HALF_PI = Math.PI / 2
const PHYSICS_INTERVAL_MS = 50
const PHYSICS_TIMESTEP = PHYSICS_INTERVAL_MS / 1000 // 0.05
// A timer fires up to a millisecond or two before its time, which must not cost a whole tick
const EARLY_MS = 2
// One mouse count at the default 50 % sensitivity: vanilla turns in whole multiples of this
// (0.15 * (0.6 * 0.5 + 0.2)^3 * 8), and the sensitivity estimate of an anticheat reads it back out of the deltas
const LOOK_STEP = conv.toRadians(0.15)
// player_input bits (the packet's flags, in protocol order)
const INPUT = { forward: 1, back: 2, left: 4, right: 8, jump: 16, sneak: 32, sprint: 64 }
const MOVEMENT_INPUT = INPUT.forward | INPUT.back | INPUT.left | INPUT.right | INPUT.jump
const MAX_PITCH_DEG = 90

function inject (bot, { physicsEnabled, maxCatchupTicks }) {
  // A stall is forgotten rather than replayed: the Timer check of Grim lets a burst of two ticks through at any
  // latency, while a longer one is only legal with a ping of 80 ms or more
  const MAX_BURST = Math.max(1, maxCatchupTicks ?? 2)
  const world = { getBlock: (pos) => { return bot.blockAt(pos, false) } }
  const physics = Physics(bot.registry, world)
  // The movement packet carries exactly the rotation the tick was simulated with, so a turn takes effect on the
  // next tick. Give physics.yawSpeed / pitchSpeed (rad/s) a finite value to ease the turn instead.
  physics.yawSpeed = Infinity
  physics.pitchSpeed = Infinity

  const version = bot.registry.version
  const positionUpdateSentEveryTick = bot.supportFeature('positionUpdateSentEveryTick')
  const hasConfigurationState = bot.supportFeature('hasConfigurationState') // 1.20.2+
  // 1.21.2+ clients end every tick with a tick_end packet, sent after that tick's movement packet
  const sendsTickEnd = bot.supportFeature('sendsClientTickEndPacket')
  const hasPlayerInput = bot.supportFeature('newPlayerInputPacket')
  // Clients before 1.21.6 report sneaking with entity_action (player_input's shift bit alone is not read until 1.21.6)
  const sneakByEntityAction = version['<']('1.21.6')
  // The order of the two entity_actions is checked (PacketOrderH): sneak first since 1.21.2, sprint first before
  const sneakFirst = version['>=']('1.21.2')
  // 1.21.2+ movement packets carry whether the bot is pushing against a wall
  const hasCollisionFlag = version['>=']('1.21.2')
  // Moving by less than 2.0E-4 blocks is not worth a position packet (0.03 before 1.21.2)
  const POSITION_EPSILON_SQ = version['>=']('1.21.2') ? 4e-8 : 9e-4
  // Window actions while sneaking are flagged by Grim from 1.21.9
  const gateSneakingWindowActions = version['>=']('1.21.9')
  const blindnessId = bot.registry.effectsByName?.Blindness?.id

  bot.jumpQueued = false
  bot.jumpTicks = 0 // autojump cooldown

  const controlState = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    sneak: false
  }
  // Rotation the movement packets carry, in radians, continuous (not wrapped) like the packets' yaw. A turn
  // is eased from here.
  let lastSentYaw = null
  let lastSentPitch = null
  let forceSend = false
  let doPhysicsTimer = null
  let loopRunning = false // from the first login: the ticks are scheduled
  let due = 0
  let ended = false
  let shouldUsePhysics = false
  bot.physicsEnabled = physicsEnabled ?? true
  let deadTicks = 21

  // What LocalPlayer remembers of the last movement packet it sent (xLast, yRotLast, lastOnGround...). The
  // answer to a teleport is not part of it, so the first tick after one reports the new position again.
  const lastSent = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, onGround: false, collision: false }
  let positionReminder = 0
  // What has been reported to the server of the keys, sneak and sprint (LocalPlayer.lastSentInput, wasShiftKeyDown,
  // wasSprinting)
  const sent = { input: 0, sneak: false, sprint: false }
  // Sprinting after the vanilla rules (below); the key (controlState.sprint) only asks for it
  let sprinting = false
  // Pose.CROUCHING as it was at the START of this tick: the shift key of the previous tick (the vanilla client
  // updates its pose at the end of a tick). The sneaking speed and the 1.5 high box follow the pose, one tick behind the key.
  let crouching = false
  let jumpTapped = false
  // bot.elytraFly() waiting for the next tick that reports the keys
  let elytraStart = null
  // Ticks left of the shift key bot.dismount() holds
  let dismountTicks = 0
  // Whether the last tick's wall contact was a graze (vanilla's minorHorizontalCollision)
  let softCollision = false
  const hasCrouchBox = bot.registry.version['>=']('1.14')
  let inTick = false
  const moveEvents = []

  function resetClientPlayer () {
    // A new LocalPlayer: nothing has been sent yet
    Object.assign(lastSent, { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, onGround: false, collision: false })
    positionReminder = 0
    sent.input = 0
    sent.sneak = false
    sent.sprint = false
    sprinting = false
    crouching = false
    softCollision = false
  }

  // Timer scheduling: fixed 50 ms steps against a deadline, so the average rate is exactly 20 ticks per second
  // however late a timer fires. https://gafferongames.com/post/fix_your_timestep/
  // WARNING: THIS IS NOT ACCURATE ON WINDOWS (15.6 Timer Resolution)
  // use WSL or switch to Linux
  // see: https://discord.com/channels/413438066984747026/519952494768685086/901948718255833158
  function schedule () {
    if (ended) return
    doPhysicsTimer = setTimeout(doPhysics, Math.max(1, due - performance.now()))
  }

  function doPhysics () {
    doPhysicsTimer = null
    try {
      const now = performance.now()
      // Whole ticks past the burst cap are dropped, never replayed
      if (now - due > PHYSICS_INTERVAL_MS * (MAX_BURST - 1)) due = now - PHYSICS_INTERVAL_MS * (MAX_BURST - 1)
      while (due <= now + EARLY_MS) {
        tickPhysics()
        due += PHYSICS_INTERVAL_MS
      }
    } finally {
      schedule()
    }
  }

  // One client tick, in the order of the vanilla client (see input_queue.js):
  //   replies to the server (pong, teleport, player_rotation) -> held slot -> swap/drop -> one action -> simulation
  //   -> player_input, sneak, sprint -> movement packet -> tick_end
  function tickPhysics () {
    if (bot._client.state !== 'play') return // do nothing outside of the play state (e.g. server transfer configuration phase)
    inTick = true
    try {
      runTick()
    } finally {
      inTick = false
      try {
        // 'move' listeners run after tick_end: a packet written from one of them can not land inside the tick
        while (moveEvents.length) bot.emit('move', moveEvents.shift())
      } finally {
        bot._input.afterTick()
      }
    }
  }

  function runTick () {
    flushReplies()
    if (!bot.entity?.position || !Number.isFinite(bot.entity.position.x)) return // entity not ready
    const rot = shouldUsePhysics ? captureRotation() : currentRotation()
    bot._input.flush(rot)
    if (bot.vehicle) {
      syncVehicleInput() // riding: the keys steer the vehicle, nothing of the walking physics runs
      settleLook()
    } else if (bot.blockAt(bot.entity.position) != null && shouldUsePhysics) { // otherwise the chunk is unloaded: no simulation
      // The keys as this tick uses them: a listener of physicsTick that changes them acts on the next tick
      const controls = effectiveControls()
      const tapped = jumpTapped
      jumpTapped = false
      if (bot.physicsEnabled) {
        const before = bot.entity.position.clone()
        // the pose box of the previous tick (the crouching box is 1.14+; before, sneaking kept the 1.8 box)
        physics.playerHeight = Math.fround(crouching && hasCrouchBox ? 1.5 : 1.8)
        const state = new PlayerState(bot, controls)
        state.slowMovement = crouching // sneaking speed follows the pose, one tick behind the key
        // The rotation of the packet (a float in degrees), not the one asked for
        state.yaw = PI - conv.toRadians(rot.yaw)
        state.pitch = -conv.toRadians(rot.pitch)
        physics.simulatePlayer(state, world).apply(bot)
        crouching = controls.sneak // updatePlayerPose
        recordMovement(before, controls, rot)
        bot.emit('physicsTick')
        bot.emit('physicTick') // Deprecated, only exists to support old plugins. May be removed in the future
      }
      const elytra = elytraStart
      elytraStart = null
      syncInputState(controls, tapped, elytra !== null)
      updatePosition(rot)
      if (elytra) elytra.resolve()
    } else {
      settleLook()
    }
    if (sendsTickEnd) bot._client.write('tick_end', {})
  }

  // Whether a movement packet can go out this tick: it needs the server to have placed the bot, the chunk it stands
  // in, and no vehicle
  function canMove () {
    return loopRunning && shouldUsePhysics && !bot.vehicle && !!bot.entity?.position && bot.blockAt(bot.entity.position) != null
  }

  // Where no movement packet can carry a turn (before the first teleport, riding, in an unloaded chunk, dead) there
  // is nobody to wait for: the turn counts as sent, and the next packet starts from it
  function settleLook () {
    if (lookingTask.done) return
    lastSentYaw = bot.entity.yaw
    lastSentPitch = bot.entity.pitch
    forceSend = false
    lookingTask.finish()
  }

  // remove this when 'physicTick' is removed
  bot.on('newListener', (name) => {
    if (name === 'physicTick') console.warn('Mineflayer detected that you are using a deprecated event (physicTick)! Please use this event (physicsTick) instead.')
  })

  function cleanup () {
    ended = true
    loopRunning = false
    clearTimeout(doPhysicsTimer)
    doPhysicsTimer = null
    cancelRespawnReply()
    clearTimeout(replyTimer)
    replyTimer = null
    pendingReplies.length = 0
    if (elytraStart) elytraStart.reject(new Error('The bot has ended'))
    elytraStart = null
  }

  // Movement packets. `pos` is a Vec3 or null; `rot` is { yaw, pitch } in degrees or null.
  function writeMovement (name, pos, rot, onGround, collision) {
    const params = { onGround, flags: { onGround, hasHorizontalCollision: collision } } // flags: 1.21.3+
    if (pos) {
      params.x = pos.x
      params.y = pos.y
      params.z = pos.z
    }
    if (rot) {
      params.yaw = rot.yaw
      params.pitch = rot.pitch
    }
    bot._client.write(name, params)
  }

  function emitMove () {
    const oldPos = new Vec3(lastSent.x, lastSent.y, lastSent.z)
    if (inTick) moveEvents.push(oldPos)
    else bot.emit('move', oldPos)
  }

  // The answers to the server: PosRot / Rot in the air, with no wall contact, exactly the values the server set
  // (Grim reads these as the confirmation; sending anything else makes it ignore the teleport)
  function sendTeleportReply (pos, yaw, pitch) {
    if (bot._client.state !== 'play') return
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return
    writeMovement('position_look', pos, { yaw: Math.fround(yaw), pitch: Math.fround(pitch) }, false, false)
    emitMove()
  }

  function sendRotationReply (yaw, pitch) {
    if (bot._client.state !== 'play') return
    writeMovement('look', null, { yaw: Math.fround(yaw), pitch: Math.fround(pitch) }, false, false)
    emitMove()
  }

  function deltaYaw (yaw1, yaw2) {
    let dYaw = (yaw1 - yaw2) % PI_2
    if (dYaw < -PI) dYaw += PI_2
    else if (dYaw > PI) dYaw -= PI_2

    return dYaw
  }

  // returns false if bot should send position packets
  function isEntityRemoved () {
    if (bot.isAlive === true) deadTicks = 0
    if (bot.isAlive === false && deadTicks <= 20) deadTicks++
    if (deadTicks >= 20) return true
    return false
  }

  const packetPitch = (pitch) => math.clamp(-MAX_PITCH_DEG, Math.fround(conv.toNotchianPitch(pitch)), MAX_PITCH_DEG)

  // The rotation of the bot as a packet holds it, with nothing eased (physics is not running yet)
  function currentRotation () {
    return { yaw: Math.fround(conv.toNotchianYaw(bot.entity.yaw)), pitch: packetPitch(bot.entity.pitch) }
  }

  // The rotation this tick's movement packet carries (and the simulation uses): bot.entity's, moved towards its
  // target by at most the turn speed. A forced look takes the whole way.
  function captureRotation () {
    const maxYaw = forceSend ? Infinity : maxTurn(physics.yawSpeed)
    const maxPitch = forceSend ? Infinity : maxTurn(physics.pitchSpeed)
    forceSend = false
    lastSentYaw += math.clamp(-maxYaw, deltaYaw(bot.entity.yaw, lastSentYaw), maxYaw)
    lastSentPitch += math.clamp(-maxPitch, bot.entity.pitch - lastSentPitch, maxPitch)
    return { yaw: Math.fround(conv.toNotchianYaw(lastSentYaw)), pitch: packetPitch(lastSentPitch) }
  }

  // The most a tick may turn: a whole number of mouse steps, so eased turns keep the grid
  function maxTurn (speed) {
    return Math.max(LOOK_STEP, Math.floor((PHYSICS_TIMESTEP * speed) / LOOK_STEP) * LOOK_STEP)
  }

  // vanilla LocalPlayer.sendPosition
  function updatePosition (rot) {
    // Only send updates for 20 ticks after death
    if (isEntityRemoved()) return settleLook()
    // Don't send position with invalid coordinates (NaN after death)
    const position = bot.entity.position
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) return settleLook()

    const onGround = bot.entity.onGround
    const collision = hasCollisionFlag && !!bot.entity.isCollidedHorizontally
    const dx = position.x - lastSent.x
    const dy = position.y - lastSent.y
    const dz = position.z - lastSent.z
    positionReminder++
    // A position goes out when the bot moved, and at least every 20th tick
    const positionUpdated = dx * dx + dy * dy + dz * dz > POSITION_EPSILON_SQ || positionReminder >= 20
    const lookUpdated = lastSent.yaw !== rot.yaw || lastSent.pitch !== rot.pitch

    if (positionUpdated && lookUpdated) {
      emitMove()
      writeMovement('position_look', position, rot, onGround, collision)
    } else if (positionUpdated) {
      emitMove()
      writeMovement('position', position, null, onGround, collision)
    } else if (lookUpdated) {
      emitMove()
      writeMovement('look', null, rot, onGround, collision)
    } else if (positionUpdateSentEveryTick || onGround !== lastSent.onGround || collision !== lastSent.collision) {
      // For versions < 1.12, one player packet should be sent every tick for the server to update health correctly.
      // Otherwise only a change of onGround / wall contact is worth a packet.
      writeMovement('flying', null, null, onGround, collision)
    }
    if (positionUpdated) {
      lastSent.x = position.x
      lastSent.y = position.y
      lastSent.z = position.z
      positionReminder = 0
    }
    if (lookUpdated) {
      lastSent.yaw = rot.yaw
      lastSent.pitch = rot.pitch
    }
    lastSent.onGround = onGround
    lastSent.collision = collision

    // The turn bot.look() waited for is on its way
    if (!lookingTask.done && Math.abs(deltaYaw(bot.entity.yaw, lastSentYaw)) < 1e-7 && Math.abs(bot.entity.pitch - lastSentPitch) < 1e-7) {
      lookingTask.finish()
    }
  }

  bot.physics = physics

  function getEffectLevel (mcData, effectName, effects) {
    const effectDescriptor = mcData.effectsByName[effectName]
    if (!effectDescriptor) {
      return 0
    }
    const effectInfo = effects[effectDescriptor.id]
    if (!effectInfo) {
      return 0
    }
    return effectInfo.amplifier + 1
  }

  const jumpDown = () => controlState.jump || jumpTapped || !!(sent.input & INPUT.jump)

  bot.elytraFly = async () => {
    if (bot.entity.elytraFlying) {
      throw new Error('Already elytra flying')
    } else if (bot.entity.onGround) {
      throw new Error('Unable to fly from ground')
    } else if (bot.entity.isInWater) {
      throw new Error('Unable to elytra fly while in water')
    }

    const mcData = require('minecraft-data')(bot.version)
    if (getEffectLevel(mcData, 'Levitation', bot.entity.effects) > 0) {
      throw new Error('Unable to elytra fly with levitation effect')
    }

    const torsoSlot = bot.getEquipmentDestSlot('torso')
    const item = bot.inventory.slots[torsoSlot]
    if (item == null || item.name !== 'elytra') {
      throw new Error('Elytra must be equip to start flying')
    }
    if (bot.vehicle) throw new Error('Unable to elytra fly while riding')
    if (elytraStart) throw new Error('Already starting to elytra fly')
    // ElytraB: the jump key must be up when the start is sent and goes down in the same tick. So release it first and
    // wait until the server has been told.
    bot.setControlState('jump', false)
    for (let i = 0; jumpDown(); i++) {
      if (i >= 10) throw new Error('The jump key is still down: unable to start elytra flying')
      await bot._input.nextTick()
    }
    // The start leaves in the tick of LocalPlayer.aiStep, ahead of player_input (jump) and the movement packet
    await new Promise((resolve, reject) => { elytraStart = { resolve, reject } })
  }

  // --- Keys, sneak and sprint: state, reported once per tick when it changed -------------------------------------

  bot.setControlState = (control, state) => {
    assert.ok(control in controlState, `invalid control: ${control}`)
    assert.ok(typeof state === 'boolean', `invalid state: ${state}`)
    if (controlState[control] === state) return
    controlState[control] = state
    if (control === 'jump' && state) {
      bot.jumpQueued = true
      jumpTapped = true // reported with the next tick even if the key is up again by then
    }
  }

  bot.getControlState = (control) => {
    assert.ok(control in controlState, `invalid control: ${control}`)
    return controlState[control]
  }

  bot.clearControlStates = () => {
    for (const control in controlState) {
      bot.setControlState(control, false)
    }
  }

  bot.controlState = {}

  for (const control of Object.keys(controlState)) {
    Object.defineProperty(bot.controlState, control, {
      enumerable: true,
      get () {
        return controlState[control]
      },
      set (state) {
        bot.setControlState(control, state)
        return state
      }
    })
  }

  // Sprinting as the vanilla client keeps it (LocalPlayer.aiStep), from the state the previous tick left. The key only
  // asks for it: it starts when the bot moves forward and is able to, and ends when it can no longer.
  function updateSprint (c) {
    const forward = c.forward && !c.back
    const enoughFood = bot.food === undefined || bot.food > 6 || !!bot.abilities?.mayFly
    // Vanilla sprints under water too, but that is swimming (its own pose, box and look-driven motion), which the
    // engine doesn't simulate: never sprint in water rather than be set back for it
    const inWater = !!bot.entity.isInWater
    // the engine's exact graze flag where it computes one (1.21+), else the estimate from the last move
    const graze = bot.entity.minorHorizontalCollision ?? softCollision
    if (sprinting) {
      // stop: no forward input, too hungry, a wall in the way (other than a graze), in water
      const wall = !!bot.entity.isCollidedHorizontally && !graze
      if (!forward || !enoughFood || wall || inWater || c.sneak || bot.entity.elytraFlying) sprinting = false
    } else if (c.sprint && forward && enoughFood && !c.sneak && !bot.itemInUse && !bot.entity.elytraFlying &&
      !(blindnessId !== undefined && bot.entity.effects?.[blindnessId]) && !inWater) {
      sprinting = true
    }
  }

  // The keys the simulation of this tick must use: sprint is the sprinting state, not the key
  function effectiveControls () {
    updateSprint(controlState)
    return { ...controlState, sprint: sprinting }
  }
  bot._effectiveControls = () => ({ ...controlState, sprint: sprinting })
  // The state the simulation of the tick used, for whoever reads it afterwards (the engine takes them from PlayerState)
  Object.defineProperty(bot, 'sprinting', { get: () => sprinting, enumerable: true, configurable: true })
  Object.defineProperty(bot, 'crouching', { get: () => crouching, enumerable: true, configurable: true })

  // vanilla Entity.isHorizontalCollisionSoft: a wall contact where the bot still moved the way its input pushes
  // (within 8 degrees) is not a reason to stop sprinting
  function recordMovement (before, controls, rot) {
    const after = bot.entity.position
    const x = after.x - before.x
    const z = after.z - before.z
    const yaw = conv.toRadians(rot.yaw)
    const sin = Math.sin(yaw)
    const cos = Math.cos(yaw)
    const xxa = (controls.left ? 1 : 0) - (controls.right ? 1 : 0)
    const zza = (controls.forward ? 1 : 0) - (controls.back ? 1 : 0)
    const g = xxa * cos - zza * sin
    const h = zza * cos + xxa * sin
    const i = g * g + h * h
    softCollision = i >= 1e-5 && Math.acos((g * x + h * z) / Math.sqrt(i * (x * x + z * z))) < 0.13962634
  }

  // The keys as player_input carries them
  function inputBits (c, jumpWasTapped) {
    return (c.forward ? INPUT.forward : 0) | (c.back ? INPUT.back : 0) | (c.left ? INPUT.left : 0) |
      (c.right ? INPUT.right : 0) | (c.jump || jumpWasTapped ? INPUT.jump : 0) | (c.sneak ? INPUT.sneak : 0) |
      (controlState.sprint ? INPUT.sprint : 0)
  }

  function writePlayerInput (bits) {
    bot._client.write('player_input', {
      inputs: {
        forward: !!(bits & INPUT.forward),
        backward: !!(bits & INPUT.back),
        left: !!(bits & INPUT.left),
        right: !!(bits & INPUT.right),
        jump: !!(bits & INPUT.jump),
        shift: !!(bits & INPUT.sneak),
        sprint: !!(bits & INPUT.sprint)
      }
    })
    sent.input = bits
  }

  // LocalPlayer.aiStep / tick, after the simulation: the elytra start (the jump key goes down in this very tick),
  // player_input when the keys changed, then sneak and sprint (each only on change, in the order of the client
  // version), then the movement packet
  function syncInputState (c, jumpWasTapped, startElytra = false) {
    if (startElytra) {
      bot._client.write('entity_action', {
        entityId: bot.entity.id,
        actionId: entityActionId(bot.registry, 'start_elytra_flying'),
        jumpBoost: 0
      })
    }
    if (hasPlayerInput) {
      const bits = inputBits(c, jumpWasTapped || startElytra)
      if (bits !== sent.input) {
        writePlayerInput(bits)
        if (!sneakByEntityAction) sent.sneak = !!(bits & INPUT.sneak)
      }
    }
    const reportSneak = () => {
      if (!sneakByEntityAction || c.sneak === sent.sneak) return
      bot._client.write('entity_action', {
        entityId: bot.entity.id,
        actionId: entityActionId(bot.registry, c.sneak ? 'start_sneaking' : 'stop_sneaking'),
        jumpBoost: 0
      })
      sent.sneak = c.sneak
    }
    const reportSprint = () => {
      if (c.sprint === sent.sprint) return
      bot._client.write('entity_action', {
        entityId: bot.entity.id,
        actionId: entityActionId(bot.registry, c.sprint ? 'start_sprinting' : 'stop_sprinting'),
        jumpBoost: 0
      })
      sent.sprint = c.sprint
    }
    if (sneakFirst) {
      reportSneak()
      reportSprint()
    } else {
      reportSprint()
      reportSneak()
    }
  }

  // --- Riding ---------------------------------------------------------------------------------------------------
  // In a vehicle the walking physics are off and the keys steer the vehicle. The client reports them like walking
  // keys (player_input when they change, from 1.21.2), but sends no sneak or sprint entity_action: the shift key is
  // what leaves the vehicle. Before 1.21.2 the keys go out as steer_vehicle in every tick of the ride.
  const STEER_MAX = Math.fround(0.98) // Grim: VehicleA flags more
  let steering = false // the controls were set by moveVehicle

  function syncVehicleInput () {
    sprinting = false
    const c = { ...controlState, sneak: controlState.sneak || dismountTicks > 0 }
    if (dismountTicks > 0) dismountTicks--
    if (hasPlayerInput) {
      const bits = inputBits(c, false) & ~INPUT.sprint
      if (bits !== sent.input) writePlayerInput(bits)
    } else {
      bot._client.write('steer_vehicle', {
        sideways: ((c.left ? 1 : 0) - (c.right ? 1 : 0)) * STEER_MAX,
        forward: ((c.forward ? 1 : 0) - (c.back ? 1 : 0)) * STEER_MAX,
        jump: (c.jump ? 0x01 : 0) | (c.sneak ? 0x02 : 0)
      })
    }
    // getting on stops the sprint (LocalPlayer.sendIsSprintingIfNeeded)
    if (sent.sprint) {
      bot._client.write('entity_action', { entityId: bot.entity.id, actionId: entityActionId(bot.registry, 'stop_sprinting'), jumpBoost: 0 })
      sent.sprint = false
    }
  }

  // Steer the vehicle the bot rides: left and forward are -1, 0 or 1 (1 is left / forward). Like the keys, it holds
  // until changed.
  bot.moveVehicle = (left, forward) => {
    if (!bot.vehicle) {
      bot.emit('error', new Error('moveVehicle: not mounted'))
      return
    }
    steering = true
    bot.setControlState('forward', forward > 0)
    bot.setControlState('back', forward < 0)
    bot.setControlState('left', left > 0)
    bot.setControlState('right', left < 0)
  }

  // Leave the vehicle with the shift key, held for a few ticks
  bot.dismount = () => {
    if (!bot.vehicle) {
      bot.emit('error', new Error('dismount: not mounted'))
      return
    }
    dismountTicks = 3
  }

  bot.on('dismount', () => {
    dismountTicks = 0
    // the keys that steered the vehicle must not walk the bot away
    if (steering) {
      steering = false
      for (const key of ['forward', 'back', 'left', 'right']) bot.setControlState(key, false)
    }
  })

  // True when the server has been told that no key is held, the bot does not sprint and (from 1.21.9) does not sneak.
  // Window clicks and closes are flagged by Grim otherwise (MultiActionsC/D): a player's keys are released when a
  // screen opens, and the packet saying so has to be out before the click.
  function inputIdle () {
    const c = controlState
    if (c.forward || c.back || c.left || c.right || c.jump || jumpTapped) return false
    if (sprinting || sent.sprint || (sent.input & MOVEMENT_INPUT)) return false
    if (gateSneakingWindowActions && (c.sneak || sent.sneak)) return false
    return true
  }

  bot._input.isIdle = inputIdle
  // Waits (up to maxTicks) until inputIdle() holds; throws if the keys are still held by then
  bot._input.idle = async (maxTicks = 40) => {
    for (let i = 0; !inputIdle(); i++) {
      if (i >= maxTicks) throw new Error('The movement keys are still held: not clicking in a window while moving')
      await bot._input.nextTick()
    }
  }

  // --- Looking ------------------------------------------------------------------------------------------------

  let lookingTask = createDoneTask()

  bot._client.on('explosion', explosion => {
    // TODO: emit an explosion event with more info
    if (bot.physicsEnabled && bot.game.gameMode !== 'creative') {
      if (explosion.playerKnockback) { // 1.21.3+
        // Fixes issue #3635
        bot.entity.velocity.x += explosion.playerKnockback.x
        bot.entity.velocity.y += explosion.playerKnockback.y
        bot.entity.velocity.z += explosion.playerKnockback.z
      }
      if ('playerMotionX' in explosion) {
        bot.entity.velocity.x += explosion.playerMotionX
        bot.entity.velocity.y += explosion.playerMotionY
        bot.entity.velocity.z += explosion.playerMotionZ
      }
    }
  })

  // Turn to (yaw, pitch) in radians. The yaw takes the short way round (a packet never jumps by more than 180
  // degrees) and the pitch stays within +-90 degrees however the grid rounds. Resolves once a movement packet
  // carries the rotation. `force` skips the easing when physics.yawSpeed / pitchSpeed are finite.
  bot.look = async (yaw, pitch, force) => {
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) throw new Error(`look: the rotation must be finite, got ${yaw}, ${pitch}`)
    if (!lookingTask.done) {
      lookingTask.finish() // finish the previous one
    }
    lookingTask = createTask()

    // this is done to bypass certain anticheat checks that detect the player's sensitivity
    // by calculating the gcd of how much they move the mouse each tick
    const yawChange = Math.round(deltaYaw(yaw, bot.entity.yaw) / LOOK_STEP) * LOOK_STEP
    let pitchChange = Math.round((math.clamp(-HALF_PI, pitch, HALF_PI) - bot.entity.pitch) / LOOK_STEP) * LOOK_STEP
    // the grid may step over the pole
    const target = bot.entity.pitch + pitchChange
    if (target > HALF_PI + 1e-9) pitchChange -= LOOK_STEP
    else if (target < -HALF_PI - 1e-9) pitchChange += LOOK_STEP

    if (yawChange === 0 && pitchChange === 0) {
      lookingTask.finish()
      return
    }

    bot.entity.yaw += yawChange
    bot.entity.pitch = math.clamp(-HALF_PI, bot.entity.pitch + pitchChange, HALF_PI)
    if (force) forceSend = true
    if (!canMove()) settleLook()

    await lookingTask.promise
  }

  bot.lookAt = async (point, force) => {
    if (!Number.isFinite(point.x + point.y + point.z)) throw new Error(`lookAt: the point must be finite, got ${point}`)
    const delta = point.minus(bot.entity.position.offset(0, bot.entity.eyeHeight, 0))
    const yaw = Math.atan2(-delta.x, -delta.z)
    const groundDistance = Math.sqrt(delta.x * delta.x + delta.z * delta.z)
    const pitch = Math.atan2(delta.y, groundDistance)
    await bot.look(yaw, pitch, force)
  }

  // --- Server rotation and position ----------------------------------------------------------------------------

  // The yaw of a packet (degrees) as the continuous radians the easing works in
  const unwrappedYaw = (degrees) => PI - conv.toRadians(degrees)

  // 1.21.3+. The vanilla client applies the rotation and answers with a Rot packet in the air and with no wall
  // contact (Grim flags an unanswered one: BadPacketsB). 26.1 can send it relative to the current rotation.
  bot._client.on('player_rotation', (packet) => {
    const yaw = packet.relativeYaw ? conv.toNotchianYaw(bot.entity.yaw) + packet.yaw : packet.yaw
    const pitch = packet.relativePitch ? conv.toNotchianPitch(bot.entity.pitch) + packet.pitch : packet.pitch
    bot.entity.yaw = conv.fromNotchianYaw(yaw)
    bot.entity.pitch = conv.fromNotchianPitch(pitch)
    const reply = () => {
      lastSentYaw = unwrappedYaw(yaw)
      lastSentPitch = conv.fromNotchianPitch(pitch)
      sendRotationReply(yaw, pitch)
    }
    // A rotation arriving without a physics loop (before login) has nobody to answer to
    if (bot._client.state === 'play') bot._replyOnNextTick(reply)
  })

  // player position and look (clientbound)
  // The vanilla client hands every play packet to the client thread, which drains the queue at the
  // start of a tick (PacketUtils.ensureRunningOnSameThread) and writes each reply as the packet is
  // handled. So a teleport is answered at most once per tick however fast the server sends them,
  // and replies to different packets (a pong, a teleport confirm) leave in packet arrival order.
  const pendingReplies = []
  let replyTimer = null

  function flushReplies () {
    clearTimeout(replyTimer)
    replyTimer = null
    if (bot._client.state !== 'play') return
    while (pendingReplies.length) pendingReplies.shift()()
  }

  bot._replyOnNextTick = (reply) => {
    pendingReplies.push(reply)
    // While no tick is running (the login packet starts it) a reply waits at most one tick.
    if (!loopRunning && replyTimer === null) replyTimer = setTimeout(flushReplies, PHYSICS_INTERVAL_MS)
  }
  // The teleport's state is applied as the packet arrives, like the handlers around it
  // (player_rotation, entity_velocity), so a later packet is not overwritten by an earlier teleport.
  // Only the reply waits for the next tick, carrying the values this teleport set.
  bot._client.on('position', (packet) => {
    // A newer teleport supersedes the one a deferred reply would answer.
    cancelRespawnReply()
    // Is this necessary? Feels like it might wrongly overwrite hitbox size sometimes
    // e.g. when crouching/crawling/swimming. Can someone confirm?
    bot.entity.height = 1.8

    const vel = bot.entity.velocity
    const pos = bot.entity.position
    let newYaw, newPitch

    // Note: 1.20.5+ uses a bitflags object, older versions use a bitmask number
    if (typeof packet.flags === 'object') {
      // Modern path with bitflags object
      if (Number.isFinite(packet.dx)) {
        // 1.21.2+: the packet carries the velocity (relative to the current one with the dx/dy/dz flags).
        // Not applied: the rotation of the old velocity by a relative yaw change (flags.yawDelta).
        vel.set(
          packet.flags.dx ? vel.x + packet.dx : packet.dx,
          packet.flags.dy ? vel.y + packet.dy : packet.dy,
          packet.flags.dz ? vel.z + packet.dz : packet.dz
        )
      } else {
        // Velocity is only set to 0 if the flag is not set, otherwise keep current velocity
        vel.set(
          packet.flags.x ? vel.x : 0,
          packet.flags.y ? vel.y : 0,
          packet.flags.z ? vel.z : 0
        )
      }
      // If flag is set, then the corresponding value is relative, else it is absolute
      pos.set(
        packet.flags.x ? (pos.x + packet.x) : packet.x,
        packet.flags.y ? (pos.y + packet.y) : packet.y,
        packet.flags.z ? (pos.z + packet.z) : packet.z
      )
      newYaw = (packet.flags.yaw ? conv.toNotchianYaw(bot.entity.yaw) : 0) + packet.yaw
      newPitch = (packet.flags.pitch ? conv.toNotchianPitch(bot.entity.pitch) : 0) + packet.pitch
    } else {
      // Legacy path with bitmask number
      // Velocity is only set to 0 if the flag is not set, otherwise keep current velocity
      vel.set(
        packet.flags & 1 ? vel.x : 0,
        packet.flags & 2 ? vel.y : 0,
        packet.flags & 4 ? vel.z : 0
      )
      // If flag is set, then the corresponding value is relative, else it is absolute
      pos.set(
        packet.flags & 1 ? (pos.x + packet.x) : packet.x,
        packet.flags & 2 ? (pos.y + packet.y) : packet.y,
        packet.flags & 4 ? (pos.z + packet.z) : packet.z
      )
      newYaw = (packet.flags & 8 ? conv.toNotchianYaw(bot.entity.yaw) : 0) + packet.yaw
      newPitch = (packet.flags & 16 ? conv.toNotchianPitch(bot.entity.pitch) : 0) + packet.pitch
    }

    bot.entity.yaw = conv.fromNotchianYaw(newYaw)
    bot.entity.pitch = conv.fromNotchianPitch(newPitch)
    // The bot keeps its ground state: the vanilla client only reports "in the air" in the confirmation, and a
    // bot that really stands on the ground would otherwise start the next step with air acceleration
    bot.jumpTicks = 0

    const teleportPos = pos.clone()
    const reply = () => answerTeleport(packet.teleportId, teleportPos, newYaw, newPitch)
    reply.teleport = true
    bot._replyOnNextTick(reply)
  })

  function answerTeleport (teleportId, pos, yaw, pitch) {
    if (bot.supportFeature('teleportUsesOwnPacket')) {
      bot._client.write('teleport_confirm', { teleportId })
    }

    const confirmMove = () => {
      shouldUsePhysics = true
      lastSentYaw = unwrappedYaw(yaw)
      lastSentPitch = conv.fromNotchianPitch(pitch)
      bot.emit('forcedMove')
    }

    // After death/respawn, a server older than 1.19 may kick for the forced position_look response sent at once
    // ("Invalid move player packet"). Newer servers expect it with the confirmation: Grim reads a late one as an
    // ignored teleport and sets the bot back again.
    if (respawnReplyDelayMs > 0 && respawnTimer > 0 && Date.now() - respawnTimer < 2000) {
      respawnTimer = 0 // only delay once
      respawnReply = setTimeout(() => {
        respawnReply = null
        sendTeleportReply(pos, yaw, pitch)
        confirmMove()
      }, respawnReplyDelayMs)
      return
    }

    sendTeleportReply(pos, yaw, pitch)
    confirmMove()
  }

  bot.waitForTicks = async function (ticks) {
    if (ticks <= 0) return
    await new Promise((resolve, reject) => {
      // Assuming 20 ticks per second, add extra time for lag
      const timeout = setTimeout(() => {
        bot.removeListener('physicsTick', tickListener)
        reject(new Error(`Timeout waiting for ${ticks} ticks after ${(ticks * 50 + 5000)}ms`))
      }, ticks * 50 + 5000) // 50ms per tick + 5s buffer

      const tickListener = () => {
        ticks--
        if (ticks === 0) {
          clearTimeout(timeout)
          bot.removeListener('physicsTick', tickListener)
          resolve()
        }
      }

      bot.on('physicsTick', tickListener)
    })
  }

  let respawnTimer = 0
  // How long the answer to the teleport after a death waits (see answerTeleport)
  let respawnReplyDelayMs = version['<']('1.19') ? 1500 : 0
  Object.defineProperty(bot, '_respawnReplyDelayMs', {
    get: () => respawnReplyDelayMs,
    set: (ms) => { respawnReplyDelayMs = ms }
  })
  // The deferred respawn reply answers one teleport of the current play session. The server only
  // accepts a reply to its latest teleport, and once the client leaves play (start_configuration)
  // or a new session begins (login) the position it carries means nothing to the server and the
  // play-state packet cannot be written anyway.
  let respawnReply = null
  function cancelRespawnReply () {
    clearTimeout(respawnReply)
    respawnReply = null
  }
  bot.on('mount', () => { shouldUsePhysics = false })
  bot.on('death', () => {
    shouldUsePhysics = false
    respawnTimer = Date.now()
  })
  bot.on('respawn', () => {
    shouldUsePhysics = false
    // The server makes a new player: the client starts from nothing sent (no keys, no sneak, no sprint)
    resetClientPlayer()
    // A teleport queued before the respawn positioned the bot in the old world; answering it now
    // would turn physics back on before the server has placed the bot in the new one. Pongs stay
    // queued, as transaction-ordering anticheats expect every ping answered in order.
    for (let i = pendingReplies.length - 1; i >= 0; i--) {
      if (pendingReplies[i].teleport) pendingReplies.splice(i, 1)
    }
  })
  bot.on('login', () => {
    shouldUsePhysics = false
    cancelRespawnReply()
    resetClientPlayer()
    // A reply still queued here belongs to the world the bot just left, and its id means nothing
    // to the server it is about to talk to.
    pendingReplies.length = 0
    if (!loopRunning && !ended) {
      loopRunning = true
      due = performance.now() + PHYSICS_INTERVAL_MS
      schedule()
    }
  })
  // A proxy (e.g. Velocity) transferring us to another server makes the client
  // re-enter the configuration phase, during which play-state movement packets
  // are not allowed. Physics is re-enabled by the position packet handler once
  // the server finishes configuration and play resumes.
  if (hasConfigurationState) {
    bot._client.on('start_configuration', () => {
      shouldUsePhysics = false
      cancelRespawnReply()
    })
  }
  // Replies queued in play are meaningless once the client leaves it (e.g. reconfiguration).
  bot._client.on('state', (state) => {
    if (state !== 'play') pendingReplies.length = 0
  })
  bot.on('end', cleanup)
}
