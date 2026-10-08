// Helpers the scenarios share
const { Vec3 } = require('vec3')
const { CARDINALS, cellOf, center, follow, face, settle } = require('../lib/nav')
const { Inconclusive, hdist } = require('../lib/util')

// Collect what the bot writes while a block of code runs
function recordOut (ctx) {
  const list = []
  const on = (rec, params) => list.push({ rec, params })
  ctx.session.on('out', on)
  return { list, stop: () => ctx.session.removeListener('out', on) }
}

const isMovement = (name) => name === 'position' || name === 'position_look' || name === 'look' || name === 'flying'

// The positions the bot reported, in order
function sentPositions (list) {
  return list.filter(r => isMovement(r.rec.name) && r.params.x !== undefined).map(r => ({ tick: r.rec.tick, x: r.params.x, y: r.params.y, z: r.params.z, name: r.rec.name }))
}

// Horizontal distance per position packet from `from`, ignoring the packets before the first move
function moveDeltas (from, positions) {
  const out = []
  let prev = from
  let moving = false
  for (const p of positions) {
    const d = hdist(prev, p)
    if (!moving && d < 1e-6) { prev = p; continue }
    moving = true
    out.push(d)
    prev = p
  }
  return out
}

// Cardinal directions with a flat run of at least minRun cells ahead of pos
function runsAt (ctx, pos, { minRun, maxRun }) {
  return CARDINALS.map(dir => ({ dir, run: ctx.nav.flatRun(pos, dir, maxRun + 1) })).filter(r => r.run >= minRun)
}

// Walk (keys only) to open flat ground if the bot does not stand on some. `extra(pos)` adds a requirement (headroom).
// Returns the runs [{ dir, run }] from where the bot stands afterwards.
async function openGround (ctx, { minRun = 4, maxRun = 6, extra = () => true, prefer = 4 } = {}) {
  const bot = ctx.bot
  const good = (pos) => extra(pos) ? runsAt(ctx, pos, { minRun, maxRun }) : []
  const here = good(bot.entity.position)
  if (here.length >= prefer) return here
  for (const want of [prefer, 1]) {
    if (want === 1 && here.length >= 1) return here
    const found = ctx.nav.search(cellOf(bot.entity.position), (c) => {
      const r = good(center(c))
      return r.length >= want ? r : null
    }, { radius: ctx.opts.radius, maxNodes: 2500 })
    if (found) {
      ctx.note(`walking ${found.path.length} cells to open flat ground`)
      await follow(ctx, found.path)
      const r = good(bot.entity.position)
      if (r.length) return r
    }
  }
  throw new Inconclusive(`no flat ground with ${minRun} free blocks in a row within ${ctx.opts.radius} blocks`)
}

// Walk one leg with the movement keys: face the direction, then hold forward until `dist` blocks are covered.
// Returns what was sent during it.
async function leg (ctx, dir, dist, { sprint = false, sneak = false, jump = false, ticks } = {}) {
  const bot = ctx.bot
  const start = bot.entity.position.clone()
  await face(ctx, dir)
  await ctx.ticks(2)
  const rec = recordOut(ctx)
  let sprinted = 0
  let airborne = 0
  const coast = sprint ? 0.5 : sneak ? 0.05 : 0.3
  bot.setControlState('sneak', sneak)
  if (sneak) await ctx.ticks(2)
  bot.setControlState('forward', true)
  if (sprint) bot.setControlState('sprint', true)
  if (jump) bot.setControlState('jump', true)
  try {
    await ctx.until(() => {
      if (bot.sprinting) sprinted++
      if (!bot.entity.onGround) airborne++
      return hdist(start, bot.entity.position) >= dist - coast
    }, { ticks: ticks ?? Math.ceil(dist * (sneak ? 40 : 12)) + 40, what: `${dist} blocks of walking` })
  } finally {
    bot.clearControlStates()
  }
  await ctx.ticks(1)
  await settle(ctx)
  rec.stop()
  return { start, end: bot.entity.position.clone(), list: rec.list, moved: hdist(start, bot.entity.position), sprinted, airborne }
}

