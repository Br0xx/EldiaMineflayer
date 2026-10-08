const { Vec3 } = require('vec3')
const { cellOf, follow, settle } = require('../lib/nav')
const { Inconclusive } = require('../lib/util')
const { recordOut, plainBlockItem, shulkerContents, itemLine, hold } = require('./common')

const CONTAINERS = ['chest', 'trapped_chest', 'barrel', 'ender_chest']
const isContainerName = (n) => CONTAINERS.includes(n) || /shulker_box$/.test(n)

const container = {
  name: 'container',
  title: 'open chests, barrels, shulker boxes and ender chests; read their items and the shulkers inside',
  needs: 'a chest, barrel, shulker box or ender chest within the radius and reachable on foot',
  async run (ctx) {
    const bot = ctx.bot
    const nav = ctx.nav
    await ctx.grounded()
    const ids = Object.values(bot.registry.blocksByName).filter(b => isContainerName(b.name)).map(b => b.id)
    const eye = () => bot.entity.position.offset(0, 1.62, 0)
    const spots = bot.findBlocks({ matching: ids, maxDistance: ctx.opts.radius, count: 60 })
      .sort((a, b) => eye().distanceTo(a) - eye().distanceTo(b))
    if (!spots.length) ctx.skip('no chest, barrel, shulker box or ender chest within the radius')
    const results = []
    let opened = 0
    for (const pos of spots) {
      if (opened >= ctx.opts.maxContainers) break
      const block = bot.blockAt(pos)
      const label = `${block.name} at ${ctx.session.where(pos)}`
      const reach = nav.search(cellOf(bot.entity.position), (c) => {
        const e = new Vec3(c.x + 0.5, c.y + 1.62, c.z + 0.5)
        return e.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= 2.6 && !(c.x === pos.x && c.z === pos.z && c.y === pos.y) && nav.sees(c, block)
      }, { radius: ctx.opts.radius + 4, maxNodes: 4000 })
      if (!reach) {
        ctx.note(`${label}: no spot to stand within reach that is reachable on foot, skipped`)
        results.push({ block: block.name, pos: ctx.session.where(pos), status: 'unreachable' })
        continue
      }
      await follow(ctx, reach.path)
      opened++
      const rec = recordOut(ctx)
      const t0 = Date.now()
      let window
      try {
        window = await bot.openContainer(block)
      } catch (err) {
        rec.stop()
        ctx.fail(`${label}: could not open it (${err.code ?? 'error'}: ${err.message})`)
        results.push({ block: block.name, pos: ctx.session.where(pos), status: 'failed', error: err.message })
        continue
      }
      const openMs = Date.now() - t0
      const click = rec.list.find(r => r.rec.name === 'block_place')
      rec.stop()
      const items = window.containerItems()
      const lines = items.map(i => {
        const l = itemLine(i)
        if (/shulker_box$/.test(i.name)) {
          const inside = shulkerContents(bot, i)
          l.contents = inside
          if (inside === null) ctx.note(`${label}: a ${i.name} item without readable contents`)
        }
        return l
      })
      results.push({ block: block.name, pos: ctx.session.where(pos), status: 'ok', openMs, afterClickMs: click ? Date.now() - click.rec.t - ctx.session.t0 : null, windowType: window.type, items: lines.length, shulkersRead: lines.filter(l => l.contents).length })
      ctx.note(`${label}: ${lines.length} stacks in ${openMs} ms${lines.some(l => l.contents) ? ` (${lines.filter(l => l.contents).length} shulker boxes read)` : ''}`)
      bot.closeWindow(window).catch(() => {})
      await ctx.ticks(4)
      ctx.expect(!bot.currentWindow, `${label}: the window is still open after closing it`)
      await ctx.sleep(1500)
    }
    ctx.metric('containers', results)
    if (!opened) throw new Inconclusive('containers found, but none reachable on foot')
    ctx.metric('opened', results.filter(r => r.status === 'ok').length)
  }
}

const FOOD_NO = /^(rotten_flesh|poisonous_potato|spider_eye|pufferfish|chicken|golden_apple|enchanted_golden_apple|chorus_fruit|suspicious_stew|raw_|beef$|porkchop$|mutton$|rabbit$|cod$|salmon$|tropical_fish|milk|honey_bottle|potion|ominous)/

