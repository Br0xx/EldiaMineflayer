const { performance } = require('perf_hooks')
const { createTask } = require('../promise_utils')

module.exports = inject

// Digging as a tick-driven state machine, the way the vanilla client does it (MultiPlayerGameMode.startDestroyBlock
// and continueDestroyBlock, run from Minecraft.handleKeybinds), so that the packets of a dig look like a person's to
// the Grim anticheat (BreakA/B, FastBreak, NoSwingBreak, MultiBreak, AirLiquidBreak, RotationBreak, FarBreak):
//
//   - The face is the one the crosshair ray hits: the bot looks at a visible point of the block first, waits for the
//     rotation to reach the server, and the START packet reports the face of a ray-cast along the rotation of the
//     tick it is written in, from the eyes, within the block reach (4.5, or the block_interaction_range attribute).
//   - START (with a sequence number) and its swing go out in the input phase of one tick. Every following tick of
//     the dig adds the break progress (digTime is a whole number of ticks, so 1 / ticks per tick) and swings; the
//     tick whose progress reaches 1.0 writes FINISH (with a sequence number) and the swing behind it.
//   - A block that breaks at once (creative, or progress >= 1 on the first tick) gets START only, no FINISH.
//   - After a break the next START waits 5 ticks of destroyDelay: it goes out on the 6th tick after FINISH. The held
//     attack key keeps swinging meanwhile. A creative START sets the same delay.
//   - A dig that ends before its FINISH (stopDigging, the crosshair or the reach leaving the block) sends ABORT with
//     face DOWN and sequence 0. Moving on to another block sends ABORT for the old one carrying the new START's face.
//   - A tick in which something else was done (a placement, an attack...) skips the dig: the break does not advance.
//
// One difference from the vanilla client, on purpose: it also adds progress in the tick of START, so FINISH follows
// ceil(1/damage) - 1 ticks after it. Here FINISH follows ceil(1/damage) ticks after START, never faster than Grim's
// FastBreak prediction (ceil(1/damage) * 50 ms), at the price of one tick per block.
const DESTROY_DELAY = 5
const DOWN = 0

