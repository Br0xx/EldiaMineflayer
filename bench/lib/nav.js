// Looking at the world around the bot and walking in it with the movement keys only (no pathfinder), so the
// scenarios can adapt to whatever they spawn in. Cells are integer block coordinates; a "standing cell" is the
// block the feet are in, with a full solid cube below it and two free blocks above the floor.
const { Vec3 } = require('vec3')
const { Inconclusive } = require('./util')

const CARDINALS = [
  { name: 'north', dx: 0, dz: -1 },
  { name: 'east', dx: 1, dz: 0 },
  { name: 'south', dx: 0, dz: 1 },
  { name: 'west', dx: -1, dz: 0 }
]
const LIQUID = new Set(['water', 'lava', 'bubble_column'])
// The player can walk through these but not like through air
const SLOW_OR_RISKY = new Set(['cobweb', 'sweet_berry_bush', 'fire', 'soul_fire', 'powder_snow', 'ladder', 'vine', 'scaffolding', 'nether_portal', 'end_portal', 'end_gateway', 'tripwire', 'wither_rose', 'big_dripleaf', 'twisting_vines', 'weeping_vines', 'cave_vines', 'kelp', 'seagrass', 'tall_seagrass'])
// Floors that change the physics (friction, bounce, slowdown) or hurt
const ODD_FLOOR = new Set(['lava', 'cactus', 'magma_block', 'campfire', 'soul_campfire', 'honey_block', 'soul_sand', 'slime_block', 'ice', 'packed_ice', 'blue_ice', 'frosted_ice', 'mud', 'powder_snow', 'bubble_column', 'pointed_dripstone', 'wither_rose', 'sculk_sensor', 'sculk_shrieker', 'sculk_catalyst', 'bedrock_placeholder'])

const cellOf = (v) => ({ x: Math.floor(v.x), y: Math.floor(v.y + 0.001), z: Math.floor(v.z) })
const center = (c) => new Vec3(c.x + 0.5, c.y, c.z + 0.5)
const key = (c) => `${c.x},${c.y},${c.z}`
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a))
const yawTo = (dx, dz) => Math.atan2(-dx, -dz)

function make (bot) {
  const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))

  const fullCube = (b) => {
    const s = b?.shapes
    return !!s && s.length === 1 && s[0][0] === 0 && s[0][1] === 0 && s[0][2] === 0 && s[0][3] === 1 && s[0][4] === 1 && s[0][5] === 1
  }
  const floorOk = (b) => !!b && fullCube(b) && !ODD_FLOOR.has(b.name)
  const passable = (b) => !!b && b.boundingBox === 'empty' && !LIQUID.has(b.name) && !SLOW_OR_RISKY.has(b.name)
  const isWater = (b) => !!b && b.name === 'water'

  // Can a player stand here (feet in this cell)?
  function standable (x, y, z) {
    return floorOk(at(x, y - 1, z)) && passable(at(x, y, z)) && passable(at(x, y + 1, z))
  }

  // How many standing cells in a row at the same height lie ahead of `pos` in a cardinal direction, over the
  // width of the player box
  function flatRun (pos, dir, max = 8) {
    const c = cellOf(pos)
    const along = dir.dx !== 0 ? 'x' : 'z'
    const lat = dir.dx !== 0 ? 'z' : 'x'
    const lo = Math.floor(pos[lat] - 0.31)
    const hi = Math.floor(pos[lat] + 0.31)
    let n = 0
    for (let k = 1; k <= max; k++) {
      const a = c[along] + (dir.dx + dir.dz) * k
      let ok = true
      for (let l = lo; l <= hi && ok; l++) {
        const x = along === 'x' ? a : l
        const z = along === 'x' ? l : a
        ok = standable(x, c.y, z) && passable(at(x, c.y + 2, z))
      }
      if (!ok) break
      n = k
    }
    return n
  }

  // Neighbour standing cells: same height, one step up (a jump) or one step down
  function neighbours (c, { jumps = true } = {}) {
    const out = []
    for (const d of CARDINALS) {
      const x = c.x + d.dx
      const z = c.z + d.dz
      if (standable(x, c.y, z)) out.push({ x, y: c.y, z, d })
      else if (jumps && standable(x, c.y + 1, z) && passable(at(c.x, c.y + 2, c.z))) out.push({ x, y: c.y + 1, z, d })
      else if (standable(x, c.y - 1, z) && passable(at(x, c.y + 1, z))) out.push({ x, y: c.y - 1, z, d })
    }
    return out
  }

  // Is the block the player would step on missing next to this cell (a drop of a block or more)?
  const dropAt = (c, d) => {
    const x = c.x + d.dx
    const z = c.z + d.dz
    return passable(at(x, c.y, z)) && passable(at(x, c.y + 1, z)) && !!at(x, c.y - 1, z) && at(x, c.y - 1, z).boundingBox === 'empty' && !isWater(at(x, c.y - 1, z)) && !LIQUID.has(at(x, c.y - 1, z).name)
  }
  const isEdge = (c) => CARDINALS.some(d => dropAt(c, d))

  // Breadth-first search over standing cells for the nearest one `goal(cell)` accepts. Returns { cell, path, value }
  // (path: cells from the one after the start to the goal) or null. Cells at an edge are avoided unless allowEdges.
  function search (start, goal, { radius = 16, maxNodes = 5000, jumps = true, allowEdges = false } = {}) {
    const seen = new Map([[key(start), null]])
    const queue = [start]
    let n = 0
    while (queue.length && n++ < maxNodes) {
      const c = queue.shift()
      const value = goal(c)
      if (value) {
        const path = []
        for (let p = c; p && key(p) !== key(start); p = seen.get(key(p))) path.unshift(p)
        return { cell: c, path, value }
      }
      for (const nb of neighbours(c, { jumps })) {
        if (seen.has(key(nb))) continue
        if (Math.hypot(nb.x - start.x, nb.z - start.z) > radius || Math.abs(nb.y - start.y) > 6) continue
        if (!allowEdges && isEdge(nb)) continue
        seen.set(key(nb), c)
        queue.push(nb)
      }
    }
    return null
  }

  // Free line from the eyes of a player standing in `c` to the middle of `block`
  function sees (c, block) {
    const eye = new Vec3(c.x + 0.5, c.y + 1.62, c.z + 0.5)
    const target = block.position.offset(0.5, 0.5, 0.5)
    const dist = eye.distanceTo(target)
    const step = target.minus(eye).scaled(0.1 / dist)
    for (let p = eye.clone(), d = 0; d < dist - 0.6; d += 0.1, p.add(step)) {
      const b = bot.blockAt(p)
      if (b && b.boundingBox === 'block' && !b.position.equals(block.position)) return false
    }
    return true
  }

  return { at, fullCube, floorOk, passable, isWater, standable, flatRun, neighbours, dropAt, isEdge, search, sees, cellOf, center }
}

