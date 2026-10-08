const { Vec3 } = require('vec3')
const { sleep } = require('../promise_utils')

module.exports = inject

// Block and inventory interactions the way a vanilla client makes them, for servers running the Grim
// anticheat (9b9t). What a vanilla client does that a naive bot does not:
//   - A click names the face and the exact point the crosshair hits, sent after the rotation reached the
//     server, while the player stands still. -> clickBlock: look at a visible point, wait settleTicks, ray-cast, click.
//   - Clicking from 3-4 blocks was refused now and then on 9b9t; from within 3 it works. -> reach 3 by default.
//   - 9b9t silently refuses a container opened within ~0.5 s of the previous one (the click is acknowledged, no
//     window comes). -> openContainer keeps containerSpacingMs between opens.
//   - A window that opens after the caller gave up stays open, and a walk made with a window open is dropped by
//     the server. -> openContainer closes late windows; closeAnyWindow before walking.
//   - A player puts a totem in the offhand with the swap-hands key from the hotbar, not by clicking the inventory.
const DEFAULTS = {
  // Max distance from the eyes to the clicked point. Vanilla allows 4.5.
  reach: 3,
  // Ticks to wait after turning before clicking, so the rotation has reached the server.
  settleTicks: 2,
  // Minimum time between two container opens.
  containerSpacingMs: 1500,
  // How long to wait for a container window.
  openTimeoutMs: 8000,
  // Pause between two inventory clicks.
  clickGapMs: 150
}

// prismarine-world BlockFace order (BOTTOM, TOP, NORTH, SOUTH, WEST, EAST) -> outward direction
const FACE_DIRS = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]]

// Packets the server answers a click with, listed in the timeout error to tell "ignored" from "refused"
const REPLY_PACKETS = ['acknowledge_player_digging', 'open_window', 'close_window']