function inject (bot) {
  // The dig whose START went out and that is neither finished nor aborted (MultiPlayerGameMode.isDestroying)
  let started = null
  // The latest bot.dig() call whose START has not gone out yet (turning to the block, waiting for the delay)
  let request = null
  // Ticks left of the destroy delay. fresh: it was set in this tick's input phase, so this tick does not count.
  let delay = 0
  let delayFresh = false
  let hooked = false

  bot.targetDigBlock = null
  bot.targetDigFace = null
  bot.lastDigTime = null

  const abortError = () => new Error('Digging aborted')
  const delayLeft = () => delay

  function syncTarget () {
    bot.targetDigBlock = request?.block ?? started?.block ?? null
    bot.targetDigFace = !request && started ? started.face : null
  }

  function setDelay (inInputPhase) {
    delay = DESTROY_DELAY
    delayFresh = inInputPhase
  }

  // --- Ending a dig -----------------------------------------------------------------------------------------------

  function detach (d) {
    if (d.onUpdate) bot.removeListener(d.eventName, d.onUpdate)
    d.onUpdate = null
  }

  // The block is gone for the client (its own FINISH or START predicted it, or the server broke it)
  function broke (d, newBlock) {
    if (d.done) return
    d.done = true
    if (started === d) started = null
    detach(d)
    bot.lastDigTime = performance.now()
    syncTarget()
    bot.emit('diggingCompleted', newBlock ?? bot.blockAt(d.block.position))
    d.task.finish()
  }

  // The dig ends without being broken. The caller writes the ABORT, if one is due.
  function abandon (d, err = abortError()) {
    if (d.done) return
    d.done = true
    if (started === d) started = null
    detach(d)
    bot.lastDigTime = performance.now()
    syncTarget()
    bot.emit('diggingAborted', d.block)
    d.task.cancel(err)
  }

  function writeAbort (position, face) {
    bot._client.write('block_dig', { status: 1, location: position, face, sequence: 0 })
  }

  function cancelRequest (r) {
    r.cancelled = true
    if (request === r) request = null
    syncTarget()
    bot.emit('diggingAborted', r.block)
    r.task.cancel(abortError())
  }

  // --- Starting -----------------------------------------------------------------------------------------------------

  // MultiPlayerGameMode.startDestroyBlock. Everything that can fail is checked by the caller: nothing here throws
  // after the first packet is written. abortBlock: the block of a dig this one replaces, aborted with the new face.
  function begin (d, face, abortBlock, inInputPhase) {
    const ms = bot.digTime(d.block)
    if (abortBlock) writeAbort(abortBlock.position, face)
    bot._client.write('block_dig', { status: 0, location: d.block.position, face, sequence: bot._nextSequence() })
    bot._writeSwing()
    d.face = face
    d.progress = 0
    d.item = bot.heldItem?.type ?? null
    d.fresh = inInputPhase // the START tick adds no progress
    if (ms === 0) {
      // breaks at once: the client predicts the air and sends no FINISH. Creative also sets the destroy delay.
      if (bot.game.gameMode === 'creative') setDelay(inInputPhase)
      bot._updateBlockState(d.block.position, 0)
      broke(d)
      return
    }
    if (!d.onUpdate) {
      d.eventName = `blockUpdate:${d.block.position}`
      // The server never interrupts a dig, but some send a block update when it starts, so only air counts. All
      // block update listeners receive (null, null) when the world is unloaded.
      d.onUpdate = (oldBlock, newBlock) => { if (newBlock?.type === 0) broke(d, newBlock) }
      bot.on(d.eventName, d.onUpdate)
    }
    started = d
    syncTarget()
  }

  // Runs in the input phase of the tick the START goes out in
  function start (r, rot, forceLook) {
    if (r.cancelled) return
    const pos = r.block.position
    // AirLiquidBreak: not a block that is gone (own break, someone else's) or one that can not be clicked
    if (!bot._aim.isBreakable(bot.blockAt(pos))) throw new Error(`There is no block to dig at ${pos}`)
    const reach = bot._aim.blockReach()
    const hit = bot._aim.blockHitAt(pos, rot, reach)
    let face
    if (hit) {
      face = hit.face
    } else if (forceLook === 'ignore') {
      // the caller turns the head itself: the face the eyes look at, as long as the block is in reach
      if (bot._aim.distanceToBlock(pos) > reach) throw bot._aim.blockError('too-far')
      face = bot._aim.faceTowardsEyes(pos)
    } else {
      throw bot._aim.blockError(bot._aim.distanceToBlock(pos) > reach ? 'too-far' : 'no-sight')
    }
    if (bot.digTime(r.block) === Infinity) throw new Error(`dig time for ${r.block.name} is Infinity`)
    const old = started
    const d = { block: r.block, task: r.task, watch: forceLook !== 'ignore', progress: 0, fresh: true, done: false, suspended: false, face, item: null, eventName: null, onUpdate: null }
    if (request === r) request = null
    begin(d, face, old?.block, true)
    if (old) abandon(old) // its ABORT (with this face) went out in begin
  }

  // --- Every tick of a dig ---------------------------------------------------------------------------------------

  // MultiPlayerGameMode.continueDestroyBlock. Runs after the queue, in every tick, with the rotation of the tick's
  // movement packet and whether an action of another kind went out in it.
  function tick (rot, primarySent) {
    if (delay > 0) {
      if (delayFresh) {
        delayFresh = false
      } else {
        delay--
        // the held attack key goes on swinging through the delay
        if (request?.holding && !primarySent && !bot.usingHeldItem) bot._writeSwing()
      }
    }
    const d = started
    if (!d || d.suspended) return
    if (d.fresh) {
      d.fresh = false
      return
    }
    if (primarySent) return // something else was done in this tick: the key was not held
    try {
      continueDig(d, rot)
    } catch (err) {
      // a throw here would end the tick loop
      abandon(d, err)
    }
  }

  function continueDig (d, rot) {
    const pos = d.block.position
    const here = bot.blockAt(pos)
    if (!here) return writeAbortAndAbandon(d) // the chunk is gone
    if (here.type === 0) return // the server broke it: the block update completes the dig
    const reach = bot._aim.blockReach()
    const hit = bot._aim.blockHitAt(pos, rot, reach)
    // the crosshair left the block (or it left the reach): vanilla stops destroying
    if (d.watch ? !hit : bot._aim.distanceToBlock(pos) > reach) return writeAbortAndAbandon(d)
    const face = hit?.face ?? d.face
    if ((bot.heldItem?.type ?? null) !== d.item) {
      // another item in hand is another dig: ABORT and START again, with the face now looked at
      begin(d, face, d.block, false)
      return
    }
    const ms = bot.digTime(d.block)
    d.progress += ms === 0 ? 1 : ms === Infinity ? 0 : 50 / ms
    if (d.progress >= 1 - 1e-9) {
      bot._client.write('block_dig', { status: 2, location: pos, face, sequence: bot._nextSequence() })
      bot._writeSwing()
      setDelay(false)
      bot._updateBlockState(pos, 0) // the client predicts the air
      broke(d)
    } else {
      bot._writeSwing()
    }
  }

  function writeAbortAndAbandon (d) {
    writeAbort(d.block.position, DOWN)
    abandon(d)
  }

  // --- API ----------------------------------------------------------------------------------------------------------

  // Where to look to dig the block: a point of the face asked for, else of whatever side the eyes see
  function aimPoint (block, digFace) {
    const reach = bot._aim.blockReach()
    if (digFace?.x || digFace?.y || digFace?.z) {
      const found = bot._aim.facePoint(block, digFace, { reach })
      if (!found.ok) throw bot._aim.blockError(found.reason)
      return found.point
    }
    const point = bot._aim.visiblePoint(block, reach)
    if (!point) throw bot._aim.blockError(bot._aim.distanceToBlock(block.position) > reach ? 'too-far' : 'no-sight')
    return point
  }

  async function dig (block, forceLook, digFace) {
    if (block === null || block === undefined) {
      throw new Error('dig was called with an undefined or null block')
    }
    if (!digFace || typeof digFace === 'function') digFace = 'auto'

    const waitTime = bot.digTime(block)
    if (waitTime === Infinity) {
      throw new Error(`dig time for ${block?.name ?? block} is Infinity`)
    }

    if (!hooked) {
      hooked = true
      bot._input.onTick(tick)
    }

    // The block the dig is on: it just goes on, like holding the key
    if (started && started.block.position.equals(block.position)) {
      if (request) cancelRequest(request)
      started.suspended = false
      syncTarget()
      return started.task.promise
    }
    if (request && request.block.position.equals(block.position)) return request.task.promise

    // In vanilla the crosshair has to be on the new block before the old dig is given up; the ABORT then carries the
    // new START's face. The old dig stands still until then.
    if (request) cancelRequest(request)
    const mine = request = { block, task: createTask(), cancelled: false, holding: false }
    mine.task.promise.catch(() => {}) // a request replaced before it started is rejected for nobody
    if (started) started.suspended = true
    syncTarget()
    bot.targetDigBlock = block

    const check = () => { if (mine.cancelled) throw abortError() }
    try {
      if (forceLook !== 'ignore') {
        await bot._aim.lookSettled(aimPoint(block, digFace))
        check()
      }
      // a used item (eating...) first: the hands are busy (MultiActionsB, PacketOrderI)
      await bot._aim.releaseItem()
      check()
      // FastBreak: the 5 ticks after a break
      mine.holding = true
      while (delayLeft() > 0) {
        await bot._aim.ticks(1)
        check()
      }
      mine.holding = false
      await bot._input.enqueue('dig', (rot) => start(mine, rot, forceLook))
    } catch (err) {
      mine.holding = false
      if (request === mine) request = null
      if (started) started.suspended = false
      syncTarget()
      throw err
    }

    await mine.task.promise
  }

  // Let go of the attack key: ABORT with face DOWN and sequence 0, if the dig had started
  function stopDigging () {
    if (request) cancelRequest(request)
    const d = started
    if (!d) return
    abandon(d)
    // a dead player sends nothing
    if (bot.isAlive !== false) bot._input.enqueue('dig', () => writeAbort(d.block.position, DOWN))
  }

  bot.on('death', () => {
    try {
      bot.removeAllListeners('diggingAborted')
      bot.removeAllListeners('diggingCompleted')
      bot.stopDigging()
    } catch (_) {}
  })

  // A new world / a new connection starts from nothing: no packet is due for a dig of the old one
  const reset = () => {
    delay = 0
    if (request) cancelRequest(request)
    if (started) abandon(started)
  }
  bot.on('respawn', reset)
  bot.on('end', reset)

  function canDigBlock (block) {
    return !!block && block.diggable && bot._aim.distanceToBlock(block.position) <= bot._aim.blockReach()
  }

  function digTime (block) {
    let type = null
    let enchantments = []

    // Retrieve currently held item ID and active enchantments from heldItem
    const currentlyHeldItem = bot.heldItem
    if (currentlyHeldItem) {
      type = currentlyHeldItem.type
      enchantments = currentlyHeldItem.enchants
    }

    // Append helmet enchantments (because Aqua Affinity actually affects dig speed)
    const headEquipmentSlot = bot.getEquipmentDestSlot('head')
    const headEquippedItem = bot.inventory.slots[headEquipmentSlot]
    if (headEquippedItem) {
      const helmetEnchantments = headEquippedItem.enchants
      enchantments = enchantments.concat(helmetEnchantments)
    }

    const creative = bot.game.gameMode === 'creative'
    return block.digTime(
      type,
      creative,
      ['water', 'flowing_water'].includes(bot._getBlockAtEyeLevel()?.name),
      !bot.entity.onGround,
      enchantments,
      bot.entity.effects
    )
  }

  bot._getBlockAtEyeLevel = () => bot.entity.position && bot.blockAt(bot.entity.position.offset(0, bot.entity.eyeHeight, 0))
  bot.dig = dig
  bot.stopDigging = stopDigging
  bot.canDigBlock = canDigBlock
  bot.digTime = digTime
}