const inventory = {
  name: 'inventory',
  title: 'list the inventory; move a totem to the offhand and back; eat standing still',
  needs: 'nothing; a totem and food in the inventory make it do more',
  commands: false,
  async run (ctx) {
    const bot = ctx.bot
    const mc = bot.registry
    await ctx.grounded()
    const hotbarStart = bot.inventory.hotbarStart ?? 36
    const list = () => bot.inventory.items().map(itemLine)
    if (ctx.opts.commands) {
      if (!bot.inventory.items().some(i => i.name === 'totem_of_undying')) await ctx.command(`/give ${ctx.opts.username} totem_of_undying 1`)
      if (!bot.inventory.items().some(i => mc.foodsByName?.[i.name] && !FOOD_NO.test(i.name))) await ctx.command(`/give ${ctx.opts.username} bread 3`)
    }
    ctx.metric('inventory', list())
    ctx.note(`${bot.inventory.items().length} stacks in the inventory`)

    // totem
    const isTotem = (i) => i.name === 'totem_of_undying'
    const totem = bot.inventory.items().find(isTotem)
    if (!totem) ctx.note('no totem of undying: the offhand swap was skipped')
    else if (bot.inventory.slots[45]?.name === 'totem_of_undying') ctx.note('the offhand already holds a totem: the swap was skipped')
    else {
      let slot = bot.inventory.slots.findIndex((it, i) => i >= hotbarStart && i < hotbarStart + 9 && it && isTotem(it))
      if (slot < 0) {
        const to = await bot.vanilla.toHotbar(isTotem)
        ctx.note(`moved the totem to hotbar slot ${to} with a number-key click`)
        slot = hotbarStart + to
        await ctx.ticks(6)
      }
      const index = slot - hotbarStart
      const previous = bot.quickBarSlot
      const moved = await bot.vanilla.offhandFromHotbar(isTotem)
      ctx.expect(moved, 'offhandFromHotbar found no totem in the hotbar')
      const inOffhand = await ctx.until(() => bot.inventory.slots[45]?.name === 'totem_of_undying', { ticks: 40, what: 'the totem in the offhand' }).then(() => true, () => false)
      ctx.expect(inOffhand, 'the server did not put the totem in the offhand')
      if (inOffhand) {
        await ctx.ticks(10)
        await bot.setQuickBarSlot(index)
        await bot.vanilla.swapHands()
        await bot.setQuickBarSlot(previous)
        const back = await ctx.until(() => bot.inventory.slots[slot]?.name === 'totem_of_undying', { ticks: 40, what: 'the totem back in the hotbar' }).then(() => true, () => false)
        ctx.expect(back, 'the totem did not come back from the offhand')
      }
      ctx.metric('totemSwap', inOffhand)
    }

    // food
    const food = bot.inventory.items().find(i => mc.foodsByName?.[i.name] && !FOOD_NO.test(i.name) && i.slot >= hotbarStart && i.slot < hotbarStart + 9)
    if (!food) ctx.note('no safe food in the hotbar: eating was skipped')
    else if (bot.food >= 20) ctx.note('food is full: eating was skipped')
    else {
      const previous = bot.quickBarSlot
      const before = bot.food
      await bot.setQuickBarSlot(food.slot - hotbarStart)
      await ctx.ticks(4)
      await settle(ctx)
      try {
        await bot.consume()
      } catch (err) {
        ctx.fail(`eating ${food.name} failed: ${err.message}`)
      }
      await ctx.ticks(10)
      await bot.setQuickBarSlot(previous)
      ctx.metric('ate', { item: food.name, foodBefore: before, foodAfter: bot.food })
      ctx.expect(bot.food > before, `food did not rise after eating ${food.name} (${before} -> ${bot.food})`)
    }
  }
}

// The block next to the bot's feet that is cheap to dig and put back: a floor block of a neighbouring column
function diggable (ctx) {
  const bot = ctx.bot
  const nav = ctx.nav
  const c = cellOf(bot.entity.position)
  const names = ['dirt', 'grass_block', 'stone', 'cobblestone', 'netherrack', 'sand', 'gravel', 'end_stone', 'deepslate', 'andesite', 'diorite', 'granite', 'oak_planks']
  const out = []
  for (const d of [{ dx: 0, dz: -1 }, { dx: 1, dz: 0 }, { dx: 0, dz: 1 }, { dx: -1, dz: 0 }]) {
    const b = nav.at(c.x + d.dx, c.y - 1, c.z + d.dz)
    const above = nav.at(c.x + d.dx, c.y, c.z + d.dz)
    if (!b || !nav.fullCube(b) || !nav.passable(above) || !b.diggable) continue
    const ms = bot.digTime(b)
    if (!Number.isFinite(ms) || ms > 10000) continue
    out.push({ block: b, ms, pref: names.indexOf(b.name) < 0 ? 99 : names.indexOf(b.name) })
  }
  return out.sort((a, b) => a.pref - b.pref || a.ms - b.ms)
}

