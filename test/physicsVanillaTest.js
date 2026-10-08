/* eslint-env mocha */

// Offline tests of the vendored physics engine (lib/physics/engine.js) against a fake world, and of the plugin code
// that feeds it (attributes, velocities). The expected numbers are the vanilla client's, as mirrored by Grim.

const assert = require('assert')
const mc = require('minecraft-protocol')
const { Vec3 } = require('vec3')
const mineflayer = require('../') // also registers the 26.2 data
const { Physics, PlayerState } = require('../lib/physics/engine')
const { once, sleep } = require('../lib/promise_utils')
const { getPort } = require('./common/util')

const F = Math.fround
const HALF_WIDTH = F(0.6) / 2 // the vanilla box is a float: 0.30000001192...
const FULL = [[0, 0, 0, 1, 1, 1]]
const SLAB = [[0, 0, 0, 1, 0.5, 1]]
const SOUL_SAND = [[0, 0, 0, 1, 0.875, 1]]
const FLOOR_Y = 63 // the top of the floor

class World {
  constructor (mcData) {
    this.mcData = mcData
    this.blocks = new Map()
  }

  set (x, y, z, name, shapes = FULL, metadata = 0) {
    this.blocks.set(`${x},${y},${z}`, { type: this.mcData.blocksByName[name].id, name, shapes, metadata, position: new Vec3(x, y, z), boundingBox: shapes.length ? 'block' : 'empty' })
  }

  fill (x0, y0, z0, x1, y1, z1, name, shapes) {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) this.set(x, y, z, name, shapes)
  }

  getBlock (p) {
    const x = Math.floor(p.x)
    const y = Math.floor(p.y)
    const z = Math.floor(p.z)
    return this.blocks.get(`${x},${y},${z}`) || { type: 0, name: 'air', shapes: [], metadata: 0, position: new Vec3(x, y, z), boundingBox: 'empty' }
  }
}

// yaw 3PI/2 walks towards +x (mineflayer's yaw)
const EAST = Math.PI * 3 / 2

function makeEntity (x = 0.5, y = FLOOR_Y, z = 0.5, yaw = EAST) {
  return {
    pos: new Vec3(x, y, z),
    vel: new Vec3(0, -0.0784, 0), // a body standing still has the gravity of the last tick in it
    onGround: true,
    isInWater: false,
    isInLava: false,
    isInWeb: false,
    isCollidedHorizontally: false,
    isCollidedVertically: true,
    elytraFlying: false,
    jumpTicks: 0,
    jumpQueued: false,
    fireworkRocketDuration: 0,
    attributes: null,
    yaw,
    pitch: 0,
    control: { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false },
    jumpBoost: 0,
    speed: 0,
    slowness: 0,
    dolphinsGrace: 0,
    slowFalling: 0,
    levitation: 0,
    depthStrider: 0,
    elytraEquipped: false
  }
}

function setup (version, build) {
  const mcData = require('minecraft-data')(version)
  const world = new World(mcData)
  world.fill(-30, FLOOR_Y - 2, -30, 60, FLOOR_Y - 1, 30, 'stone') // the top of the floor is at y = FLOOR_Y
  if (build) build(world)
  const physics = Physics(mcData, world)
  return { mcData, world, physics }
}

// run n ticks, return what `probe` reads after each
function run (physics, world, entity, n, probe, each) {
  const out = []
  for (let i = 0; i < n; i++) {
    if (each) each(entity, i)
    physics.simulatePlayer(entity, world)
    out.push(probe(entity))
  }
  return out
}

