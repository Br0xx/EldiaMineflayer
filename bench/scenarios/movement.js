const { Vec3 } = require('vec3')
const { CARDINALS, cellOf, center, follow, face, settle, steerTo } = require('../lib/nav')
const { walkCurve, jumpCurve, compare } = require('../lib/vanilla')
const { Inconclusive, hdist, round } = require('../lib/util')
const { recordOut, sentPositions, moveDeltas, openGround, outAndBack, opposite } = require('./common')

// Whether the floor under the bot is a plain full block (vanilla slipperiness 0.6)
const plainFloor = (ctx) => {
  const c = cellOf(ctx.bot.entity.position)
  return ctx.nav.floorOk(ctx.nav.at(c.x, c.y - 1, c.z))
}
const headroom = (ctx, n = 4) => (pos) => {
  const c = cellOf(pos)
  for (let dy = 2; dy < n; dy++) if (!ctx.nav.passable(ctx.nav.at(c.x, c.y + dy, c.z))) return false
  return true
}

const walk = {
  name: 'walk',
  title: 'walk 4 to 6 blocks each way and back, against the vanilla acceleration curve',
  needs: 'flat ground with 4 free blocks in a row, ideally in all four directions',
  async run (ctx) {
    const bot = ctx.bot
    await ctx.grounded()
    const runs = await openGround(ctx, { minRun: 4, maxRun: 6, prefer: 4 })
    await settle(ctx)
    ctx.note(`directions walked: ${runs.map(r => `${r.dir.name} ${Math.min(6, r.run)}`).join(', ')}`)
    let first = true
    for (const { dir, run } of runs) {
      const dist = Math.min(6, run)
      const from = bot.entity.position.clone()
      const checkCurve = first && plainFloor(ctx)
      const { out, back } = await outAndBack(ctx, dir, dist)
      ctx.expect(out.moved > dist - 1, `walking ${dir.name} moved only ${out.moved.toFixed(2)} of ${dist} blocks`)
      ctx.expect(hdist(back.end, from) < 1.2, `after walking ${dir.name} and back the bot is ${hdist(back.end, from).toFixed(2)} blocks from where it started`)
      if (checkCurve) {
        const deltas = moveDeltas(out.start, sentPositions(out.list))
        const cmp = compare(deltas.slice(0, 5), walkCurve(5))
        ctx.metric('walkFirstTicks', deltas.slice(0, 5).map(d => round(d, 4)))
        ctx.metric('walkCurveMaxError', round(cmp.max, 6))
        ctx.expect(cmp.max < 0.002, `the first ticks of walking from rest moved ${deltas.slice(0, 5).map(d => d.toFixed(4)).join(', ')}, vanilla: ${walkCurve(5).map(d => d.toFixed(4)).join(', ')}`)
        first = false
      }
    }
  }
}

const sprint = {
  name: 'sprint',
  title: 'sprint 4 to 6 blocks and back',
  needs: 'flat ground with 4 free blocks in a row; food above 6',
  async run (ctx) {
    const bot = ctx.bot
    await ctx.grounded()
    if (bot.food <= 6) throw new Inconclusive(`food is ${bot.food}: a bot cannot sprint at 6 or less`)
    const [{ dir, run }] = await openGround(ctx, { minRun: 4, maxRun: 6, prefer: 2 })
    const dist = Math.min(6, run)
    const { out, back } = await outAndBack(ctx, dir, dist, { sprint: true })
    ctx.metric('sprintTicks', out.sprinted + back.sprinted)
    ctx.expect(out.sprinted > 3, 'the bot never started sprinting')
    const steady = Math.max(0, ...moveDeltas(out.start, sentPositions(out.list)))
    ctx.metric('sprintTopSpeed', round(steady, 4))
    if (!Object.keys(bot.entity.effects ?? {}).length && plainFloor(ctx)) {
      ctx.expect(steady > 0.25 && steady < 0.3, `sprinting reached ${steady.toFixed(4)} blocks per tick at most (vanilla: about 0.28)`)
    }
    ctx.expect(back.moved > dist - 1.5, `the way back moved only ${back.moved.toFixed(2)} blocks`)
  }
}

