/* eslint-env mocha */

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const net = require('net')
const mineflayer = require('../')
const { installProtodefGuard, protodefSkipped } = require('../lib/protodef_guard')
const { loadPathfinder } = require('../lib/pathfinder')
const { sleep } = require('../lib/promise_utils')
const { getPort } = require('./common/util')
const grimLint = require('./grimLint')
const { EventEmitter } = require('events')
const vec3 = require('vec3')

describe('9bflayer connection guards', function () {
  this.timeout(10 * 1000)

  describe('protodef guard', () => {
    const version = '1.21.4'
    const { createDeserializer } = require('minecraft-protocol/src/transforms/serializer')
    const mappings = require('minecraft-data')(version).protocol.play.toClient.types.packet[1][0].type[1].mappings
    const id = parseInt(Object.keys(mappings).find(k => mappings[k] === 'update_health'), 16)
    // update_health with its fields cut off: protodef throws "Read error for ..."
    const truncated = Buffer.from([id, 0x00])

    it('skips an undecodable packet and counts it', () => {
      assert.strictEqual(installProtodefGuard(), true)
      assert.strictEqual(installProtodefGuard(), true) // installing twice wraps once
      const deserializer = createDeserializer({ version, state: 'play', isServer: false })
      const before = protodefSkipped()
      const parsed = deserializer.parsePacketBuffer(truncated)
      assert.strictEqual(parsed.data.name, 'unknown')
      assert.deepStrictEqual(parsed.data.params, {})
      assert.strictEqual(parsed.metadata.size, truncated.length)
      assert.strictEqual(protodefSkipped() - before, 1)
    })

    it('still decodes valid packets and is exported', () => {
      const deserializer = createDeserializer({ version, state: 'play', isServer: false })
      const full = Buffer.concat([Buffer.from([id]), Buffer.from([0x41, 0xa0, 0x00, 0x00]), Buffer.from([0x14]), Buffer.from([0x40, 0xa0, 0x00, 0x00])])
      const before = protodefSkipped()
      const parsed = deserializer.parsePacketBuffer(full)
      assert.strictEqual(parsed.data.name, 'update_health')
      assert.strictEqual(parsed.data.params.health, 20)
      assert.strictEqual(protodefSkipped(), before)
      assert.strictEqual(mineflayer.protodefSkipped, protodefSkipped)
    })
  })

  describe('createBot defaults', () => {
    it('keeps the 60 s keep-alive, hides errors and lets the caller override', () => {
      const custom = { username: 'custom', host: '127.0.0.1', port: 1, connect: () => {}, checkTimeoutInterval: 5000, hideErrors: false }
      mineflayer.createBot(custom).end()
      assert.strictEqual(custom.checkTimeoutInterval, 5000)
      assert.strictEqual(custom.hideErrors, false)
      const plain = { username: 'plain', host: '127.0.0.1', port: 1, connect: () => {} }
      mineflayer.createBot(plain).end()
      assert.strictEqual(plain.checkTimeoutInterval, 60000)
      assert.strictEqual(plain.hideErrors, true)
      assert.strictEqual(plain.skipUndecodablePackets, true)
    })
  })

  describe('late socket guard', () => {
    it('destroys a socket that connects after bot.end() before anything is written to it', async () => {
      // a plain TCP server, so any byte the bot writes (handshake, login start) is seen
      const port = await getPort()
      let bytes = 0
      let connections = 0
      const server = net.createServer((socket) => {
        connections++
        socket.on('data', (data) => { bytes += data.length })
        socket.on('error', () => {})
      })
      await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
      // stands in for a slow Microsoft sign-in: the connection is made long after bot.end()
      const bot = mineflayer.createBot({
        username: 'late',
        version: '1.21.4',
        port,
        host: '127.0.0.1',
        auth: (client, options) => { setTimeout(() => options.connect(client), 200) }
      })
      let ends = 0
      bot.on('end', () => ends++)
      bot.end('test')
      bot.end('test')
      await sleep(100)
      assert.strictEqual(ends, 1, 'bot.end() before the connection reports end at once, once')
      await sleep(600)
      server.close()
      assert.strictEqual(bytes, 0, 'the bot wrote to the server after bot.end()')
      assert.strictEqual(connections, 0, 'a late socket must be destroyed before it connects')
      assert.strictEqual(ends, 1)
    })
  })

  describe('loadPathfinder', () => {
    function fakePathfinder (body) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), '9bflayer-pf-'))
      const pkg = path.join(dir, 'node_modules', 'mineflayer-pathfinder')
      fs.mkdirSync(pkg, { recursive: true })
      fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"mineflayer-pathfinder","main":"index.js"}')
      fs.writeFileSync(path.join(pkg, 'index.js'), body)
      return dir
    }

    it('replaces fullStop with releasing the keys', () => {
      const dir = fakePathfinder(`module.exports = function inject (bot) {
  function fullStop () {
    bot.clearControlStates()

    // Kind of cheaty, but the server will not tell the difference
    bot.entity.velocity.x = 0
    bot.entity.position.x = 1
  }

  return { stop: fullStop }
}
`)
      let cleared = 0
      const { stop } = loadPathfinder(dir)({ clearControlStates: () => cleared++ })
      stop() // an unpatched fullStop would throw on the missing bot.entity
      assert.strictEqual(cleared, 1)
      assert.strictEqual(loadPathfinder(dir), loadPathfinder(path.join(dir, 'x.js')), 'cached per resolved file')
    })

    it('throws instead of guessing when the pattern is not found', () => {
      const dir = fakePathfinder('module.exports = function inject (bot) { return {} }\n')
      assert.throws(() => loadPathfinder(dir), /no fullStop\(\) as expected/)
    })

    it('is exported as 9bflayer/pathfinder', () => {
      assert.strictEqual(require('../pathfinder').loadPathfinder, loadPathfinder)
    })
  })

  describe('grimLint', () => {
    function lintFor (version) {
      const registry = require('prismarine-registry')(version)
      const bot = { registry, supportFeature: registry.supportFeature, _client: Object.assign(new EventEmitter(), { write () {} }) }
      const lint = grimLint(bot, { report () {} })
      const send = (name, params = {}) => bot._client.write(name, params)
      const ids = () => lint.violations.map(v => v.id)
      return { send, ids, lint }
    }
    const pos = { x: 1, y: 65, z: 1, yaw: 10, pitch: 0, onGround: true, flags: { onGround: true } }
    const tick = (send, extra = {}) => { send('position_look', { ...pos, ...extra }); send('tick_end') }
    const place = { location: vec3(1, 64, 1), direction: 1, cursorX: 0.5, cursorY: 1, cursorZ: 0.5, sequence: 1 }

    it('accepts a vanilla tick', () => {
      const { send, ids } = lintFor('1.21.4')
      send('pong', { id: 1 })
      send('held_item_slot', { slotId: 3 })
      send('block_place', place)
      send('arm_animation', { hand: 0 })
      send('player_input', { inputs: {} })
      send('entity_action', { actionId: 'start_sneaking' })
      send('entity_action', { actionId: 'start_sprinting' })
      tick(send)
      assert.deepStrictEqual(ids(), [])
    })

    it('flags what the vanilla order forbids', () => {
      const cases = [
        ['Post', (send) => { tick(send); send('arm_animation', {}); send('tick_end'); send('block_place', place); send('pong', { id: 1 }) }],
        ['PacketOrderO', (send) => { send('position_look', pos); send('arm_animation', {}); send('tick_end') }],
        ['PacketOrderE', (send) => { send('block_place', place); send('held_item_slot', { slotId: 1 }) }],
        ['PacketOrderF', (send) => { send('entity_action', { actionId: 'start_sprinting' }); send('block_place', place) }],
        ['PacketOrderH', (send) => { send('entity_action', { actionId: 'start_sprinting' }); send('entity_action', { actionId: 'start_sneaking' }) }],
        ['BadPacketsX', (send) => { send('entity_action', { actionId: 'start_sprinting' }); send('entity_action', { actionId: 'stop_sprinting' }) }],
        ['BadPacketsZ', (send) => { send('player_input', {}); send('player_input', {}) }],
        ['BadPacketsA', (send) => { send('held_item_slot', { slotId: 1 }); tick(send); send('held_item_slot', { slotId: 1 }) }],
        ['BadPacketsD', (send) => tick(send, { pitch: 90.075 })],
        ['AimModulo360', (send) => { tick(send); tick(send, { yaw: 10 - 343 }) }],
        ['AimDuplicateLook', (send) => { tick(send); tick(send) }],
        ['PacketOrderB', (send) => { send('attack', { entityId: 1 }); send('entity_action', { actionId: 'start_sprinting' }) }],
        ['PacketOrderI/J/M/MultiActionsF', (send) => { send('attack', { entityId: 1 }); send('arm_animation', {}); send('use_item', { hand: 0, sequence: 1 }) }],
        ['MultiPlace', (send) => { send('block_place', place); send('block_place', { ...place, sequence: 2, cursorX: 0.1 }) }],
        ['BadPacketsH', (send) => send('block_place', { ...place, sequence: 5 })],
        ['BadPacketsJ', (send) => { send('use_item', { hand: 0, sequence: 1, rotation: { x: 1, y: 2 } }); tick(send) }],
        ['NoSwingBreak', (send) => { send('block_dig', { status: 0, location: vec3(0, 0, 0), face: 1, sequence: 1 }); tick(send) }],
        ['PacketOrderG', (send) => { send('block_place', place); send('block_dig', { status: 6, location: vec3(0, 0, 0), face: 0, sequence: 0 }) }],
        ['BadPacketsL', (send) => send('block_dig', { status: 6, location: vec3(0, 0, 0), face: 3, sequence: 0 })],
        ['TickTimer', (send) => { send('position_look', pos); send('position_look', { ...pos, yaw: 11 }) }],
        ['PacketOrderC', (send) => { send('use_entity', { target: 1, mouse: 0 }) }],
        // pos is (1, 65, 1): the eyes are at 66.62 / 66.27
        ['PositionBreakA', (send) => { tick(send); send('block_dig', { status: 0, location: vec3(1, 70, 1), face: 1, sequence: 1 }) }],
        ['FarBreak', (send) => { tick(send); send('block_dig', { status: 0, location: vec3(9, 65, 1), face: 5, sequence: 1 }) }],
        ['PositionPlace', (send) => { tick(send); send('block_place', { ...place, location: vec3(1, 70, 1), direction: 1 }) }],
        ['FarPlace', (send) => { tick(send); send('block_place', { ...place, location: vec3(1, 64, 12) }) }],
        ['FastBreak', (send) => {
          tick(send)
          const dig = (status) => { send('block_dig', { status, location: vec3(1, 64, 1), face: 1, sequence: status === 0 ? 1 : 2 }); send('arm_animation', {}) }
          dig(0); tick(send, { yaw: 11 }); dig(2); for (let i = 0; i < 4; i++) tick(send, { yaw: 12 + i }); dig(0)
        }],
        ['WrongBreak', (send) => { tick(send); send('block_dig', { status: 0, location: vec3(1, 64, 1), face: 1, sequence: 1 }); send('block_dig', { status: 2, location: vec3(1, 64, 2), face: 1, sequence: 2 }) }],
        ['PositionBreakB', (send) => { tick(send); send('block_dig', { status: 1, location: vec3(1, 64, 1), face: 3, sequence: 0 }); tick(send, { yaw: 11 }); send('block_dig', { status: 0, location: vec3(1, 64, 1), face: 1, sequence: 1 }) }],
        ['VehicleA', (send) => send('steer_vehicle', { sideways: 1, forward: 0, jump: 0 })]
      ]
      for (const [id, run] of cases) {
        const { send, ids } = lintFor('1.21.4')
        run(send)
        assert.ok(ids().includes(id), `${id} not reported, got ${ids()}`)
      }
    })

    it('accepts a vanilla dig: abort with a new face, START with it, FINISH 6 ticks before the next START', () => {
      const { send, ids } = lintFor('1.21.4')
      tick(send)
      const dig = (status, extra = {}) => { send('block_dig', { status, location: vec3(1, 64, 1), face: 1, sequence: status === 1 ? 0 : 1, ...extra }); send('arm_animation', {}) }
      send('block_dig', { status: 1, location: vec3(2, 64, 1), face: 1, sequence: 0 })
      dig(0)
      tick(send, { yaw: 11 })
      send('block_dig', { status: 2, location: vec3(1, 64, 1), face: 1, sequence: 2 })
      send('arm_animation', {})
      for (let i = 0; i < 6; i++) tick(send, { yaw: 12 + i })
      send('block_dig', { status: 0, location: vec3(1, 64, 1), face: 1, sequence: 3 })
      send('arm_animation', {})
      assert.deepStrictEqual(ids(), [])
    })

    it('checks the hit point of an interaction with a player', () => {
      const lint = (point) => {
        const registry = require('prismarine-registry')('1.21.4')
        const bot = { registry, supportFeature: registry.supportFeature, _client: Object.assign(new EventEmitter(), { write () {} }) }
        const l = grimLint(bot, { report () {}, players: new Set([5]) })
        bot._client.write('use_entity', { target: 5, mouse: 2, ...point })
        bot._client.write('use_entity', { target: 5, mouse: 0 })
        return l.violations.map(v => v.id)
      }
      assert.deepStrictEqual(lint({ x: 0.1, y: 1, z: -0.2 }), [])
      assert.deepStrictEqual(lint({ x: 0.5, y: 1, z: 0 }), ['InvalidInteractCursor'])
      assert.deepStrictEqual(lint({ x: 0, y: 2, z: 0 }), ['InvalidInteractCursor'])
    })

    it('answers a server rotation like a teleport: exactly, in the air, and it is no tick', () => {
      const { send, ids } = lintFor('1.21.4')
      const bot = { _client: null }
      assert.ok(!bot._client)
      const registry = require('prismarine-registry')('1.21.4')
      const client = Object.assign(new EventEmitter(), { write () {} })
      const fake = { registry, supportFeature: registry.supportFeature, _client: client }
      const lint = grimLint(fake, { report () {} })
      const write = (name, params) => client.write(name, params)
      client.emit('player_rotation', { yaw: 90, pitch: 10 })
      write('look', { yaw: 90, pitch: 10, onGround: false, flags: { onGround: false, hasHorizontalCollision: false } })
      write('position_look', { ...pos, yaw: 91 })
      write('tick_end')
      assert.deepStrictEqual(lint.violations, [], 'the answer is no tick packet, so a tick still follows')
      client.emit('player_rotation', { yaw: 90, pitch: 10 })
      write('look', { yaw: 90, pitch: 10, onGround: true, flags: { onGround: true } })
      assert.deepStrictEqual(lint.violations.map(v => v.id), ['BadPacketsB'])
      assert.deepStrictEqual(ids(), [])
      assert.ok(send)
    })
  })

  describe('aim helpers', () => {
    const { rayBox, distanceToBox } = require('../lib/plugins/aim')
    it('finds where a ray enters a box, and the face', () => {
      const min = vec3(0, 0, 0)
      const max = vec3(1, 1, 1)
      let hit = rayBox(vec3(0.5, 5, 0.5), vec3(0, -1, 0), min, max)
      assert.deepStrictEqual([hit.t, hit.face, hit.point.y], [4, 1, 1]) // enters through the top
      hit = rayBox(vec3(-3, 0.5, 0.5), vec3(1, 0, 0), min, max)
      assert.deepStrictEqual([hit.t, hit.face], [3, 4]) // the west face
      hit = rayBox(vec3(0.5, 0.5, 4), vec3(0, 0, -1), min, max)
      assert.strictEqual(hit.face, 3) // the south face
      assert.strictEqual(rayBox(vec3(5, 5, 5), vec3(0, 1, 0), min, max), null)
      assert.strictEqual(rayBox(vec3(0.5, 0.5, 0.5), vec3(1, 0, 0), min, max).t, 0, 'from inside')
      assert.strictEqual(rayBox(vec3(0.5, 5, 0.5), vec3(0, 1, 0), min, max), null, 'behind the ray')
    })
    it('measures the distance to a box', () => {
      assert.strictEqual(distanceToBox(vec3(0.5, 0.5, 0.5), vec3(0, 0, 0), vec3(1, 1, 1)), 0)
      assert.strictEqual(distanceToBox(vec3(4, 0.5, 0.5), vec3(0, 0, 0), vec3(1, 1, 1)), 3)
      assert.ok(Math.abs(distanceToBox(vec3(4, 5, 0.5), vec3(0, 0, 0), vec3(1, 1, 1)) - 5) < 1e-12)
    })
  })

  describe('input queue', () => {
    function fakeBot () {
      const bot = new EventEmitter()
      require('../lib/plugins/input_queue')(bot)
      return bot
    }
    const rot = { yaw: 0, pitch: 0 }

    it('sends one primary action per tick, in the order queued, after the swap and before the bare swing', async () => {
      const bot = fakeBot()
      const out = []
      const q = (cls, name) => bot._input.enqueue(cls, () => { out.push(name) })
      const all = [q('swing', 'swing'), q('use', 'use'), q('attack', 'attack'), q('swap', 'swap'), q('release', 'release'), q('swing', 'swing2')]
      bot._input.flush(rot)
      assert.deepStrictEqual(out, ['swap', 'use', 'swing'])
      assert.strictEqual(bot._input.pending, 3)
      bot._input.flush(rot)
      assert.deepStrictEqual(out, ['swap', 'use', 'swing', 'attack', 'swing2'])
      bot._input.flush(rot)
      assert.deepStrictEqual(out.slice(5), ['release'])
      bot._input.afterTick()
      await Promise.all(all)
    })

    it('does not swap after a drop in one tick', () => {
      const bot = fakeBot()
      const out = []
      bot._input.enqueue('drop', () => out.push('drop'))
      bot._input.enqueue('swap', () => out.push('swap'))
      bot._input.flush(rot)
      assert.deepStrictEqual(out, ['drop'])
      bot._input.flush(rot)
      assert.deepStrictEqual(out, ['drop', 'swap'])
    })

    it('settles after the tick, passes the result on and rejects what throws without an unhandled rejection', async () => {
      const bot = fakeBot()
      let settled = false
      const ok = bot._input.enqueue('use', (r) => r).then((r) => { settled = true; return r })
      bot._input.enqueue('dig', () => { throw new Error('boom') }) // nobody awaits it
      const failing = bot._input.enqueue('release', () => { throw new Error('boom') })
      bot._input.flush(rot)
      await sleep(5)
      assert.strictEqual(settled, false, 'callers continue after the tick, not inside it')
      bot._input.flush(rot)
      bot._input.flush(rot)
      bot._input.afterTick()
      assert.strictEqual(await ok, rot)
      await assert.rejects(failing, /boom/)
    })

    it('rejects what is queued when the bot ends, and what is queued after', async () => {
      const bot = fakeBot()
      const waiting = bot._input.enqueue('use', () => {})
      bot.emit('end')
      await assert.rejects(waiting, /ended/)
      await assert.rejects(bot._input.enqueue('use', () => {}), /ended/)
    })

    it('runs the per-tick hooks after the queue, told whether a primary action left', () => {
      const bot = fakeBot()
      const seen = []
      bot._input.onTick((r, primary) => seen.push(primary))
      bot._input.flush(rot)
      bot._input.enqueue('use', () => {})
      bot._input.flush(rot)
      assert.deepStrictEqual(seen, [false, true])
    })
  })

  describe('prediction sequence', () => {
    function fakeBot () {
      const bot = new EventEmitter()
      bot._client = new EventEmitter()
      require('../lib/plugins/sequence')(bot)
      return bot
    }

    it('starts again from the first value on login and in a new world, and goes on in the same world', () => {
      const bot = fakeBot()
      bot._client.emit('login', { worldName: 'minecraft:overworld' })
      assert.deepStrictEqual([bot._nextSequence(), bot._nextSequence()], [1, 2])
      bot._client.emit('respawn', { worldName: 'minecraft:overworld', dimension: 'minecraft:overworld' }) // died
      assert.strictEqual(bot._nextSequence(), 3)
      bot._client.emit('respawn', { worldName: 'minecraft:the_nether' })
      assert.strictEqual(bot._nextSequence(), 1)
      bot._client.emit('login', { worldState: { name: 'minecraft:overworld' } })
      assert.strictEqual(bot._nextSequence(), 1)
      bot._client.emit('respawn', { worldState: { name: 'minecraft:overworld' } })
      assert.strictEqual(bot._nextSequence(), 2)
      bot._client.emit('respawn', { worldState: { name: 'minecraft:the_end' } })
      assert.strictEqual(bot._nextSequence(), 1)
      // before 1.16 only the dimension id names the world
      bot._client.emit('login', { dimension: 0 })
      bot._nextSequence()
      bot._client.emit('respawn', { dimension: 0 })
      assert.strictEqual(bot._nextSequence(), 2)
      bot._client.emit('respawn', { dimension: -1 })
      assert.strictEqual(bot._nextSequence(), 1)
    })
  })

  describe('entity_action ids', () => {
    const entityActionId = require('../lib/entity_action')
    const mc = require('minecraft-protocol')

    // what the server decodes from what the bot writes
    function onTheWire (version, action) {
      const registry = require('prismarine-registry')(version)
      const serializer = mc.createSerializer({ state: 'play', isServer: false, version: registry.version.minecraftVersion })
      const parser = mc.createDeserializer({ state: 'play', isServer: true, version: registry.version.minecraftVersion })
      const buffer = serializer.createPacketBuffer({ name: 'entity_action', params: { entityId: 1, actionId: entityActionId(registry, action), jumpBoost: 0 } })
      return parser.parsePacketBuffer(buffer).data.params.actionId
    }

    for (const version of ['1.12.2', '1.20.4', '1.21.4', '1.21.5', '1.21.6', '1.21.11', '26.1', '26.2']) {
      it(`${version}: sprint, sneak and leave bed mean what they say`, () => {
        const registry = require('prismarine-registry')(version)
        assert.strictEqual(onTheWire(version, 'start_sprinting'), 'start_sprinting')
        assert.strictEqual(onTheWire(version, 'stop_sprinting'), 'stop_sprinting')
        assert.ok(['leave_bed', 'stop_sleeping'].includes(onTheWire(version, 'leave_bed')))
        if (registry.version['<']('1.21.6')) {
          assert.strictEqual(onTheWire(version, 'start_sneaking'), 'start_sneaking')
          assert.strictEqual(onTheWire(version, 'stop_sneaking'), 'stop_sneaking')
        } else {
          assert.throws(() => entityActionId(registry, 'start_sneaking'), /does not exist/)
        }
      })
    }
  })
})