const dig = {
  name: 'dig',
  title: 'dig the block next to the feet, check the START/FINISH timing, put it back if the drop is at hand',
  needs: 'a diggable full block next to the bot with free air above it (--modify)',
  modify: true,
  async run (ctx) {
    const bot = ctx.bot
    await ctx.grounded()
    const [pick] = diggable(ctx)
    if (!pick) ctx.skip('no diggable block next to the feet')
    const { block, ms } = pick
    const where = ctx.session.where(block.position)
    const name = block.name
    const expected = Math.ceil(ms / 50)
    const rec = recordOut(ctx)
    try {
      await bot.dig(block)
    } catch (err) {
      rec.stop()
      ctx.fail(`dig ${name} at ${where} failed: ${err.message}`)
      return
    }
    await ctx.ticks(6)
    rec.stop()
    const dig = rec.list.filter(r => r.rec.name === 'block_dig')
    const start = dig.find(r => r.params.status === 0)
    const finish = dig.find(r => r.params.status === 2)
    ctx.expect(!!start, 'no START (block_dig status 0) was sent')
    ctx.metric('block', name)
    ctx.metric('digTimeMs', ms)
    if (ms > 0 && expected > 1) {
      if (ctx.expect(!!finish, `no FINISH (status 2) after START of ${name}`) && start) {
        const gap = finish.rec.tick - start.rec.tick
        ctx.metric('startToFinishTicks', gap)
        ctx.metric('expectedTicks', expected)
        ctx.expect(gap >= expected, `FINISH came ${gap} ticks after START, the break takes ${expected} (FastBreak)`)
        ctx.expect(gap <= expected + 3, `FINISH came ${gap} ticks after START, the break takes ${expected}`)
      }
    }
    const swings = rec.list.filter(r => r.rec.name === 'arm_animation').length
    ctx.metric('swings', swings)
    const after = bot.blockAt(block.position)
    ctx.expect(after && after.name === 'air', `the server did not break ${name} at ${where} (it is ${after?.name})`)
    // the drop is picked up when the bot stands next to it; the item may be another one (grass drops dirt)
    const wanted = [name, ...(bot.registry.blocks[block.type]?.drops ?? []).map(d => bot.registry.items[typeof d === 'number' ? d : d.drop]?.name)].filter(Boolean)
    let mine = null
    for (let i = 0; i < 12 && !mine; i++) {
      await ctx.sleep(250)
      mine = bot.inventory.items().find(it => wanted.includes(it.name))
    }
    if (after?.name === 'air' && mine) {
      const ref = ctx.nav.at(block.position.x, block.position.y - 1, block.position.z)
      try {
        await hold(ctx, mine)
        await bot.placeBlock(ref, new Vec3(0, 1, 0))
        await ctx.ticks(6)
        ctx.note(`put a ${mine.name} back where the ${name} was`)
      } catch (err) {
        ctx.note(`left a hole where ${name} was at ${where}: ${err.message}`)
      }
    } else if (after?.name === 'air') {
      ctx.note(`left a hole where ${name} was at ${where} (the drop was not picked up)`)
    }
  }
}

const place = {
  name: 'place',
  title: 'place a block next to the feet and dig it again',
  needs: 'a plain block item in the inventory and free ground next to the bot (--modify)',
  modify: true,
  async run (ctx) {
    const bot = ctx.bot
    const nav = ctx.nav
    await ctx.grounded()
    const item = plainBlockItem(bot)
    if (!item) ctx.skip('no plain block item in the inventory to place')
    const c = cellOf(bot.entity.position)
    const spot = [{ dx: 0, dz: -1 }, { dx: 1, dz: 0 }, { dx: 0, dz: 1 }, { dx: -1, dz: 0 }]
      .map(d => ({ ref: nav.at(c.x + d.dx, c.y - 1, c.z + d.dz), at: new Vec3(c.x + d.dx, c.y, c.z + d.dz) }))
      .find(s => nav.floorOk(s.ref) && s.ref.name !== 'grass_block_x' && nav.passable(nav.at(s.at.x, s.at.y, s.at.z)) && nav.passable(nav.at(s.at.x, s.at.y + 1, s.at.z)))
    if (!spot) ctx.skip('no free floor next to the feet')
    await hold(ctx, item)
    await ctx.ticks(3)
    const rec = recordOut(ctx)
    try {
      await bot.placeBlock(spot.ref, new Vec3(0, 1, 0))
    } catch (err) {
      rec.stop()
      ctx.fail(`placing ${item.name} failed: ${err.message}`)
      return
    }
    await ctx.ticks(6)
    rec.stop()
    const placed = bot.blockAt(spot.at)
    ctx.expect(rec.list.some(r => r.rec.name === 'block_place'), 'no block_place packet was sent')
    ctx.expect(placed && placed.name === item.name, `the server did not keep the ${item.name} (the block is ${placed?.name})`)
    if (placed && placed.name === item.name) {
      await ctx.sleep(300)
      try {
        await bot.dig(placed)
        await ctx.ticks(6)
        ctx.note(`placed ${item.name} and dug it again`)
      } catch (err) {
        ctx.fail(`digging the placed ${item.name} failed: ${err.message}`)
      }
    }
  }
}

module.exports = { container, inventory, dig, place }