const jump = {
  name: 'jump',
  title: 'jump in place five times against the vanilla arc',
  needs: 'ground with 3 free blocks above it',
  async run (ctx) {
    const bot = ctx.bot
    await ctx.grounded()
    await openGround(ctx, { minRun: 1, prefer: 1, extra: headroom(ctx, 4) }).catch(() => {
      if (!headroom(ctx, 4)(bot.entity.position)) throw new Inconclusive('no spot with 3 free blocks above the ground')
    })
    await settle(ctx)
    const worst = []
    for (let i = 0; i < 5; i++) {
      const y0 = bot.entity.position.y
      const rec = recordOut(ctx)
      bot.setControlState('jump', true)
      bot.setControlState('jump', false) // a tap: it still counts for the next tick
      let rose = false
      await ctx.until(() => {
        rose = rose || bot.entity.position.y > y0 + 0.1
        return rose && bot.entity.onGround
      }, { ticks: 60, what: 'the jump to land' })
      await ctx.ticks(2)
      rec.stop()
      const all = sentPositions(rec.list).map(p => p.y - y0)
      const ys = all.slice(Math.max(0, all.findIndex(y => y > 1e-6)))
      const cmp = compare(ys.slice(0, 5), jumpCurve(5))
      worst.push(cmp.max)
      if (i === 0) ctx.metric('jumpArcHeights', ys.slice(0, 5).map(y => round(y, 4)))
      ctx.expect(cmp.max < 0.003, `jump ${i + 1}: heights ${ys.slice(0, 5).map(y => y.toFixed(4)).join(', ')}, vanilla: ${jumpCurve(5).map(y => y.toFixed(4)).join(', ')}`)
      ctx.expect(Math.abs(bot.entity.position.y - y0) < 0.01, `jump ${i + 1}: landed at y ${(bot.entity.position.y - y0).toFixed(4)} from where it took off`)
      await ctx.ticks(3)
    }
    ctx.metric('jumpArcMaxError', round(Math.max(...worst), 6))
  }
}

const sprintjump = {
  name: 'sprintjump',
  title: 'sprint-jump 4 to 6 blocks and back',
  needs: 'flat ground with 4 free blocks in a row and 3 free blocks above it; food above 6',
  async run (ctx) {
    const bot = ctx.bot
    await ctx.grounded()
    if (bot.food <= 6) throw new Inconclusive(`food is ${bot.food}: a bot cannot sprint at 6 or less`)
    const [{ dir, run }] = await openGround(ctx, { minRun: 4, maxRun: 6, prefer: 2, extra: headroom(ctx, 4) })
    const dist = Math.min(6, run)
    const { out, back } = await outAndBack(ctx, dir, dist, { sprint: true, jump: true })
    ctx.metric('airTicks', out.airborne + back.airborne)
    ctx.expect(out.airborne > 2, 'the bot never left the ground')
    ctx.expect(out.moved > dist - 2, `the sprint jump moved only ${out.moved.toFixed(2)} of ${dist} blocks`)
    ctx.expect(back.moved > dist - 2.5, `the way back moved only ${back.moved.toFixed(2)} blocks`)
  }
}

const sneak = {
  name: 'sneak',
  title: 'sneak-walk, and stop at an edge',
  needs: 'flat ground; for the edge check a drop of a block or more next to flat ground',
  async run (ctx) {
    const bot = ctx.bot
    const nav = ctx.nav
    await ctx.grounded()
    const [{ dir, run }] = await openGround(ctx, { minRun: 3, maxRun: 4, prefer: 2 })
    const dist = Math.min(4, run)
    const { out, back } = await outAndBack(ctx, dir, dist, { sneak: true })
    ctx.expect(out.moved > dist - 1 && back.moved > dist - 1.5, `sneaking moved ${out.moved.toFixed(2)} and ${back.moved.toFixed(2)} blocks of ${dist}`)
    ctx.metric('sneakTopSpeed', round(Math.max(0, ...moveDeltas(out.start, sentPositions(out.list))), 4))
    bot.setControlState('sneak', false)
    await ctx.ticks(3)

    // An edge: two flat cells and then a drop, in the direction d, reached by a cell two cells before the edge
    const found = nav.search(cellOf(bot.entity.position), (c) => CARDINALS.map(d => {
      const p1 = { x: c.x + d.dx, y: c.y, z: c.z + d.dz }
      const p2 = { x: c.x + 2 * d.dx, y: c.y, z: c.z + 2 * d.dz }
      return nav.standable(p1.x, p1.y, p1.z) && nav.standable(p2.x, p2.y, p2.z) && nav.dropAt(p2, d) ? { d, p2 } : null
    }).find(Boolean), { radius: ctx.opts.radius, maxNodes: 3000 })
    if (!found) {
      ctx.note('no edge (a drop of a block or more next to flat ground) within the radius: the edge check was skipped')
      return
    }
    await follow(ctx, found.path)
    const { d, p2 } = found.value
    // the far side of the edge cell, along d
    const boundary = d.dx !== 0 ? p2.x + (d.dx > 0 ? 1 : 0) : p2.z + (d.dz > 0 ? 1 : 0)
    const along = (p) => (d.dx !== 0 ? p.x : p.z) * (d.dx + d.dz)
    const y0 = bot.entity.position.y
    await face(ctx, d)
    bot.setControlState('sneak', true)
    await ctx.ticks(3)
    bot.setControlState('forward', true)
    let still = 0
    let last = bot.entity.position.clone()
    await ctx.until(() => {
      still = hdist(last, bot.entity.position) < 0.0005 ? still + 1 : 0
      last = bot.entity.position.clone()
      return still >= 8 || bot.entity.position.y < y0 - 0.3
    }, { ticks: 160, what: 'the sneaking bot to stop at the edge' })
    bot.setControlState('forward', false)
    await ctx.ticks(3)
    const over = along(bot.entity.position) - boundary * (d.dx + d.dz)
    ctx.metric('edgeOvershoot', round(over, 4))
    ctx.expect(bot.entity.position.y > y0 - 0.1, `the sneaking bot walked off the edge and fell to y ${(bot.entity.position.y - y0).toFixed(2)}`)
    ctx.expect(over <= 0.31, `the sneaking bot's centre went ${over.toFixed(3)} blocks past the edge (the box may overhang by 0.3)`)
    // back off still sneaking: letting go of the key while hanging over the edge is a fall
    await face(ctx, opposite(d))
    bot.setControlState('forward', true)
    await ctx.ticks(16)
    bot.clearControlStates()
    await settle(ctx)
  }
}

