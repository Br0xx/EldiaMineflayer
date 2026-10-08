const { Vec3 } = require('vec3')
const { sleep } = require('../promise_utils')
const playerActionId = require('../player_action')

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

// Packets the server answers a click with, listed in the timeout error to tell "ignored" from "refused"
const REPLY_PACKETS = ['acknowledge_player_digging', 'open_window', 'close_window']

function inject (bot, options) {
  bot.vanilla = bot.vanilla ?? {}
  bot.vanilla.options = { ...DEFAULTS, ...options?.vanilla?.interact }

  let lastContainerOpenAt = 0
  let openChain = Promise.resolve()

  const config = (o) => ({ ...bot.vanilla.options, ...o })

  // The aiming helpers live in aim.js (digging, placing and attacking use them too)
  const { eyePosition, blockAtLook, standStill, lookSettled, visiblePoint } = bot._aim
  const lookSettledDefault = (point, settleTicks = bot.vanilla.options.settleTicks) => lookSettled(point, settleTicks)

  function clickError (result) {
    return bot._aim.blockError(result.reason)
  }

  // Right-click a block like a vanilla client: stand still, look at a visible point, wait for the rotation to
  // reach the server, ray-cast, then send use_item_on with the face and exact point hit, and swing. Not sneaking
  // (a sneak click with an item in hand uses the item instead of the block).
  async function clickBlock (block, o) {
    const cfg = config(o)
    if (bot.getControlState('sneak')) bot.setControlState('sneak', false)
    await bot._aim.releaseItem() // hands busy with an item: no click
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
    // Written in the input phase of a tick, the swing right behind. The rotation of that tick's movement packet must
    // still point at the block (somebody may have turned the head meanwhile).
    let sent = false
    await bot._input.enqueue('use', (rot) => {
      if (!bot._aim.blockHitAt(block.position, rot, cfg.reach)) return
      bot._writeBlockPlace(block.position, hit.face, cursor)
      bot._writeSwing('right')
      sent = true
    })
    return sent ? { ok: true, face: hit.face, cursor } : { ok: false, reason: 'no-sight' }
  }

  // Close the open container window, if any (do this before walking: a server may drop moves made with one open).
  // The close waits for the movement keys to be released, as a window click does (see inventory.js).
  async function closeAnyWindow () {
    if (bot.currentWindow) {
      try { await bot.closeWindow(bot.currentWindow) } catch { /* already closed */ }
    }
  }

  async function openOnce (block, o) {
    const cfg = config(o)
    await closeAnyWindow()
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

  // The swap-hands key (F): SWAP_ITEM_WITH_OFFHAND. Not a predicted action, so its sequence stays 0. It goes out
  // with the next tick, ahead of any click, and resolves once it is written.
  function swapHands () {
    if (bot.supportFeature('doesntHaveOffHandSlot')) throw new Error('this version has no offhand')
    return bot._input.enqueue('swap', () => {
      bot._client.write('block_dig', { status: playerActionId(bot.registry, 'swap_hands'), location: new Vec3(0, 0, 0), face: 0, sequence: 0 })
    })
  }

  // Put an item that is in the hotbar into the offhand the way a player does: select its hotbar slot, press F,
  // select the previous slot again. Returns false if no such item is in the hotbar.
  async function offhandFromHotbar (match) {
    const hotbarStart = bot.inventory.hotbarStart ?? 36
    for (let i = 0; i < 9; i++) {
      const item = bot.inventory.slots[hotbarStart + i]
      if (!item || !match(item)) continue
      const previous = bot.quickBarSlot
      // each step is a tick of its own: select (start of a tick), swap (next tick), select the old slot again
      if (previous !== i) await bot.setQuickBarSlot(i)
      await swapHands()
      if (previous !== i) await bot.setQuickBarSlot(previous)
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

  // Keep a totem of undying in the offhand: from the hotbar with the swap-hands key, else (fromInventory) one from
  // the main inventory is moved to the hotbar first, standing still unless health is 10 or less. Waits up to 20
  // ticks for the server to confirm the offhand slot. Returns whether the offhand holds a totem.
  // Pair it with the pop: bot.on('totemUsed', () => bot.vanilla.ensureOffhandTotem())
  let totemRun = null
  function ensureOffhandTotem ({ fromInventory = true } = {}) {
    totemRun ??= (async () => {
      if (bot.supportFeature('doesntHaveOffHandSlot')) return false
      const isTotem = item => item.name === 'totem_of_undying'
      const offhandHasTotem = () => !!bot.inventory.slots[45] && isTotem(bot.inventory.slots[45])
      if (offhandHasTotem()) return true
      let swapped = await offhandFromHotbar(isTotem)
      if (!swapped && fromInventory) {
        if (bot.health > 10) await standStill()
        if (await toHotbar(isTotem) >= 0) swapped = await offhandFromHotbar(isTotem)
      }
      if (!swapped) return false
      for (let i = 0; i < 20 && !offhandHasTotem(); i++) await bot._input.nextTick()
      return offhandHasTotem()
    })().finally(() => { totemRun = null })
    return totemRun
  }

  // Entity actions, reported as a result like clickBlock's instead of an error: { ok: true } or
  // { ok: false, reason: 'gone' | 'too-far' | 'no-sight' | 'moved' }. See bot.attack / bot.useOn for the options.
  async function entityAction (action, entity, o) {
    try {
      await action(entity, o)
      return { ok: true }
    } catch (err) {
      if (['gone', 'too-far', 'no-sight', 'moved'].includes(err.code)) return { ok: false, reason: err.code }
      throw err
    }
  }

  // Aim at the entity's hitbox, let the rotation settle, then attack and swing
  const attackEntity = (entity, o) => entityAction((e, opts) => bot.attack(e, opts), entity, o)

  // Aim at the entity's hitbox, let the rotation settle, then right-click it (use_entity at the hit point, then the interaction)
  const interactEntity = (entity, o) => entityAction((e, opts) => bot._interactEntity(e, opts), entity, o)

  Object.assign(bot.vanilla, {
    attackEntity,
    interactEntity,
    clickBlock,
    clickError,
    openContainer,
    closeAnyWindow,
    standStill,
    lookSettled: lookSettledDefault,
    visiblePoint: (block, reach = bot.vanilla.options.reach) => visiblePoint(block, reach),
    windowClick,
    shiftClick,
    swapHands,
    offhandFromHotbar,
    ensureOffhandTotem,
    toHotbar
  })
}