// ---- steering, with a scenario context (ctx.bot, ctx.until) -------------------------------------------------

function horizontalSpeed (v) { return Math.hypot(v.x, v.z) }

// Wait until the bot stands still on the ground
async function settle (ctx, ticks = 100) {
  const bot = ctx.bot
  let still = 0
  try {
    await ctx.until(() => {
      const v = bot.entity.velocity
      still = bot.entity.onGround && horizontalSpeed(v) < 0.004 && Math.abs(v.y) < 0.1 ? still + 1 : 0
      return still >= 3
    }, { ticks, what: 'the bot to stand still on the ground' })
  } catch (err) {
    throw new Inconclusive(`the bot did not come to rest (${err.message})`)
  }
}

function aim (bot, dx, dz, pitch = 0) {
  const yaw = yawTo(dx, dz)
  if (Math.abs(wrapAngle(yaw - bot.entity.yaw)) > 0.07 || Math.abs(bot.entity.pitch - pitch) > 0.07) bot.look(yaw, pitch).catch(() => {})
}

// Walk (keys only) to the middle of a cell. Throws Inconclusive if something blocks the way.
async function steerTo (ctx, cell, { tolerance = 0.3, stop = false, ticks = 100, sprint = false } = {}) {
  const bot = ctx.bot
  const target = center(cell)
  let lastPos = bot.entity.position.clone()
  let still = 0
  bot.setControlState('forward', true)
  if (sprint) bot.setControlState('sprint', true)
  try {
    await ctx.until(() => {
      const p = bot.entity.position
      const dx = target.x - p.x
      const dz = target.z - p.z
      const d = Math.hypot(dx, dz)
      if (d < tolerance + (stop ? 0.15 : 0)) return true
      aim(bot, dx, dz)
      const feetY = Math.floor(p.y + 0.001)
      bot.setControlState('jump', cell.y > feetY && bot.entity.onGround && d < 1.4)
      still = Math.hypot(p.x - lastPos.x, p.z - lastPos.z) < 0.02 ? still + 1 : 0
      lastPos = p.clone()
      if (still > 14 && !bot.entity.isInWater) throw new Inconclusive(`blocked at ${ctx.session.where(p)} on the way to ${ctx.session.where(cell)}`)
      return false
    }, { ticks, what: `the bot to reach ${ctx.session.where(cell)}` })
  } catch (err) {
    bot.clearControlStates()
    if (err instanceof Inconclusive) throw err
    throw new Inconclusive(err.message)
  }
  if (stop) {
    bot.clearControlStates()
    await settle(ctx)
  }
}

async function follow (ctx, path, opts = {}) {
  for (let i = 0; i < path.length; i++) await steerTo(ctx, path[i], { ...opts, stop: i === path.length - 1 })
  ctx.bot.clearControlStates()
  if (!path.length) await settle(ctx)
}

// Face a cardinal direction and wait for the packet that carries it
async function face (ctx, dir, pitch = 0) {
  await ctx.bot.look(yawTo(dir.dx, dir.dz), pitch)
}

module.exports = { make, CARDINALS, cellOf, center, key, settle, steerTo, follow, face, aim, yawTo, wrapAngle, horizontalSpeed, LIQUID }