// A straight stair run from a stair block: { start cell, u (the way up), blocks }
function stairRun (ctx, S) {
  const nav = ctx.nav
  const shapes = S.shapes ?? []
  const half = S.getProperties?.().half
  if (half === 'top' || shapes.length !== 2) return null
  const tall = shapes.find(s => s[4] > 0.99)
  if (!tall) return null
  const cx = (tall[0] + tall[3]) / 2 - 0.5
  const cz = (tall[2] + tall[5]) / 2 - 0.5
  if (Math.max(Math.abs(cx), Math.abs(cz)) < 0.2) return null
  const u = Math.abs(cx) > Math.abs(cz) ? { dx: Math.sign(cx), dz: 0 } : { dx: 0, dz: Math.sign(cz) }
  const blocks = []
  let p = S.position
  while (blocks.length < 4) {
    const b = nav.at(p.x, p.y, p.z)
    if (!b || !/_stairs$/.test(b.name) || b.shapes.length !== 2) break
    const t = b.shapes.find(s => s[4] > 0.99)
    const same = t && Math.sign(((t[0] + t[3]) / 2 - 0.5)) === Math.sign(cx) && Math.sign(((t[2] + t[5]) / 2 - 0.5)) === Math.sign(cz)
    if (!same || !nav.passable(nav.at(p.x, p.y + 1, p.z)) || !nav.passable(nav.at(p.x, p.y + 2, p.z))) break
    blocks.push(p)
    p = p.offset(u.dx, 1, u.dz)
  }
  const start = { x: S.position.x - u.dx, y: S.position.y, z: S.position.z - u.dz }
  if (!blocks.length || !nav.standable(start.x, start.y, start.z)) return null
  return { start, u, blocks }
}

const stairs = {
  name: 'stairs',
  title: 'walk up and down stairs without jumping',
  needs: 'a straight run of bottom-half stairs with free space above, reachable on foot',
  async run (ctx) {
    const bot = ctx.bot
    const nav = ctx.nav
    await ctx.grounded()
    const ids = Object.values(bot.registry.blocksByName).filter(b => /_stairs$/.test(b.name)).map(b => b.id)
    const found = bot.findBlocks({ matching: ids, maxDistance: ctx.opts.radius, count: 64 })
      .map(p => stairRun(ctx, bot.blockAt(p))).filter(Boolean)
      .sort((a, b) => b.blocks.length - a.blocks.length || hdist(center(a.start), bot.entity.position) - hdist(center(b.start), bot.entity.position))
    if (!found.length) ctx.skip('no straight stairs with free space above within the radius')
    let reach = null
    let run = null
    for (const r of found.slice(0, 6)) {
      reach = nav.search(cellOf(bot.entity.position), (c) => c.x === r.start.x && c.y === r.start.y && c.z === r.start.z, { radius: ctx.opts.radius + 6, maxNodes: 4000 })
      if (reach) { run = r; break }
    }
    if (!reach) throw new Inconclusive('stairs found, but none reachable on foot')
    await follow(ctx, reach.path)
    const { u, blocks } = run
    const top = run.start.y + blocks.length
    ctx.note(`${blocks.length} stair block${blocks.length > 1 ? 's' : ''} up`)
    for (let pass = 0; pass < 2; pass++) {
      await face(ctx, u)
      await ctx.ticks(2)
      bot.setControlState('forward', true)
      await ctx.until(() => bot.entity.position.y >= top - 0.05 && hdist(bot.entity.position, center(blocks.at(-1))) < 0.3, { ticks: 40 + 16 * blocks.length, what: 'the bot to walk up the stairs' }).catch(() => {})
      bot.clearControlStates()
      await ctx.ticks(4)
      const rose = bot.entity.position.y - run.start.y
      ctx.metric('stairsRise', round(rose, 3))
      ctx.expect(rose > blocks.length - 0.3, `walking forward up ${blocks.length} stair block(s) rose only ${rose.toFixed(2)} blocks (without jumping)`)
      await settle(ctx)
      await face(ctx, opposite(u))
      await ctx.ticks(2)
      bot.setControlState('forward', true)
      await ctx.until(() => bot.entity.position.y <= run.start.y + 0.05 && bot.entity.onGround, { ticks: 40 + 16 * blocks.length, what: 'the bot to walk down the stairs' }).catch(() => {})
      bot.clearControlStates()
      await settle(ctx)
      ctx.expect(bot.entity.position.y - run.start.y < 0.1, `the way down ended ${(bot.entity.position.y - run.start.y).toFixed(2)} blocks above the start`)
    }
  }
}