const roughly = (actual, expected, tolerance, message) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message ?? ''} expected ${expected} +- ${tolerance}, got ${actual}`)

describe('9bflayer physics', function () {
  this.timeout(10 * 1000)

  for (const version of ['1.21.4', '26.1', '26.2']) {
    describe(`${version} ground movement`, () => {
      it('accelerates from rest like the vanilla client: 0.098, 0.1515, 0.1807 blocks per tick', () => {
        const { physics, world } = setup(version)
        const e = makeEntity()
        e.control.forward = true
        const dx = []
        let last = e.pos.x
        for (let i = 0; i < 6; i++) {
          physics.simulatePlayer(e, world)
          dx.push(e.pos.x - last)
          last = e.pos.x
        }
        // 0.098, then the 0.6F * 0.91F friction and another 0.098 of acceleration...
        roughly(dx[0], 0.098, 1e-6, 'tick 1')
        roughly(dx[1], 0.15150, 5e-5, 'tick 2') // EBSlab recorded 0.152 on 9b9t
        roughly(dx[2], 0.18072, 5e-5, 'tick 3') // recorded as 0.180 (truncated)
        roughly(dx[3], 0.19668, 5e-5, 'tick 4')
        // the terminal walking speed is 0.2158 blocks per tick
        for (let i = 0; i < 80; i++) physics.simulatePlayer(e, world)
        const before = e.pos.x
        physics.simulatePlayer(e, world)
        roughly(e.pos.x - before, 0.2158, 5e-4, 'walking speed')
        assert.strictEqual(e.onGround, true)
        assert.strictEqual(e.pos.y, FLOOR_Y)
      })

      it('jumps along 0.42, 0.7532, 1.0013, 1.1661, 1.2492 (recorded on 9b9t)', () => {
        const { physics, world } = setup(version)
        const e = makeEntity()
        e.control.jump = true
        const heights = run(physics, world, e, 5, en => en.pos.y - FLOOR_Y)
        const expected = [0.42, 0.7532, 1.0013, 1.1661, 1.2492]
        expected.forEach((h, i) => roughly(heights[i], h, 1e-4, `tick ${i + 1}`))
        // the jump speed is (float) 0.42: 0.41999998688697815
        const f = makeEntity()
        f.control.jump = true
        physics.simulatePlayer(f, world)
        assert.strictEqual(f.pos.y - FLOOR_Y, F(0.42))
      })

      it('sprint-jumps with the 0.2 boost along the yaw, and sprints 30 % faster on the ground', () => {
        const { physics, world } = setup(version)
        const a = makeEntity()
        a.control.forward = true
        a.control.sprint = true
        physics.simulatePlayer(a, world)
        roughly(a.pos.x - 0.5, 0.098 * 1.3, 1e-6, 'sprinting first tick')
        const b = makeEntity()
        b.control.forward = true
        b.control.sprint = true
        b.control.jump = true
        physics.simulatePlayer(b, world)
        // 0.2 boost (the table's sin / cos of the yaw) plus the sprinting input of a bot on the ground
        roughly(b.pos.x - 0.5, 0.2 + F(0.1) * 1.3 * 0.98, 1e-4)
        assert.ok(b.vel.x > 0.15 && b.vel.y > 0, `${b.vel.x} ${b.vel.y}`)
        assert.ok(Math.abs(b.vel.z) < 1e-6, 'no sideways boost on an axis yaw')
      })

      it('stops exactly at the float-hitbox position at a wall (the box is 0.30000001192 half-width)', () => {
        const { physics, world } = setup(version, w => w.fill(5, FLOOR_Y, -3, 5, FLOOR_Y + 3, 3, 'stone'))
        const e = makeEntity()
        e.control.forward = true
        run(physics, world, e, 60, en => en.pos.x)
        const gap = 5 - (e.pos.x + HALF_WIDTH)
        // vanilla drops the last sliver (< 3.2e-4 blocks) of the approach, so the gap is small but never negative
        assert.ok(gap >= -1e-12 && gap < 3.2e-4, `gap ${gap}`)
        assert.strictEqual(e.isCollidedHorizontally, true)
        assert.strictEqual(e.vel.x, 0)
        // the same wall with a 0.3 box would have put the centre at 4.7: the float box stops 1.2e-8 earlier
        assert.ok(e.pos.x <= 5 - 0.3 - 1e-9 + 3.2e-4)
        // and it stays there, tick after tick
        const rest = e.pos.x
        run(physics, world, e, 10, en => en.pos.x)
        assert.strictEqual(e.pos.x, rest)
      })

      it('steps up a slab without jumping, and needs a jump for a full block', () => {
        const { physics, world } = setup(version, w => {
          w.set(5, FLOOR_Y, 0, 'stone', SLAB) // half a block
          w.set(5, FLOOR_Y, 4, 'stone') // a whole one
        })
        const e = makeEntity()
        e.control.forward = true
        run(physics, world, e, 40, en => en.pos.y, en => { if (en.pos.x > 5.6) en.control.forward = false }) // stop on it
        roughly(e.pos.y, FLOOR_Y + 0.5, 1e-9, 'stood on the slab')
        assert.ok(e.pos.x > 5.2, `walked onto the slab: ${e.pos.x}`)
        assert.strictEqual(e.onGround, true)
        // the full block: blocked, then up with a jump
        const f = makeEntity(0.5, FLOOR_Y, 4.5)
        f.control.forward = true
        run(physics, world, f, 30, en => en.pos.x)
        assert.strictEqual(f.pos.y, FLOOR_Y, 'a full block is no step')
        assert.ok(f.pos.x < 5 - HALF_WIDTH + 1e-6)
        const g = makeEntity(0.5, FLOOR_Y, 4.5)
        g.control.forward = true
        run(physics, world, g, 40, en => en.pos.y, en => { en.control.jump = en.pos.x > 4.3 && en.pos.x < 4.9; if (en.pos.x > 5.5) en.control.forward = false })
        assert.strictEqual(g.pos.y, FLOOR_Y + 1, 'jumped on the block')
        assert.ok(g.pos.x > 5.2)
      })

      it('does not step up while falling past a ledge (1.21 collides from the landed box)', () => {
        // a bot falling at 0.5 blocks per tick beside a 1 high block is landed first and may step from there only
        // up to a step height: it must not be lifted by the old algorithm's 0.6 raise
        const { physics, world } = setup(version, w => w.set(5, FLOOR_Y, 0, 'stone'))
        const e = makeEntity(4.6, FLOOR_Y + 0.5, 0.5)
        e.onGround = false
        e.isCollidedVertically = false
        e.vel.set(0.1, -0.5, 0)
        e.control.forward = true
        physics.simulatePlayer(e, world)
        assert.ok(e.pos.y <= FLOOR_Y + 0.5 - 0.1, `fell: ${e.pos.y}`)
        run(physics, world, e, 5, en => en.pos.y)
        assert.strictEqual(e.pos.y, FLOOR_Y)
        assert.strictEqual(e.onGround, true)
      })

      it('slows to 0.4 on soul sand: the first tick moves 0.098, the next speed is 0.098 * 0.4 * 0.546', () => {
        const { physics, world } = setup(version, w => w.fill(-30, FLOOR_Y, -30, 60, FLOOR_Y, 30, 'soul_sand', SOUL_SAND))
        const e = makeEntity(0.5, FLOOR_Y + 0.875)
        e.control.forward = true
        const dx = run(physics, world, e, 2, en => en.pos.x)
        roughly(dx[0] - 0.5, 0.098, 1e-6)
        // vx after tick 1 = 0.098 * F(0.4), * F(0.6F * 0.91F); tick 2 adds 0.098 and moves that much
        const carried = 0.098 * F(0.4) * F(F(0.6) * F(0.91))
        roughly(dx[1] - dx[0], carried + 0.098, 1e-6, 'second tick')
        // and settles at about 0.125 blocks a tick, against 0.2158 on stone
        const rest = run(physics, world, e, 60, en => en.pos.x)
        roughly(rest[59] - rest[58], 0.1254, 2e-3, 'soul sand speed')
      })

      it('slows on honey the same way, and jumps with half the speed (0.5F)', () => {
        const { physics, world } = setup(version, w => w.fill(-30, FLOOR_Y - 1, -30, 60, FLOOR_Y - 1, 30, 'honey_block'))
        const e = makeEntity()
        e.control.jump = true
        physics.simulatePlayer(e, world)
        assert.strictEqual(e.pos.y - FLOOR_Y, F(F(0.42) * F(0.5)))
      })

      it('eats slowly: a bot using an item moves at 0.2 of the walking input', () => {
        const { physics, world } = setup(version)
        const e = makeEntity()
        e.control.forward = true
        e.usingItem = true
        e.useSpeedMultiplier = 0.2
        physics.simulatePlayer(e, world)
        roughly(e.pos.x - 0.5, 0.1 * F(F(0.2) * F(0.98)), 1e-6)
        // PlayerState reads bot.itemInUse
        const bot = fakeBot(version, { itemInUse: true })
        assert.strictEqual(new PlayerState(bot, e.control).usingItem, true)
        assert.strictEqual(new PlayerState(fakeBot(version, { itemInUse: false }), e.control).usingItem, false)
        assert.strictEqual(new PlayerState(bot, e.control).useSpeedMultiplier, 0.2)
      })

      it('takes the speed multiplier of the used item from 1.21.11 (use_effects), 0.2 before', () => {
        const withUseEffects = (v) => {
          const item = { componentMap: new Map([['use_effects', { type: 'use_effects', data: { can_sprint: true, interact_vibrations: true, speed_multiplier: 0.5 } }]]) }
          return new PlayerState(fakeBot(v, { itemInUse: true, heldItem: item }), makeEntity().control).useSpeedMultiplier
        }
        assert.strictEqual(withUseEffects('1.21.4'), 0.2)
        assert.strictEqual(withUseEffects('1.21.11'), 0.5)
        assert.strictEqual(withUseEffects('26.2'), 0.5)
      })

      it('walks 0.3 of the speed while crouching, one tick behind the key when the driver says so', () => {
        const { physics, world } = setup(version)
        const sneaking = makeEntity()
        sneaking.control.forward = true
        sneaking.control.sneak = true
        physics.simulatePlayer(sneaking, world)
        roughly(sneaking.pos.x - 0.5, 0.1 * F(F(0.3) * F(0.98)), 1e-6)
        // the key was pressed this tick, the pose is still standing: no slowdown yet
        const lagged = makeEntity()
        lagged.control.forward = true
        lagged.control.sneak = true
        lagged.slowMovement = false
        physics.simulatePlayer(lagged, world)
        roughly(lagged.pos.x - 0.5, 0.098, 1e-6)
        // and released while the pose is still crouched: still slow
        const released = makeEntity()
        released.control.forward = true
        released.slowMovement = true
        physics.simulatePlayer(released, world)
        roughly(released.pos.x - 0.5, 0.1 * F(F(0.3) * F(0.98)), 1e-6)
        // the crouched box is 1.5 high: it fits under a 1.6 ceiling
        physics.playerHeight = F(1.5)
        const under = makeEntity()
        under.control.forward = true
        under.slowMovement = true
        world.fill(3, FLOOR_Y + 1, -2, 3, FLOOR_Y + 3, 2, 'stone', [[0, 0.6, 0, 1, 1, 1]]) // 1.6 above the floor
        run(physics, world, under, 150, en => en.pos.x)
        assert.ok(under.pos.x > 4, `walked under the ceiling: ${under.pos.x}`)
        // the same walk with the standing box (1.8) is stopped by it
        physics.playerHeight = F(1.8)
        const standing = makeEntity()
        standing.control.forward = true
        run(physics, world, standing, 150, en => en.pos.x)
        assert.ok(standing.pos.x < 3, `blocked by the ceiling: ${standing.pos.x}`)
      })

      it('stops at the edge of a platform while sneaking, and falls off it when not', () => {
        const build = w => {
          w.fill(-30, FLOOR_Y - 2, -30, 60, FLOOR_Y - 2, 30, 'air') // no floor outside of the platform
          for (let x = -30; x <= 60; x++) for (let y = FLOOR_Y - 2; y <= FLOOR_Y - 1; y++) for (let z = -30; z <= 30; z++) w.blocks.delete(`${x},${y},${z}`)
          w.fill(0, FLOOR_Y - 1, -2, 2, FLOOR_Y - 1, 2, 'stone') // a 3 x 5 platform, edge at x = 3
        }
        const { physics, world } = setup(version, build)
        const sneaker = makeEntity(1.5, FLOOR_Y, 0.5)
        sneaker.control.forward = true
        sneaker.control.sneak = true
        run(physics, world, sneaker, 80, en => en.pos.x)
        assert.strictEqual(sneaker.pos.y, FLOOR_Y, 'did not fall')
        assert.strictEqual(sneaker.onGround, true)
        // the box may hang over the edge, but no further than the step back-off allows (the centre stays on the block
        // or within 0.05 of its edge)
        assert.ok(sneaker.pos.x > 3 && sneaker.pos.x < 3.3, `x ${sneaker.pos.x}`)
        const walker = makeEntity(1.5, FLOOR_Y, 0.5)
        walker.control.forward = true
        run(physics, world, walker, 20, en => en.pos.y)
        assert.ok(walker.pos.y < FLOOR_Y - 1, 'walks off the edge when not sneaking')
      })

      it('climbs vines and the cave and nether vines, and a trapdoor above a ladder', () => {
        const { physics, world, mcData } = setup(version, w => {
          w.set(5, FLOOR_Y, 0, 'stone')
          for (let y = FLOOR_Y; y < FLOOR_Y + 6; y++) {
            w.set(0, y, 3, 'weeping_vines_plant', [])
          }
        })
        assert.ok(mcData.blocksByName.weeping_vines_plant)
        const e = makeEntity(0.5, FLOOR_Y, 3.5)
        e.control.jump = true
        run(physics, world, e, 20, en => en.pos.y)
        assert.ok(e.pos.y > FLOOR_Y + 2, `climbing weeping vines: ${e.pos.y}`)
      })
    })
  }

  describe('1.21.4 details', () => {
    it('scaffolding is climbed down by sneaking, other climbables hold', () => {
      const { physics, world } = setup('1.21.4', w => {
        for (let y = FLOOR_Y; y < FLOOR_Y + 6; y++) { w.set(0, y, 3, 'ladder', []); w.set(2, y, 3, 'scaffolding', []) }
      })
      const ladder = makeEntity(0.5, FLOOR_Y + 3, 3.5)
      ladder.onGround = false
      ladder.control.sneak = true
      run(physics, world, ladder, 10, en => en.pos.y)
      assert.strictEqual(ladder.pos.y, FLOOR_Y + 3, 'sneaking holds on a ladder')
      const scaffold = makeEntity(2.5, FLOOR_Y + 3, 3.5)
      scaffold.onGround = false
      scaffold.control.sneak = true
      run(physics, world, scaffold, 10, en => en.pos.y)
      assert.ok(scaffold.pos.y < FLOOR_Y + 3 - 0.5, `sneaking on scaffolding goes down: ${scaffold.pos.y}`)
    })

    it('zeroes the horizontal speed per axis on 1.21.4 and by length from 1.21.5', () => {
      for (const [version, lengthRule] of [['1.21.4', false], ['1.21.5', true], ['26.1', true]]) {
        const { physics, world } = setup(version)
        assert.strictEqual(physics.modernMinMovement, lengthRule, version)
        const e = makeEntity()
        e.vel.set(0.0025, -0.0784, 0.0022) // |v|^2 = 1.1e-5: above 9e-6, each axis below 0.003
        physics.simulatePlayer(e, world)
        if (lengthRule) assert.ok(e.pos.x > 0.5 && e.pos.z > 0.5, `${version}: kept both ${e.pos}`)
        else assert.ok(e.pos.x === 0.5 && e.pos.z === 0.5, `${version}: zeroed both ${e.pos}`)
        const f = makeEntity()
        f.vel.set(0.0035, -0.0784, 0.0025) // x above, z below the per-axis threshold
        physics.simulatePlayer(f, world)
        if (lengthRule) assert.ok(f.pos.z > 0.5, `${version}: z kept with x`)
        else assert.ok(f.pos.z === 0.5 && f.pos.x > 0.5, `${version}: z zeroed alone`)
      }
    })

    it('drops a collided move of 1e-7 blocks squared or less, as the 1.21.2 client does', () => {
      const { physics, world } = setup('1.21.4', w => w.fill(5, FLOOR_Y, -3, 5, FLOOR_Y + 3, 3, 'stone'))
      const e = makeEntity(5 - HALF_WIDTH - 0.0002, FLOOR_Y) // 2e-4 from the wall
      e.vel.x = 0.1
      e.onGround = true
      physics.simulatePlayer(e, world)
      assert.strictEqual(e.pos.x, 5 - HALF_WIDTH - 0.0002, 'the 2e-4 sliver is not applied')
      assert.strictEqual(e.isCollidedHorizontally, true)
    })

    it('jumps with the stronger vertical speed on 1.21.2+: max(0.42, vy)', () => {
      const { physics, world } = setup('1.21.4')
      const e = makeEntity()
      e.vel.y = 0.5 // already rising faster than a jump (a bubble column, a slime bounce)
      e.control.jump = true
      physics.simulatePlayer(e, world)
      assert.ok(e.pos.y - FLOOR_Y > 0.4, `${e.pos.y}`)
      const old = setup('1.21.1')
      const f = makeEntity()
      f.vel.y = 0.5
      f.onGround = true
      f.control.jump = true
      old.physics.simulatePlayer(f, old.world)
      roughly(f.pos.y - FLOOR_Y, 0.42, 1e-6, '1.21.1 replaces the speed')
    })

    it('reads the movement speed from server attributes without counting the server sprint modifier twice', () => {
      const { physics, world, mcData } = setup('1.21.4')
      const resource = mcData.attributesByName.movementSpeed.resource
      assert.strictEqual(resource, 'minecraft:movement_speed')
      // Speed II: +40 % (multiply total 0.4), plus the sprinting modifier the server keeps for a sprinting player
      const attributes = {
        [resource]: { value: F(0.1), modifiers: [{ uuid: 'minecraft:effect.speed', amount: 0.4, operation: 2 }, { uuid: 'minecraft:sprinting', amount: F(0.3), operation: 2 }] }
      }
      const speed = makeEntity()
      speed.attributes = attributes
      speed.control.forward = true
      speed.control.sprint = true
      physics.simulatePlayer(speed, world)
      // (0.1 * 1.4) + (that * 0.3F) = 0.182 per tick of input, times the 0.98
      roughly(speed.pos.x - 0.5, F(F(0.1) * 1.4 * 1.3) * 0.98, 2e-6)
      // not the 1.3 squared of the server's sprint modifier on top of the bot's own
      assert.ok(speed.pos.x - 0.5 < 0.2)
      const plain = makeEntity()
      plain.attributes = { [resource]: { value: F(0.1), modifiers: [] } }
      plain.control.forward = true
      physics.simulatePlayer(plain, world)
      roughly(plain.pos.x - 0.5, 0.098, 1e-6)
    })

    it('uses the sneaking speed, jump strength and gravity attributes', () => {
      const { physics, world, mcData } = setup('1.21.4')
      const attr = (name, value) => ({ [mcData.attributesByName[name].resource]: { value, modifiers: [] } })
      const sneak = makeEntity()
      sneak.attributes = attr('sneakingSpeed', 1) // swift sneak III
      sneak.control.forward = true
      sneak.control.sneak = true
      physics.simulatePlayer(sneak, world)
      roughly(sneak.pos.x - 0.5, 0.098, 1e-6)
      const jump = makeEntity()
      jump.attributes = attr('jumpStrength', 0.84)
      jump.control.jump = true
      physics.simulatePlayer(jump, world)
      roughly(jump.pos.y - FLOOR_Y, F(0.84), 1e-9)
      const fall = makeEntity(0.5, FLOOR_Y + 5)
      fall.onGround = false
      fall.vel.y = 0
      fall.attributes = attr('gravity', 0.04)
      physics.simulatePlayer(fall, world)
      roughly(fall.vel.y, -0.04 * 0.98, 1e-6)
    })
  })

  describe('1.21.11 and 26.2 differences', () => {
    it('uses the new sin / cos table from 1.21.11', () => {
      // The tables hold the same floats; 1.21.11 computes the index in double arithmetic, which lands one entry
      // away (a 1e-4 rad step) for a few of every 10000 angles. Sweep until a few such angles were seen.
      const a = setup('1.21.9')
      const b = setup('1.21.11')
      let different = 0
      for (let yaw = 0.01; yaw < 6.28; yaw += 0.0001) {
        const ea = makeEntity(0.5, FLOOR_Y, 0.5, yaw)
        const eb = makeEntity(0.5, FLOOR_Y, 0.5, yaw)
        ea.control.forward = eb.control.forward = true
        a.physics.simulatePlayer(ea, a.world)
        b.physics.simulatePlayer(eb, b.world)
        if (ea.vel.x !== eb.vel.x || ea.vel.z !== eb.vel.z) different++
        roughly(ea.vel.x, eb.vel.x, 2e-5)
        roughly(ea.vel.z, eb.vel.z, 2e-5)
      }
      assert.ok(different > 0, 'the tables differ somewhere')
    })

    it('26.2 reads friction_modifier, air_drag_modifier and bounciness', () => {
      const { physics, world, mcData } = setup('26.2')
      const attr = (name, value) => ({ [mcData.attributesByName[name].resource]: { value, modifiers: [] } })
      // half the (1 - friction): the 0.6F stone slides like a 0.8F block, so a bot at speed keeps 0.8 * 0.91 of it a tick
      const coast = (attributes) => {
        const e = makeEntity()
        e.attributes = attributes
        e.vel.x = 0.2
        physics.simulatePlayer(e, world)
        return e.vel.x
      }
      roughly(coast(null), 0.2 * F(F(0.6) * F(0.91)), 1e-9)
      roughly(coast({ ...attr('frictionModifier', 0.5), ...attr('airDragModifier', 1) }), 0.2 * F(F(0.8) * F(0.91)), 1e-7)
      // and the modifiers at their default of 1 change nothing
      assert.strictEqual(coast({ ...attr('frictionModifier', 1), ...attr('airDragModifier', 1) }), coast(null))
    })
  })

  describe('1.21.4 fluids', () => {
    const pool = (w) => {
      w.fill(-30, FLOOR_Y, -30, 60, FLOOR_Y + 4, 30, 'water', [])
    }
    it('sprint-swimming glides with friction 0.9 and does not sink', () => {
      const { physics, world } = setup('1.21.4', pool)
      const walk = makeEntity(0.5, FLOOR_Y + 1)
      walk.onGround = false
      const swim = makeEntity(0.5, FLOOR_Y + 1)
      swim.onGround = false
      swim.vel.set(0.2, 0, 0)
      walk.vel.set(0.2, 0, 0)
      swim.control.sprint = true
      physics.simulatePlayer(walk, world)
      physics.simulatePlayer(swim, world)
      assert.ok(swim.vel.x > walk.vel.x, `${swim.vel.x} vs ${walk.vel.x}`)
      roughly(walk.vel.x, 0.2 * F(0.8) + 0, 3e-3)
      roughly(swim.vel.x, 0.2 * F(0.9), 3e-3)
      // gravity / 16 sinks a swimmer by 0.005 a tick; a sprint-swimmer keeps its height
      assert.ok(walk.vel.y < 0 && swim.vel.y === 0, `${walk.vel.y} ${swim.vel.y}`)
    })

    it('depth strider (water_movement_efficiency) drags the friction up to the ground friction', () => {
      const { physics, world, mcData } = setup('1.21.4', pool)
      const slow = makeEntity(0.5, FLOOR_Y + 1)
      const fast = makeEntity(0.5, FLOOR_Y + 1)
      for (const e of [slow, fast]) { e.onGround = false; e.vel.set(0.2, 0, 0) }
      fast.attributes = { [mcData.attributesByName.waterMovementEfficiency.resource]: { value: 1, modifiers: [] } }
      physics.simulatePlayer(slow, world)
      physics.simulatePlayer(fast, world)
      // efficiency 1 while airborne counts half: friction 0.8 + (0.546 - 0.8) * 0.5
      roughly(fast.vel.x, 0.2 * (0.8 + (0.54600006 - 0.8) * 0.5), 3e-3)
      assert.ok(fast.vel.x < slow.vel.x)
    })

    it('averages the current of the cells it touches instead of normalising their sum', () => {
      // two cells are touched: a still one below (no current) and one flowing east above it. The vanilla client adds
      // (0 + (1, 0, 0)) / 2 * 0.014; normalising the sum (the original) would push the full 0.014.
      const { physics, world } = setup('1.21.4', w => {
        for (let x = 0; x <= 6; x++) {
          for (let z = -3; z <= 3; z++) {
            w.set(x, FLOOR_Y, z, 'water', [], 0) // sources, flat
            w.set(x, FLOOR_Y + 1, z, 'water', [], x) // a ramp: the level rises towards +x, so the water flows east
          }
        }
      })
      const e = makeEntity(3.5, FLOOR_Y)
      e.vel.set(0, 0, 0)
      physics.simulatePlayer(e, world)
      roughly(e.vel.x, 0.007 * 0.8, 3e-4)
    })
  })

  describe('plugin code around the engine (mock server)', function () {
    for (const version of ['1.21.4', '26.1', '26.2']) {
      describe(`${version}`, () => {
        let server
        let bot
        beforeEach(async () => {
          const registry = require('prismarine-registry')(version)
          const port = await getPort()
          server = mc.createServer({ 'online-mode': false, version, port })
          server.on('connection', client => {
            const write = client.write
            client.write = function (name, params) {
              if (name === 'success' && params.sessionId === undefined) params = { ...params, sessionId: require('crypto').randomUUID() }
              return write.call(this, name, params)
            }
          })
          await once(server, 'listening')
          bot = mineflayer.createBot({ username: 'player', version, port })
          bot.test = { registry }
        })
        afterEach((done) => {
          if (bot._client.ended) done()
          else bot.on('end', () => done())
          server.close()
        })

        it('decodes update_attributes by the registry order and keeps the old name of the ones that were right', (done) => {
          const registry = bot.test.registry
          const field = registry.protocol.play.toClient.types.packet_entity_update_attributes[1][1].type[1].type[1][0]
          const stale = field.type[1].mappings
          const idOf = (name) => registry.attributesArray.findIndex(a => a.resource === registry.attributesByName[name].resource)
          // what the wire carries is the registry index; the stale table names it wrongly, so write it by the stale name
          const speedId = idOf('movementSpeed')
          const armorId = idOf('armor')
          assert.ok(stale[speedId] !== undefined && stale[speedId] !== registry.attributesByName.movementSpeed.resource, 'the stale name is wrong')
          server.on('playerJoin', async (client) => {
            try {
              const login = registry.loginPacket
              login.entityId = 0
              client.write('login', login)
              await once(bot, 'login')
              client.write('entity_update_attributes', {
                entityId: 0,
                properties: [
                  { key: stale[speedId], value: 0.10000000149011612, modifiers: [{ uuid: 'minecraft:effect.speed', amount: 0.2, operation: 2 }] },
                  { key: stale[armorId], value: 3, modifiers: [] }
                ]
              })
              await once(bot, 'entityAttributes')
              const attributes = bot.entity.attributes
              const speed = attributes[registry.attributesByName.movementSpeed.resource]
              assert.ok(speed, `movement speed under ${registry.attributesByName.movementSpeed.resource}: ${Object.keys(attributes)}`)
              assert.strictEqual(speed.value, 0.10000000149011612)
              assert.strictEqual(speed.modifiers.length, 1)
              assert.strictEqual(attributes[stale[speedId]], undefined, 'not left under the wrong name')
              assert.strictEqual(attributes[registry.attributesByName.armor.resource].value, 3)
              if (stale[armorId] === 'generic.armor') assert.strictEqual(attributes['generic.armor'].value, 3, 'explosion code reads generic.armor')
              done()
            } catch (e) { done(e) }
          })
        })

        it('reads entity_velocity in blocks per tick on every version', (done) => {
          const registry = bot.test.registry
          const lp = JSON.stringify(registry.protocol.play.toClient.types.packet_entity_velocity).includes('lpVec3')
          server.on('playerJoin', async (client) => {
            try {
              const login = registry.loginPacket
              login.entityId = 0
              client.write('login', login)
              await once(bot, 'login')
              // 0.5, 0.25, -0.125 blocks per tick: 1/8000 fixed point before 1.21.9, plain numbers from it
              const velocity = lp ? { x: 0.5, y: 0.25, z: -0.125 } : { x: 4000, y: 2000, z: -1000 }
              client.write('entity_velocity', { entityId: 0, velocity })
              await sleep(100)
              const v = bot.entity.velocity
              roughly(v.x, 0.5, 2e-3, 'x')
              roughly(v.y, 0.25, 2e-3, 'y')
              roughly(v.z, -0.125, 2e-3, 'z')
              done()
            } catch (e) { done(e) }
          })
        })
      })
    }
  })

  describe('the supporting block decides friction, speed and jump factors (1.20+)', () => {
    const ICE_Y = FLOOR_Y - 1 // the layer whose top is the floor
    // vanilla: 0.1F * (0.21600002F / (0.98F ^ 3)), times the 0.98 of the key
    const iceStep = F(F(0.1) * F(F(0.21600002) / F(F(F(0.98) * F(0.98)) * F(0.98)))) * F(0.98)

    // one ice block at x 0..1, z 0..1; the floor on the other side of x = 1 is cut away below the box, so that a
    // centre past the edge has air under it; `rest` is what the cut layer is refilled with (nothing by default)
    function iceEdge (version, rest) {
      return setup(version, w => {
        for (let x = 1; x <= 60; x++) for (let z = -30; z <= 30; z++) w.blocks.delete(`${x},${ICE_Y},${z}`)
        for (let x = -30; x <= 0; x++) for (let z = -30; z <= 30; z++) w.blocks.delete(`${x},${ICE_Y},${z}`)
        w.set(0, ICE_Y, 0, 'ice')
        if (rest) rest(w)
      })
    }
    // a tick without input first, as a bot that has been standing there: vanilla finds the supporting block at the end
    // of a move, and the friction of the next tick reads it
    function walkOneTick (physics, world, x, z = 0.5) {
      const e = makeEntity(x, FLOOR_Y, z)
      physics.simulatePlayer(e, world)
      e.control.forward = true
      const before = e.pos.x
      physics.simulatePlayer(e, world)
      return { e, dx: e.pos.x - before }
    }

    for (const version of ['1.21.4', '26.2', '1.20.4']) {
      it(`${version}: centre past the ice edge, box still on it: ice friction (0.0225), not stone's (0.098)`, () => {
        const { physics, world } = iceEdge(version)
        const inside = walkOneTick(physics, world, 0.5)
        const edge = walkOneTick(physics, world, 1.2)
        assert.deepStrictEqual({ ...edge.e.supportingBlock }, { x: 0, y: ICE_Y, z: 0 })
        assert.ok(edge.dx < 0.03, `dx ${edge.dx}`)
        roughly(edge.dx, inside.dx, 1e-9, 'same as standing in the middle of the ice')
        if (version !== '1.20.4') roughly(edge.dx, iceStep, 1e-6, 'vanilla ice step 0.02249')
      })

      it(`${version}: the box off the ice altogether is plain stone friction again`, () => {
        const { physics, world } = iceEdge(version, w => w.set(1, ICE_Y, 0, 'stone'))
        const { e, dx } = walkOneTick(physics, world, 1.6) // box 1.3..1.9: on the stone at x = 1
        assert.deepStrictEqual({ ...e.supportingBlock }, { x: 1, y: ICE_Y, z: 0 })
        roughly(dx, 0.098, 1e-3)
      })

      it(`${version}: straddling ice and stone, the block closest to the centre is the one stood on`, () => {
        const { physics, world } = iceEdge(version, w => w.fill(1, ICE_Y, -30, 60, ICE_Y, 30, 'stone'))
        const onIce = walkOneTick(physics, world, 0.9) // ice centre 0.4 away, stone 0.6
        assert.deepStrictEqual({ ...onIce.e.supportingBlock }, { x: 0, y: ICE_Y, z: 0 })
        assert.ok(onIce.dx < 0.03, `ice dx ${onIce.dx}`)
        const onStone = walkOneTick(physics, world, 1.1) // stone 0.4 away, ice 0.6: the old code read the stone too
        assert.deepStrictEqual({ ...onStone.e.supportingBlock }, { x: 1, y: ICE_Y, z: 0 })
        roughly(onStone.dx, 0.098, 1e-3)
        // the centre over stone but the box still touching ice: stone wins (closer), same as the centre column
        const flush = walkOneTick(physics, world, 1.04)
        roughly(flush.dx, 0.098, 1e-3)
      })
    }

    it('soul sand: the 0.4 factor holds with the centre past the edge', () => {
      for (const version of ['1.21.4', '1.20.4']) {
        const { physics, world } = setup(version, w => w.set(0, FLOOR_Y, 0, 'soul_sand', SOUL_SAND))
        const e = makeEntity(1.2, FLOOR_Y + 0.875, 0.5) // box 0.9..1.5: on the soul sand by 0.1
        physics.simulatePlayer(e, world)
        e.control.forward = true
        physics.simulatePlayer(e, world)
        // 0.098 of speed, * F(0.4) block factor, * F(0.6F * 0.91F) friction (the air column does not matter)
        roughly(e.vel.x, 0.098 * F(0.4) * F(F(0.6) * F(0.91)), 1e-6, version)
      }
    })

    it('honey: the jump is halved from the edge, too (1.21.4)', () => {
      const { physics, world } = iceEdge('1.21.4', w => w.set(0, ICE_Y, 0, 'honey_block'))
      const e = makeEntity(1.2, FLOOR_Y)
      physics.simulatePlayer(e, world)
      e.control.jump = true
      physics.simulatePlayer(e, world)
      assert.strictEqual(e.pos.y - FLOOR_Y, F(F(0.42) * F(0.5)))
    })

    it('keeps the block when a fast move ends over nothing, once; a second such tick falls back to the centre', () => {
      const { physics, world } = iceEdge('1.21.4')
      const e = makeEntity(0.9, FLOOR_Y)
      physics.simulatePlayer(e, world)
      e.vel.x = 0.7 // box 1.3..1.9 at the end of the move: the slab is empty, the box one move back is on the ice
      physics.simulatePlayer(e, world)
      assert.strictEqual(e.onGround, true)
      assert.deepStrictEqual({ ...e.supportingBlock }, { x: 0, y: ICE_Y, z: 0 })
      assert.strictEqual(e.supportNoBlocks, false)

      const f = makeEntity(0.9, FLOOR_Y)
      f.supportNoBlocks = true // the tick before was on the ground over nothing
      f.vel.x = 0.7
      physics.simulatePlayer(f, world)
      assert.strictEqual(f.onGround, true)
      assert.strictEqual(f.supportingBlock, null)
      assert.strictEqual(f.supportNoBlocks, true)
    })

    it('forgets the supporting block in the air', () => {
      const { physics, world } = iceEdge('1.21.4')
      const e = makeEntity(0.5, FLOOR_Y)
      physics.simulatePlayer(e, world)
      assert.ok(e.supportingBlock)
      e.control.jump = true
      physics.simulatePlayer(e, world)
      assert.strictEqual(e.onGround, false)
      assert.strictEqual(e.supportingBlock, null)
      assert.strictEqual(e.supportNoBlocks, false)
    })

    it('PlayerState carries the supporting block from tick to tick', () => {
      const { physics, world } = iceEdge('1.21.4')
      const bot = fakeBot('1.21.4')
      bot.entity.position = new Vec3(1.2, FLOOR_Y, 0.5)
      bot.entity.yaw = EAST
      bot.entity.velocity = new Vec3(0, -0.0784, 0)
      const control = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
      let state = new PlayerState(bot, control)
      physics.simulatePlayer(state, world)
      state.apply(bot)
      assert.deepStrictEqual({ ...bot.entity.supportingBlock }, { x: 0, y: ICE_Y, z: 0 })
      state = new PlayerState(bot, { ...control, forward: true })
      assert.deepStrictEqual({ ...state.supportingBlock }, { x: 0, y: ICE_Y, z: 0 })
      physics.simulatePlayer(state, world)
      roughly(state.pos.x - 1.2, iceStep, 1e-6)
    })

    for (const version of ['1.8.8', '1.12.2', '1.19.4']) {
      it(`${version} is unchanged: friction still comes from the block under the centre`, () => {
        const { physics, world } = iceEdge(version)
        const edge = walkOneTick(physics, world, 1.2)
        assert.strictEqual(edge.e.supportingBlock, undefined, 'not tracked before 1.20')
        roughly(edge.dx, 0.098, 1e-3, 'air under the centre: default friction')
        const inside = walkOneTick(physics, world, 0.5)
        assert.ok(inside.dx < 0.03, `ice under the centre ${inside.dx}`)
      })
    }
  })

  describe('older versions keep the original code', () => {
    for (const version of ['1.8.8', '1.12.2', '1.16.5', '1.20.4']) {
      it(`${version} still walks 0.098 and jumps 0.42 on the float box`, () => {
        const { physics, world } = setup(version)
        assert.strictEqual(physics.modern, false)
        const e = makeEntity()
        e.control.forward = true
        physics.simulatePlayer(e, world)
        roughly(e.pos.x - 0.5, 0.098, 1e-3)
        const j = makeEntity()
        j.control.jump = true
        physics.simulatePlayer(j, world)
        roughly(j.pos.y - FLOOR_Y, 0.42, 1e-6)
        assert.strictEqual(physics.playerHalfWidth, HALF_WIDTH)
      })
    }

    it('1.20.4 slows down on soul sand it stands on (the original looked a block too low)', () => {
      const { physics, world } = setup('1.20.4', w => w.fill(-30, FLOOR_Y, -30, 60, FLOOR_Y, 30, 'soul_sand', SOUL_SAND))
      const e = makeEntity(0.5, FLOOR_Y + 0.875)
      e.control.forward = true
      const xs = run(physics, world, e, 60, en => en.pos.x)
      assert.ok(xs[59] - xs[58] < 0.14, `${xs[59] - xs[58]}`)
    })
  })

  // ---- Swimming, poses, stuck multipliers, bubble columns, elytra, flight (engine level) -------------------------------
  describe('1.21.4 swimming and poses', () => {
    const DEEP = w => w.fill(-30, FLOOR_Y, -30, 60, FLOOR_Y + 60, 30, 'water', [])
    // a body in deep water that was sprinting last tick with its eyes under water, as one that has just started to swim
    function swimmer (physics) {
      const e = makeEntity(0.5, FLOOR_Y + 20)
      e.onGround = false
      e.vel.set(0, 0, 0)
      e.pose = 'standing'
      e.lastSprinting = true
      e.eyeInWater = true
      e.control.sprint = true
      return e
    }

    it('sprint + eyes under water + in water: swimming, the pose is the 0.6 box with eyes at 0.4, from the next tick', () => {
      const { physics, world } = setup('1.21.4', DEEP)
      const e = swimmer()
      e.control.forward = true
      physics.simulatePlayer(e, world)
      assert.strictEqual(e.isSwimming, true)
      assert.strictEqual(e.pose, 'swimming') // decided at the end of the tick...
      assert.strictEqual(physics.playerHeight, F(1.8)) // ...this tick still had the standing box
      physics.simulatePlayer(e, world)
      assert.strictEqual(physics.playerHeight, F(0.6))
      assert.strictEqual(physics.poses.swimming.eye, F(0.4))
    })

    it('swims forward at 0.98 * 0.02 a tick with friction 0.9, and its vertical speed follows the look (0.06, 0.085 steeply down)', () => {
      for (const pitch of [0.5, -0.7, 0]) {
        const { physics, world } = setup('1.21.4', DEEP)
        const e = swimmer()
        e.control.forward = true
        e.pitch = pitch
        let vx = 0
        let vy = 0
        const lookY = Math.sin(pitch)
        const scale = lookY < -0.2 ? 0.085 : 0.06
        for (let i = 0; i < 25; i++) {
          physics.simulatePlayer(e, world)
          // vanilla by hand: the look steers vy, then moveRelative adds 0.02 * 0.98 along x, then 0.9 / 0.8 friction;
          // a sprint-swimmer has no gravity
          vy += (lookY - vy) * scale
          vy *= 0.8
          vx = (vx + 0.02 * 0.98) * 0.9
          roughly(e.vel.x, vx, 1e-6, `vx ${i}`)
          roughly(e.vel.y, vy, 2e-4, `vy ${i} pitch ${pitch}`)
        }
      }
    })

    it('does not steer upwards near the surface unless it jumps (no water 0.9 above the feet)', () => {
      const { physics, world } = setup('1.21.4', w => w.fill(-30, FLOOR_Y, -30, 60, FLOOR_Y, 30, 'water', []))
      const mk = jump => {
        const e = makeEntity(0.5, FLOOR_Y + 0.15)
        e.onGround = false
        e.isSwimming = true
        e.lastSprinting = true
        e.eyeInWater = true
        e.pose = 'swimming'
        e.pitch = 0.5
        e.vel.set(0, 0.1, 0)
        e.control.sprint = true
        e.control.jump = jump
        physics.simulatePlayer(e, world)
        return e
      }
      roughly(mk(false).vel.y, 0.1 * 0.8, 1e-8, 'no steering')
      roughly(mk(true).vel.y, (0.14 + (Math.sin(0.5) - 0.14) * 0.06) * 0.8, 3e-4, 'steering while jumping (the jump first)')
    })

    it('swimming ends a tick after the sprint, standing follows at the end of that tick; out of the water at once', () => {
      const { physics, world } = setup('1.21.4', DEEP)
      const e = swimmer()
      physics.simulatePlayer(e, world)
      assert.strictEqual(e.pose, 'swimming')
      e.control.sprint = false
      physics.simulatePlayer(e, world) // the last tick still counted as sprinting
      assert.strictEqual(e.isSwimming, true)
      physics.simulatePlayer(e, world)
      assert.strictEqual(e.isSwimming, false)
      assert.strictEqual(e.pose, 'standing')
      // out of the water: not swimming at once
      const dry = setup('1.21.4')
      const d = makeEntity()
      d.pose = 'swimming'
      d.isSwimming = true
      d.lastSprinting = true
      dry.physics.simulatePlayer(d, dry.world)
      assert.strictEqual(d.isSwimming, false)
      assert.strictEqual(d.pose, 'standing')
    })

    it('a ceiling keeps the pose small: 1.5 clearance crouches, 1.0 crawls (swimming pose out of the water)', () => {
      const out = (clearance, shapes) => {
        const { physics, world } = setup('1.21.4', w => w.fill(-30, FLOOR_Y + 1, -30, 60, FLOOR_Y + 1, 30, 'stone', shapes))
        const e = makeEntity()
        e.pose = 'swimming'
        e.isSwimming = true
        e.lastSprinting = true
        physics.simulatePlayer(e, world)
        return { e, physics, world, clearance }
      }
      assert.strictEqual(out(1.5, [[0, 0.5, 0, 1, 1, 1]]).e.pose, 'crouching') // the ceiling is at 1.5 above the floor
      const crawl = out(1.0, FULL)
      assert.strictEqual(crawl.e.pose, 'swimming')
      assert.strictEqual(crawl.e.isInWater, false) // so it is crawling
    })

    it('crawls and crouches at the sneaking speed (0.3), the crouch also while the key is already up', () => {
      const speed = (pose, build, sneakKey) => {
        const { physics, world } = setup('1.21.4', build)
        const e = makeEntity()
        e.pose = pose
        e.wasSneaking = pose === 'crouching'
        e.control.forward = true
        e.control.sneak = !!sneakKey
        return run(physics, world, e, 120, en => en.pos.x).slice(-2).reduce((a, b) => b - a)
      }
      const standing = speed('standing')
      const crouch = speed('crouching', undefined, true)
      const crawl = speed('swimming', w => w.fill(-30, FLOOR_Y + 1, -30, 60, FLOOR_Y + 1, 30, 'stone', FULL))
      roughly(crouch, standing * 0.3, 2e-4, 'crouch')
      roughly(crawl, standing * 0.3, 2e-4, 'crawl')
      // standing up needs room: the pose of the last tick being crouching with a ceiling above keeps the slowdown without the key
      const { physics, world } = setup('1.21.4', w => w.fill(-30, FLOOR_Y + 1, -30, 60, FLOOR_Y + 1, 30, 'stone', [[0, 0.5, 0, 1, 1, 1]]))
      const low = makeEntity()
      low.pose = 'crouching'
      low.control.forward = true
      physics.simulatePlayer(low, world)
      roughly(low.pos.x - 0.5, 0.1 * F(F(0.3) * F(0.98)), 1e-6, 'no room to stand: slow without a key')
    })

    it('sneaking in water sinks by 0.04 a tick before the move', () => {
      const { physics, world } = setup('1.21.4', DEEP)
      const e = makeEntity(0.5, FLOOR_Y + 20)
      e.onGround = false
      e.vel.set(0, 0, 0)
      physics.simulatePlayer(e, world)
      const still = e.vel.y
      const s = makeEntity(0.5, FLOOR_Y + 20)
      s.onGround = false
      s.vel.set(0, 0, 0)
      s.control.sneak = true
      physics.simulatePlayer(s, world)
      roughly(s.vel.y - still, -0.04 * 0.8, 1e-9)
    })

    it('a gliding body is the 0.6 box and flies through a gap a block high', () => {
      const { physics, world } = setup('1.21.4', w => {
        w.fill(1, FLOOR_Y + 3, -2, 12, FLOOR_Y + 3, 2, 'stone', FULL) // floor of the gap (top at +4)
        w.fill(1, FLOOR_Y + 5, -2, 12, FLOOR_Y + 5, 2, 'stone', FULL) // ceiling of the gap (bottom at +5)
      })
      const e = makeEntity(0.5, FLOOR_Y + 4.2)
      e.onGround = false
      e.elytraFlying = true
      e.elytraEquipped = true
      e.pose = 'gliding'
      e.vel.set(0.5, 0.05, 0)
      e.pitch = 0.05
      run(physics, world, e, 8, en => en.pos.x)
      assert.ok(e.pos.x > 3.5, `flew into the gap: x ${e.pos.x}`)
      assert.strictEqual(e.pose, 'gliding')
      // and with the standing box (no pose) the same gap is a wall
      const { physics: p2, world: w2 } = setup('1.21.4', w => {
        w.fill(1, FLOOR_Y + 3, -2, 12, FLOOR_Y + 3, 2, 'stone', FULL)
        w.fill(1, FLOOR_Y + 5, -2, 12, FLOOR_Y + 5, 2, 'stone', FULL)
      })
      const t = makeEntity(0.5, FLOOR_Y + 4.2)
      t.onGround = false
      t.elytraFlying = true
      t.elytraEquipped = true
      t.vel.set(0.5, 0.05, 0)
      t.pitch = 0.05
      run(p2, w2, t, 8, en => en.pos.x)
      assert.ok(t.pos.x < 1, `stopped at the gap: x ${t.pos.x}`)
    })
  })

  describe('1.21+ block effects', () => {
    const column = (up) => w => {
      w.fill(-30, FLOOR_Y, -30, 60, FLOOR_Y + 20, 30, 'water', [])
      for (let y = FLOOR_Y; y <= FLOOR_Y + 20; y++) w.set(0, y, 0, 'bubble_column', [], up ? 1 : 0)
    }
    const afterOneTick = (version) => {
      const { physics, world } = setup(version, column(true))
      const e = makeEntity(0.5, FLOOR_Y + 10, 0.5)
      e.onGround = false
      e.vel.set(0, 0, 0)
      physics.simulatePlayer(e, world)
      return e.vel.y
    }

    it('a bubble column pushes before the water friction up to 1.21.1 and after it from 1.21.2', () => {
      // the box is in two cells of the column (more column above each): +0.06 for each; the water friction is 0.8 and
      // gravity / 16 (0.005) sinks
      roughly(afterOneTick('1.21.1'), (0 + 0.12) * 0.8 - 0.005, 1e-8, '1.21.1')
      roughly(afterOneTick('1.21.4'), (0 * 0.8 - 0.005) + 0.12, 1e-8, '1.21.4')
      roughly(afterOneTick('1.21.2'), (0 * 0.8 - 0.005) + 0.12, 1e-8, '1.21.2')
      roughly(afterOneTick('26.2'), (0 * 0.8 - 0.005) + 0.12, 1e-8, '26.2')
    })

    it('the top of a column (air above) pushes 0.1 up to 1.8, a down column pulls 0.03 down to -0.3 (-0.9 at the top)', () => {
      const { physics, world } = setup('1.21.4', w => {
        w.fill(-30, FLOOR_Y, -30, 60, FLOOR_Y + 3, 30, 'water', [])
        for (let y = FLOOR_Y; y <= FLOOR_Y + 3; y++) w.set(0, y, 0, 'bubble_column', [], 1)
      })
      const e = makeEntity(0.5, FLOOR_Y + 3.2, 0.5) // in the top cell, with air above (the water is only 4 deep)
      e.onGround = false
      e.vel.set(0, 0, 0)
      physics.simulatePlayer(e, world)
      roughly(e.vel.y, (0 * 0.8 - 0.005) + 0.1, 1e-8)
      const d = setup('1.21.4', column(false))
      const f = makeEntity(0.5, FLOOR_Y + 10, 0.5)
      f.onGround = false
      f.vel.set(0, 0, 0)
      f.fallDistance = 5
      d.physics.simulatePlayer(f, d.world)
      assert.strictEqual(f.fallDistance, 0)
      roughly(f.vel.y, (0 * 0.8 - 0.005) - 0.03 * 2, 1e-8, 'each of the two cells takes 0.03 off')
      f.vel.set(0, -0.29, 0)
      d.physics.simulatePlayer(f, d.world)
      assert.strictEqual(f.vel.y, -0.3, 'not below -0.3')
    })

    const webCell = (name, shapes = []) => w => w.set(0, FLOOR_Y, 0, name, shapes)
    const stepInto = (version, name, tweak) => {
      const { physics, world } = setup(version, webCell(name))
      const e = makeEntity(0.5, FLOOR_Y, 0.5)
      e.control.forward = true
      if (tweak) tweak(e)
      const xs = run(physics, world, e, 4, en => en.pos.x)
      return { e, xs, step: xs.map((x, i) => x - (i ? xs[i - 1] : 0.5)) }
    }

    it('cobweb: the move is 0.25 / 0.05 / 0.25 of the speed and the speed is cleared, every tick it stays in it', () => {
      for (const version of ['1.21.1', '1.21.4', '26.2']) {
        const { step, e } = stepInto(version, 'cobweb')
        // tick 1 walks free (the web is found at the end of the tick); tick 2 moves what is left of it plus the new input
        // by a quarter, and clears the speed; from then on it is the input alone, 0.098 * 0.25
        roughly(step[0], 0.098, 1e-6, `${version} free first tick`)
        roughly(step[1], (0.098 * F(0.6) * F(0.91) + 0.098) * 0.25, 1e-6, `${version} second tick`)
        for (let i = 2; i < 4; i++) roughly(step[i], 0.098 * 0.25, 1e-6, `${version} stuck tick ${i}`)
        assert.strictEqual(e.fallDistance, 0)
      }
    })

    it('cobweb with Weaving is 0.5; a sweet berry bush 0.8 / 0.75 / 0.8; powder snow 0.9 / 1.5 / 0.9 for the block the feet are in', () => {
      const weaving = stepInto('1.21.4', 'cobweb', e => { e.weaving = 1 })
      roughly(weaving.step[2], 0.098 * 0.5, 1e-6, 'weaving')
      const berry = stepInto('1.21.4', 'sweet_berry_bush')
      roughly(berry.step[2], 0.098 * F(0.8), 1e-6, 'berry')
      const snow = stepInto('1.21.4', 'powder_snow')
      roughly(snow.step[2], 0.098 * F(0.9), 1e-6, 'powder snow')
      // powder snow only counts when the feet are in it: standing a block above, in the air over it, does nothing
      const { physics, world } = setup('1.21.4', w => w.set(0, FLOOR_Y + 1, 0, 'powder_snow', []))
      const high = makeEntity(0.5, FLOOR_Y + 0.5, 0.5) // the box reaches into the snow, the feet are in the air below it
      high.onGround = false
      high.vel.set(0, 0, 0)
      physics.simulatePlayer(high, world)
      assert.ok(!high.stuckSpeed, 'only the block the feet are in sticks')
    })

    it('a stuck body keeps no jump: the jump speed is cleared with the rest of the velocity', () => {
      const { physics, world } = setup('1.21.4', webCell('cobweb'))
      const e = makeEntity(0.5, FLOOR_Y, 0.5)
      run(physics, world, e, 1, en => en.pos.y) // stuck now
      e.control.jump = true
      physics.simulatePlayer(e, world)
      assert.ok(e.pos.y - FLOOR_Y < 0.05, `rose ${e.pos.y - FLOOR_Y}`)
    })

    it('powder snow: a player in leather boots stands on it, sneaking or without boots it sinks, and boots climb it like a ladder', () => {
      const build = w => w.set(0, FLOOR_Y, 0, 'powder_snow', [])
      const land = (tweak) => {
        const { physics, world } = setup('1.21.4', build)
        const e = makeEntity(0.5, FLOOR_Y + 1.4, 0.5)
        e.onGround = false
        e.vel.set(0, 0, 0)
        tweak(e)
        run(physics, world, e, 25, en => en.pos.y)
        return e
      }
      const boots = land(e => { e.leatherBoots = true })
      roughly(boots.pos.y, FLOOR_Y + 1, 1e-6, 'on top')
      assert.strictEqual(boots.onGround, true)
      assert.ok(land(e => { e.leatherBoots = false }).pos.y < FLOOR_Y + 0.5, 'no boots: through')
      assert.ok(land(e => { e.leatherBoots = true; e.control.sneak = true }).pos.y < FLOOR_Y + 0.5, 'sneaking: through')
      // after a fall of more than 2.5 blocks the block holds only its lower 0.9 (and then the body is in it, which
      // resets the fall distance: it sinks on, as in vanilla)
      {
        const { physics, world } = setup('1.21.4', build)
        const e = makeEntity(0.5, FLOOR_Y + 0.95, 0.5)
        e.onGround = false
        e.vel.set(0, -0.2, 0)
        e.leatherBoots = true
        e.fallDistance = 3
        physics.simulatePlayer(e, world)
        assert.strictEqual(e.onGround, true)
        roughly(e.pos.y, FLOOR_Y + F(0.9), 1e-6, 'stopped by the lower 0.9')
        assert.strictEqual(e.fallDistance, 0, 'and now the feet are in the snow')
      }
      // in the block: the jump key climbs at 0.2 (-0.08 gravity, 0.98 drag)
      const { physics, world } = setup('1.21.4', build)
      const c = makeEntity(0.5, FLOOR_Y, 0.5)
      c.onGround = false
      c.vel.set(0, 0, 0)
      c.leatherBoots = true
      c.control.jump = true
      physics.simulatePlayer(c, world)
      roughly(c.vel.y, (0.2 - 0.08) * 0.98, 1e-6)
      c.leatherBoots = false
      c.vel.set(0, 0, 0)
      physics.simulatePlayer(c, world)
      assert.ok(c.vel.y < 0.1)
    })
  })

  describe('1.21+ elytra and flight', () => {
    it('the elytra follows the float look vector: no lift at 0 pitch, the look-down term and the 0.99F, 0.98F, 0.99F drag', () => {
      const { physics, world } = setup('1.21.4')
      const e = makeEntity(0.5, FLOOR_Y + 30)
      e.onGround = false
      e.elytraFlying = true
      e.elytraEquipped = true
      e.vel.set(1, 0, 0)
      e.pitch = 0
      physics.simulatePlayer(e, world)
      // yaw EAST: the look is +x; horizontal speed 1; gravity -0.08 * (-1 + 0.75) = -0.02 on vy... as vy < 0 it turns into speed
      const vyBefore = -0.08 * (1 - 0.75)
      const turn = vyBefore * -0.1
      roughly(e.vel.y, (vyBefore + turn) * F(0.98), 1e-6, 'vy')
      roughly(e.vel.x, (1 + turn) * F(0.99), 1e-3, 'vx')
    })

    it('the rocket boost comes after the move of the tick, on the look of that tick', () => {
      const { physics, world } = setup('1.21.4')
      const e = makeEntity(0.5, FLOOR_Y + 30)
      e.onGround = false
      e.elytraFlying = true
      e.elytraEquipped = true
      e.fireworkRocketDuration = 3
      physics.simulatePlayer(e, world)
      assert.ok(e.pos.x - 0.5 < 0.02, `the first move is not boosted: ${e.pos.x - 0.5}`) // (it turns a little of its fall into speed)
      roughly(e.vel.x, 0.855, 1e-2, 'boosted at the end: 0.1 + (1.5 - vx) * 0.5 on top of vx')
      assert.strictEqual(e.fireworkRocketDuration, 2)
      const before = e.pos.x
      physics.simulatePlayer(e, world)
      assert.ok(e.pos.x - before > 0.5, 'then it moves')
    })

    it('creative flight: 0.05 a tick of acceleration (doubled sprinting), drag 0.91, climbs at flying speed * 3 with the vertical speed decaying by 0.6', () => {
      const { physics, world } = setup('1.21.4')
      const fly = (control) => {
        const e = makeEntity(0.5, FLOOR_Y + 30)
        e.onGround = false
        e.flying = true
        e.flyingSpeed = 0.05
        e.vel.set(0, 0, 0)
        Object.assign(e.control, control)
        run(physics, world, e, 120, en => en.pos.x)
        return e
      }
      let vx = 0
      for (let i = 0; i < 120; i++) vx = (vx + 0.05 * 0.98) * 0.91
      roughly(fly({ forward: true }).vel.x, vx, 1e-6, 'flying')
      let vs = 0
      for (let i = 0; i < 120; i++) vs = (vs + 0.1 * 0.98) * 0.91
      roughly(fly({ forward: true, sprint: true }).vel.x, vs, 1e-6, 'sprint flying')
      let vy = 0
      for (let i = 0; i < 120; i++) vy = (vy + 0.15) * 0.6
      roughly(fly({ jump: true }).vel.y, vy, 1e-6, 'up')
      roughly(fly({ sneak: true }).vel.y, -vy, 1e-6, 'down')
      const hover = fly({})
      assert.strictEqual(hover.vel.y, 0, 'no gravity')
      assert.strictEqual(hover.pose, undefined)
    })

    it('a flying player floats on water and does not swim', () => {
      const { physics, world } = setup('1.21.4', w => w.fill(-30, FLOOR_Y, -30, 60, FLOOR_Y + 60, 30, 'water', []))
      const e = makeEntity(0.5, FLOOR_Y + 20)
      e.onGround = false
      e.flying = true
      e.vel.set(0, 0, 0)
      e.control.forward = true
      run(physics, world, e, 5, en => en.pos.x)
      assert.strictEqual(e.vel.y, 0)
      assert.ok(e.vel.x > 0.1, `air speed, not water speed: ${e.vel.x}`)
    })

    it('a spectator passes through walls', () => {
      const { physics, world } = setup('1.21.4', w => w.fill(3, FLOOR_Y, -3, 4, FLOOR_Y + 3, 3, 'stone', FULL))
      const e = makeEntity(0.5, FLOOR_Y + 1)
      e.onGround = false
      e.flying = true
      e.spectator = true
      e.control.forward = true
      run(physics, world, e, 40, en => en.pos.x)
      assert.ok(e.pos.x > 6, `through the wall: ${e.pos.x}`)
    })

    it('older versions keep their elytra and flight code (1.20.4 does not fly or glide with poses)', () => {
      const { physics, world } = setup('1.20.4')
      const e = makeEntity(0.5, FLOOR_Y + 30)
      e.onGround = false
      e.flying = true // the original has no flight
      e.vel.set(0, 0, 0)
      physics.simulatePlayer(e, world)
      assert.ok(e.vel.y < 0, 'gravity applies')
    })
  })

  // ---- The tick driver (lib/plugins/physics.js) against a mock server, with the packet-order validator of Grim ----------
  describe('the driver around the engine (mock server)', function () {
    this.timeout(30 * 1000)
    const grimLint = require('./grimLint')
    const nbt = require('prismarine-nbt')
    for (const version of ['1.21.4', '26.2']) {
      describe(version, () => {
        const registry = require('prismarine-registry')(version)
        const Chunk = require('prismarine-chunk')(version)
        const Item = require('prismarine-item')(registry)
        const entityActionId = require('../lib/entity_action')
        const names = list => list.map(p => p.name)
        const chatText = (text) => registry.supportFeature('chatPacketsUseNbtComponents') ? nbt.comp({ text: nbt.string(text) }) : JSON.stringify({ text })
        let server, bot, client, lint, received

        beforeEach(async () => {
          const port = await getPort()
          server = mc.createServer({ 'online-mode': false, version, port })
          server.on('connection', c => {
            const write = c.write
            c.write = function (name, params) {
              if (name === 'success' && params.sessionId === undefined) params = { ...params, sessionId: require('crypto').randomUUID() }
              return write.call(this, name, params)
            }
          })
          await once(server, 'listening')
          bot = mineflayer.createBot({ username: 'player', version, port })
          bot.test = { pluginsLoaded: new Promise(resolve => bot.once('inject_allowed', resolve)) }
        })
        afterEach((done) => {
          if (bot._client.ended) done()
          else bot.on('end', () => done())
          server.close()
        })

        function chunkPacket (chunk) {
          const lights = chunk.dumpLight()
          return {
            x: 0,
            z: 0,
            groundUp: true,
            biomes: chunk.dumpBiomes !== undefined ? chunk.dumpBiomes() : undefined,
            heightmaps: { type: 'compound', name: '', value: { MOTION_BLOCKING: { type: 'longArray', value: new Array(36).fill([0, 0]) } } },
            bitMap: chunk.getMask(),
            chunkData: chunk.dump(),
            blockEntities: [],
            trustEdges: false,
            skyLightMask: lights && lights.skyLightMask,
            blockLightMask: lights && lights.blockLightMask,
            emptySkyLightMask: lights && lights.emptySkyLightMask,
            emptyBlockLightMask: lights && lights.emptyBlockLightMask,
            skyLight: lights?.skyLight,
            blockLight: lights?.blockLight
          }
        }

        // A stone floor at y = 64 (the bot stands at (1.5, 65, 4.5)); `build(chunk)` adds the rest
        async function join (build) {
          const chunk = bot.supportFeature('tallWorld') ? new Chunk({ minY: -64, worldHeight: 384 }) : new Chunk()
          for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) chunk.setBlockType(new Vec3(x, 64, z), registry.blocksByName.stone.id)
          if (build) build(chunk)
          received = []
          await new Promise(resolve => {
            server.on('playerJoin', async (c) => {
              client = c
              await bot.test.pluginsLoaded
              client.on('packet', (data, meta) => received.push({ name: meta.name, data }))
              const login = registry.loginPacket
              login.entityId = 0
              client.write('login', login)
              client.write('map_chunk', chunkPacket(chunk))
              client.write('position', { x: 1.5, y: 65, z: 4.5, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: {}, teleportId: 0 })
              client.write('update_health', { health: 20, food: 20, foodSaturation: 5 })
              await once(bot, 'chunkColumnLoad')
              await sleep(400) // lands on the floor
              resolve()
            })
          })
          bot.quickBarSlot = 0
          lint = grimLint(bot, { players: new Set() })
          received.length = 0
        }

        it('a movement key pressed with a window open closes the window first; the walk starts after the close_window', async () => {
          await join()
          const pWindows = require('prismarine-windows')(version)
          const chestData = pWindows.windows['minecraft:generic_9x3'] ?? { type: 'minecraft:chest', slots: 63 }
          client.write('open_window', { windowId: 1, inventoryType: chestData.type, windowTitle: chatText(''), slotCount: chestData.slots - 36, entityId: 0 })
          client.write('window_items', { windowId: 1, stateId: 1, items: Array.from({ length: chestData.slots }, () => Item.toNotch(null)), carriedItem: Item.toNotch(null) })
          await once(bot, 'windowOpen')
          assert.ok(bot.currentWindow)
          received.length = 0
          let closedFor = null
          bot.once('windowClosedForMovement', w => { closedFor = w })
          bot.setControlState('forward', true)
          await bot.waitForTicks(6)
          const close = names(received).indexOf('close_window')
          assert.ok(close >= 0, `no close_window in ${names(received).join(' ')}`)
          assert.strictEqual(bot.currentWindow, null)
          assert.ok(closedFor, 'the event fired')
          const input = received.findIndex(p => p.name === 'player_input' && p.data.inputs.forward)
          assert.ok(input > close, 'the first forward input is after the close')
          const moved = received.findIndex(p => (p.name === 'position' || p.name === 'position_look') && Math.abs(p.data.z - 4.5) > 1e-9)
          assert.ok(moved > close, 'the first position that moved is after the close')
          assert.ok(bot.entity.position.z > 4.5 + 0.05, 'and then it walks (south, +z)')
          assert.deepStrictEqual(lint.violations, [])
        })

        it('keys already reported as held when a window opens: the release goes out first, the close_window a tick later', async () => {
          await join()
          bot.setControlState('forward', true)
          await bot.waitForTicks(3)
          const pWindows = require('prismarine-windows')(version)
          const chestData = pWindows.windows['minecraft:generic_9x3'] ?? { type: 'minecraft:chest', slots: 63 }
          client.write('open_window', { windowId: 1, inventoryType: chestData.type, windowTitle: chatText(''), slotCount: chestData.slots - 36, entityId: 0 })
          client.write('window_items', { windowId: 1, stateId: 1, items: Array.from({ length: chestData.slots }, () => Item.toNotch(null)), carriedItem: Item.toNotch(null) })
          await once(bot, 'windowOpen')
          received.length = 0
          await bot.waitForTicks(4)
          const order = names(received).filter(n => n === 'player_input' || n === 'close_window')
          assert.deepStrictEqual(order.slice(0, 2), ['player_input', 'close_window'], 'the zero input is out before the close')
          assert.strictEqual(received.find(p => p.name === 'player_input').data.inputs.forward, false)
          assert.deepStrictEqual(lint.violations, [])
        })

        it('sprinting, then starting to eat: stop_sprinting goes out in the tick the use starts, and the sprint resumes after the release', async () => {
          await join()
          bot.food = 10
          bot.inventory.updateSlot(bot.QUICK_BAR_START, new Item(registry.itemsByName.bread.id, 3))
          bot.setControlState('forward', true)
          bot.setControlState('sprint', true)
          await bot.waitForTicks(4)
          assert.strictEqual(bot.sprinting, true)
          received.length = 0
          await bot.activateItem()
          await bot.waitForTicks(2)
          const use = names(received).indexOf('use_item')
          const stop = received.findIndex(p => p.name === 'entity_action' && p.data.actionId === entityActionId(registry, 'stop_sprinting'))
          assert.ok(use >= 0 && stop > use, `use_item ${use}, stop_sprinting ${stop}`)
          assert.ok(!names(received).slice(use, stop).includes('tick_end'), 'in the same tick')
          assert.strictEqual(bot.sprinting, false)
          await bot.waitForTicks(3)
          assert.strictEqual(bot.sprinting, false, 'not while eating')
          await bot.deactivateItem()
          await bot.waitForTicks(3)
          assert.strictEqual(bot.sprinting, true)
          assert.deepStrictEqual(lint.violations, [])
        })

        it('sneaking stops a sprint a tick after the key (the crouch lags the key) and a crouched bot does not start one', async () => {
          await join()
          bot.setControlState('forward', true)
          bot.setControlState('sprint', true)
          await bot.waitForTicks(4)
          assert.strictEqual(bot.sprinting, true)
          bot.setControlState('sneak', true)
          await bot.waitForTicks(1)
          assert.strictEqual(bot.sprinting, true, 'the pose is still standing in the tick of the key')
          await bot.waitForTicks(2)
          assert.strictEqual(bot.sprinting, false)
          assert.strictEqual(bot.pose, 'crouching')
          assert.strictEqual(bot.entity.height, 1.5)
          assert.strictEqual(bot.entity.eyeHeight, F(1.27))
          bot.setControlState('sneak', false)
          await bot.waitForTicks(4)
          assert.strictEqual(bot.sprinting, true)
          assert.strictEqual(bot.entity.height, F(1.8))
          assert.deepStrictEqual(lint.violations, [])
        })

        it('swims: sprint starts under water, the pose becomes the 0.6 box, a teleport keeps it, and it stands again after the sprint', async () => {
          await join(chunk => {
            for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 65; y <= 70; y++) chunk.setBlockType(new Vec3(x, y, z), registry.blocksByName.water.id)
          })
          bot.food = 20
          bot.setControlState('forward', true)
          bot.setControlState('sprint', true)
          await bot.waitForTicks(8)
          assert.strictEqual(bot.sprinting, true)
          assert.strictEqual(bot.pose, 'swimming')
          assert.strictEqual(bot.entity.height, F(0.6))
          assert.strictEqual(bot.entity.eyeHeight, F(0.4))
          const actions = received.filter(p => p.name === 'entity_action').map(p => p.data.actionId)
          assert.deepStrictEqual(actions, [entityActionId(registry, 'start_sprinting')], 'start_sprinting once, never stopped')
          assert.ok(bot.entity.position.z > 4.5 + 0.3, 'swims forward')
          client.write('position', { x: 1.5, y: 66, z: 2.5, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: {}, teleportId: 1 })
          await bot.waitForTicks(2)
          assert.strictEqual(bot.entity.height, F(0.6), 'a teleport keeps the pose')
          // letting go of the sprint key changes nothing (a swimmer keeps sprinting); letting go of forward, off the floor, ends it
          bot.setControlState('sprint', false)
          await bot.waitForTicks(3)
          assert.strictEqual(bot.sprinting, true)
          bot.setControlState('forward', false)
          await bot.waitForTicks(5)
          assert.strictEqual(bot.sprinting, false)
          assert.strictEqual(bot.pose, 'standing')
          assert.strictEqual(bot.entity.height, F(1.8))
          assert.deepStrictEqual(lint.violations, [])
        })

        it('wading with the head out of the water does not sprint', async () => {
          await join(chunk => {
            for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) chunk.setBlockType(new Vec3(x, 65, z), registry.blocksByName.water.id)
          })
          bot.food = 20
          bot.setControlState('forward', true)
          bot.setControlState('sprint', true)
          await bot.waitForTicks(6)
          assert.strictEqual(bot.sprinting, false)
          assert.deepStrictEqual(received.filter(p => p.name === 'entity_action' && p.data.actionId === entityActionId(registry, 'start_sprinting')), [])
        })
      })
    }
  })

  // A bot with just what PlayerState reads
  function fakeBot (version, extra = {}) {
    const registry = require('prismarine-registry')(version)
    return {
      version,
      registry,
      entity: { position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0), onGround: true, effects: {}, yaw: 0, pitch: 0, attributes: {} },
      inventory: { slots: [] },
      jumpTicks: 0,
      jumpQueued: false,
      fireworkRocketDuration: 0,
      ...extra
    }
  }
})