function inject (bot, options) {
  bot.vanilla = bot.vanilla ?? {}
  bot.vanilla.options = { ...DEFAULTS, ...options?.vanilla?.interact }

  let lastContainerOpenAt = 0
  let openChain = Promise.resolve()

  const config = (o) => ({ ...bot.vanilla.options, ...o })

  function eyePosition () {
    return bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)
  }

  // Ray-cast along the bot's current rotation from its eyes
  // (bot.blockAtCursor starts at the entity height instead, 0.18 above the eyes)
  function blockAtLook (reach) {
    const { yaw, pitch } = bot.entity
    const dir = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
    return bot.world.raycast(eyePosition(), dir, reach)
  }

  // Wait (up to maxTicks) until the bot stands on the ground without horizontal speed. True if it does.
  async function standStill (maxTicks = 20) {
    for (let i = 0; i < maxTicks; i++) {
      const v = bot.entity.velocity
      if (bot.entity.onGround && Math.abs(v.x) < 0.003 && Math.abs(v.z) < 0.003) return true
      await bot.waitForTicks(1)
    }
    return false
  }

  // Turn to a point and give the rotation settleTicks ticks to reach the server.
  async function lookSettled (point, settleTicks = bot.vanilla.options.settleTicks) {
    await bot.lookAt(point, true)
    await bot.waitForTicks(settleTicks)
  }

  // A point on the block that the bot's eyes can see within reach: the centre, else the centres of the faces
  // turned towards the eyes (a little inside, so the ray lands on that face). Null if none is visible.
  function visiblePoint (block, reach = bot.vanilla.options.reach) {
    const eye = eyePosition()
    const p = block.position
    const candidates = [p.offset(0.5, 0.5, 0.5)]
    for (const [x, y, z] of FACE_DIRS) {
      const face = p.offset(0.5 + x * 0.45, 0.5 + y * 0.45, 0.5 + z * 0.45)
      // Only faces turned towards the eyes can be hit
      if ((eye.x - face.x) * x + (eye.y - face.y) * y + (eye.z - face.z) * z > 0) candidates.push(face)
    }
    for (const c of candidates) {
      if (eye.distanceTo(c) > reach) continue
      const dir = c.minus(eye)
      const hit = bot.world.raycast(eye, dir.normalize(), reach)
      if (hit && hit.position.equals(p)) return c
    }
    return null
  }

  function clickError (result) {
    const err = new Error(result.reason === 'too-far' ? 'block is out of reach' : 'block is not visible within reach')
    err.code = result.reason
    return err
  }

  // Right-click a block like a vanilla client: stand still, look at a visible point, wait for the rotation to
  // reach the server, ray-cast, then send use_item_on with the face and exact point hit, and swing. Not sneaking
  // (a sneak click with an item in hand uses the item instead of the block).
  async function clickBlock (block, o) {
    const cfg = config(o)
    if (bot.getControlState('sneak')) bot.setControlState('sneak', false)
    await standStill()
    const target = visiblePoint(block, cfg.reach)
    if (!target) {
      const tooFar = eyePosition().distanceTo(block.position.offset(0.5, 0.5, 0.5)) > cfg.reach
      return { ok: false, reason: tooFar ? 'too-far' : 'no-sight' }
    }
    await lookSettled(target, cfg.settleTicks)
    const hit = blockAtLook(cfg.reach)
    if (!hit || !hit.position.equals(block.position) || !(hit.face >= 0 && hit.face <= 5)) return { ok: false, reason: 'no-sight' }
    const cursor = hit.intersect.minus(block.position)
    bot._writeBlockPlace(block.position, hit.face, cursor)
    bot.swingArm('right')
    return { ok: true, face: hit.face, cursor }
  }

  // Close the open container window, if any (do this before walking: a server may drop moves made with one open)
  function closeAnyWindow () {
    if (bot.currentWindow) {
      try { bot.closeWindow(bot.currentWindow) } catch { /* already closed */ }
    }
  }

  async function openOnce (block, o) {
    const cfg = config(o)
    closeAnyWindow()
    const since = Date.now() - lastContainerOpenAt
    if (since < cfg.containerSpacingMs) await sleep(cfg.containerSpacingMs - since)
    // What the server answers the click with, for the timeout error
    const replies = []
    const onReply = (data, meta) => {
      if (replies.length < 10 && REPLY_PACKETS.includes(meta.name)) {
        replies.push(meta.name === 'acknowledge_player_digging' ? `ack ${data.sequenceId}` : meta.name)
      }
    }
    bot._client.on('packet', onReply)
    try {
      const click = await clickBlock(block, cfg)
      if (!click.ok) throw clickError(click)
      // Listening from here misses nothing: the window comes from the network, and no I/O runs before this line
      const window = await new Promise((resolve, reject) => {
        const onOpen = (w) => {
          clearTimeout(timer)
          resolve(w)
        }
        const timer = setTimeout(() => {
          bot.removeListener('windowOpen', onOpen)
          // Too late to be useful, but a window may still come: close it so the bot isn't stuck "in" a container
          const late = (w) => { try { bot.closeWindow(w) } catch { /* gone */ } }
          bot.once('windowOpen', late)
          setTimeout(() => bot.removeListener('windowOpen', late), 15_000).unref()
          const err = new Error(`no window within ${cfg.openTimeoutMs / 1000} s (server sent: ${replies.join(', ') || 'nothing'})`)
          err.code = 'timeout'
          reject(err)
        }, cfg.openTimeoutMs)
        bot.once('windowOpen', onOpen)
      })
      lastContainerOpenAt = Date.now()
      return window
    } finally {
      bot._client.removeListener('packet', onReply)
    }
  }

  // Open a container block and resolve with its window (extended like bot.openBlock's: withdraw(), close()...).
  // Keeps containerSpacingMs between opens; concurrent calls queue up.
  function openContainer (block, o) {
    const run = openChain.then(() => openOnce(block, o))
    openChain = run.catch(() => {})
    return run
  }

  // One inventory click (mineflayer handles stateId and changed slots), paced like a person clicking
  async function windowClick (slot, mouseButton, mode, o) {
    await bot.clickWindow(slot, mouseButton, mode)
    await sleep(config(o).clickGapMs)
  }

  // Shift-click a slot of the open window (moves the stack to the other side)
  function shiftClick (slot, o) {
    return windowClick(slot, 0, 1, o)
  }

  // The swap-hands key (F): SWAP_ITEM_WITH_OFFHAND. Not a predicted action, so its sequence stays 0.
  function swapHands () {
    if (bot.supportFeature('doesntHaveOffHandSlot')) throw new Error('this version has no offhand')
    bot._client.write('block_dig', { status: 6, location: new Vec3(0, 0, 0), face: 0, sequence: 0 })
  }

  // Put an item that is in the hotbar into the offhand the way a player does: select its hotbar slot, press F,
  // select the previous slot again. Returns false if no such item is in the hotbar.
  async function offhandFromHotbar (match) {
    const hotbarStart = bot.inventory.hotbarStart ?? 36
    for (let i = 0; i < 9; i++) {
      const item = bot.inventory.slots[hotbarStart + i]
      if (!item || !match(item)) continue
      const previous = bot.quickBarSlot
      if (previous !== i) {
        bot.setQuickBarSlot(i)
        await bot.waitForTicks(1)
      }
      swapHands()
      await bot.waitForTicks(1)
      if (previous !== i) bot.setQuickBarSlot(previous)
      return true
    }
    return false
  }

  // Move an item from the main inventory (slots 9-35) into a hotbar slot with a number-key click on the
  // player's own inventory (no container needed). Prefers an empty hotbar slot. Returns the hotbar index or -1.
  async function toHotbar (match, o) {
    const inv = bot.inventory
    const hotbarStart = inv.hotbarStart ?? 36
    const from = inv.slots.findIndex((it, i) => i >= 9 && i < hotbarStart && it && match(it))
    if (from < 0) return -1
    let target = -1
    for (let i = 0; i < 9; i++) {
      if (!inv.slots[hotbarStart + i]) {
        target = i
        break
      }
    }
    if (target < 0) target = (bot.quickBarSlot + 1) % 9 // swap out something that isn't in hand
    await windowClick(from, target, 2, o)
    return target
  }

  Object.assign(bot.vanilla, {
    clickBlock,
    clickError,
    openContainer,
    closeAnyWindow,
    standStill,
    lookSettled,
    visiblePoint,
    windowClick,
    shiftClick,
    swapHands,
    offhandFromHotbar,
    toHotbar
  })
}