const step = {
  name: 'step',
  title: 'jump up a one-block step and walk down',
  needs: 'a full block one higher than flat ground next to it, with free space above, reachable on foot',
  async run (ctx) {
    const bot = ctx.bot
    const nav = ctx.nav
    await ctx.grounded()
    const found = nav.search(cellOf(bot.entity.position), (c) => {
      const up = nav.neighbours(c).find(n => n.y === c.y + 1 && nav.passable(nav.at(c.x, c.y + 3, c.z)))
      return up ? { up } : null
    }, { radius: ctx.opts.radius, maxNodes: 3000, allowEdges: true })
    if (!found) ctx.skip('no one-block step within the radius')
    await follow(ctx, found.path)
    const lower = found.cell
    const upper = found.value.up
    for (let i = 0; i < 3; i++) {
      await steerTo(ctx, upper, { stop: true, ticks: 60 })
      ctx.expect(Math.abs(bot.entity.position.y - upper.y) < 0.05, `round ${i + 1}: after the jump up the bot is ${(bot.entity.position.y - upper.y).toFixed(2)} blocks from the step top`)
      await steerTo(ctx, lower, { stop: true, ticks: 60 })
      ctx.expect(Math.abs(bot.entity.position.y - lower.y) < 0.05, `round ${i + 1}: after the walk down the bot is ${(bot.entity.position.y - lower.y).toFixed(2)} blocks from the floor`)
    }
  }
}

const water = {
  name: 'water',
  title: 'wade into water and out again',
  needs: 'water next to ground, reachable on foot',
  async run (ctx) {
    const bot = ctx.bot
    const nav = ctx.nav
    await ctx.grounded()
    const found = nav.search(cellOf(bot.entity.position), (c) => CARDINALS.map(d => {
      const w = { x: c.x + d.dx, z: c.z + d.dz }
      return nav.isWater(nav.at(w.x, c.y - 1, w.z)) && nav.passable(nav.at(w.x, c.y, w.z)) && nav.passable(nav.at(w.x, c.y + 1, w.z)) ? { d } : null
    }).find(Boolean), { radius: ctx.opts.radius, maxNodes: 3000 })
    if (!found) ctx.skip('no water next to walkable ground within the radius')
    await follow(ctx, found.path)
    const { d } = found.value
    const home = bot.entity.position.clone()
    await face(ctx, d)
    await ctx.ticks(2)
    bot.setControlState('forward', true)
    let wet = 0
    await ctx.until(() => {
      wet = bot.entity.isInWater ? wet + 1 : wet
      return wet >= 20
    }, { ticks: 120, what: 'the bot to wade in' }).catch(() => {})
    ctx.metric('ticksInWater', wet)
    ctx.expect(wet >= 20, 'the bot did not get into the water')
    await face(ctx, opposite(d))
    bot.setControlState('forward', true)
    // a person climbs out of a pool with the jump key held
    await ctx.until(() => {
      bot.setControlState('jump', !!bot.entity.isInWater)
      return bot.entity.onGround && !bot.entity.isInWater && hdist(bot.entity.position, home) < 1
    }, { ticks: 200, what: 'the bot to get out of the water' }).catch(() => {})
    bot.clearControlStates()
    ctx.expect(!bot.entity.isInWater && bot.entity.onGround, 'the bot did not get out of the water')
    await ctx.ticks(10)
  }
}

module.exports = { walk, sprint, jump, sprintjump, sneak, stairs, step, water, Vec3 }