const opposite = (d) => CARDINALS.find(c => c.dx === -d.dx && c.dz === -d.dz)

// Out and back along one direction
async function outAndBack (ctx, dir, dist, flags) {
  const out = await leg(ctx, dir, dist, flags)
  const back = await leg(ctx, opposite(dir), Math.max(1, hdist(out.end, out.start)), flags)
  return { out, back }
}

// A block item from the inventory that can be placed as a plain solid block
const NOT_PLAIN = /(chest|barrel|shulker|furnace|table|anvil|bed$|door|sign|banner|button|lever|plate|rail|torch|sand$|gravel|powder|tnt|piston|dispenser|dropper|hopper|command|portal|crafting|loom|barrier|bedrock|spawner|lava|water|fire|end_|dragon|beacon|head|skull|lantern|campfire|candle|pot|cauldron|bell|lectern|stonecutter|grindstone|smithing|cartography|fletching|brewing|enchanting|jukebox|note_block|observer|repeater|comparator|daylight|target|sculk|slab|stairs|fence|wall|pane|trapdoor|gate|glass|leaves|ice|slime|honey|carpet|snow|cake|egg|coral|vine|sapling|flower|mushroom|crop|seeds|bamboo|kelp|scaffolding|chain|rod|bars|ladder|cobweb|web)/
function plainBlockItem (bot) {
  const prefer = ['cobblestone', 'dirt', 'stone', 'netherrack', 'oak_planks', 'deepslate', 'cobbled_deepslate']
  const items = bot.inventory.items().filter(i => bot.registry.blocksByName[i.name]?.boundingBox === 'block' && !NOT_PLAIN.test(i.name))
  return prefer.map(n => items.find(i => i.name === n)).find(Boolean) ?? items[0] ?? null
}

// What is inside a shulker box item: [{ name, count }] or null if the item carries no readable contents
function shulkerContents (bot, item) {
  const reg = bot.registry
  const nameOf = (id) => reg.items[id]?.name ?? `item#${id}`
  const comp = item.componentMap?.get('container') ?? item.components?.find(c => c.type === 'container')
  if (comp) {
    const contents = comp.data?.contents ?? comp.data?.items ?? comp.data
    return Array.isArray(contents)
      ? contents.map(s => s.item ?? s).filter(s => s && (s.itemCount ?? s.count) > 0).map(s => ({ name: nameOf(s.itemId ?? s.id), count: s.itemCount ?? s.count }))
      : null
  }
  // before 1.20.5: BlockEntityTag.Items in the item's NBT
  const items = item.nbt?.value?.BlockEntityTag?.value?.Items?.value?.value
  if (Array.isArray(items)) {
    return items.map(t => ({ name: String(t.id?.value ?? '?').replace('minecraft:', ''), count: t.Count?.value ?? t.count?.value ?? 1 }))
  }
  return item.nbt || item.components?.length ? [] : null
}

const itemLine = (i) => ({ name: i.name, count: i.count, slot: i.slot })

// Hold an inventory item the way a player does: its hotbar slot, after a number-key click if it is not in the hotbar
async function hold (ctx, item) {
  const bot = ctx.bot
  const start = bot.inventory.hotbarStart ?? 36
  let slot = bot.inventory.slots.findIndex((it, i) => i >= start && i < start + 9 && it && it.name === item.name)
  if (slot < 0) {
    const to = await bot.vanilla.toHotbar(i => i.name === item.name)
    if (to < 0) throw new Inconclusive(`${item.name} is not in the inventory`)
    await ctx.ticks(6)
    slot = start + to
  }
  await bot.setQuickBarSlot(slot - start)
}

module.exports = { hold, recordOut, isMovement, sentPositions, moveDeltas, runsAt, openGround, leg, outAndBack, opposite, plainBlockItem, shulkerContents, itemLine, Vec3 }
