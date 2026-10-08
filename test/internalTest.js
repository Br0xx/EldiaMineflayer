/* eslint-env mocha */

const mineflayer = require('../')
const vec3 = require('vec3')
const mc = require('minecraft-protocol')
const assert = require('assert')
const { sleep } = require('../lib/promise_utils')
const nbt = require('prismarine-nbt')
const { once, onceWithCleanup } = require('../lib/promise_utils')
const { EventEmitter } = require('events')
const { getPort } = require('./common/util')
const grimLint = require('./grimLint')

for (const supportedVersion of mineflayer.testedVersions) {
  const registry = require('prismarine-registry')(supportedVersion)
  const version = registry.version
  const Chunk = require('prismarine-chunk')(supportedVersion)
  const Item = require('prismarine-item')(registry)

  // what every tick writes, whatever else the bot does
  const TICK_PACKETS = ['tick_end', 'position', 'position_look', 'look', 'flying', 'player_input', 'pong']

  const statusShift = version['>=']('26.3') ? 1 : 0 // see lib/player_action.js
  const hasSignedChat = registry.supportFeature('signedChat')
  function chatText (text) {
    // TODO: move this to prismarine-chat in a new ChatMessage(text).toNotch(asNbt) method
    return registry.supportFeature('chatPacketsUseNbtComponents')
      ? nbt.comp({ text: nbt.string(text) })
      : JSON.stringify({ text })
  }

  // 26.3 sends the light masks as a BitSet byte array, little-endian, where earlier versions send [msb, lsb] long pairs
  const maskBytes = version['>=']('26.3')
    ? longs => {
      const out = Buffer.alloc(longs.length * 8)
      longs.forEach(([msb, lsb], i) => { out.writeInt32LE(lsb, i * 8); out.writeInt32LE(msb, i * 8 + 4) })
      return out
    }
    : longs => longs

  function generateChunkPacket (chunk) {
    const lights = chunk.dumpLight()
    return {
      x: 0,
      z: 0,
      groundUp: true,
      biomes: chunk.dumpBiomes !== undefined ? chunk.dumpBiomes() : undefined,
      heightmaps: {
        type: 'compound',
        name: '',
        value: {
          MOTION_BLOCKING: { type: 'longArray', value: new Array(36).fill([0, 0]) }
        }
      }, // send fake heightmap
      bitMap: chunk.getMask(),
      chunkData: chunk.dump(),
      blockEntities: [],
      trustEdges: false,
      skyLightMask: lights && maskBytes(lights.skyLightMask),
      blockLightMask: lights && maskBytes(lights.blockLightMask),
      emptySkyLightMask: lights && maskBytes(lights.emptySkyLightMask),
      emptyBlockLightMask: lights && maskBytes(lights.emptyBlockLightMask),
      skyLight: lights?.skyLight,
      blockLight: lights?.blockLight
    }
  }

  describe(`mineflayer_internal ${supportedVersion}v`, function () {
    this.timeout(10 * 1000)
    let bot
    let server
    let PORT
    beforeEach(async function () {
      PORT = await getPort()
      server = mc.createServer({
        'online-mode': false,
        version: supportedVersion,
        port: PORT
      })
      // 26.2's login success carries a session id that minecraft-protocol's server doesn't fill in yet.
      server.on('connection', client => {
        const write = client.write
        client.write = function (name, params) {
          if (name === 'success' && params.sessionId === undefined) params = { ...params, sessionId: require('crypto').randomUUID() }
          return write.call(this, name, params)
        }
      })
      await once(server, 'listening')
      bot = mineflayer.createBot({
        username: 'player',
        version: supportedVersion,
        port: PORT
      })
      bot.test = {}
      // Plugins are injected on a timer after createBot, which can lose the
      // race against the mock server's playerJoin
      bot.test.pluginsLoaded = new Promise(resolve => bot.once('inject_allowed', resolve))

      bot.test.buildChunk = () => {
        if (bot.supportFeature('tallWorld')) {
          return new Chunk({ minY: -64, worldHeight: 384 })
        } else {
          return new Chunk()
        }
      }

      bot.test.generateLoginPacket = () => {
        let loginPacket
        if (bot.supportFeature('usesLoginPacket')) {
          loginPacket = registry.loginPacket
          loginPacket.entityId = 0 // Default login packet in minecraft-data 1.16.5 is 1, so set it to 0
        } else {
          loginPacket = {
            entityId: 0,
            levelType: 'fogetaboutit',
            gameMode: 0,
            previousGameMode: 255,
            worldNames: ['minecraft:overworld'],
            dimension: 0,
            worldName: 'minecraft:overworld',
            hashedSeed: [0, 0],
            difficulty: 0,
            maxPlayers: 20,
            reducedDebugInfo: 1,
            enableRespawnScreen: true
          }
        }
        return loginPacket
      }
    })
    afterEach((done) => {
      if (bot._client.ended) done()
      else bot.on('end', () => done())
      server.close()
    })
    it('chat', (done) => {
      bot.once('chat', (username, message) => {
        assert.strictEqual(username, 'gary')
        assert.strictEqual(message, 'hello')
        bot.chat('hi')
      })
      server.on('playerJoin', (client) => {
        client.write('login', bot.test.generateLoginPacket())
        const message = hasSignedChat
          ? JSON.stringify({ text: 'hello' })
          : JSON.stringify({
            translate: 'chat.type.text',
            with: [{
              text: 'gary'
            },
            'hello'
            ]
          })

        if (hasSignedChat) {
          const uuid = 'd3527a0b-bc03-45d5-a878-2aafdd8c8a43' // random
          const networkName = chatText('gary')

          if (registry.supportFeature('incrementedChatType')) {
            client.write('player_chat', {
              plainMessage: 'hello',
              filterType: 0,
              type: { chatType: 0 },
              networkName,
              previousMessages: [],
              senderUuid: uuid,
              timestamp: Date.now(),
              index: 0,
              salt: 1n
            })
          } else if (registry.supportFeature('useChatSessions')) {
            client.write('player_chat', {
              plainMessage: 'hello',
              filterType: 0,
              type: { chatType: 0 },
              networkName,
              previousMessages: [],
              senderUuid: uuid,
              timestamp: Date.now(),
              index: 0,
              salt: 2n
            })
          } else if (registry.supportFeature('chainedChatWithHashing')) {
            client.write('player_chat', {
              plainMessage: 'hello',
              filterType: 0,
              type: 0,
              networkName,
              previousMessages: [],
              senderUuid: uuid,
              timestamp: Date.now(),
              salt: 3n,
              signature: Buffer.alloc(0)
            })
          } else {
            client.write('player_chat', {
              signedChatContent: '',
              unsignedChatContent: message,
              type: 0,
              senderUuid: uuid,
              senderName: JSON.stringify({ text: 'gary' }),
              senderTeam: undefined,
              timestamp: Date.now(),
              salt: 4n,
              signature: Buffer.alloc(0)
            })
          }
        } else {
          client.write('chat', { message, position: 0, sender: '0' })
        }
        function onChat (packet) {
          const msg = packet.message || packet.unsignedChatContent || packet.signedChatContent
          assert.strictEqual(msg, 'hi')
          done()
        }
        client.on('chat_message', onChat)
        client.on('chat', onChat)
      })
    })
    it('chat before login throws a descriptive error', async () => {
      await once(bot, 'inject_allowed')
      const early = /before the client entered the play state; wait for/
      assert.throws(() => bot.chat('hi'), early)
      assert.throws(() => bot.whisper('gary', 'hi'), early)
    })
    it('chat after a kick during login throws a descriptive error', async () => {
      // Replaces the server's login handler so the client is rejected while still in the login state.
      server.on('connection', (client) => {
        client.removeAllListeners('login_start')
        client.once('login_start', () => client.end('kicked'))
      })
      const [reason] = await once(bot, 'end')
      const kicked = new RegExp(`disconnected before entering the play state \\(${reason}\\)`)
      assert.throws(() => bot.chat('hi'), kicked)
      assert.throws(() => bot.whisper('gary', 'hi'), kicked)
    })
    it('entity effects', (done) => {
      bot.once('entityEffect', (entity, effect) => {
        assert.strictEqual(entity.id, 8)
        assert.strictEqual(effect.id, 10)
        assert.strictEqual(effect.amplifier, 1)
        assert.strictEqual(effect.duration, 11)
        done()
      })
      // Versions prior to 1.11 have capital first letter
      const entities = bot.registry.entitiesByName
      const creeperId = entities.creeper ? entities.creeper.id : entities.Creeper.id
      server.on('playerJoin', (client) => {
        client.write(bot.registry.supportFeature('consolidatedEntitySpawnPacket') ? 'spawn_entity' : 'spawn_entity_living', {
          entityId: 8, // random
          entityUUID: '00112233-4455-6677-8899-aabbccddeeff',
          objectUUID: '00112233-4455-6677-8899-aabbccddeeff',
          type: creeperId,
          x: 10,
          y: 11,
          z: 12,
          yaw: 13,
          pitch: 14,
          headPitch: 14,
          velocity: { x: 15, y: 16, z: 17 },
          metadata: []
        })
        client.write('entity_effect', {
          entityId: 8,
          effectId: 10,
          amplifier: 1,
          duration: 11,
          hideParticles: false
        })
      })
    })
    it('blockAt', (done) => {
      const pos = vec3(1, 65, 1)
      const goldId = bot.registry.blocksByName.gold_block.id
      bot.on('chunkColumnLoad', (columnPoint) => {
        assert.strictEqual(columnPoint.x, 0)
        assert.strictEqual(columnPoint.z, 0)
        assert.strictEqual(bot.blockAt(pos).type, goldId)
        done()
      })
      server.on('playerJoin', (client) => {
        client.write('login', bot.test.generateLoginPacket())
        const chunk = bot.test.buildChunk()
        chunk.setBlockType(pos, goldId)
        client.write('map_chunk', generateChunkPacket(chunk))
      })
    })

    describe('digTime', () => {
      it('should use eye-level water check instead of isInWater for dig speed', (done) => {
        const blockPos = vec3(1, 65, 1)
        const playerPos = vec3(1.5, 66, 1.5)
        // eyeHeight is 1.62, so eye level at y=67.62 -> block at y=67
        // A second position where eye level has water: player at y=70, eye at y=71.62 -> block y=71
        const playerPos2 = vec3(1.5, 70, 1.5)
        const eyeLevelBlockPos2 = vec3(1, 71, 1)
        const dirtId = bot.registry.blocksByName.dirt.id
        const waterId = bot.registry.blocksByName.water.id
        const blockPos2 = vec3(1, 69, 1)

        bot.on('chunkColumnLoad', () => {
          // Set bot entity properties
          bot.entity.eyeHeight = 1.62
          bot.entity.onGround = true
          bot.entity.isInWater = false
          bot.entity.effects = {}
          bot.game = bot.game || {}
          bot.game.gameMode = 'survival'

          // Test 1: No water at eye level -> normal dig speed
          bot.entity.position = playerPos
          const block1 = bot.blockAt(blockPos)
          const digTimeNoWater = bot.digTime(block1)

          // Test 2: Water at eye level -> slower dig speed
          bot.entity.position = playerPos2
          const block2 = bot.blockAt(blockPos2)
          const digTimeWithWater = bot.digTime(block2)

          // Digging in water should be slower (higher dig time)
          assert(digTimeWithWater > digTimeNoWater,
            `Dig time with water at eye level (${digTimeWithWater}) should be greater than without (${digTimeNoWater})`)

          // Test 3: isInWater=true but no water block at eye level should NOT slow digging
          // (this is the bug that was fixed - previously isInWater incorrectly affected dig speed)
          bot.entity.position = playerPos
          bot.entity.isInWater = true
          const digTimeFeetInWater = bot.digTime(block1)
          assert.strictEqual(digTimeFeetInWater, digTimeNoWater,
            'isInWater should not affect dig time when eye level is not in water')

          done()
        })
        server.on('playerJoin', (client) => {
          client.write('login', bot.test.generateLoginPacket())
          const chunk = bot.test.buildChunk()
          // Place dirt blocks to dig at two locations
          chunk.setBlockType(blockPos, dirtId)
          chunk.setBlockType(blockPos2, dirtId)
          // Place water only at the second eye-level position
          chunk.setBlockType(eyeLevelBlockPos2, waterId)
          client.write('map_chunk', generateChunkPacket(chunk))
        })
      })
    })

    describe('physics', () => {
      const pos = vec3(1, 65, 1)
      const goldId = 41
      it('no physics if there is no chunk', (done) => {
        let fail = 0
        const basePosition = {
          x: 1.5,
          y: 66,
          z: 1.5,
          dx: 0, // 1.21.3
          dy: 0, // 1.21.3
          dz: 0, // 1.21.3
          pitch: 0,
          yaw: 0,
          flags: bot.registry.version['>=']('1.21.3') ? {} : 0,
          teleportId: 0
        }
        server.on('playerJoin', async (client) => {
          await client.write('login', bot.test.generateLoginPacket())
          await client.write('position', basePosition)
          client.on('packet', (data, meta) => {
            const packetName = meta.name
            switch (packetName) {
              case 'position':
                fail++
                break
              case 'position_look':
                fail++
                break
              case 'look':
                fail++
                break
            }
            if (fail > 1) assert.fail('position packet sent')
          })
          await sleep(2000)
          done()
        })
      })
      it('absolute position & relative position (velocity)', (done) => {
        // forcedMove fires when the teleport is answered at the start of a physics tick, so the state
        // it produces has to be read then; awaiting the event resumes after that tick's simulation.
        const onForcedMove = () => new Promise(resolve => {
          bot.once('forcedMove', () => resolve({ velocity: bot.entity.velocity.clone(), position: bot.entity.position.clone() }))
        })
        server.on('playerJoin', async (client) => {
          try {
            await client.write('login', bot.test.generateLoginPacket())
            const chunk = bot.test.buildChunk()
            chunk.setBlockType(pos, goldId)
            await client.write('map_chunk', generateChunkPacket(chunk))

            await once(bot, 'chunkColumnLoad')

            // --- Test 1: Absolute Position ---
            const absolutePositionPacket = {
              x: 1.5,
              y: 80,
              z: 1.5,
              pitch: 0,
              yaw: 0,
              teleportId: 1,
              flags: bot.supportFeature('positionPacketHasBitflags') ? { x: false, y: false, z: false, yaw: false, pitch: false } : 0
            }

            bot.entity.velocity.y = -1.0 // Give bot some velocity

            const p1 = onForcedMove()
            client.write('position', absolutePositionPacket)
            const afterAbsolute = await p1

            // Assertions for absolute teleport
            assert.strictEqual(afterAbsolute.velocity.y, 0, 'Velocity should be reset to 0 after an absolute teleport')
            assert.deepStrictEqual(afterAbsolute.position, vec3(1.5, 80, 1.5), 'Position should be set absolutely')

            // --- Test 2: Relative Position ---
            const relativePositionPacket = {
              x: 1.0,
              y: -2.0,
              z: 0.5,
              pitch: 0,
              yaw: 0,
              teleportId: 2,
              flags: bot.supportFeature('positionPacketHasBitflags') ? { x: true, y: true, z: true, yaw: false, pitch: false } : 7
            }

            // Set a known velocity *before* the relative update
            bot.entity.velocity.y = -1.0
            const initialPosition = bot.entity.position.clone()
            const expectedPosition = initialPosition.plus(vec3(1.0, -2.0, 0.5))

            const p2 = onForcedMove()
            client.write('position', relativePositionPacket)
            const afterRelative = await p2

            // Assertions for relative teleport
            assert.notStrictEqual(afterRelative.velocity.y, 0, 'Velocity should be preserved after a relative teleport')
            assert.deepStrictEqual(afterRelative.position, expectedPosition, 'Position should be updated relatively')

            done()
          } catch (err) {
            done(err)
          }
        })
      })
      it('drops the tick backlog after an event-loop stall instead of draining it', (done) => {
        server.on('playerJoin', async (client) => {
          client.write('login', bot.test.generateLoginPacket())
          const chunk = bot.test.buildChunk()
          chunk.setBlockType(pos, goldId)
          await client.write('map_chunk', generateChunkPacket(chunk))
          await client.write('position', {
            x: 1.5,
            y: 66,
            z: 1.5,
            dx: 0,
            dy: 0,
            dz: 0,
            pitch: 0,
            yaw: 0,
            teleportId: 1,
            flags: bot.supportFeature('positionPacketHasBitflags') ? { x: false, y: false, z: false, yaw: false, pitch: false } : 0
          })
          await once(bot, 'physicsTick')
          await sleep(300)
          // No physics tick can run during the stall (30 ticks' worth).
          const stallUntil = Date.now() + 1500
          while (Date.now() < stallUntil) { /* busy wait */ }
          let ticks = 0
          const count = () => ticks++
          bot.on('physicsTick', count)
          await sleep(500)
          bot.off('physicsTick', count)
          // 10 ticks at 20 tps plus one burst of at most maxCatchupTicks (2).
          assert.ok(ticks <= 18, `${ticks} physics ticks in the 500 ms after a 1.5 s stall`)
          assert.ok(ticks >= 8, `only ${ticks} physics ticks in 500 ms`)
          done()
        })
      })
      it('answers only the latest teleport when a second one lands inside the respawn reply delay', (done) => {
        // After a death the reply to the next teleport waits 1.5 s. A teleport that arrives inside
        // that window replaces it: the deferred reply must not go out with the older coordinates.
        const teleport = (teleportId, x, y, z) => ({
          x,
          y,
          z,
          dx: 0,
          dy: 0,
          dz: 0,
          pitch: 0,
          yaw: 0,
          flags: bot.supportFeature('positionPacketHasBitflags') ? {} : 0,
          teleportId
        })
        server.on('playerJoin', async (client) => {
          try {
            await bot.test.pluginsLoaded
            bot._respawnReplyDelayMs = 1500 // the default is 0 from 1.19 on
            await client.write('login', bot.test.generateLoginPacket())
            const chunk = bot.test.buildChunk()
            chunk.setBlockType(pos, goldId)
            await client.write('map_chunk', generateChunkPacket(chunk))
            await once(bot, 'chunkColumnLoad')
            const replies = []
            client.on('packet', (data, meta) => {
              if (meta.name === 'position_look') replies.push([data.x, data.y, data.z])
            })
            await client.write('position', teleport(0, 1.5, 80, 1.5))
            while (replies.length === 0) await once(client, 'packet')
            replies.length = 0

            bot.emit('death')
            await client.write('position', teleport(1, 3.5, 80, 3.5))
            await sleep(100)
            await client.write('position', teleport(2, 1.5, 66, 1.5))
            // Outlive the 1.5 s reply delay.
            await sleep(1700)

            assert.deepStrictEqual(replies, [[1.5, 66, 1.5]], `teleport replies: ${JSON.stringify(replies)}`)
            done()
          } catch (err) {
            done(err)
          }
        })
      })
      it('gravity + land on solid block + jump', (done) => {
        let y = 80
        let landed = false
        bot.on('move', () => {
          if (landed) return
          assert.ok(bot.entity.position.y <= y)
          assert.ok(bot.entity.position.y >= pos.y)
          y = bot.entity.position.y
          if (bot.entity.position.y <= pos.y + 1) {
            assert.strictEqual(bot.entity.position.y, pos.y + 1)
            assert.strictEqual(bot.entity.onGround, true)
            landed = true
            done()
          } else {
            assert.strictEqual(bot.entity.onGround, false)
          }
        })
        server.on('playerJoin', (client) => {
          client.write('login', bot.test.generateLoginPacket())
          const chunk = bot.test.buildChunk()

          chunk.setBlockType(pos, goldId)
          client.write('map_chunk', generateChunkPacket(chunk))
          client.write('position', {
            x: 1.5,
            y: 80,
            z: 1.5,
            pitch: 0,
            yaw: 0,
            flags: bot.supportFeature('positionPacketHasBitflags') ? { x: false, y: false, z: false, yaw: false, pitch: false } : 0,
            teleportId: 0
          })
        })
      })
      it('no movement packets during a server transfer configuration phase', function (done) {
        // Regression test for https://github.com/PrismarineJS/mineflayer/issues/3776
        // While the client is in the configuration phase (Velocity/BungeeCord server
        // transfer), sending play-state movement packets gets the bot kicked.
        // NOTE: the mock server's client.on('packet') cannot be used here, because
        // the server-side mock connection stays in the play state while only the
        // bot's client transitions to configuration — outbound movement packets then
        // fail to deserialize on the mock server and are silently dropped. Intercept
        // the bot's own client.write() instead, which directly captures what the bot
        // attempts to send, whatever the state.
        if (!bot.supportFeature('hasConfigurationState')) {
          this.skip()
          return
        }
        const positionPacket = {
          x: 1.5,
          y: 80,
          z: 1.5,
          dx: 0,
          dy: 0,
          dz: 0,
          pitch: 0,
          yaw: 0,
          flags: bot.registry.version['>=']('1.21.3') ? {} : 0,
          teleportId: 0
        }
        const movementPackets = ['position', 'position_look', 'look', 'flying']
        let phase = 'play'
        let movementDuringConfig = 0
        server.on('playerJoin', async (client) => {
          const originalWrite = bot._client.write.bind(bot._client)
          bot._client.write = (name, params) => {
            if (phase === 'configuration' && movementPackets.includes(name)) {
              movementDuringConfig++
            }
            return originalWrite(name, params)
          }

          await client.write('login', bot.test.generateLoginPacket())
          const chunk = bot.test.buildChunk()
          chunk.setBlockType(pos, goldId)
          await client.write('map_chunk', generateChunkPacket(chunk))
          await once(bot, 'chunkColumnLoad')
          // The initial position enables physics and movement packets
          const p1 = once(bot, 'forcedMove')
          await client.write('position', positionPacket)
          await p1

          // Wait until the in-flight teleport response has been sent so it is
          // not miscounted, then have the proxy pull the client back into the
          // configuration phase.
          await sleep(100)
          await client.write('start_configuration', {})
          // Confirm the client state actually flipped before observing.
          if (bot._client.state !== 'configuration') {
            await once(bot._client, 'state')
          }
          phase = 'configuration'
          await sleep(500)
          phase = 'play'

          assert.strictEqual(movementDuringConfig, 0,
            `physics loop sent ${movementDuringConfig} movement packet(s) during configuration phase`)
          done()
        })
      })

      it('cancels the delayed respawn teleport reply when a transfer lands inside its delay', function (done) {
        // After a death the reply to the respawn teleport is deferred 1.5 s. A proxy transfer that
        // starts inside that window must not make the timer write a play packet in the
        // configuration state.
        if (!bot.supportFeature('hasConfigurationState')) {
          this.skip()
          return
        }
        const positionPacket = {
          x: 1.5,
          y: 80,
          z: 1.5,
          dx: 0,
          dy: 0,
          dz: 0,
          pitch: 0,
          yaw: 0,
          flags: bot.supportFeature('positionPacketHasBitflags') ? {} : 0,
          teleportId: 0
        }
        const movementPackets = ['position', 'position_look', 'look', 'flying']
        const sent = []
        server.on('playerJoin', async (client) => {
          try {
            await bot.test.pluginsLoaded
            bot._respawnReplyDelayMs = 1500 // the default is 0 from 1.19 on
            const originalWrite = bot._client.write.bind(bot._client)
            bot._client.write = (name, params) => {
              if (movementPackets.includes(name)) sent.push(`${name} in ${bot._client.state}`)
              return originalWrite(name, params)
            }

            await client.write('login', bot.test.generateLoginPacket())
            const chunk = bot.test.buildChunk()
            chunk.setBlockType(pos, goldId)
            await client.write('map_chunk', generateChunkPacket(chunk))
            await once(bot, 'chunkColumnLoad')
            const p1 = once(bot, 'forcedMove')
            await client.write('position', positionPacket)
            await p1

            bot.emit('death')
            sent.length = 0
            await client.write('position', { ...positionPacket, teleportId: 1 })
            await sleep(100)
            await client.write('start_configuration', {})
            if (bot._client.state !== 'configuration') {
              await once(bot._client, 'state')
            }
            // Outlive the 1.5 s reply delay.
            await sleep(1700)

            assert.deepStrictEqual(sent, [], `movement packets written after the transfer began: ${sent.join(', ')}`)
            done()
          } catch (err) {
            done(err)
          }
        })
      })
      it('accepts a configuration-phase resource pack with the real UUID bytes', function () {
        // The accept must carry the pack's real UUID bytes; a uuid-1345 object serializes to
        // 16 zero bytes.
        // The mock server never reaches the configuration phase, so the plugin is driven directly.
        if (!registry.supportFeature('resourcePackUsesUUID')) {
          this.skip()
          return
        }
        const packUuid = '8ef4746b-93b7-3c32-9dcb-b375016c114d'
        const expectedBytes = Buffer.from(packUuid.replace(/-/g, ''), 'hex')
        const serializer = mc.createSerializer({ state: 'configuration', isServer: false, version: supportedVersion })

        const client = new EventEmitter()
        client.state = 'configuration'
        const writes = []
        client.write = (name, params) => { writes.push({ name, params }) }
        const fakeBot = new EventEmitter()
        fakeBot._client = client
        fakeBot.supportFeature = registry.supportFeature.bind(registry)
        require('../lib/plugins/resource_pack')(fakeBot)

        client.emit('add_resource_pack', {
          uuid: packUuid,
          url: 'https://example.invalid/pack.zip',
          hash: '88b406352dc8a335b1050a4bf9577a878c812012',
          forced: false
        })

        const accept = writes.find((w) => w.name === 'resource_pack_receive')
        assert(accept, 'bot should answer the pack during the configuration phase')
        const buf = serializer.createPacketBuffer({ name: accept.name, params: accept.params })
        assert(buf.includes(expectedBytes),
          'resource_pack_receive must carry the pack UUID bytes, not a zero UUID')
      })
    })

    describe('look without a movement packet', () => {
      it('resolves where no packet can carry the turn: before the first teleport, riding, in an unloaded chunk', async function () {
        await new Promise(resolve => {
          server.on('playerJoin', async (client) => {
            await bot.test.pluginsLoaded
            client.write('login', bot.test.generateLoginPacket())
            await once(bot, 'login')
            resolve()
          })
        })
        // no teleport yet: the server has not placed the bot
        await bot.look(1, 0.2)
        await bot.lookAt(vec3(3, 70, 3), true)
        // riding
        const Entity = require('prismarine-entity')(bot.version)
        bot.vehicle = new Entity(90)
        bot.emit('mount')
        await bot.look(2, -0.2)
        await bot.look(2.5, 0.1, true)
        bot.vehicle = null
      })
    })

    describe('tick_end', () => {
      const basePosition = () => ({
        x: 1.5,
        y: 66,
        z: 1.5,
        dx: 0,
        dy: 0,
        dz: 0,
        pitch: 0,
        yaw: 0,
        teleportId: 0,
        flags: bot.registry.version['>=']('1.21.3') ? {} : 0
      })
      it('ends every tick with tick_end on 1.21.2+', function (done) {
        if (!bot.supportFeature('sendsClientTickEndPacket')) return this.skip()
        server.on('playerJoin', (client) => {
          client.write('login', bot.test.generateLoginPacket())
          client.write('position', basePosition())
          let ticks = 0
          client.on('tick_end', () => { if (++ticks === 5) done() })
        })
      })
    })

    describe('world', () => {
      const pos = vec3(1, 65, 1)
      const goldId = 41
      it('switchWorld respawn', (done) => {
        const loginPacket = bot.test.generateLoginPacket()
        let respawnPacket
        if (bot.supportFeature('usesLoginPacket')) {
          loginPacket.worldName = 'minecraft:overworld'
          loginPacket.hashedSeed = [0, 0]
          loginPacket.entityId = 0
          respawnPacket = {
            // 1.19+ the `dimension` filed is a string in respawn packet and undefined in login packet, in previous versions it's same NBT data in login/respawn
            dimension: bot.supportFeature('dimensionDataInCodec') ? 'minecraft:overworld' : loginPacket.dimension,
            worldName: loginPacket.worldName,
            hashedSeed: loginPacket.hashedSeed,
            gamemode: 0,
            previousGamemode: 255,
            isDebug: false,
            isFlat: false,
            copyMetadata: true,
            death: {
              dimensionName: '',
              location: {
                x: 0,
                y: 0,
                z: 0
              }
            }
          }
          if (bot.supportFeature('spawnRespawnWorldDataField')) {
            respawnPacket = {
              worldState: respawnPacket
            }
            respawnPacket.worldState.name = loginPacket.worldName
            respawnPacket.worldState.dimension = loginPacket.dimension
          }
        } else {
          respawnPacket = {
            dimension: 0,
            hashedSeed: [0, 0],
            gamemode: 0,
            levelType: 'default'
          }
        }
        const chunk = bot.test.buildChunk()
        chunk.setBlockType(pos, goldId)
        const chunkPacket = generateChunkPacket(chunk)
        const positionPacket = {
          x: 1.5,
          y: 80,
          z: 1.5,
          pitch: 0,
          yaw: 0,
          flags: 0,
          teleportId: 0
        }
        server.on('playerJoin', async (client) => {
          await bot.test.pluginsLoaded
          bot.once('respawn', () => {
            assert.ok(bot.world.getColumn(0, 0) !== undefined)
            bot.once('respawn', () => {
              assert.ok(bot.world.getColumn(0, 0) === undefined)
              done()
            })
            if (bot.supportFeature('spawnRespawnWorldDataField')) {
              respawnPacket.worldState.name = 'minecraft:nether'
            } else {
              respawnPacket.worldName = 'minecraft:nether'
            }
            if (bot.supportFeature('spawnRespawnWorldDataField')) {
              respawnPacket.worldState.dimension = 1
            } else if (bot.supportFeature('usesLoginPacket')) {
              respawnPacket.dimension.name = 'e'
            } else {
              respawnPacket.dimension = 1
            }
            client.write('respawn', respawnPacket)
          })
          await client.write('login', loginPacket)
          await client.write('map_chunk', chunkPacket)
          await client.write('position', positionPacket)
          await client.write('update_health', {
            health: 20,
            food: 20,
            foodSaturation: 0
          })
          await bot.waitForTicks(1)
          await client.write('respawn', respawnPacket)
        })
      })
    })

    describe('game', () => {
      it('responds to ping / transaction packets', (done) => { // only on 1.17
        server.on('playerJoin', async (client) => {
          if (bot.supportFeature('transactionPacketExists')) {
            const transactionPacket = { windowId: 0, action: 42, accepted: false }
            client.once('transaction', (data, meta) => {
              assert.ok(meta.name === 'transaction')
              assert.ok(data.action === 42)
              assert.ok(data.accepted === true)
              done()
            })
            client.write('transaction', transactionPacket)
          } else {
            client.once('pong', (data) => {
              assert(data.id === 42)
              done()
            })
            client.write('ping', { id: 42 })
          }
        })
      })

      it('window titles are ChatMessages whatever shape the server sends', async () => {
        const Item = require('prismarine-item')(registry)
        // A component title plus the bare-string form third-party servers send.
        const titles = registry.supportFeature('chatPacketsUseNbtComponents')
          ? [nbt.comp({ text: nbt.string('Test Chest') }), nbt.string('Test Chest')]
          : [JSON.stringify({ text: 'Test Chest' }), 'Test Chest']
        const chest = registry.supportFeature('village&pillageInventoryWindows')
          ? { inventoryType: 2 }
          : { inventoryType: 'minecraft:chest', slotCount: 27 }
        const [client] = await once(server, 'playerJoin')
        client.write('login', bot.test.generateLoginPacket())
        for (const [i, windowTitle] of titles.entries()) {
          const windowId = i + 1
          client.write('open_window', { windowId, windowTitle, ...chest })
          client.write('window_items', { windowId, stateId: 0, items: [], carriedItem: Item.toNotch(null) })
          const [window] = await once(bot, 'windowOpen')
          assert.strictEqual(window.id, windowId)
          assert.strictEqual(window.title.constructor.name, 'ChatMessage')
          assert.strictEqual(window.title.toString(), 'Test Chest')
        }
      })

      it('pong is written at the next tick boundary, after the movement packet of the tick that received the ping', function (done) {
        if (bot.supportFeature('transactionPacketExists')) {
          this.skip()
          return
        }
        const movementPackets = ['position', 'position_look', 'look', 'flying']
        server.on('playerJoin', async (client) => {
          try {
            client.write('login', bot.test.generateLoginPacket())
            const chunk = bot.test.buildChunk()
            chunk.setBlockType(vec3(1, 65, 1), 41)
            client.write('map_chunk', generateChunkPacket(chunk))
            await once(bot, 'chunkColumnLoad')
            client.write('position', {
              x: 1.5,
              y: 80,
              z: 1.5,
              dx: 0,
              dy: 0,
              dz: 0,
              pitch: 0,
              yaw: 0,
              flags: bot.supportFeature('positionPacketHasBitflags') ? { x: false, y: false, z: false, yaw: false, pitch: false } : 0,
              teleportId: 0
            })
            await once(bot, 'forcedMove')

            // Falling takes a few ticks to leave the teleport height.
            await bot.waitForTicks(4)

            const seen = []
            client.on('packet', (data, meta) => seen.push({ name: meta.name, data }))

            // The ping is processed inside a tick: after the simulation, before
            // the movement packet carrying this tick's position.
            const { tickY, pingedAt } = await new Promise(resolve => {
              bot.once('physicsTick', () => {
                bot._client.emit('ping', { id: 123 })
                resolve({ tickY: bot.entity.position.y, pingedAt: Date.now() })
              })
            })
            assert.ok(tickY < 80, 'bot must be falling so every tick writes a movement packet')

            const [pong] = await onceWithCleanup(client, 'pong', { timeout: 200 })
            const pongedAt = Date.now()
            assert.strictEqual(pong.id, 123)
            assert.ok(pongedAt - pingedAt <= 200, `pong took ${pongedAt - pingedAt} ms`)

            await sleep(100)
            const pongs = seen.filter(p => p.name === 'pong')
            assert.strictEqual(pongs.length, 1, 'each ping is answered exactly once')
            const pongIndex = seen.indexOf(pongs[0])
            // 1.21.2+ ends the tick with tick_end right behind its movement packet.
            let beforeIndex = pongIndex - 1
            if (seen[beforeIndex]?.name === 'tick_end') beforeIndex--
            const before = seen[beforeIndex]
            assert.ok(before !== undefined, 'a movement packet precedes the pong')
            assert.ok(movementPackets.includes(before.name), `packet before pong is ${before.name}`)
            assert.strictEqual(before.data.y, tickY, 'the pong follows the movement packet of the tick that received the ping')
            done()
          } catch (err) {
            done(err)
          }
        })
      })

      it('pong is written within one tick when physics is not ticking', function (done) {
        if (bot.supportFeature('transactionPacketExists')) {
          this.skip()
          return
        }
        server.on('playerJoin', async (client) => {
          try {
            client.write('login', bot.test.generateLoginPacket())
            await once(bot, 'login')
            const pongs = []
            client.on('pong', (data) => pongs.push(data))
            const pingedAt = Date.now()
            client.write('ping', { id: 123 })
            const [pong] = await onceWithCleanup(client, 'pong', { timeout: 200 })
            const pongedAt = Date.now()
            assert.strictEqual(pong.id, 123)
            assert.ok(pongedAt - pingedAt <= 200, `pong took ${pongedAt - pingedAt} ms`)
            await sleep(100)
            assert.strictEqual(pongs.length, 1, 'each ping is answered exactly once')
            done()
          } catch (err) {
            done(err)
          }
        })
      })

      it('closeWindow follows close_window with a no-op inventory click on pre-1.17 only', (done) => {
        server.on('playerJoin', (client) => {
          const clicks = []
          let closed = false
          client.on('packet', (data, meta) => {
            if (meta.name === 'close_window') closed = true
            if (meta.name !== 'window_click') return
            clicks.push(data)
            assert.ok(closed, 'the sync click must follow close_window')
            client.write('transaction', { windowId: data.windowId, action: data.action, accepted: true })
          })
          const loggedIn = once(bot, 'login')
          client.write('login', bot.test.generateLoginPacket())
          loggedIn
            .then(() => bot.closeWindow(bot.inventory))
            .then(() => sleep(100))
            .then(() => {
              if (bot.supportFeature('stateIdUsed')) {
                assert.strictEqual(clicks.length, 0)
              } else {
                assert.strictEqual(clicks.length, 1)
                assert.strictEqual(clicks[0].windowId, 0)
                assert.strictEqual(clicks[0].slot, -999)
                assert.strictEqual(clicks[0].mode, 0)
                assert.strictEqual(clicks[0].mouseButton, 0)
              }
            })
            .then(done, done)
        })
      })

      it('dimension type lookup uses worldType over worldName on 1.19-1.20.4', function (done) {
        // On proxy/modded servers the worldName (level name) may differ from
        // the dimension type. For versions with dimensionDataInCodec but
        // without segmentedRegistryCodecData (1.19-1.20.4), the bot should
        // prefer worldType (login) / dimension (respawn) for the codec lookup.
        if (!bot.supportFeature('dimensionDataInCodec') || bot.supportFeature('segmentedRegistryCodecData')) {
          this.skip()
          return
        }

        const loginPacket = bot.test.generateLoginPacket()
        // Simulate a proxy/modded server: worldName is a custom level name
        // but worldType is still the real dimension type
        loginPacket.worldName = 'modded:custom_world'
        loginPacket.worldType = 'minecraft:overworld'

        server.on('playerJoin', (client) => {
          client.write('login', loginPacket)
          bot.once('login', () => {
            assert.strictEqual(bot.game.dimension, 'overworld',
              'should use worldType for dimension, not worldName')
            assert.ok(bot.game.minY !== undefined,
              'minY should be set from codec lookup')
            assert.ok(bot.game.height !== undefined,
              'height should be set from codec lookup')
            done()
          })
        })
      })
    })

    describe('rain', () => {
      it('flips isRaining on rain level zero-crossings without start_raining', (done) => {
        // Vanilla 26.1 can bring rain in with only rain_level_change ramps,
        // never sending start_raining/stop_raining (observed on a quick
        // weather flip), so level crossings alone must drive isRaining.
        const mapped = JSON.stringify(registry.protocol.play.toClient.types.packet_game_state_change).includes('rain_level_change')
        const reason = mapped ? 'rain_level_change' : 7
        server.on('playerJoin', (client) => {
          client.write('login', bot.test.generateLoginPacket())
          // Plugins inject after a deferred inject_allowed, so bot state is
          // only readable once the bot has seen login.
          bot.once('login', () => {
            assert.strictEqual(bot.isRaining, false)
            bot.once('rain', () => {
              assert.strictEqual(bot.isRaining, true)
              bot.once('rain', () => {
                assert.strictEqual(bot.isRaining, false)
                assert.strictEqual(bot.rainState, 0)
                done()
              })
              client.write('game_state_change', { reason, gameMode: 0 })
            })
            client.write('game_state_change', { reason, gameMode: 0.01 })
            // A second wet level must not emit again: if it did, the inner
            // once would run with isRaining still true and fail the assert.
            client.write('game_state_change', { reason, gameMode: 0.5 })
          })
        })
      })
    })

    describe('block actions', () => {
      it('emits chestLidMove again once an open chest has been replaced', async () => {
        const pos = vec3(1, 65, 1)
        const chestId = bot.registry.blocksByName.chest.id
        const location = { x: pos.x, y: pos.y, z: pos.z }
        const [client] = await once(server, 'playerJoin')
        client.write('login', bot.test.generateLoginPacket())
        const chunk = bot.test.buildChunk()
        chunk.setBlockType(pos, chestId)
        client.write('map_chunk', generateChunkPacket(chunk))
        await once(bot, 'chunkColumnLoad')
        const chestStateId = bot.blockAt(pos).stateId

        const opened = onceWithCleanup(bot, 'chestLidMove', { timeout: 2000 })
        client.write('block_action', { location, byte1: 1, byte2: 1, blockId: chestId })
        await opened

        // Breaking the chest while it is open never yields a closing block
        // action, so the open count must not survive the block change.
        client.write('block_change', { location, type: 0 })
        client.write('block_change', { location, type: chestStateId })
        const reopened = onceWithCleanup(bot, 'chestLidMove', { timeout: 2000 })
        client.write('block_action', { location, byte1: 1, byte2: 1, blockId: chestId })
        const [block, isOpen] = await reopened
        assert.ok(block.position.equals(pos))
        assert.strictEqual(isOpen, 1)
      })
    })

    describe('abilities', () => {
      it('tracks what the server allows', (done) => {
        server.on('playerJoin', (client) => {
          bot.once('abilities', (abilities) => {
            assert.strictEqual(abilities.invulnerable, true)
            assert.strictEqual(abilities.flying, true)
            assert.strictEqual(abilities.mayFly, true)
            assert.strictEqual(abilities.instantBuild, false)
            assert.strictEqual(abilities.flyingSpeed, 0.05000000074505806)
            assert.strictEqual(abilities.walkingSpeed, 0.10000000149011612)
            assert.strictEqual(bot.abilities, abilities)
            // prismarine-physics reads the flight state off the entity
            assert.strictEqual(bot.entity.flying, true)
            done()
          })
          client.write('login', bot.test.generateLoginPacket())
          bot.once('login', () => {
            // Abilities' own defaults hold until the server sends the packet
            assert.deepStrictEqual(bot.abilities, {
              invulnerable: false,
              flying: false,
              mayFly: false,
              instantBuild: false,
              flyingSpeed: 0.05,
              walkingSpeed: 0.1
            })
            client.write('abilities', { flags: 7, flyingSpeed: 0.05, walkingSpeed: 0.1 })
          })
        })
      })
    })

    describe('entities', () => {
      it('entity id changes on login', (done) => {
        const loginPacket = bot.test.generateLoginPacket()
        server.on('playerJoin', (client) => {
          if (bot.supportFeature('usesLoginPacket')) {
            loginPacket.entityId = 0 // Default login packet in minecraft-data 1.16.5 is 1, so set it to 0
          }
          client.write('login', loginPacket)
          bot.once('login', () => {
            assert.ok(bot.entity.id === 0)
            loginPacket.entityId = 42
            bot.once('login', () => {
              assert.ok(bot.entity.id === 42)
              done()
            })
            client.write('login', loginPacket)
          })
        })
      })

      it('player displayName', (done) => {
        server.on('playerJoin', (client) => {
          bot.on('entitySpawn', (entity) => {
            const player = bot.players[entity.username]
            assert.strictEqual(entity.username, player.displayName.toString())
            if (registry.supportFeature('playerInfoActionIsBitfield')) {
              client.write('player_info', {
                action: { update_display_name: true },
                data: [{
                  uuid: '1-2-3-4',
                  displayName: chatText('wvffle')
                }]
              })
            } else {
              client.write('player_info', {
                action: 'update_display_name',
                data: [{
                  uuid: '1-2-3-4',
                  displayName: chatText('wvffle')
                }]
              })
            }
          })

          bot.once('playerUpdated', (player) => {
            assert.strictEqual('wvffle', player.displayName.toString())
            if (registry.supportFeature('playerInfoActionIsBitfield')) {
              client.write('player_info', {
                action: { update_display_name: true },
                data: [{
                  uuid: '1-2-3-4',
                  displayName: null
                }]
              })
            } else {
              client.write('player_info', {
                action: 'update_display_name',
                data: [{
                  uuid: '1-2-3-4',
                  displayName: null
                }]
              })
            }

            bot.once('playerUpdated', (player) => {
              assert.strictEqual(player.entity.username, player.displayName.toString())
              done()
            })
          })

          if (registry.supportFeature('playerInfoActionIsBitfield')) {
            client.write('player_info', {
              action: { add_player: true },
              data: [{
                uuid: '1-2-3-4',
                player: {
                  name: 'bot5',
                  properties: []
                },
                gamemode: 0,
                latency: 0
              }]
            })
          } else {
            client.write('player_info', {
              action: 'add_player',
              data: [{
                uuid: '1-2-3-4',
                name: 'bot5',
                properties: [],
                gamemode: 0,
                ping: 0
              }]
            })
          }

          if (bot.registry.supportFeature('unifiedPlayerAndEntitySpawnPacket')) {
            client.write('spawn_entity', {
              entityId: 56,
              objectUUID: '1-2-3-4',
              type: bot.registry.entitiesByName.player.internalId,
              x: 1,
              y: 2,
              z: 3,
              pitch: 0,
              yaw: 0,
              headPitch: 0,
              objectData: 1,
              velocity: { x: 0, y: 0, z: 0 }
            })
          } else {
            client.write('named_entity_spawn', {
              entityId: 56,
              playerUUID: '1-2-3-4',
              x: 1,
              y: 2,
              z: 3,
              yaw: 0,
              pitch: 0,
              currentItem: -1,
              metadata: []
            })
          }
        })
      })

      it('does not crash when skin texture is mojangson format', (done) => {
        // Mojangson-style texture data (not valid JSON, but valid mojangson)
        const mojangsonStr = '{textures:{SKIN:{url:"http://textures.minecraft.net/texture/abc123",metadata:{model:"slim"}}}}'
        const mojangsonBase64 = Buffer.from(mojangsonStr).toString('base64')

        server.on('playerJoin', (client) => {
          bot.on('entitySpawn', (entity) => {
            const player = bot.players[entity.username]
            assert.ok(player, 'player should exist')
            assert.ok(player.skinData, 'skinData should be parsed from mojangson')
            assert.strictEqual(player.skinData.url, 'http://textures.minecraft.net/texture/abc123')
            assert.strictEqual(player.skinData.model, 'slim')
            assert.strictEqual(player.skinData.capeUrl, undefined)
            done()
          })

          if (registry.supportFeature('playerInfoActionIsBitfield')) {
            client.write('player_info', {
              action: { add_player: true },
              data: [{
                uuid: '1-2-3-4',
                player: {
                  name: 'bot5',
                  properties: [{
                    name: 'textures',
                    value: mojangsonBase64,
                    signature: ''
                  }]
                },
                gamemode: 0,
                latency: 0
              }]
            })
          } else {
            client.write('player_info', {
              action: 'add_player',
              data: [{
                uuid: '1-2-3-4',
                name: 'bot5',
                properties: [{
                  name: 'textures',
                  value: mojangsonBase64,
                  signature: ''
                }],
                gamemode: 0,
                ping: 0
              }]
            })
          }

          if (bot.registry.supportFeature('unifiedPlayerAndEntitySpawnPacket')) {
            client.write('spawn_entity', {
              entityId: 56,
              objectUUID: '1-2-3-4',
              type: bot.registry.entitiesByName.player.internalId,
              x: 1,
              y: 2,
              z: 3,
              pitch: 0,
              yaw: 0,
              headPitch: 0,
              objectData: 1,
              velocity: { x: 0, y: 0, z: 0 },
              velocityX: 0,
              velocityY: 0,
              velocityZ: 0
            })
          } else {
            client.write('named_entity_spawn', {
              entityId: 56,
              playerUUID: '1-2-3-4',
              x: 1,
              y: 2,
              z: 3,
              yaw: 0,
              pitch: 0,
              currentItem: -1,
              metadata: []
            })
          }
        })
      })

      it('does not crash when skin texture is valid JSON', (done) => {
        const validJson = JSON.stringify({
          textures: {
            SKIN: {
              url: 'http://textures.minecraft.net/texture/def456',
              metadata: { model: 'default' }
            },
            CAPE: {
              url: 'http://textures.minecraft.net/texture/cape789'
            }
          }
        })
        const jsonBase64 = Buffer.from(validJson).toString('base64')

        server.on('playerJoin', (client) => {
          bot.on('entitySpawn', (entity) => {
            const player = bot.players[entity.username]
            assert.ok(player, 'player should exist')
            assert.ok(player.skinData, 'skinData should be parsed from JSON')
            assert.strictEqual(player.skinData.url, 'http://textures.minecraft.net/texture/def456')
            assert.strictEqual(player.skinData.model, 'default')
            assert.strictEqual(player.skinData.capeUrl, 'http://textures.minecraft.net/texture/cape789')
            done()
          })

          if (registry.supportFeature('playerInfoActionIsBitfield')) {
            client.write('player_info', {
              action: { add_player: true },
              data: [{
                uuid: '1-2-3-4',
                player: {
                  name: 'bot6',
                  properties: [{
                    name: 'textures',
                    value: jsonBase64,
                    signature: ''
                  }]
                },
                gamemode: 0,
                latency: 0
              }]
            })
          } else {
            client.write('player_info', {
              action: 'add_player',
              data: [{
                uuid: '1-2-3-4',
                name: 'bot6',
                properties: [{
                  name: 'textures',
                  value: jsonBase64,
                  signature: ''
                }],
                gamemode: 0,
                ping: 0
              }]
            })
          }

          if (bot.registry.supportFeature('unifiedPlayerAndEntitySpawnPacket')) {
            client.write('spawn_entity', {
              entityId: 57,
              objectUUID: '1-2-3-4',
              type: bot.registry.entitiesByName.player.internalId,
              x: 1,
              y: 2,
              z: 3,
              pitch: 0,
              yaw: 0,
              headPitch: 0,
              objectData: 1,
              velocity: { x: 0, y: 0, z: 0 },
              velocityX: 0,
              velocityY: 0,
              velocityZ: 0
            })
          } else {
            client.write('named_entity_spawn', {
              entityId: 57,
              playerUUID: '1-2-3-4',
              x: 1,
              y: 2,
              z: 3,
              yaw: 0,
              pitch: 0,
              currentItem: -1,
              metadata: []
            })
          }
        })
      })

      it('sets players[player].entity to null upon despawn', (done) => {
        let serverClient = null
        bot.once('entitySpawn', (entity) => {
          if (bot.version !== '1.17') {
            serverClient.write('entity_destroy', {
              entityIds: [8]
            })
          } else {
            serverClient.write('destroy_entity', {
              entityIds: 8
            })
          }
        })
        bot.once('entityGone', (entity) => {
          assert.strictEqual(bot.players[entity.username], undefined)
          done()
        })
        server.on('playerJoin', (client) => {
          serverClient = client

          if (registry.supportFeature('playerInfoActionIsBitfield')) {
            client.write('player_info', {
              action: { add_player: true },
              data: [{
                uuid: '1-2-3-4',
                player: { name: 'bot5', properties: [] },
                gamemode: 0,
                latency: 0
              }]
            })
          } else {
            client.write('player_info', {
              id: 56,
              state: 'play',
              action: 'add_player',
              length: 1,
              data: [{
                uuid: '1-2-3-4',
                name: 'bot5',
                propertiesLength: 0,
                properties: [],
                gamemode: 0,
                ping: 0,
                hasDisplayName: false
              }]
            })
          }

          if (bot.registry.supportFeature('unifiedPlayerAndEntitySpawnPacket')) {
            client.write('spawn_entity', {
              entityId: 56,
              objectUUID: '1-2-3-4',
              type: bot.registry.entitiesByName.player.internalId,
              x: 1,
              y: 2,
              z: 3,
              pitch: 0,
              yaw: 0,
              headPitch: 0,
              objectData: 1,
              velocity: { x: 0, y: 0, z: 0 }
            })
          } else {
            client.write('named_entity_spawn', {
              entityId: 56,
              playerUUID: '1-2-3-4',
              x: 1,
              y: 2,
              z: 3,
              yaw: 0,
              pitch: 0,
              currentItem: -1,
              metadata: []
            })
          }
        })
      })

      it('metadata', (done) => {
        server.on('playerJoin', (client) => {
          bot.on('entitySpawn', (entity) => {
            assert.strictEqual(entity.displayName, 'Creeper')

            const lastMeta = entity.metadata
            bot.on('entityUpdate', (entity) => {
              assert.ok('0' in entity.metadata)
              assert.strictEqual(entity.metadata[0], 1)
              assert.strictEqual(entity.metadata[1], lastMeta[1])
              done()
            })

            client.write('entity_metadata', {
              entityId: 8,
              metadata: [
                { key: 0, type: bot.registry.supportFeature('mcDataHasEntityMetadata') ? 'int' : 0, value: 1 }
              ]
            })
          })

          // Versions prior to 1.11 have capital first letter
          const entities = bot.registry.entitiesByName
          const creeperId = entities.creeper ? entities.creeper.id : entities.Creeper.id
          client.write(bot.registry.supportFeature('consolidatedEntitySpawnPacket') ? 'spawn_entity' : 'spawn_entity_living', {
            entityId: 8, // random
            entityUUID: '00112233-4455-6677-8899-aabbccddeeff',
            objectUUID: '00112233-4455-6677-8899-aabbccddeeff',
            type: creeperId,
            x: 10,
            y: 11,
            z: 12,
            yaw: 13,
            pitch: 14,
            headPitch: 14,
            velocity: { x: 15, y: 16, z: 17 },
            metadata: [
              { type: 0, key: bot.registry.supportFeature('mcDataHasEntityMetadata') ? 'byte' : 0, value: 0 },
              { type: 0, key: bot.registry.supportFeature('mcDataHasEntityMetadata') ? 'int' : 1, value: 1 }
            ]
          })
        })
      })

      it('only updates oxygen level from bot metadata', function (done) {
        if (!bot.registry.supportFeature('mcDataHasEntityMetadata')) this.skip()

        server.on('playerJoin', (client) => {
          client.write('login', bot.test.generateLoginPacket())
          bot.once('login', () => {
            bot.oxygenLevel = 20
            let breathEvents = 0
            bot.on('breath', () => { breathEvents++ })

            bot.once('entitySpawn', (entity) => {
              const airSupplyKey = bot.registry.entitiesByName[entity.name].metadataKeys.indexOf('air_supply')
              bot._client.once('entity_metadata', () => {
                try {
                  assert.strictEqual(bot.oxygenLevel, 20)
                  assert.strictEqual(breathEvents, 0)

                  bot.once('breath', () => {
                    try {
                      assert.strictEqual(bot.oxygenLevel, 10)
                      assert.strictEqual(breathEvents, 1)
                      done()
                    } catch (err) {
                      done(err)
                    }
                  })
                  client.write('entity_metadata', {
                    entityId: bot.entity.id,
                    metadata: [{ key: airSupplyKey, type: 'int', value: 150 }]
                  })
                } catch (err) {
                  done(err)
                }
              })
              client.write('entity_metadata', {
                entityId: entity.id,
                metadata: [{ key: airSupplyKey, type: 'int', value: 15 }]
              })
            })

            const cowId = bot.registry.entitiesByName.cow.id
            client.write(bot.registry.supportFeature('consolidatedEntitySpawnPacket') ? 'spawn_entity' : 'spawn_entity_living', {
              entityId: 8,
              entityUUID: '00112233-4455-6677-8899-aabbccddeeff',
              objectUUID: '00112233-4455-6677-8899-aabbccddeeff',
              type: cowId,
              x: 10,
              y: 11,
              z: 12,
              yaw: 13,
              pitch: 14,
              headPitch: 14,
              velocity: { x: 0, y: 0, z: 0 }
            })
          })
        })
      })

      it('\'itemDrop\' event', function (done) {
        const itemData = {
          itemId: 149,
          itemCount: 5
        }

        server.on('playerJoin', (client) => {
          bot.on('itemDrop', (entity) => {
            const slotPosition = metadataPacket.metadata[0].key

            if (bot.supportFeature('itemsAreAlsoBlocks')) {
              assert.strictEqual(entity.metadata[slotPosition].blockId, itemData.itemId)
            } else if (bot.supportFeature('itemsAreNotBlocks')) {
              assert.strictEqual(entity.metadata[slotPosition].itemId, itemData.itemId)
            }
            assert.strictEqual(entity.metadata[slotPosition].itemCount, itemData.itemCount)

            done()
          })

          let entityType
          if (['1.8', '1.9', '1.10', '1.11', '1.12'].includes(bot.majorVersion)) {
            entityType = 2
          } else {
            entityType = bot.registry.entitiesArray.find(e => e.name.toLowerCase() === 'item' || e.name.toLowerCase() === 'item_stack').id
          }
          client.write('spawn_entity', {
            entityId: 16,
            objectUUID: '00112233-4455-6677-8899-aabbccddeeff',
            type: Number(entityType),
            x: 0,
            y: 0,
            z: 0,
            pitch: 0,
            yaw: 0,
            headPitch: 0,
            objectData: 1,
            velocity: { x: 0, y: 0, z: 0 }
          })

          const metadataPacket = {
            entityId: 16,
            metadata: [
              { key: 7, type: 6, value: { itemCount: itemData.itemCount } }
            ]
          }
          // Versions prior to 1.13 use 5 as type field value of metadata for storing a slot. 1.13 and so on, use 6
          // Also the structure of a slot changes from 1.12 to 1.13
          if (bot.supportFeature('itemsAreAlsoBlocks')) {
            metadataPacket.metadata[0].key = 6
            metadataPacket.metadata[0].type = 5
            metadataPacket.metadata[0].value.blockId = itemData.itemId
            metadataPacket.metadata[0].value.itemDamage = 0
          } else if (bot.supportFeature('itemsAreNotBlocks')) {
            if (bot.majorVersion === '1.13') metadataPacket.metadata[0].key = 6
            metadataPacket.metadata[0].value.itemId = itemData.itemId
            metadataPacket.metadata[0].value.present = true
          }

          if (bot.supportFeature('entityMetadataHasLong')) {
            metadataPacket.metadata[0].type = 7
          }

          if (bot.registry.supportFeature('mcDataHasEntityMetadata')) {
            metadataPacket.metadata[0].type = 'item_stack'
          }
          metadataPacket.metadata[0].value.addedComponentCount = 0
          metadataPacket.metadata[0].value.removedComponentCount = 0
          metadataPacket.metadata[0].value.components = []
          metadataPacket.metadata[0].value.removeComponents = []

          client.write('entity_metadata', metadataPacket)
        })
      })
    })

    it('bed', (done) => {
      const blocks = bot.registry.blocksByName
      const entities = bot.registry.entitiesByName

      const playerPos = vec3(10, 0, 0)
      const zombiePos = vec3(0, 0, 0)
      const beds = [
        { head: vec3(10, 0, 3), foot: vec3(10, 0, 2), facing: 2, throws: false },
        { head: vec3(9, 0, 4), foot: vec3(10, 0, 4), facing: 3, throws: true, error: new Error('the bed is too far') },
        { head: vec3(8, 0, 0), foot: vec3(8, 0, 1), facing: 0, throws: true, error: new Error('there are monsters nearby') },
        { head: vec3(12, 0, 0), foot: vec3(11, 0, 0), facing: 1, throws: false }
      ]

      const zombieId = entities.zombie ? entities.zombie.id : entities.Zombie.id
      let bedBlock
      if (bot.supportFeature('oneBlockForSeveralVariations', version.majorVersion)) {
        bedBlock = blocks.bed
      } else if (bot.supportFeature('blockSchemeIsFlat', version.majorVersion)) {
        bedBlock = blocks.red_bed
      }
      const bedId = bedBlock.id

      bot.once('chunkColumnLoad', (columnPoint) => {
        for (const bed in beds) {
          const bedBock = bot.blockAt(beds[bed].foot)
          const bedBockMetadata = bot.parseBedMetadata(bedBock)
          assert.strictEqual(bedBockMetadata.facing, beds[bed].facing, 'The facing property seems to be wrong')
          assert.strictEqual(bedBockMetadata.part, false, 'The part property seems to be wrong') // Is the foot

          if (beds[bed].throws) {
            bot.sleep(bedBock).catch(err => assert.strictEqual(err, beds[bed].error))
          } else {
            bot.sleep(bedBock).catch(err => assert.ifError(err))
          }
        }

        done()
      })

      server.once('playerJoin', (client) => {
        const loginPacket = bot.test.generateLoginPacket()
        client.write('login', loginPacket)
        // Set timeOfDay after login is processed so bot.time is initialized
        bot.once('login', () => { bot.time.timeOfDay = 18000 })

        const chunk = bot.test.buildChunk()

        for (const bed in beds) {
          chunk.setBlockType(beds[bed].head, bedId)
          chunk.setBlockType(beds[bed].foot, bedId)
        }

        if (bot.supportFeature('blockStateId', version.majorVersion)) {
          chunk.setBlockStateId(beds[0].foot, 3 + bedBlock.minStateId) // { facing: north, occupied: false, part: foot }
          chunk.setBlockStateId(beds[0].head, 2 + bedBlock.minStateId) // { facing:north, occupied: false, part: head }

          chunk.setBlockStateId(beds[1].foot, 15 + bedBlock.minStateId) // { facing: east, occupied:false, part:foot }
          chunk.setBlockStateId(beds[1].head, 14 + bedBlock.minStateId) // { facing: east, occupied: false, part: head }

          chunk.setBlockStateId(beds[2].foot, 7 + bedBlock.minStateId) // { facing: south, occupied: false, part: foot }
          chunk.setBlockStateId(beds[2].head, 6 + bedBlock.minStateId) // { facing: south, occupied: false, part: head }

          chunk.setBlockStateId(beds[3].foot, 11 + bedBlock.minStateId) // { facing: west, occupied: false, part: foot }
          chunk.setBlockStateId(beds[3].head, 10 + bedBlock.minStateId) // { facing: west, occupied: false, part: head }
        } else if (bot.supportFeature('blockMetadata', version.majorVersion)) {
          chunk.setBlockData(beds[0].foot, 2) // { facing: north, occupied: false, part: foot }
          chunk.setBlockData(beds[0].head, 10) // { facing:north, occupied: false, part: head }

          chunk.setBlockData(beds[1].foot, 3) // { facing: east, occupied:false, part:foot }
          chunk.setBlockData(beds[1].head, 11) // { facing: east, occupied: false, part: head }

          chunk.setBlockData(beds[2].foot, 0) // { facing: south, occupied: false, part: foot }
          chunk.setBlockData(beds[2].head, 8) // { facing: south, occupied: false, part: head }

          chunk.setBlockData(beds[3].foot, 1) // { facing: west, occupied: false, part: foot }
          chunk.setBlockData(beds[3].head, 9) // { facing: west, occupied: false, part: head }
        }

        client.write('position', {
          x: playerPos.x,
          y: playerPos.y,
          z: playerPos.z,
          yaw: 0,
          pitch: 0,
          flags: 0,
          teleportId: 1
        })

        client.write(bot.registry.supportFeature('consolidatedEntitySpawnPacket') ? 'spawn_entity' : 'spawn_entity_living', {
          entityId: 8,
          entityUUID: '00112233-4455-6677-8899-aabbccddeeff',
          objectUUID: '00112233-4455-6677-8899-aabbccddeeff',
          type: zombieId,
          x: zombiePos.x,
          y: zombiePos.y,
          z: zombiePos.z,
          yaw: 0,
          pitch: 0,
          headPitch: 0,
          velocity: { x: 0, y: 0, z: 0 },
          metadata: []
        })

        client.write('map_chunk', generateChunkPacket(chunk))
      })
    })

    describe('activateBlock', () => {
      it('defaults the cursor to the centre of the clicked face and swings after use_item_on', (done) => {
        server.on('playerJoin', async (client) => {
          await bot.test.pluginsLoaded
          const loggedIn = once(bot, 'login')
          await client.write('login', bot.test.generateLoginPacket())
          await loggedIn
          bot.lookAt = async () => {}
          const writes = []
          bot._client.write = (name, params) => { writes.push({ name, params }) }
          const block = { position: vec3(1, 65, 1) }
          await bot.activateBlock(block, vec3(0, 1, 0))
          await bot.activateBlock(block, vec3(-1, 0, 0))
          writes.splice(0, writes.length, ...writes.filter(w => !TICK_PACKETS.includes(w.name)))
          try {
            const scale = bot.supportFeature('blockPlaceHasHandAndFloatCursor') || bot.supportFeature('blockPlaceHasInsideBlock') ? 1 : 16
            assert.deepStrictEqual(writes.map(w => w.name), ['block_place', 'arm_animation', 'block_place', 'arm_animation'])
            const cursor = ({ params }) => [params.cursorX / scale, params.cursorY / scale, params.cursorZ / scale, params.direction]
            assert.deepStrictEqual(cursor(writes[0]), [0.5, 1, 0.5, 1])
            assert.deepStrictEqual(cursor(writes[2]), [0, 0.5, 0.5, 4])
            done()
          } catch (err) {
            done(err)
          }
        })
      })
    })

    describe('vanilla interact', () => {
      const Item = require('prismarine-item')(supportedVersion)
      const pWindows = require('prismarine-windows')(supportedVersion)
      const chestData = pWindows.windows['minecraft:generic_9x3'] ?? { type: 'minecraft:chest', slots: 63 }
      const hasSequence = registry.version['>=']('1.19') // block_place carries a sequence number since 1.19

      // Stone floor at y = 64, the bot standing at (1.5, 65, 4.5), a chest at (1, 65, 2) and a stone block buried at (1, 63, 2)
      const chestPos = vec3(1, 65, 2)
      const buriedPos = vec3(1, 63, 2)
      async function joinWithWorld (onBlockPlace) {
        const chunk = bot.test.buildChunk()
        for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) chunk.setBlockType(vec3(x, 64, z), registry.blocksByName.stone.id)
        chunk.setBlockType(vec3(1, 63, 2), registry.blocksByName.stone.id)
        chunk.setBlockType(chestPos, registry.blocksByName.chest.id)
        const received = []
        await new Promise(resolve => {
          server.on('playerJoin', async (client) => {
            await bot.test.pluginsLoaded
            client.write('login', bot.test.generateLoginPacket())
            client.write('map_chunk', generateChunkPacket(chunk))
            client.write('position', {
              x: 1.5,
              y: 65,
              z: 4.5,
              dx: 0,
              dy: 0,
              dz: 0,
              yaw: 0,
              pitch: 0,
              flags: bot.registry.version['>=']('1.21.3') ? {} : 0,
              teleportId: 0
            })
            client.on('packet', (data, meta) => {
              received.push({ name: meta.name, data, at: Date.now() })
              if (meta.name === 'block_place' && onBlockPlace) onBlockPlace(client, data)
            })
            await once(bot, 'chunkColumnLoad')
            await sleep(300) // lands on the floor
            resolve()
          })
        })
        return received
      }

      it('clickBlock reports the face and point the ray-cast hits, after turning, with a sequence number', async function () {
        if (!hasSequence) return this.skip()
        const received = await joinWithWorld()
        const block = bot.blockAt(chestPos)

        const result = await bot.vanilla.clickBlock(block)
        await sleep(200)
        assert.strictEqual(result.ok, true)
        const click = received.find(p => p.name === 'block_place')
        assert.ok(click, 'no block_place packet')
        // the south face is the one an eye at z = 4.5 can see; a chest is 14/16 wide, so that face is at 15/16
        assert.strictEqual(click.data.direction, 3)
        assert.ok([0, 'main_hand'].includes(click.data.hand))
        assert.ok(click.data.sequence > 0, 'a predicted action carries a sequence number')
        assert.ok(Math.abs(click.data.cursorZ - 0.9375) < 1e-9, `cursorZ ${click.data.cursorZ} must lie on the south face`)
        for (const c of [click.data.cursorX, click.data.cursorY]) assert.ok(c >= 0 && c <= 1)
        assert.deepStrictEqual(received.slice(received.indexOf(click), received.indexOf(click) + 2).map(p => p.name), ['block_place', 'arm_animation'])

        // the rotation the bot ended with really points at the reported point
        const eye = bot.entity.position.offset(0, bot.entity.eyeHeight, 0)
        const { yaw, pitch } = bot.entity
        const dir = vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
        const reported = chestPos.offset(click.data.cursorX, click.data.cursorY, click.data.cursorZ)
        const t = (reported.z - eye.z) / dir.z
        assert.ok(eye.plus(dir.scaled(t)).distanceTo(reported) < 1e-6, 'rotation does not hit the reported point')
        // and the rotation reached the server before the click (a turn sent with, or after, the click is not vanilla)
        const lastLook = received.slice(0, received.indexOf(click)).reverse().find(p => ['look', 'position_look'].includes(p.name))
        assert.ok(lastLook, 'no rotation was sent before the click')
        const { toNotchianYaw, toNotchianPitch } = require('../lib/conversions')
        assert.ok(Math.abs(lastLook.data.yaw - toNotchianYaw(yaw)) < 0.01 && Math.abs(lastLook.data.pitch - toNotchianPitch(pitch)) < 0.01,
          `the click was sent with the server at ${lastLook.data.yaw}/${lastLook.data.pitch}, not at the aim`)

        // a second click gets a higher sequence number
        await bot.vanilla.clickBlock(block)
        await sleep(100)
        const clicks = received.filter(p => p.name === 'block_place')
        assert.ok(clicks[1].data.sequence > clicks[0].data.sequence)
      })

      it('clickBlock and activateBlock refuse a block that is out of reach or not visible', async function () {
        if (!hasSequence) return this.skip()
        const received = await joinWithWorld()

        assert.deepStrictEqual(await bot.vanilla.clickBlock(bot.blockAt(vec3(1, 65, 12))), { ok: false, reason: 'too-far' })
        // under the floor: within reach once the reach is raised, but the floor is in the way
        assert.deepStrictEqual(await bot.vanilla.clickBlock(bot.blockAt(buriedPos), { reach: 6 }), { ok: false, reason: 'no-sight' })
        await assert.rejects(bot.activateBlock(bot.blockAt(vec3(1, 65, 12))), err => err.code === 'too-far')
        await sleep(100)
        assert.strictEqual(received.filter(p => p.name === 'block_place').length, 0)
      })

      it('activateBlock with an explicit face keeps that face', async function () {
        if (!hasSequence) return this.skip()
        const received = await joinWithWorld()
        await bot.activateBlock(bot.blockAt(chestPos), vec3(1, 0, 0), vec3(1, 0.25, 0.75))
        await sleep(100)
        const click = received.find(p => p.name === 'block_place')
        assert.strictEqual(click.data.direction, 5)
        assert.deepStrictEqual([click.data.cursorX, click.data.cursorY, click.data.cursorZ], [1, 0.25, 0.75])
      })

      it('openContainer keeps containerSpacingMs between opens and closes the previous window', async function () {
        if (!hasSequence) return this.skip()
        let windowId = 0
        const received = await joinWithWorld((client) => {
          windowId++
          client.write('open_window', { windowId, inventoryType: chestData.type, windowTitle: chatText(''), slotCount: chestData.slots - 36, entityId: 0 })
          client.write('window_items', {
            windowId,
            stateId: 1,
            items: Array.from({ length: chestData.slots }, () => Item.toNotch(null)),
            carriedItem: Item.toNotch(null)
          })
        })
        bot.vanilla.options.containerSpacingMs = 600
        const block = bot.blockAt(chestPos)

        const first = await bot.openContainer(block)
        const firstOpenedAt = Date.now()
        const second = await bot.vanilla.openContainer(block)
        const gap = Date.now() - firstOpenedAt
        assert.ok(gap >= 590, `second window opened ${gap} ms after the first`)
        assert.notStrictEqual(first, second)
        assert.strictEqual(typeof second.close, 'function', 'the window is extended like openBlock\'s')
        const names = received.map(p => p.name)
        assert.ok(names.indexOf('close_window') > names.indexOf('block_place'), 'the first window is closed before the next open')
        assert.strictEqual(names.lastIndexOf('block_place') > names.indexOf('close_window'), true)
      })

      it('openContainer times out with the replies the server sent', async function () {
        if (!hasSequence) return this.skip()
        await joinWithWorld((client, data) => client.write('acknowledge_player_digging', { sequenceId: data.sequence }))
        bot.vanilla.options.openTimeoutMs = 300
        await assert.rejects(bot.vanilla.openContainer(bot.blockAt(chestPos)), err => {
          assert.strictEqual(err.code, 'timeout')
          assert.match(err.message, /no window within 0\.3 s \(server sent: ack \d+\)/)
          return true
        })
      })

      it('options can be overridden through createBot', () => {
        const other = mineflayer.createBot({ username: 'other', version: supportedVersion, port: PORT, vanilla: { interact: { reach: 4.5, clickGapMs: 10 } } })
        return new Promise(resolve => other.once('inject_allowed', () => {
          // plugins are injected on the next timer tick
          setTimeout(() => {
            assert.deepStrictEqual(other.vanilla.options, { reach: 4.5, settleTicks: 2, containerSpacingMs: 1500, openTimeoutMs: 8000, clickGapMs: 10 })
            other.end()
            resolve()
          }, 10)
        }))
      })
    })

    describe('swap hands', () => {
      it('swapHands writes block_dig status SWAP_ITEM_WITH_OFFHAND (6, 7 on 26.3) with sequence 0', async function () {
        if (bot.supportFeature('doesntHaveOffHandSlot')) return this.skip()
        server.on('playerJoin', (client) => client.write('login', bot.test.generateLoginPacket()))
        await once(bot, 'login')
        await bot.test.pluginsLoaded
        const writes = []
        bot._client.write = (name, params) => { writes.push({ name, params }) }
        bot._nextSequence() // vanilla numbers predicted actions only: the counter has moved on, swap hands stays 0
        const swapped = bot.vanilla.swapHands()
        assert.strictEqual(writes.filter(w => w.name === 'block_dig').length, 0, 'the swap waits for the next tick')
        await swapped
        const dig = writes.filter(w => w.name === 'block_dig')
        assert.strictEqual(dig.length, 1)
        assert.strictEqual(dig[0].params.status, 6 + statusShift)
        if (hasSequenceField()) assert.strictEqual(dig[0].params.sequence, 0)
      })

      it('offhandFromHotbar selects the slot, swaps hands and selects the previous slot again', async function () {
        // the offhand predates the totem in the data (1.9 - 1.11.2)
        if (bot.supportFeature('doesntHaveOffHandSlot') || !registry.itemsByName.totem_of_undying) return this.skip()
        server.on('playerJoin', (client) => client.write('login', bot.test.generateLoginPacket()))
        await once(bot, 'login')
        await bot.test.pluginsLoaded
        bot.quickBarSlot = 0 // the server selects a slot on join
        bot.inventory.updateSlot(bot.QUICK_BAR_START + 3, new Item(registry.itemsByName.totem_of_undying.id, 1))
        const writes = []
        bot._client.write = (name, params) => { writes.push({ name, params }) }
        const found = await bot.vanilla.offhandFromHotbar(item => item.name === 'totem_of_undying')
        const relevant = writes.filter(w => ['held_item_slot', 'block_dig'].includes(w.name))
        assert.strictEqual(found, true)
        assert.deepStrictEqual(relevant.map(w => [w.name, w.params.slotId ?? w.params.status]), [['held_item_slot', 3], ['block_dig', 6 + statusShift], ['held_item_slot', 0]])
        assert.strictEqual(await bot.vanilla.offhandFromHotbar(item => item.name === 'diamond'), false)
      })

      function hasSequenceField () {
        return registry.version['>=']('1.19')
      }
    })

    describe('chunks of the newest versions', () => {
      // 1.18+ sections written by hand from the wire format, not by prismarine-chunk: 26.2 and 26.3 have no chunk
      // class of their own (lib/mcdata/overlay.js lends them pc/1.18), and 26.3 has more block states than 15 bits
      const hasChunkFormat = registry.version['>=']('1.18')
      const sizePrefixed = registry.version['<']('1.21.5') // the paletted container's data array carries its length
      const fluidCounted = registry.version['>=']('26.1') // each section starts with a block count and a fluid count
      const maxState = registry.blocksArray.reduce((m, b) => Math.max(m, b.maxStateId), 0)
      const directBits = Math.ceil(Math.log2(maxState + 1)) // vanilla: ceillog2 of the block state registry size
      const lastBlock = registry.blocksArray[registry.blocksArray.length - 1]
      const topStateBlock = registry.blocksArray.find(b => b.maxStateId === maxState)
      const minY = -64
      const sections = 24

      const varint = (n) => {
        const out = []
        do {
          let b = n & 0x7f
          n >>>= 7
          if (n) b |= 0x80
          out.push(b)
        } while (n)
        return Buffer.from(out)
      }
      // values packed without spanning longs: floor(64 / bits) per long, first value in the low bits
      function packed (values, bits) {
        const perLong = Math.floor(64 / bits)
        const out = Buffer.alloc(Math.ceil(values.length / perLong) * 8)
        values.forEach((value, i) => {
          const at = Math.floor(i / perLong) * 8
          out.writeBigUInt64BE(out.readBigUInt64BE(at) | (BigInt(value) << BigInt((i % perLong) * bits)), at)
        })
        return Buffer.concat([sizePrefixed ? varint(out.length / 8) : Buffer.alloc(0), out])
      }
      // One section from 4096 block state ids (index = y * 256 + z * 16 + x), with a single-value biome container
      function section (states) {
        const nonAir = states.filter(s => s !== 0).length
        const head = Buffer.alloc(fluidCounted ? 4 : 2)
        head.writeInt16BE(nonAir)
        const unique = [...new Set(states)]
        let blocks
        if (unique.length === 1) {
          blocks = Buffer.concat([Buffer.from([0]), varint(unique[0]), sizePrefixed ? varint(0) : Buffer.alloc(0)])
        } else if (unique.length <= 256) {
          const bits = Math.max(4, Math.ceil(Math.log2(unique.length)))
          blocks = Buffer.concat([Buffer.from([bits]), varint(unique.length), ...unique.map(varint), packed(states.map(s => unique.indexOf(s)), bits)])
        } else {
          blocks = Buffer.concat([Buffer.from([directBits]), packed(states, directBits)])
        }
        const biomes = Buffer.concat([Buffer.from([0]), varint(0), sizePrefixed ? varint(0) : Buffer.alloc(0)])
        return Buffer.concat([head, blocks, biomes])
      }
      const index = (x, y, z) => y * 256 + z * 16 + x

      // what the world holds: a few states in section 4, every state kind in section 5, stone in section 6
      const spots = [
        [vec3(1, 2, 3), lastBlock.defaultState],
        [vec3(15, 15, 15), maxState],
        [vec3(0, 0, 0), registry.blocksByName.stone.defaultState],
        [vec3(7, 8, 9), registry.blocksByName.dirt.defaultState]
      ]
      const mixed = Array.from({ length: 4096 }, (_, i) => (i * 37 + 11) % (maxState + 1))
      mixed[100] = maxState
      mixed[4000] = lastBlock.maxStateId
      const few = new Array(4096).fill(0)
      for (const [p, state] of spots) few[index(p.x, p.y, p.z)] = state
      const stone = new Array(4096).fill(registry.blocksByName.stone.defaultState)
      const air = new Array(4096).fill(0)
      const world = Array.from({ length: sections }, (_, i) => i === 4 ? few : i === 5 ? mixed : i === 6 ? stone : air)

      const emptyMask = version['>=']('26.3') ? Buffer.alloc(0) : []
      async function join (chunkPacket) {
        await new Promise(resolve => {
          server.on('playerJoin', async (client) => {
            await bot.test.pluginsLoaded
            client.write('login', bot.test.generateLoginPacket())
            client.write('map_chunk', chunkPacket)
            await once(bot, 'chunkColumnLoad')
            resolve()
          })
        })
      }
      const rawChunk = (chunkData, rest) => ({
        x: 0,
        z: 0,
        heightmaps: { type: 'compound', name: '', value: { MOTION_BLOCKING: { type: 'longArray', value: new Array(37).fill([0, 0]) } } },
        chunkData,
        blockEntities: [],
        skyLightMask: emptyMask,
        blockLightMask: emptyMask,
        emptySkyLightMask: emptyMask,
        emptyBlockLightMask: emptyMask,
        skyLight: [],
        blockLight: [],
        ...rest
      })

      it('the world height comes from the dimension codec of the login packet', async function () {
        if (!hasChunkFormat) return this.skip()
        server.on('playerJoin', (client) => client.write('login', bot.test.generateLoginPacket()))
        await once(bot, 'login')
        const types = registry.loginPacket.dimensionCodec?.['minecraft:dimension_type']?.entries
        if (!types) return this.skip() // before 1.20.5 the codec is one NBT compound
        const overworld = nbt.simplify(nbt.comp(Object.fromEntries(types.map(e => [e.key, e.value]))))['minecraft:overworld']
        assert.strictEqual(bot.game.minY, overworld.min_y)
        assert.strictEqual(bot.game.height, overworld.height)
        assert.strictEqual(bot.game.height >> 4, sections)
        // the chunk reader sizes its biome palette from the biome data: it has to match the registry the server sends
        // (minecraft-data's 1.21.4 login packet is older than its biomes, so only the newest versions are compared)
        if (registry.version['>=']('26.1')) assert.strictEqual(registry.loginPacket.dimensionCodec['minecraft:worldgen/biome'].entries.length, registry.biomesArray.length)
      })

      it('prismarine-chunk reads the hand-written sections and writes them back readable', function () {
        if (!hasChunkFormat) return this.skip()
        const first = bot.test.buildChunk()
        first.load(Buffer.concat(world.map(section)))
        const second = bot.test.buildChunk()
        second.load(first.dump())
        let differing = 0
        world.forEach((states, s) => {
          for (let i = 0; i < 4096; i++) {
            const at = vec3(i & 15, minY + s * 16 + (i >> 8), (i >> 4) & 15)
            if (first.getBlockStateId(at) !== states[i] || second.getBlockStateId(at) !== states[i]) differing++
          }
        })
        assert.strictEqual(differing, 0)
      })

      it('reads chunk data into the right blocks: ids past the 26.1 count, palettes of 4 and 15/16 bits', async function () {
        if (!hasChunkFormat) return this.skip()
        await join(rawChunk(Buffer.concat(world.map(section))))
        for (const [p, state] of spots) {
          const at = p.offset(0, minY + 4 * 16, 0)
          assert.strictEqual(bot.blockAt(at).stateId, state, `state at ${at}`)
        }
        assert.strictEqual(bot.blockAt(vec3(1, minY + 4 * 16 + 2, 3)).type, lastBlock.id)
        // the whole section of 4096 different kinds, down to the highest state id
        let checked = 0
        for (let i = 0; i < 4096; i++) {
          const block = bot.blockAt(vec3(i & 15, minY + 5 * 16 + (i >> 8), (i >> 4) & 15))
          if (block.stateId !== mixed[i]) assert.fail(`state ${block.stateId} instead of ${mixed[i]} at index ${i}`)
          checked++
        }
        assert.strictEqual(checked, 4096)
        assert.strictEqual(bot.blockAt(vec3(100 & 15, minY + 5 * 16 + (100 >> 8), (100 >> 4) & 15)).type, topStateBlock.id)
        assert.strictEqual(bot.blockAt(vec3(0, minY + 6 * 16 + 7, 0)).name, 'stone')
        assert.strictEqual(bot.blockAt(vec3(0, minY + 9 * 16 + 7, 0)).name, 'air')
        assert.strictEqual(bot.blockAt(vec3(0, minY, 0)).name, 'air')
        if (registry.version['>=']('26.2')) assert.ok(lastBlock.id >= 1168 && maxState > 29872, 'the data has blocks the 26.1 registry does not')
        if (registry.version['>=']('26.3')) assert.strictEqual(directBits, 16, '26.3 has more than 32768 block states')

        // findBlocks over the decoded sections
        const spot = vec3(1, minY + 4 * 16 + 2, 3)
        const found = bot.findBlocks({ matching: lastBlock.id, maxDistance: 64, count: 4096 })
        assert.ok(found.some(p => p.equals(spot)), 'findBlocks finds the last block of the registry')
        assert.ok(found.every(p => bot.blockAt(p).type === lastBlock.id))
        assert.ok(bot.findBlocks({ matching: topStateBlock.id, maxDistance: 64, count: 4096 }).some(p => p.equals(vec3(100 & 15, minY + 5 * 16 + (100 >> 8), (100 >> 4) & 15))))
        assert.strictEqual(bot.findBlocks({ matching: registry.blocksByName.stone.id, maxDistance: 64, count: 5000 }).length >= 4096, true)
        assert.strictEqual(bot.findBlock({ matching: lastBlock.id, maxDistance: 64 }).position.equals(spot), true)
      })

      it('reads the light of a chunk whose masks are long arrays, or a byte array on 26.3', async function () {
        if (!hasChunkFormat) return this.skip()
        const column = bot.test.buildChunk()
        column.setBlockType(vec3(3, 70, 3), registry.blocksByName.stone.id)
        column.setSkyLight(vec3(3, 71, 3), 12)
        column.setBlockLight(vec3(3, 130, 3), 7)
        await join({ ...generateChunkPacket(column), x: 0, z: 0 })
        const loaded = bot.world.getColumn(0, 0)
        assert.strictEqual(loaded.getSkyLight(vec3(3, 71, 3)), 12)
        assert.strictEqual(loaded.getBlockLight(vec3(3, 130, 3)), 7)
        assert.strictEqual(loaded.getSkyLight(vec3(3, 71, 4)), 0)
        assert.strictEqual(bot.blockAt(vec3(3, 70, 3)).name, 'stone')
      })
    })

    describe('containers', () => {
      const Item = require('prismarine-item')(supportedVersion)
      const Block = require('prismarine-block')(registry)
      const pWindows = require('prismarine-windows')(supportedVersion)
      const modern = registry.version['>=']('1.14') && !!registry.itemsByName.shulker_box // window types are numbers, shulker boxes exist
      const components = registry.supportFeature('itemsWithComponents')
      const templates = registry.version['>=']('26.1') // the container component lists optional ItemStackTemplates
      const hasSequence = registry.version['>=']('1.19')
      const item = (name, count = 1) => new Item(registry.itemsByName[name].id, count)

      // The shulker box item of the tests: diamond x3 in slot 0 (with a data component), emerald x64 in slot 5, stone x1 in slot 26
      const inside = [[0, 'diamond', 3], [5, 'emerald', 64], [26, 'stone', 1]]
      function shulkerWith (contents, color = 'shulker_box') {
        const shulker = item(color)
        if (components) {
          const list = Array.from({ length: Math.max(...contents.map(c => c[0])) + 1 }, () => (templates ? null : { itemCount: 0 }))
          for (const [slot, name, count] of contents) {
            list[slot] = {
              itemId: registry.itemsByName[name].id,
              itemCount: count,
              addedComponentCount: slot === 0 ? 1 : 0,
              removedComponentCount: 0,
              components: slot === 0 ? [{ type: 'repair_cost', data: 7 }] : [],
              removeComponents: []
            }
          }
          shulker.components = [{ type: 'container', data: { contents: list } }]
        } else {
          shulker.nbt = nbt.comp({
            BlockEntityTag: nbt.comp({
              Items: nbt.list(nbt.comp(contents.map(([slot, name, count]) => ({
                Slot: nbt.byte(slot),
                id: nbt.string('minecraft:' + name),
                Count: nbt.byte(count)
              }))))
            })
          })
        }
        return shulker
      }
      const expected = inside.map(([slot, name, count]) => ({ slot, name, count }))
      // the data component of slot 0 is only there on 1.20.5+
      const withoutComponents = items => items.map(({ slot, name, count }) => ({ slot, name, count }))

      it('reads the contents of a shulker box item sent over the wire: slots, counts, components', async function () {
        if (!modern) return this.skip()
        server.on('playerJoin', async (client) => {
          await bot.test.pluginsLoaded
          client.write('login', bot.test.generateLoginPacket())
          client.write('set_slot', { windowId: 0, stateId: 1, slot: 36, item: Item.toNotch(shulkerWith(inside)) })
        })
        await bot.test.pluginsLoaded
        await once(bot.inventory, 'updateSlot:36')
        const held = bot.inventory.slots[36]
        assert.strictEqual(held.name, 'shulker_box')
        const found = bot.containerItems(held)
        assert.deepStrictEqual(withoutComponents(found), expected)
        assert.strictEqual(bot.vanilla.shulkerContents(held).length, 3)
        if (components) assert.deepStrictEqual(found[0].components, [{ type: 'repair_cost', data: 7 }])
        else assert.strictEqual(found[0].components, undefined)
        assert.deepStrictEqual(bot.containerItems(item('shulker_box')), [])
        assert.deepStrictEqual(bot.containerItems(null), [])
      })

      it('opens every window type: the menu names, with the container ones accepted as containers', async function () {
        if (!modern) return this.skip()
        const { matchWindowType } = require('../lib/container_blocks')
        const types = Object.entries(pWindows.windows).filter(([name]) => name !== 'minecraft:inventory')
        assert.ok(types.length >= 19, 'the menu list: generic 9x1-9x6, 3x3, anvil... stonecutter')
        const containers = ['minecraft:generic_9x1', 'minecraft:generic_9x2', 'minecraft:generic_9x3', 'minecraft:generic_9x4', 'minecraft:generic_9x5', 'minecraft:generic_9x6',
          'minecraft:generic_3x3', 'minecraft:hopper', 'minecraft:shulker_box']
        if (registry.version['>=']('1.20.3')) containers.push('minecraft:crafter_3x3')
        const opened = []
        server.on('playerJoin', async (client) => {
          client.write('login', bot.test.generateLoginPacket())
          let windowId = 0
          for (const [, data] of types) {
            windowId++
            client.write('open_window', { windowId, inventoryType: data.type, windowTitle: chatText(''), slotCount: data.slots - 36, entityId: 0 })
            client.write('window_items', { windowId, stateId: 1, items: Array.from({ length: data.slots }, () => Item.toNotch(null)), carriedItem: Item.toNotch(null) })
            await once(bot, 'windowOpen')
          }
        })
        bot.on('windowOpen', (window) => opened.push(window))
        await once(bot, 'login')
        while (opened.length < types.length) await once(bot, 'windowOpen')
        assert.deepStrictEqual(opened.map(w => w.type), types.map(([name]) => name))
        for (const window of opened) {
          assert.strictEqual(matchWindowType(window), containers.includes(window.type), `${window.type} as a container`)
          assert.strictEqual(window.slots.length, pWindows.windows[window.type].slots)
        }
        assert.ok(containers.every(name => opened.some(w => w.type === name)), 'every container menu opened')
      })

      describe('scanContainers', () => {
        // A row of containers at z = 2 (keys: x), the bot at (3.5, 65, 4.5): hopper, barrel, red shulker box, chest, a double chest,
        // a dropper, and an ender chest too far to click (reach 4.5)
        const row = 2
        const layout = {
          0: { block: 'hopper', window: 'minecraft:hopper' },
          1: { block: 'barrel', window: 'minecraft:generic_9x3' },
          2: { block: 'red_shulker_box', window: 'minecraft:shulker_box' },
          3: { block: 'chest', window: 'minecraft:generic_9x3' },
          4: { block: 'chest', window: 'minecraft:generic_9x6', props: { facing: 'south', type: 'left', waterlogged: false } },
          5: { block: 'chest', window: 'minecraft:generic_9x6', props: { facing: 'south', type: 'right', waterlogged: false } },
          6: { block: 'dropper', window: 'minecraft:generic_3x3', props: { facing: 'north', triggered: false } },
          8: { block: 'ender_chest', window: 'minecraft:generic_9x3' }
        }
        const contentsOf = {
          0: [[0, 'ender_pearl', 16]],
          1: [[3, 'cobblestone', 64]],
          2: [[4, 'stone', 64]],
          3: [[0, 'diamond', 3], [13, 'blue_shulker_box', 1]],
          4: [[40, 'gold_ingot', 9]],
          6: [[8, 'arrow', 5]]
        }

        async function joinRow () {
          const chunk = bot.test.buildChunk()
          for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) chunk.setBlockType(vec3(x, 64, z), registry.blocksByName.stone.id)
          for (const [x, spec] of Object.entries(layout)) {
            const info = registry.blocksByName[spec.block]
            const state = spec.props ? Block.fromProperties(info.id, spec.props, 0).stateId : info.defaultState
            chunk.setBlockStateId(vec3(Number(x), 65, row), state)
          }
          const received = []
          let windowId = 0
          await new Promise(resolve => {
            server.on('playerJoin', async (client) => {
              await bot.test.pluginsLoaded
              client.write('login', bot.test.generateLoginPacket())
              client.write('map_chunk', generateChunkPacket(chunk))
              client.write('position', { x: 3.5, y: 65, z: 4.5, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: bot.registry.version['>=']('1.21.3') ? {} : 0, teleportId: 0 })
              client.on('packet', (data, meta) => {
                received.push({ name: meta.name, data })
                if (meta.name !== 'block_place') return
                const spec = layout[data.location.x]
                if (!spec) return
                const win = pWindows.windows[spec.window]
                const items = Array.from({ length: win.slots }, () => Item.toNotch(null))
                for (const [slot, name, count] of contentsOf[data.location.x] ?? []) items[slot] = Item.toNotch(name.endsWith('shulker_box') ? shulkerWith(inside, name) : item(name, count))
                windowId++
                client.write('open_window', { windowId, inventoryType: win.type, windowTitle: chatText(''), slotCount: win.slots - 36, entityId: 0 })
                client.write('window_items', { windowId, stateId: 1, items, carriedItem: Item.toNotch(null) })
              })
              await once(bot, 'chunkColumnLoad')
              await sleep(300) // lands on the floor
              resolve()
            })
          })
          return received
        }

        it('finds the containers around the bot, opens them one by one and indexes them, shulker contents included', async function () {
          if (!modern || !hasSequence) return this.skip()
          const received = await joinRow()
          bot.vanilla.options.reach = 4.5
          bot.vanilla.options.containerSpacingMs = 40
          const visited = []
          const index = await bot.vanilla.scanContainers(8, { settleMs: 20, onVisit: (entry) => visited.push(entry.blockName) })

          // 8 blocks in the row, the double chest once
          assert.strictEqual(index.length, 7)
          assert.deepStrictEqual(visited, index.map(e => e.blockName))
          assert.deepStrictEqual(index.map(e => e.blockName).sort(), ['barrel', 'chest', 'chest', 'dropper', 'ender_chest', 'hopper', 'red_shulker_box'])
          const at = (name, x) => index.find(e => e.blockName === name && e.position.x === x)
          assert.deepStrictEqual(at('hopper', 0).items, [{ slot: 0, name: 'ender_pearl', count: 16 }])
          assert.deepStrictEqual(at('barrel', 1).items, [{ slot: 3, name: 'cobblestone', count: 64 }])
          assert.deepStrictEqual(at('red_shulker_box', 2).items, [{ slot: 4, name: 'stone', count: 64 }])
          assert.deepStrictEqual(at('dropper', 6).items, [{ slot: 8, name: 'arrow', count: 5 }])

          // the single chest holds a blue shulker box with three items, which are listed with their slots
          const chest = at('chest', 3)
          assert.strictEqual(chest.items.length, 2)
          assert.deepStrictEqual(chest.items[0], { slot: 0, name: 'diamond', count: 3 })
          assert.strictEqual(chest.items[1].name, 'blue_shulker_box')
          assert.strictEqual(chest.items[1].slot, 13)
          assert.deepStrictEqual(withoutComponents(chest.items[1].shulkerItems), expected)
          if (components) assert.strictEqual(chest.items[1].components, undefined, 'the container component is not repeated next to shulkerItems')

          // the double chest: one entry, the half nearer to the bot is the one that is opened, the other half is named
          const doubles = index.filter(e => e.blockName === 'chest' && e.double)
          assert.strictEqual(doubles.length, 1)
          assert.deepStrictEqual(doubles[0].items, [{ slot: 40, name: 'gold_ingot', count: 9 }])
          assert.strictEqual(doubles[0].position.x, 4)
          assert.strictEqual(doubles[0].double.x, 5)

          // the ender chest is out of reach: reported, not opened
          const ender = at('ender_chest', 8)
          assert.strictEqual(ender.error, 'too-far')
          assert.deepStrictEqual(ender.items, [])

          // one window at a time: each is closed before the next click
          const names = received.map(p => p.name).filter(n => ['block_place', 'close_window'].includes(n))
          assert.strictEqual(names.filter(n => n === 'block_place').length, 6, 'the ender chest was never clicked')
          for (let i = 1; i < names.length; i++) assert.ok(!(names[i] === 'block_place' && names[i - 1] === 'block_place'), 'a window stays open into the next click')
          assert.strictEqual(bot.currentWindow, null)
        })

        it('leaves out what skip names, and a double chest with one half skipped', async function () {
          if (!modern || !hasSequence) return this.skip()
          await joinRow()
          bot.vanilla.options.reach = 4.5
          bot.vanilla.options.containerSpacingMs = 40
          const index = await bot.vanilla.scanContainers(8, { settleMs: 20, center: vec3(3.5, 65.5, 2.5), skip: [vec3(2, 65, 2), vec3(5, 65, 2)] })
          assert.deepStrictEqual(index.map(e => e.blockName).sort(), ['barrel', 'chest', 'dropper', 'ender_chest', 'hopper'])
          assert.ok(!index.some(e => e.double))
        })

        it('reports a container that does not answer instead of throwing, and goes on with the next', async function () {
          if (!modern || !hasSequence) return this.skip()
          await joinRow()
          bot.vanilla.options.reach = 4.5
          bot.vanilla.options.openTimeoutMs = 200
          bot.vanilla.options.containerSpacingMs = 40
          const hopper = layout[0]
          delete layout[0] // the server stays silent on the hopper
          try {
            const index = await bot.vanilla.scanContainers(1.5, { center: vec3(0.5, 65.5, 2.5), settleMs: 20 })
            assert.deepStrictEqual(index.map(e => e.blockName).sort(), ['barrel', 'hopper'])
            const failed = index.find(e => e.blockName === 'hopper')
            assert.strictEqual(failed.error, 'timeout')
            assert.deepStrictEqual(failed.items, [])
            assert.strictEqual(index.find(e => e.blockName === 'barrel').items.length, 1)
          } finally {
            layout[0] = hopper
          }
        })
      })
    })

    describe('wire changes of the newest versions', () => {
      const playerAction = require('../lib/player_action')
      const entityActionId = require('../lib/entity_action')
      const isV263 = registry.version['>=']('26.3')

      async function loggedIn () {
        let client
        server.on('playerJoin', (c) => {
          client = c
          c.write('login', bot.test.generateLoginPacket())
        })
        await once(bot, 'login')
        await bot.test.pluginsLoaded
        return client
      }
      const moved = (client, name, params) => {
        const done = once(bot, 'entityMoved')
        client.write(name, params)
        return done.then(([entity]) => entity)
      }

      it('player actions: 26.3 inserted CHANGE_DESTROY_DIRECTION at 1, which moves every status after START', () => {
        const shift = isV263 ? 1 : 0
        assert.deepStrictEqual(
          ['start_digging', 'abort_digging', 'finish_digging', 'drop_stack', 'drop_item', 'release_use_item', 'swap_hands'].map(a => playerAction(registry, a)),
          [0, 1 + shift, 2 + shift, 3 + shift, 4 + shift, 5 + shift, 6 + shift])
        assert.throws(() => playerAction(registry, 'jump'))
      })

      it('entity_action ids are looked up by meaning and round-trip, whatever the version calls them', function () {
        if (!registry.version['>=']('1.21.6')) return this.skip() // before that the packet has a plain varint, see lib/entity_action.js
        const serializer = mc.createSerializer({ state: 'play', isServer: false, version: supportedVersion })
        const parser = mc.createDeserializer({ state: 'play', isServer: true, version: supportedVersion })
        for (const action of ['leave_bed', 'start_sprinting', 'stop_sprinting', 'start_riding_jump', 'stop_riding_jump', 'open_inventory', 'start_elytra_flying']) {
          const actionId = entityActionId(registry, action)
          const back = parser.parsePacketBuffer(serializer.createPacketBuffer({ name: 'entity_action', params: { entityId: 1, actionId, jumpBoost: 0 } })).data.params
          assert.strictEqual(back.actionId, actionId, action)
        }
        // the 26.2 data calls the first one leave_bed, the 26.3 data stop_sleeping
        assert.strictEqual(entityActionId(registry, 'leave_bed'), registry.version['>=']('26.3') ? 'stop_sleeping' : registry.version['>=']('26.2') ? 'leave_bed' : 'stop_sleeping')
      })

      it('moves an entity by rel_entity_move, entity_move_look and sync_entity_position (26.3: move: { onGround, steps })', async function () {
        if (!isV263) return this.skip()
        const client = await loggedIn()
        let entity = await moved(client, 'rel_entity_move', { entityId: 77, move: { onGround: true, steps: [{ dX: 4096, dY: -2048, dZ: 0, ticks: 0 }] } })
        assert.deepStrictEqual(entity.position.toArray(), [1, -0.5, 0])
        // stepped: the deltas are chained, the entity ends where their sum leads
        entity = await moved(client, 'entity_move_look', { entityId: 77, move: { onGround: false, steps: [{ dX: 4096, dY: 0, dZ: 0, ticks: 1 }, { dX: 4096, dY: 0, dZ: 4096, ticks: 1 }] }, yaw: 64, pitch: 0 })
        assert.deepStrictEqual(entity.position.toArray(), [3, -0.5, 1])
        assert.ok(Math.abs(entity.yaw - require('../lib/conversions').fromNotchianYawByte(64)) < 1e-9)
        entity = await moved(client, 'sync_entity_position', { entityId: 77, positionType: 'linear', x: 5, y: 6, z: 7, yaw: 90, pitch: 10, onGround: true })
        assert.deepStrictEqual(entity.position.toArray(), [5, 6, 7])
        entity = await moved(client, 'sync_entity_position', { entityId: 77, positionType: 'stepped', steps: [{ x: 1, y: 2, z: 3, tickOffset: 0 }, { x: 8, y: 9, z: 10, tickOffset: 1 }], yaw: 90, pitch: 10, onGround: false })
        assert.deepStrictEqual(entity.position.toArray(), [8, 9, 10])
      })

      it('update_attributes: the movement speed sent by its wire id lands under minecraft:movement_speed', async function () {
        if (!registry.version['>=']('1.20.5')) return this.skip()
        const client = await loggedIn()
        const wireId = registry.attributesArray.findIndex(a => a.resource === 'minecraft:movement_speed')
        const packet = registry.protocol.play.toClient.types.packet_entity_update_attributes ? 'entity_update_attributes' : 'update_attributes'
        const mapper = registry.protocol.play.toClient.types['packet_' + packet][1][1].type[1].type[1][0].type[1].mappings
        assert.ok(wireId >= 0)
        // the protocol data's key table is stale (31 names), so the wire id is written through the name it has for that id
        assert.ok(mapper[wireId], `the protocol data names attribute ${wireId}`)
        const updated = once(bot, 'entityAttributes')
        client.write(packet, { entityId: bot.entity.id, properties: [{ key: mapper[wireId], value: 0.2, modifiers: [] }] })
        await updated
        assert.strictEqual(bot.entity.attributes['minecraft:movement_speed'].value, 0.2)
        assert.strictEqual(Object.keys(bot.entity.attributes).filter(k => !k.startsWith('minecraft:')).length, 0, 'only resource names are left: ' + Object.keys(bot.entity.attributes))
        assert.strictEqual(bot.entity.attributes[`minecraft:${mapper[wireId].replace(/^\w+\./, '')}`], undefined, 'the stale name of that id is not a key')
      })
    })

    describe('totem of undying', () => {
      const Item = require('prismarine-item')(supportedVersion)
      const hasTotem = !registry.supportFeature('doesntHaveOffHandSlot') && !!registry.itemsByName.totem_of_undying
      const totem = () => new Item(registry.itemsByName.totem_of_undying.id, 1)
      const swapStatus = version['>=']('26.3') ? 7 : 6

      async function ready () {
        const chunk = bot.test.buildChunk()
        for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) chunk.setBlockType(vec3(x, 64, z), registry.blocksByName.stone.id)
        await new Promise(resolve => {
          server.on('playerJoin', async (client) => {
            await bot.test.pluginsLoaded
            client.write('login', bot.test.generateLoginPacket())
            client.write('map_chunk', generateChunkPacket(chunk))
            client.write('position', { x: 1.5, y: 65, z: 4.5, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: bot.registry.version['>=']('1.21.3') ? {} : 0, teleportId: 0 })
            await once(bot, 'chunkColumnLoad')
            await sleep(300) // lands on the floor
            resolve()
          })
        })
        bot.quickBarSlot = 0 // the server selects a slot on join
        const writes = []
        const write = bot._client.write
        // the packets are recorded and not sent; a swap-hands is answered like the server would, after three ticks
        bot._client.write = (name, params) => {
          writes.push({ name, params })
          if (name === 'block_dig' && params.status === swapStatus) {
            const held = bot.inventory.slots[bot.QUICK_BAR_START + bot.quickBarSlot]
            setTimeout(() => bot.inventory.updateSlot(45, held), 150)
          }
        }
        return { writes, restore: () => { bot._client.write = write } }
      }
      const summary = writes => writes.filter(w => ['held_item_slot', 'block_dig', 'window_click'].includes(w.name))
        .map(w => w.name === 'window_click' ? ['window_click', w.params.mode, w.params.mouseButton, w.params.slot] : [w.name, w.params.slotId ?? w.params.status])

      it('emits totemUsed for entity_status 35 of the bot, not of another entity', async function () {
        if (!hasTotem) return this.skip()
        let client
        server.on('playerJoin', (c) => {
          client = c
          c.write('login', bot.test.generateLoginPacket())
        })
        await once(bot, 'login')
        await bot.test.pluginsLoaded
        let pops = 0
        bot.on('totemUsed', () => pops++)
        client.write('entity_status', { entityId: 5, entityStatus: 35 })
        client.write('entity_status', { entityId: bot.entity.id, entityStatus: 2 })
        client.write('entity_status', { entityId: bot.entity.id, entityStatus: 35 })
        await once(bot, 'totemUsed')
        assert.strictEqual(pops, 1)
        client.write('entity_status', { entityId: bot.entity.id, entityStatus: 35 })
        await sleep(100)
        assert.strictEqual(pops, 2)
      })

      it('ensureOffhandTotem swaps one in from the hotbar and returns once the server confirmed the offhand', async function () {
        if (!hasTotem) return this.skip()
        const { writes } = await ready()
        bot.inventory.updateSlot(bot.QUICK_BAR_START + 3, totem())
        assert.strictEqual(await bot.vanilla.ensureOffhandTotem(), true)
        assert.deepStrictEqual(summary(writes), [['held_item_slot', 3], ['block_dig', swapStatus], ['held_item_slot', 0]])
        // it holds one now: nothing more is written
        writes.length = 0
        assert.strictEqual(await bot.vanilla.ensureOffhandTotem(), true)
        assert.deepStrictEqual(writes, [])
      })

      it('ensureOffhandTotem brings one from the main inventory to the hotbar first, with a number-key click', async function () {
        // before 1.17 a click waits for the server's transaction, which this test does not send
        if (!hasTotem || registry.supportFeature('transactionPacketExists')) return this.skip()
        const { writes } = await ready()
        bot.inventory.updateSlot(bot.QUICK_BAR_START, new Item(registry.itemsByName.stone.id, 1)) // slot 0 is taken: the totem goes to 1
        bot.inventory.updateSlot(12, totem())
        assert.strictEqual(await bot.vanilla.ensureOffhandTotem(), true)
        assert.deepStrictEqual(summary(writes), [['window_click', 2, 1, 12], ['held_item_slot', 1], ['block_dig', swapStatus], ['held_item_slot', 0]])

        writes.length = 0
        bot.inventory.updateSlot(45, null)
        bot.inventory.updateSlot(bot.QUICK_BAR_START + 1, null)
        bot.inventory.updateSlot(20, totem())
        assert.strictEqual(await bot.vanilla.ensureOffhandTotem({ fromInventory: false }), false)
        assert.deepStrictEqual(writes, [], 'fromInventory: false leaves the inventory alone')
      })

      it('ensureOffhandTotem is false without a totem, or when the server does not show it', async function () {
        if (!hasTotem) return this.skip()
        const { writes, restore } = await ready()
        assert.strictEqual(await bot.vanilla.ensureOffhandTotem(), false)
        assert.deepStrictEqual(writes, [])
        restore()
        const sent = []
        bot._client.write = (name, params) => sent.push(name)
        bot.inventory.updateSlot(bot.QUICK_BAR_START + 1, totem())
        assert.strictEqual(await bot.vanilla.ensureOffhandTotem(), false, 'the swap went out but the offhand did not change within 20 ticks')
        assert.ok(sent.includes('block_dig'))
      })
    })

    describe('activateItem', () => {
      it('does nothing with an empty hand', (done) => {
        server.on('playerJoin', async (client) => {
          await bot.test.pluginsLoaded
          const loggedIn = once(bot, 'login')
          await client.write('login', bot.test.generateLoginPacket())
          await loggedIn
          const writes = []
          bot._client.write = (name, params) => { writes.push(name) }
          bot.quickBarSlot = 0
          try {
            await bot.activateItem()
            await bot.activateItem(true)
            const sent = () => writes.filter(name => !TICK_PACKETS.includes(name))
            assert.deepStrictEqual(sent(), [])
            assert.strictEqual(bot.usingHeldItem, false)
            bot.inventory.updateSlot(bot.QUICK_BAR_START, new Item(registry.itemsByName.stone.id, 1))
            await bot.activateItem()
            assert.deepStrictEqual(sent(), [bot.supportFeature('useItemWithOwnPacket') ? 'use_item' : 'block_place'])
            assert.strictEqual(bot.usingHeldItem, false, 'a block is not an item that is used up')
            // food starts a use when the bot is hungry; the use is tracked until it is released
            bot.food = 10
            bot.inventory.updateSlot(bot.QUICK_BAR_START, new Item(registry.itemsByName.bread.id, 1))
            await bot.activateItem()
            assert.strictEqual(bot.usingHeldItem, true)
            assert.strictEqual(bot.itemInUse, true)
            await bot.deactivateItem()
            assert.strictEqual(bot.usingHeldItem, false)
            done()
          } catch (err) {
            done(err)
          }
        })
      })
    })

    describe('heldItemChanged', () => {
      it('emits heldItemChanged when the held slot is updated via set_slot', (done) => {
        const Item = require('prismarine-item')(supportedVersion)
        const QUICK_BAR_SLOT = 0
        const HOTBAR_START = 36
        const stoneId = registry.itemsByName.stone.id
        const stoneItem = new Item(stoneId, 1)
        const notchItem = Item.toNotch(stoneItem)

        server.on('playerJoin', (client) => {
          client.write('login', bot.test.generateLoginPacket())
          client.write('held_item_slot', { slot: QUICK_BAR_SLOT })

          // Wait for the held_item_slot to be processed, then listen for the
          // heldItemChanged triggered by the set_slot update to the held slot
          setTimeout(() => {
            bot.once('heldItemChanged', (newItem) => {
              assert.ok(newItem, 'heldItemChanged should provide the new item')
              assert.strictEqual(newItem.type, stoneId)
              done()
            })
            client.write('set_slot', {
              windowId: 0,
              slot: HOTBAR_START + QUICK_BAR_SLOT,
              item: notchItem
            })
          }, 100)
        })
      })

      it('emits heldItemChanged via updateSlot on the inventory', (done) => {
        const Item = require('prismarine-item')(supportedVersion)
        const QUICK_BAR_SLOT = 0
        const stoneId = registry.itemsByName.stone.id
        const stoneItem = new Item(stoneId, 1)

        server.on('playerJoin', (client) => {
          client.write('login', bot.test.generateLoginPacket())
          client.write('held_item_slot', { slot: QUICK_BAR_SLOT })

          setTimeout(() => {
            bot.once('heldItemChanged', (newItem) => {
              assert.ok(newItem, 'heldItemChanged should provide the new item')
              assert.strictEqual(newItem.type, stoneId)
              done()
            })
            // Directly call updateSlot on the inventory to simulate
            // the set_player_inventory code path
            bot.inventory.updateSlot(
              QUICK_BAR_SLOT + bot.inventory.hotbarStart,
              stoneItem
            )
          }, 100)
        })
      })
    })

    describe('held_item_slot', () => {
      function collectHeldItemSlots (client) {
        const sent = []
        client.on('packet', (data, meta) => {
          if (meta.name === 'held_item_slot') sent.push(data.slotId)
        })
        return sent
      }

      it('applies a server-sent slot equal to the carried one without echoing it', (done) => {
        server.on('playerJoin', async (client) => {
          try {
            const sent = collectHeldItemSlots(client)
            client.write('login', bot.test.generateLoginPacket())
            client.write('held_item_slot', { slot: 0 })
            await sleep(300)
            assert.strictEqual(bot.quickBarSlot, 0)
            assert.deepStrictEqual(sent, [])
            bot.setQuickBarSlot(3)
            await sleep(300)
            assert.deepStrictEqual(sent, [3])
            done()
          } catch (err) {
            done(err)
          }
        })
      })

      it('sends a server-sent slot that differs from the carried one, once per login', (done) => {
        server.on('playerJoin', async (client) => {
          try {
            const sent = collectHeldItemSlots(client)
            const changes = []
            bot.on('heldItemChanged', () => changes.push(bot.quickBarSlot))
            client.write('login', bot.test.generateLoginPacket())
            client.write('held_item_slot', { slot: 3 })
            await sleep(300)
            assert.strictEqual(bot.quickBarSlot, 3)
            assert.deepStrictEqual(sent, [3])
            assert.deepStrictEqual(changes, [3])
            client.write('held_item_slot', { slot: 3 })
            bot.setQuickBarSlot(3)
            await sleep(300)
            assert.deepStrictEqual(sent, [3])
            assert.deepStrictEqual(changes, [3])
            client.write('login', bot.test.generateLoginPacket())
            client.write('held_item_slot', { slot: 3 })
            await sleep(300)
            assert.deepStrictEqual(sent, [3, 3])
            assert.deepStrictEqual(changes, [3])
            client.write('held_item_slot', { slot: 0 })
            await sleep(300)
            assert.strictEqual(bot.quickBarSlot, 0)
            assert.deepStrictEqual(sent, [3, 3, 0])
            assert.deepStrictEqual(changes, [3, 0])
            done()
          } catch (err) {
            done(err)
          }
        })
      })
    })

    describe('generic place', () => {
      it('swings the arm after use_item_on', (done) => {
        server.on('playerJoin', async (client) => {
          await bot.test.pluginsLoaded
          const loggedIn = once(bot, 'login')
          await client.write('login', bot.test.generateLoginPacket())
          await loggedIn
          const writes = []
          bot._client.write = (name, params) => { writes.push(name) }
          bot.quickBarSlot = 0
          bot.inventory.updateSlot(bot.QUICK_BAR_START, new Item(registry.itemsByName.stone.id, 1))
          await bot._genericPlace({ position: vec3(1, 65, 1) }, vec3(0, 1, 0), { forceLook: 'ignore', swingArm: 'right' })
          try {
            assert.deepStrictEqual(writes.filter(name => !TICK_PACKETS.includes(name)), ['block_place', 'arm_animation'])
            done()
          } catch (err) {
            done(err)
          }
        })
      })
    })

    describe('windows', () => {
      const Item = require('prismarine-item')(supportedVersion)
      const pWindows = require('prismarine-windows')(supportedVersion)
      // legacy 'minecraft:chest' has a dynamic size resolved from the packet's
      // slotCount (container slots only); the modern equivalent is fixed
      const chestData = pWindows.windows['minecraft:generic_9x3'] ?? { type: 'minecraft:chest', slots: 63 }
      const merchantData = pWindows.windows['minecraft:merchant'] ?? pWindows.windows['minecraft:villager']
      const emptyItems = (n) => Array.from({ length: n }, () => Item.toNotch(null))
      const openWindowPacket = (windowId, winData) => ({
        windowId,
        inventoryType: winData.type,
        windowTitle: chatText(''),
        slotCount: winData.slots - 36,
        entityId: 0
      })
      const windowItemsPacket = (windowId, items) => ({
        windowId,
        stateId: 1,
        items,
        carriedItem: Item.toNotch(null)
      })

      it('opens a window whose early window_items reuses the id of a closed window', (done) => {
        const emeraldId = registry.itemsByName.emerald.id

        server.on('playerJoin', (client) => {
          client.write('login', bot.test.generateLoginPacket())

          bot.once('windowOpen', () => {
            bot.closeWindow(bot.currentWindow)
          })
          client.on('close_window', () => {
            bot.once('windowOpen', (window) => {
              assert.strictEqual(window.type, merchantData.key)
              assert.strictEqual(window.slots[0]?.type, emeraldId)
              done()
            })
            // a villager window sends its contents before open_window, and
            // reuses the chest's id when a respawn reset the server's window
            // id counter in between
            const items = emptyItems(merchantData.slots)
            items[0] = Item.toNotch(new Item(emeraldId, 3))
            client.write('window_items', windowItemsPacket(1, items))
            client.write('open_window', openWindowPacket(1, merchantData))
          })

          client.write('open_window', openWindowPacket(1, chestData))
          client.write('window_items', windowItemsPacket(1, emptyItems(chestData.slots)))
        })
      })

      it('applies the player-inventory region of a trailing sync for a closed window', (done) => {
        const stoneId = registry.itemsByName.stone.id
        // chest slot 30 is in the window's player-inventory region and maps
        // back to inventory slot 12
        const chestSlot = 30
        const invSlot = 12

        server.on('playerJoin', (client) => {
          client.write('login', bot.test.generateLoginPacket())

          bot.once('windowOpen', () => {
            bot.closeWindow(bot.currentWindow)
          })
          client.on('close_window', () => {
            bot.inventory.once(`updateSlot:${invSlot}`, (oldItem, newItem) => {
              assert.strictEqual(newItem?.type, stoneId)
              done()
            })
            const items = emptyItems(chestData.slots)
            items[chestSlot] = Item.toNotch(new Item(stoneId, 5))
            client.write('window_items', windowItemsPacket(1, items))
          })

          client.write('open_window', openWindowPacket(1, chestData))
          client.write('window_items', windowItemsPacket(1, emptyItems(chestData.slots)))
        })
      })
    })

    describe('scoreboard', () => {
      it('enumerates only the display slots that hold an objective', async () => {
        server.on('playerJoin', (client) => client.write('login', bot.test.generateLoginPacket()))
        await once(bot, 'login')
        bot._client.emit('scoreboard_objective', { name: 'test1', action: 0, displayText: JSON.stringify({ text: 'Test 1' }) })
        bot._client.emit('scoreboard_display_objective', { name: 'test1', position: 1 })
        assert.strictEqual(bot.scoreboard.sidebar, bot.scoreboards.test1)
        assert.strictEqual(bot.scoreboard.list, undefined)
        assert.deepStrictEqual(Object.keys(bot.scoreboard), ['1'])
        assert.ok(Object.values(bot.scoreboard).every(sb => sb !== undefined))
        assert.doesNotThrow(() => { for (const sb of Object.values(bot.scoreboard)) assert.strictEqual(sb.title, 'Test 1') })
        bot._client.emit('scoreboard_objective', { name: 'test1', action: 1 })
        assert.deepStrictEqual(Object.keys(bot.scoreboard), [])
        assert.strictEqual(bot.scoreboard.sidebar, undefined)
      })
    })
    describe('tablist', () => {
      it('handles newlines in header and footer', (done) => {
        const HEADER = 'asd\ndsa'
        const FOOTER = '\nas\nas\nas\n'
        bot._client.on('playerlist_header', (packet) => {
          setImmediate(() => {
            assert.strictEqual(bot.tablist.header.toString(), HEADER)
            assert.strictEqual(bot.tablist.footer.toString(), FOOTER)
            done()
          })
        })
        // TODO: figure out how the "extra" should be encoded in NBT so this branch can be removed
        if (registry.supportFeature('chatPacketsUseNbtComponents')) {
          server.on('playerJoin', (client) => {
            client.write('playerlist_header', {
              header: chatText(HEADER),
              footer: chatText(FOOTER)
            })
          })
        } else {
          server.on('playerJoin', (client) => {
            client.write('playerlist_header', {
              header: JSON.stringify({ text: '', extra: [{ text: HEADER, color: 'yellow' }] }),
              footer: JSON.stringify({ text: '', extra: [{ text: FOOTER, color: 'yellow' }] })
            })
          })
        }
      })
    })

    describe('scoreboard reset on login', () => {
      function teamAddPacket (teamName, players) {
        const text = registry.supportFeature('teamUsesChatComponents') ? chatText : (s) => s
        const mappedMode = registry.version['>=']('1.21.6')
        const enumRules = registry.version['>=']('1.21.5') && registry.version['<']('1.21.6')
        return {
          team: teamName,
          mode: mappedMode ? 'add' : 0,
          name: text(teamName),
          prefix: text(''),
          suffix: text(''),
          friendlyFire: 1,
          flags: { friendly_fire: true, see_friendly_invisible: false },
          nameTagVisibility: enumRules ? 0 : 'always',
          collisionRule: enumRules ? 0 : 'always',
          color: 0,
          formatting: 0,
          players
        }
      }

      function objectiveAddPacket (name) {
        const typeField = registry.protocol.play.toClient.types.packet_scoreboard_objective[1].find(f => f.name === 'type')
        return {
          name,
          action: 0,
          displayText: chatText(name),
          type: typeField.type[1].fields[0] === 'string' ? 'integer' : 0
        }
      }

      function respawnPacket (loginPacket) {
        if (!bot.supportFeature('usesLoginPacket')) {
          return { dimension: 0, hashedSeed: [0, 0], gamemode: 0, levelType: 'default' }
        }
        // The respawn packet names the world the login packet declared.
        loginPacket.worldName = 'minecraft:overworld'
        loginPacket.hashedSeed = [0, 0]
        loginPacket.entityId = 0
        const packet = {
          dimension: bot.supportFeature('dimensionDataInCodec') ? 'minecraft:overworld' : loginPacket.dimension,
          worldName: loginPacket.worldName,
          hashedSeed: loginPacket.hashedSeed,
          gamemode: 0,
          previousGamemode: 255,
          isDebug: false,
          isFlat: false,
          copyMetadata: true,
          death: { dimensionName: '', location: { x: 0, y: 0, z: 0 } }
        }
        if (!bot.supportFeature('spawnRespawnWorldDataField')) return packet
        packet.name = loginPacket.worldName
        packet.dimension = loginPacket.dimension
        return { worldState: packet }
      }

      it('clears teams and objectives on login but not on respawn', async () => {
        const teamPacketName = bot.supportFeature('teamUsesScoreboard') ? 'scoreboard_team' : 'teams'
        const [client] = await once(server, 'playerJoin')
        const loginPacket = bot.test.generateLoginPacket()
        const teams = bot.teams
        const teamMap = bot.teamMap
        const scoreboards = bot.scoreboards
        const positions = bot.scoreboard

        await client.write('login', loginPacket)
        client.write(teamPacketName, teamAddPacket('red', ['alice']))
        await once(bot, 'teamCreated')
        client.write('scoreboard_objective', objectiveAddPacket('kills'))
        client.write('scoreboard_display_objective', { position: 1, name: 'kills' })
        await once(bot, 'scoreboardPosition')
        assert.deepStrictEqual(bot.teams.red.members, ['alice'])
        assert.strictEqual(bot.teamMap.alice, bot.teams.red)
        assert.strictEqual(bot.scoreboards.kills.name, 'kills')
        assert.strictEqual(bot.scoreboard.sidebar, bot.scoreboards.kills)
        assert.strictEqual(bot.scoreboard[1], bot.scoreboards.kills)

        let removedEvents = 0
        bot.on('teamRemoved', () => removedEvents++)
        bot.on('scoreboardDeleted', () => removedEvents++)
        client.write('login', loginPacket)
        await once(bot, 'login')
        assert.strictEqual(bot.teams, teams)
        assert.strictEqual(bot.teamMap, teamMap)
        assert.strictEqual(bot.scoreboards, scoreboards)
        assert.strictEqual(bot.scoreboard, positions)
        assert.deepStrictEqual(Object.keys(bot.teams), [])
        assert.deepStrictEqual(Object.keys(bot.teamMap), [])
        assert.deepStrictEqual(Object.keys(bot.scoreboards), [])
        assert.strictEqual(bot.scoreboard[1], undefined)
        assert.strictEqual(bot.scoreboard.sidebar, undefined)
        assert.strictEqual(bot.scoreboard.list, undefined)
        assert.strictEqual(bot.scoreboard.belowName, undefined)
        assert.strictEqual(removedEvents, 0)

        client.write(teamPacketName, teamAddPacket('red', ['bob']))
        await once(bot, 'teamCreated')
        assert.deepStrictEqual(bot.teams.red.members, ['bob'])
        assert.strictEqual(bot.teamMap.alice, undefined)

        client.write('respawn', respawnPacket(loginPacket))
        await once(bot, 'respawn')
        assert.deepStrictEqual(bot.teams.red.members, ['bob'])
        assert.strictEqual(bot.teamMap.bob, bot.teams.red)
      })
    })

    describe('block prediction sequence', () => {
      it('shares one pre-incremented counter across use_item and use_item_on, 0 on release', function (done) {
        const useItemFields = registry.protocol?.play?.toServer?.types?.packet_use_item?.[1]
        if (!useItemFields?.some(f => f.name === 'sequence')) {
          this.skip()
          return
        }
        server.on('playerJoin', async (client) => {
          await bot.test.pluginsLoaded
          const loggedIn = once(bot, 'login')
          await client.write('login', bot.test.generateLoginPacket())
          await loggedIn
          const writes = []
          bot._client.write = (name, params) => { writes.push([name, params.sequence]) }
          bot.quickBarSlot = 0
          bot.inventory.updateSlot(bot.QUICK_BAR_START, new Item(registry.itemsByName.stone.id, 1))

          await bot.activateItem()
          await bot.deactivateItem()
          await bot._genericPlace({ position: vec3(1, 65, 1) }, vec3(0, 1, 0), { forceLook: 'ignore' })
          await bot.activateItem()

          try {
            assert.deepStrictEqual(writes.filter(([name]) => !TICK_PACKETS.includes(name)), [
              ['use_item', 1],
              ['block_dig', 0],
              ['block_place', 2],
              ['use_item', 3]
            ])
            done()
          } catch (err) {
            done(err)
          }
        })
      })

      it('gives both packets of a boat placement their own value, interleaved with use_item', function (done) {
        const useItemFields = registry.protocol?.play?.toServer?.types?.packet_use_item?.[1]
        if (!useItemFields?.some(f => f.name === 'sequence')) {
          this.skip()
          return
        }
        server.on('playerJoin', async (client) => {
          await bot.test.pluginsLoaded
          const loggedIn = once(bot, 'login')
          await client.write('login', bot.test.generateLoginPacket())
          await loggedIn
          // serialize every packet with the real protocol, so a missing field throws here
          const serializer = mc.createSerializer({ state: 'play', isServer: false, version: bot.version })
          const writes = []
          bot._client.write = (name, params) => {
            serializer.createPacketBuffer({ name, params })
            writes.push([name, params.sequence])
          }
          bot.lookAt = async () => {}
          bot.quickBarSlot = 0
          const boat = registry.itemsByName.oak_boat ?? registry.itemsByName.boat
          bot.inventory.updateSlot(bot.QUICK_BAR_START, new Item(boat.id, 1))

          try {
            await bot.activateItem()
            await bot.deactivateItem()
            // the caller aims (there is no world to ray-cast in here)
            const placed = bot._placeEntityWithOptions({ position: vec3(1, 64, 1) }, vec3(0, 1, 0), { forceLook: 'ignore' })
            // the click and the use_item that goes with it leave in one tick
            while (!writes.some(([name, sequence]) => name === 'use_item' && sequence === 3)) await sleep(10)
            await sleep(10)
            bot.emit('entitySpawn', { name: bot.supportFeature('entityNameUpperCaseNoUnderscore') ? 'Boat' : 'boat', position: vec3(1.5, 65, 1.5) })
            await placed
            await bot.activateItem()

            assert.deepStrictEqual(writes.filter(([name]) => name !== 'arm_animation' && !TICK_PACKETS.includes(name)), [
              ['use_item', 1],
              ['block_dig', 0],
              ['block_place', 2],
              ['use_item', 3],
              ['use_item', 4]
            ])
            done()
          } catch (err) {
            done(err)
          }
        })
      })
    })

    describe('activateBlock rotation', () => {
      it('faces the point on the clicked face that the packet reports', async () => {
        const blockPos = vec3(1, 65, 1)
        const stoneId = registry.blocksByName.stone.id
        const chunk = bot.test.buildChunk()
        for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) chunk.setBlockType(vec3(x, 64, z), stoneId)
        chunk.setBlockType(blockPos, stoneId)
        let sent = null
        await new Promise(resolve => {
          server.on('playerJoin', async (client) => {
            client.write('login', bot.test.generateLoginPacket())
            client.write('map_chunk', generateChunkPacket(chunk))
            client.write('position', {
              x: 1.5,
              y: 65,
              z: 4.5,
              dx: 0,
              dy: 0,
              dz: 0,
              yaw: 0,
              pitch: 0,
              flags: bot.registry.version['>=']('1.21.3') ? {} : 0,
              teleportId: 0
            })
            client.on('packet', (data, meta) => { if (meta.name === 'block_place') sent = data })
            await sleep(400)
            resolve()
          })
        })

        // the south face, the one an eye at z = 4.5 can see
        await bot.activateBlock(bot.blockAt(blockPos), vec3(0, 0, 1))
        await sleep(200)
        assert.ok(sent, 'no block_place packet')

        const eye = bot.entity.position.offset(0, bot.entity.eyeHeight, 0)
        const aim = (point) => {
          const d = point.minus(eye)
          return { yaw: Math.atan2(-d.x, -d.z), pitch: Math.atan2(d.y, Math.sqrt(d.x * d.x + d.z * d.z)) }
        }
        const hit = aim(blockPos.offset(0.5, 0.5, 1))
        const middle = aim(blockPos.offset(0.5, 0.5, 0.5))
        assert.ok(Math.abs(hit.pitch - middle.pitch) > 0.05, 'the two aims must be far enough apart to tell apart')
        assert.ok(Math.abs(bot.entity.pitch - hit.pitch) < 0.02,
          `pitch ${bot.entity.pitch} should face the reported hit at ${hit.pitch}, the block's middle is ${middle.pitch}`)
        assert.ok(Math.abs(bot.entity.yaw - hit.yaw) < 0.02, `yaw ${bot.entity.yaw} should face the reported hit at ${hit.yaw}`)
      })
    })

    describe('activateItem rotation', () => {
      it('should send the bot rotation in the use_item packet', function (done) {
        // The rotation field in use_item was added in 1.21.1
        const useItemFields = registry.protocol?.play?.toServer?.types?.packet_use_item?.[1]
        const hasRotation = useItemFields && useItemFields.some(f => f.name === 'rotation')
        if (!hasRotation) {
          this.skip()
          return
        }
        const { toNotchianYaw, toNotchianPitch } = require('../lib/conversions')
        const testYaw = 1.5
        const testPitch = -0.3
        server.on('playerJoin', async (client) => {
          await bot.test.pluginsLoaded
          await client.write('login', bot.test.generateLoginPacket())
          await client.write('position', {
            x: 0,
            y: 66,
            z: 0,
            dx: 0,
            dy: 0,
            dz: 0,
            yaw: 0,
            pitch: 0,
            flags: bot.registry.version['>=']('1.21.3') ? {} : 0,
            teleportId: 0
          })

          client.on('packet', (data, meta) => {
            if (meta.name === 'use_item') {
              const expectedYaw = toNotchianYaw(testYaw)
              const expectedPitch = toNotchianPitch(testPitch)
              assert.ok(data.rotation, 'use_item packet should have rotation field')
              assert.ok(Math.abs(data.rotation.x - expectedYaw) < 0.001,
                `Expected yaw ${expectedYaw}, got ${data.rotation.x}`)
              assert.ok(Math.abs(data.rotation.y - expectedPitch) < 0.001,
                `Expected pitch ${expectedPitch}, got ${data.rotation.y}`)
              done()
            }
          })

          await sleep(100)
          bot.entity.yaw = testYaw
          bot.entity.pitch = testPitch
          bot.quickBarSlot = 0
          bot.inventory.updateSlot(bot.QUICK_BAR_START, new Item(registry.itemsByName.stone.id, 1))
          bot.activateItem()
        })
      })
    })

    describe('teleports', () => {
      it('answers a teleport at the next tick instead of from inside the packet handler', (done) => {
        server.on('playerJoin', async (client) => {
          try {
            client.write('login', bot.test.generateLoginPacket())
            const chunk = bot.test.buildChunk()
            chunk.setBlockType(vec3(1, 65, 1), registry.blocksByName.stone.id)
            client.write('map_chunk', generateChunkPacket(chunk))
            await once(bot, 'chunkColumnLoad')
            const teleport = {
              x: 1.5,
              y: 80,
              z: 1.5,
              dx: 0,
              dy: 0,
              dz: 0,
              pitch: 0,
              yaw: 0,
              flags: bot.supportFeature('positionPacketHasBitflags') ? { x: false, y: false, z: false, yaw: false, pitch: false } : 0,
              teleportId: 0
            }
            client.write('position', teleport)
            await once(bot, 'forcedMove')

            const writes = []
            const write = bot._client.write.bind(bot._client)
            bot._client.write = (name, params) => { writes.push(name); return write(name, params) }
            try {
              await new Promise(resolve => bot.once('physicsTick', resolve))
              writes.length = 0
              bot._client.emit('position', { ...teleport, y: 90, teleportId: 1 })
              assert.deepStrictEqual(writes, [], 'the teleport must not be answered from inside the packet handler')
              await once(bot, 'forcedMove')
              assert.ok(writes.includes('position_look'), 'the teleport is answered on the next tick')
            } finally {
              bot._client.write = write
            }
            done()
          } catch (err) {
            done(err)
          }
        })
      })

      it('answers pings and teleports in the order the packets arrived', function (done) {
        if (bot.supportFeature('transactionPacketExists')) {
          this.skip()
          return
        }
        server.on('playerJoin', async (client) => {
          try {
            client.write('login', bot.test.generateLoginPacket())
            const chunk = bot.test.buildChunk()
            chunk.setBlockType(vec3(1, 65, 1), registry.blocksByName.stone.id)
            client.write('map_chunk', generateChunkPacket(chunk))
            await once(bot, 'chunkColumnLoad')
            const teleport = {
              x: 1.5,
              y: 80,
              z: 1.5,
              dx: 0,
              dy: 0,
              dz: 0,
              pitch: 0,
              yaw: 0,
              flags: bot.supportFeature('positionPacketHasBitflags') ? { x: false, y: false, z: false, yaw: false, pitch: false } : 0,
              teleportId: 0
            }
            client.write('position', teleport)
            await once(bot, 'forcedMove')

            const writes = []
            const write = bot._client.write.bind(bot._client)
            bot._client.write = (name, params) => { writes.push({ name, params }); return write(name, params) }
            try {
              await new Promise(resolve => bot.once('physicsTick', resolve))
              writes.length = 0
              // Between two ticks the server's ping, teleport and second ping arrive in that order.
              bot._client.emit('ping', { id: 1 })
              bot._client.emit('position', { ...teleport, y: 90, teleportId: 1 })
              bot._client.emit('ping', { id: 2 })
              assert.deepStrictEqual(writes, [], 'nothing is answered from inside the packet handlers')
              await once(bot, 'forcedMove')
              const replies = writes
                .filter(w => ['pong', 'teleport_confirm', 'position_look'].includes(w.name))
                .map(w => (w.name === 'pong' ? `pong ${w.params.id}` : w.name))
              assert.deepStrictEqual(replies, ['pong 1', 'teleport_confirm', 'position_look', 'pong 2'])
            } finally {
              bot._client.write = write
            }
            done()
          } catch (err) {
            done(err)
          }
        })
      })

      it('answers every teleport queued for a tick, in arrival order', (done) => {
        server.on('playerJoin', async (client) => {
          try {
            client.write('login', bot.test.generateLoginPacket())
            const chunk = bot.test.buildChunk()
            chunk.setBlockType(vec3(1, 65, 1), registry.blocksByName.stone.id)
            client.write('map_chunk', generateChunkPacket(chunk))
            await once(bot, 'chunkColumnLoad')
            const teleport = {
              x: 1.5,
              y: 80,
              z: 1.5,
              dx: 0,
              dy: 0,
              dz: 0,
              pitch: 0,
              yaw: 0,
              flags: bot.supportFeature('positionPacketHasBitflags') ? { x: false, y: false, z: false, yaw: false, pitch: false } : 0,
              teleportId: 0
            }
            client.write('position', teleport)
            await once(bot, 'forcedMove')

            const replies = []
            const write = bot._client.write.bind(bot._client)
            bot._client.write = (name, params) => {
              if (name === 'position_look') replies.push(params.y)
              return write(name, params)
            }
            try {
              await new Promise(resolve => bot.once('physicsTick', resolve))
              replies.length = 0
              bot._client.emit('position', { ...teleport, y: 90, teleportId: 1 })
              bot._client.emit('position', { ...teleport, y: 100, teleportId: 2 })
              await new Promise(resolve => bot.once('physicsTick', resolve))
              assert.deepStrictEqual(replies, [90, 100], 'each queued teleport gets its own reply on the same tick')
            } finally {
              bot._client.write = write
            }
            done()
          } catch (err) {
            done(err)
          }
        })
      })

      it('a rotation arriving after a queued teleport is not overwritten by it', (done) => {
        server.on('playerJoin', async (client) => {
          try {
            client.write('login', bot.test.generateLoginPacket())
            const chunk = bot.test.buildChunk()
            chunk.setBlockType(vec3(1, 65, 1), registry.blocksByName.stone.id)
            client.write('map_chunk', generateChunkPacket(chunk))
            await once(bot, 'chunkColumnLoad')
            const teleport = {
              x: 1.5,
              y: 80,
              z: 1.5,
              dx: 0,
              dy: 0,
              dz: 0,
              pitch: 0,
              yaw: 0,
              flags: bot.supportFeature('positionPacketHasBitflags') ? { x: false, y: false, z: false, yaw: false, pitch: false } : 0,
              teleportId: 0
            }
            client.write('position', teleport)
            await once(bot, 'forcedMove')

            const replies = []
            const write = bot._client.write.bind(bot._client)
            bot._client.write = (name, params) => {
              if (name === 'position_look') replies.push(params.yaw)
              return write(name, params)
            }
            try {
              await new Promise(resolve => bot.once('physicsTick', resolve))
              replies.length = 0
              bot._client.emit('position', { ...teleport, yaw: 30, teleportId: 1 })
              bot._client.emit('player_rotation', { yaw: 90, pitch: 0 })
              await once(bot, 'forcedMove')
              // the first position_look is the answer, the tick's own movement packet may follow it with the newer rotation
              assert.strictEqual(replies[0], 30, 'the teleport is answered with its own rotation')
              assert.strictEqual(bot.entity.yaw, require('../lib/conversions').fromNotchianYaw(90), 'the later rotation wins')
            } finally {
              bot._client.write = write
            }
            done()
          } catch (err) {
            done(err)
          }
        })
      })

      it('answers the teleport after a death at once on 1.19+: a late answer is an ignored teleport to Grim', function (done) {
        if (registry.version['<']('1.19')) return this.skip()
        server.on('playerJoin', async (client) => {
          try {
            await bot.test.pluginsLoaded
            client.write('login', bot.test.generateLoginPacket())
            const chunk = bot.test.buildChunk()
            chunk.setBlockType(vec3(1, 65, 1), registry.blocksByName.stone.id)
            client.write('map_chunk', generateChunkPacket(chunk))
            await once(bot, 'chunkColumnLoad')
            const teleport = { x: 1.5, y: 80, z: 1.5, dx: 0, dy: 0, dz: 0, pitch: 0, yaw: 0, flags: bot.supportFeature('positionPacketHasBitflags') ? {} : 0, teleportId: 0 }
            client.write('position', teleport)
            await once(bot, 'forcedMove')
            bot.emit('death')
            const answered = once(bot, 'forcedMove', 400)
            bot._client.emit('position', { ...teleport, y: 90, teleportId: 1 })
            await answered
            done()
          } catch (err) {
            done(err)
          }
        })
      })

      it('drops a teleport queued before a respawn but still answers pings', function (done) {
        server.on('playerJoin', async (client) => {
          try {
            client.write('login', bot.test.generateLoginPacket())
            const chunk = bot.test.buildChunk()
            chunk.setBlockType(vec3(1, 65, 1), registry.blocksByName.stone.id)
            client.write('map_chunk', generateChunkPacket(chunk))
            await once(bot, 'chunkColumnLoad')
            const teleport = {
              x: 1.5,
              y: 80,
              z: 1.5,
              dx: 0,
              dy: 0,
              dz: 0,
              pitch: 0,
              yaw: 0,
              flags: bot.supportFeature('positionPacketHasBitflags') ? { x: false, y: false, z: false, yaw: false, pitch: false } : 0,
              teleportId: 0
            }
            client.write('position', teleport)
            await once(bot, 'forcedMove')

            const writes = []
            const write = bot._client.write.bind(bot._client)
            bot._client.write = (name, params) => { writes.push(name); return write(name, params) }
            let forcedMoves = 0
            const onForcedMove = () => { forcedMoves++ }
            bot.on('forcedMove', onForcedMove)
            try {
              await new Promise(resolve => bot.once('physicsTick', resolve))
              writes.length = 0
              const pings = !bot.supportFeature('transactionPacketExists')
              if (pings) bot._client.emit('ping', { id: 1 })
              bot._client.emit('position', { ...teleport, y: 90, teleportId: 1 })
              bot.emit('respawn')
              await sleep(150)
              assert.ok(!writes.includes('teleport_confirm'), 'the old teleport is not confirmed')
              assert.ok(!writes.includes('position_look'), 'the old teleport is not answered')
              assert.strictEqual(forcedMoves, 0, 'physics is not re-enabled by the old teleport')
              if (pings) assert.ok(writes.includes('pong'), 'the ping is still answered')
            } finally {
              bot._client.write = write
              bot.off('forcedMove', onForcedMove)
            }
            done()
          } catch (err) {
            done(err)
          }
        })
      })

      it('drops queued replies when the client leaves the play state', (done) => {
        server.on('playerJoin', async (client) => {
          try {
            client.write('login', bot.test.generateLoginPacket())
            const chunk = bot.test.buildChunk()
            chunk.setBlockType(vec3(1, 65, 1), registry.blocksByName.stone.id)
            client.write('map_chunk', generateChunkPacket(chunk))
            await once(bot, 'chunkColumnLoad')
            const teleport = {
              x: 1.5,
              y: 80,
              z: 1.5,
              dx: 0,
              dy: 0,
              dz: 0,
              pitch: 0,
              yaw: 0,
              flags: bot.supportFeature('positionPacketHasBitflags') ? { x: false, y: false, z: false, yaw: false, pitch: false } : 0,
              teleportId: 0
            }
            client.write('position', teleport)
            await once(bot, 'forcedMove')

            const writes = []
            const write = bot._client.write.bind(bot._client)
            bot._client.write = (name, params) => { writes.push(name); return write(name, params) }
            try {
              await new Promise(resolve => bot.once('physicsTick', resolve))
              writes.length = 0
              bot._client.emit('position', { ...teleport, y: 90, teleportId: 1 })
              // Only the transition is simulated; the connection itself stays in play.
              bot._client.emit('state', 'configuration', 'play')
              await sleep(150)
              assert.ok(!writes.includes('position_look'), 'the teleport from the previous play session is not answered')
            } finally {
              bot._client.write = write
            }
            done()
          } catch (err) {
            done(err)
          }
        })
      })
    })

    // The packets the bot writes, checked against the order rules of the Grim anticheat (test/grimLint.js). Clients
    // from 1.21.2 on only: they end every tick with tick_end, which is what Grim's windows are built on.
    describe('grimLint', function () {
      this.timeout(30 * 1000)
      const hasTickEnd = registry.supportFeature('sendsClientTickEndPacket')
      const hasRotationPacket = registry.version['>=']('1.21.3')
      const chestPos = vec3(1, 65, 2)
      const names = (list) => list.map(p => p.name)
      let client, lint, received
      const players = new Set() // entity ids that are players, for the hit point rule of the lint

      // A stone floor at y = 64, a chest at (1, 65, 2), the bot standing at (1.5, 65, 4.5)
      async function join (onBlockPlace, { withLint = true } = {}) {
        const chunk = bot.test.buildChunk()
        for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) chunk.setBlockType(vec3(x, 64, z), registry.blocksByName.stone.id)
        chunk.setBlockType(chestPos, registry.blocksByName.chest.id)
        received = []
        await new Promise(resolve => {
          server.on('playerJoin', async (c) => {
            client = c
            await bot.test.pluginsLoaded
            client.on('packet', (data, meta) => {
              received.push({ name: meta.name, data })
              if (meta.name === 'block_place' && onBlockPlace) onBlockPlace(client, data)
            })
            client.write('login', bot.test.generateLoginPacket())
            client.write('map_chunk', generateChunkPacket(chunk))
            client.write('position', { x: 1.5, y: 65, z: 4.5, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: bot.registry.version['>=']('1.21.3') ? {} : 0, teleportId: 0 })
            client.write('update_health', { health: 20, food: 20, foodSaturation: 5 })
            await once(bot, 'chunkColumnLoad')
            await sleep(400) // lands on the floor
            resolve()
          })
        })
        bot.quickBarSlot = 0
        players.clear()
        if (withLint) lint = grimLint(bot, { players })
        received.length = 0
      }

      function flow (name, body) {
        it(name, async function () {
          if (!hasTickEnd) return this.skip()
          await join()
          await body.call(this)
          assert.deepStrictEqual(lint.violations, [])
        })
      }
      const give = (slot, name, count = 1) => bot.inventory.updateSlot(bot.QUICK_BAR_START + slot, new Item(registry.itemsByName[name].id, count))

      flow('walking: the keys are reported once per tick when they change, a tapped jump included', async () => {
        bot.setControlState('forward', true)
        await bot.waitForTicks(4)
        bot.setControlState('jump', true)
        bot.setControlState('jump', false) // released before the tick: the jump still counts
        await bot.waitForTicks(3)
        bot.clearControlStates()
        await bot.waitForTicks(3)
        const inputs = received.filter(p => p.name === 'player_input').map(p => p.data.inputs)
        // forward, forward + the tapped jump, forward again, nothing
        assert.deepStrictEqual(inputs.map(i => [i.forward, i.jump]), [[true, false], [true, true], [true, false], [false, false]])
      })

      flow('sprint and sneak: state, not events (once per tick, sneak first, vanilla stop rules)', async () => {
        bot.food = 20
        bot.setControlState('sprint', true) // no forward input yet: nothing starts
        await bot.waitForTicks(2)
        assert.strictEqual(received.filter(p => p.name === 'entity_action').length, 0)
        bot.setControlState('forward', true)
        await bot.waitForTicks(3)
        assert.strictEqual(bot.sprinting, true)
        // toggling inside one tick reports nothing: the state did not change
        bot.setControlState('sprint', false)
        bot.setControlState('sprint', true)
        bot.setControlState('sneak', true) // sneaking stops the sprint
        await bot.waitForTicks(3)
        assert.strictEqual(bot.sprinting, false)
        bot.setControlState('sneak', false)
        bot.food = 6 // too hungry to start
        await bot.waitForTicks(3)
        assert.strictEqual(bot.sprinting, false)
        bot.food = 20
        await bot.waitForTicks(3)
        assert.strictEqual(bot.sprinting, true)
        bot.setControlState('forward', false) // no forward input: stops
        await bot.waitForTicks(3)
        assert.strictEqual(bot.sprinting, false)
        bot.clearControlStates()
        await bot.waitForTicks(2)
        const actions = received.filter(p => p.name === 'entity_action').map(p => p.data.actionId)
        const sneakByAction = registry.version['<']('1.21.6')
        assert.deepStrictEqual(actions, sneakByAction
          ? ['start_sprinting', 'start_sneaking', 'stop_sprinting', 'stop_sneaking', 'start_sprinting', 'stop_sprinting']
          : ['start_sprinting', 'stop_sprinting', 'start_sprinting', 'stop_sprinting'])
      })

      flow('sprinting forward with the wall flag raised stays clean', async () => {
        bot.food = 20
        bot.setControlState('forward', true)
        bot.setControlState('sprint', true)
        await bot.waitForTicks(2)
        bot.entity.isCollidedHorizontally = true
        bot.entity.position.z = 4.5 // pushed back where it was, against nothing: the engine decides the contact
        await bot.waitForTicks(6)
        bot.clearControlStates()
        await bot.waitForTicks(2)
      })

      flow('eating: the use_item carries the rotation of the tick, the use is tracked until released', async () => {
        bot.food = 10
        give(0, 'bread', 3)
        bot.look(2.0, -0.2) // in flight when the item is used
        const eating = bot.activateItem()
        assert.strictEqual(bot.itemInUse, false, 'nothing is written before the tick')
        await eating
        assert.strictEqual(bot.itemInUse, true)
        assert.strictEqual(bot.usingHeldItem, true)
        // not even an entity_status of another entity ends it
        bot._client.emit('entity_status', { entityId: bot.entity.id + 1, entityStatus: 9 })
        assert.strictEqual(bot.itemInUse, true)
        await bot.waitForTicks(2)
        await bot.deactivateItem()
        assert.strictEqual(bot.itemInUse, false)
        const use = received.find(p => p.name === 'use_item')
        assert.ok(use, 'no use_item')
        const { toNotchianYaw, toNotchianPitch } = require('../lib/conversions')
        if (use.data.rotation) {
          assert.ok(Math.abs(use.data.rotation.x - toNotchianYaw(2.0)) < 0.2)
          assert.ok(Math.abs(use.data.rotation.y - toNotchianPitch(-0.2)) < 0.2)
        }
        bot._client.emit('entity_status', { entityId: bot.entity.id, entityStatus: 9 }) // used up
        bot.food = 10
        await bot.activateItem()
        assert.strictEqual(bot.itemInUse, true)
        bot._client.emit('entity_status', { entityId: bot.entity.id, entityStatus: 9 })
        assert.strictEqual(bot.itemInUse, false)
        await bot.activateItem()
        bot.setQuickBarSlot(1) // another slot in hand
        assert.strictEqual(bot.itemInUse, false)
      })

      flow('one action per tick: attack, use, swap, drop-in swing and held slot queued together', async () => {
        const Entity = require('prismarine-entity')(bot.version)
        const target = new Entity(77)
        target.position = vec3(1.5, 65, 1.5)
        bot.entities[77] = target
        give(0, 'bread')
        give(1, 'stone')
        const queued = [
          bot.attack(target),
          bot.activateItem(),
          bot.useOn(target),
          bot.deactivateItem(),
          bot.swingArm(),
          bot.swingArm(),
          bot.setQuickBarSlot(1)
        ]
        if (!bot.supportFeature('doesntHaveOffHandSlot')) queued.push(bot.vanilla.swapHands())
        await Promise.all(queued)
        const out = names(received).filter(n => !TICK_PACKETS.includes(n))
        // the held slot leaves first, then one action per tick with the swap ahead of it
        assert.strictEqual(out[0], 'held_item_slot')
        assert.ok(out.includes('arm_animation'))
      })

      flow('placing and breaking: the click, the swing and the dig packets stay inside their ticks', async () => {
        give(0, 'stone', 5)
        await bot._genericPlace({ position: vec3(1, 64, 2) }, vec3(0, 1, 0), { forceLook: 'ignore', swingArm: 'right' })
        await bot._genericPlace({ position: vec3(1, 64, 3) }, vec3(0, 1, 0), { forceLook: 'ignore', swingArm: 'right' })
        await bot.activateBlock({ position: vec3(1, 64, 2) }, vec3(0, 1, 0))
        bot.game.gameMode = 'creative'
        await bot.dig(bot.blockAt(vec3(1, 64, 3)))
        await bot.waitForTicks(2)
        const out = names(received)
        assert.ok(out.filter(n => n === 'block_place').length === 3)
        assert.ok(out.includes('block_dig'))
      })

      // --- digging, attacking, interacting, placing, riding: the packets of each tick -----------------------------

      // The packets written since `received` was cleared, each with the number of the tick (tick_end) it left in
      const timeline = () => {
        let tick = 0
        const out = []
        for (const p of received) {
          if (p.name === 'tick_end') tick++
          else out.push({ tick, name: p.name, data: p.data })
        }
        return out
      }
      const setBlock = (pos, name) => bot._updateBlockState(pos, registry.blocksByName[name].defaultState)
      const ticksOf = async (n) => { for (let i = 0; i < n; i++) await bot._input.nextTick() }
      const until = async (condition, what) => {
        for (let i = 0; i < 200 && !condition(); i++) await bot._input.nextTick()
        assert.ok(condition(), what)
      }
      const Entity = () => require('prismarine-entity')(bot.version)
      const addEntity = (id, position, o = {}) => {
        const entity = new (Entity())(id)
        Object.assign(entity, { position, width: 0.6, height: 1.8, type: 'mob' }, o)
        bot.entities[id] = entity
        if (entity.type === 'player') players.add(id)
        return entity
      }
      // 26.3 inserted CHANGE_DESTROY_DIRECTION at status 1: every status after START is one higher. digs() reports the old numbers
      const digs = () => timeline().filter(p => p.name === 'block_dig' && [0, 1 + statusShift, 2 + statusShift].includes(p.data.status))
        .map(p => ({ ...p, data: { ...p.data, status: p.data.status && p.data.status - statusShift } }))
      const swingTicks = () => timeline().filter(p => p.name === 'arm_animation').map(p => p.tick)
      const A = vec3(1, 65, 3)
      const B = vec3(2, 65, 3)

      flow('digging: START and its swing, a swing in every tick, FINISH and its swing on the completing tick', async () => {
        setBlock(A, 'stone')
        give(0, 'diamond_pickaxe')
        const block = bot.blockAt(A)
        const ticks = bot.digTime(block) / 50
        assert.ok(ticks >= 3 && ticks < 40, `${ticks} ticks to dig the block`)
        received.length = 0
        let completed = null
        bot.once('diggingCompleted', (b) => { completed = b })
        await bot.dig(block)
        await ticksOf(2)
        const dig = digs()
        assert.deepStrictEqual(dig.map(p => p.data.status), [0, 2])
        // the face the crosshair hits: the top, seen from the eyes above the block's centre line
        assert.strictEqual(dig[0].data.face, 1)
        assert.strictEqual(dig[1].data.face, 1)
        assert.strictEqual(dig[1].tick - dig[0].tick, ticks, 'FINISH follows START by the dig time in ticks')
        assert.strictEqual(dig[1].data.sequence, dig[0].data.sequence + 1)
        const swings = swingTicks().filter(t => t >= dig[0].tick && t <= dig[1].tick)
        assert.deepStrictEqual(swings, Array.from({ length: ticks + 1 }, (_, i) => dig[0].tick + i), 'a swing in every tick of the dig')
        const t = timeline()
        for (const [what, status] of [['START', 0], ['FINISH', 2 + statusShift]]) {
          const i = t.findIndex(p => p.name === 'block_dig' && p.data.status === status)
          assert.strictEqual(t[i + 1].name, 'arm_animation', `the swing follows ${what}`)
        }
        assert.strictEqual(bot.blockAt(A).name, 'air')
        assert.strictEqual(completed.name, 'air')
        assert.strictEqual(bot.targetDigBlock, null)
      })

      flow('digging two blocks: the next START is the 6th tick after the FINISH', async () => {
        setBlock(A, 'dirt')
        setBlock(B, 'dirt')
        give(0, 'diamond_shovel')
        received.length = 0
        await bot.dig(bot.blockAt(A))
        await bot.dig(bot.blockAt(B))
        await ticksOf(2)
        const dig = digs()
        assert.deepStrictEqual(dig.map(p => p.data.status), [0, 2, 0, 2])
        assert.strictEqual(dig[2].tick - dig[1].tick, 6)
        assert.strictEqual(dig[3].data.sequence, dig[2].data.sequence + 1)
      })

      flow('stopping a dig sends ABORT with face DOWN and sequence 0, and the block can be dug again', async () => {
        setBlock(A, 'stone')
        give(0, 'diamond_pickaxe')
        received.length = 0
        let aborted = null
        bot.once('diggingAborted', (b) => { aborted = b })
        const digging = bot.dig(bot.blockAt(A))
        await until(() => digs().length === 1, 'no START')
        await ticksOf(2)
        bot.stopDigging()
        await assert.rejects(digging, /aborted/)
        await ticksOf(2)
        const dig = digs()
        assert.deepStrictEqual(dig.map(p => p.data.status), [0, 1])
        assert.strictEqual(dig[1].data.face, 0)
        if (dig[1].data.sequence !== undefined) assert.strictEqual(dig[1].data.sequence, 0)
        assert.ok(dig[1].tick - dig[0].tick >= 2)
        assert.strictEqual(aborted.position.toString(), A.toString())
        assert.strictEqual(bot.targetDigBlock, null)
        await bot.dig(bot.blockAt(A))
        await ticksOf(2)
        assert.deepStrictEqual(digs().map(p => p.data.status), [0, 1, 0, 2])
      })

      flow('moving on to another block aborts the first one with the face of the new START', async () => {
        setBlock(A, 'stone')
        setBlock(B, 'stone')
        give(0, 'diamond_pickaxe')
        received.length = 0
        const first = bot.dig(bot.blockAt(A))
        first.catch(() => {})
        await until(() => digs().length === 1, 'no START')
        await ticksOf(2)
        await bot.dig(bot.blockAt(B))
        await assert.rejects(first, /aborted/)
        await ticksOf(2)
        const dig = digs()
        assert.deepStrictEqual(dig.map(p => p.data.status), [0, 1, 0, 2])
        assert.strictEqual(dig[1].tick, dig[2].tick, 'the abort and the new START leave in one tick')
        assert.strictEqual(dig[1].data.face, dig[2].data.face, 'the abort carries the face of the new START')
        assert.deepStrictEqual([dig[1].data.location.x, dig[2].data.location.x], [1, 2])
      })

      flow('stopDigging and a new dig between two ticks: nothing of the first dig is written for the second block', async () => {
        // (a queued FINISH used to re-read the target and land on the next block)
        setBlock(A, 'stone')
        setBlock(B, 'stone')
        give(0, 'diamond_pickaxe')
        const ticks = bot.digTime(bot.blockAt(A)) / 50
        received.length = 0
        // count the ticks from the bot's side: what the server received lags behind
        let sinceStart = null
        const write = bot._client.write
        bot._client.write = function (name, params) {
          if (name === 'block_dig' && params.status === 0) sinceStart = 0
          if (name === 'tick_end' && sinceStart !== null) sinceStart++
          return write.apply(this, arguments)
        }
        const first = bot.dig(bot.blockAt(A))
        first.catch(() => {})
        await until(() => sinceStart === ticks, 'the FINISH is due in the next tick')
        bot.stopDigging()
        const second = bot.dig(bot.blockAt(B))
        await second
        await ticksOf(2)
        const dig = digs().map(p => [p.data.status, p.data.location.x])
        assert.deepStrictEqual(dig, [[0, 1], [1, 1], [0, 2], [2, 2]])
        assert.strictEqual(bot.blockAt(B).name, 'air')
        assert.strictEqual(bot.blockAt(A).name, 'stone')
        assert.strictEqual(bot.targetDigBlock, null)
      })

      flow('one arm swing per tick while breaking, nothing else swings in between', async () => {
        setBlock(A, 'stone')
        give(0, 'diamond_pickaxe')
        received.length = 0
        await bot.dig(bot.blockAt(A))
        await ticksOf(2)
        const swings = swingTicks()
        assert.strictEqual(new Set(swings).size, swings.length, `swings per tick: ${swings}`)
      })

      flow('an instant break sends START only: a plant by hand, anything in creative (with the delay)', async () => {
        setBlock(A, 'dandelion')
        received.length = 0
        await bot.dig(bot.blockAt(A))
        await ticksOf(2)
        assert.deepStrictEqual(digs().map(p => p.data.status), [0])
        assert.strictEqual(bot.blockAt(A).name, 'air')
        assert.strictEqual(swingTicks().length, 1, 'one swing, in the tick of the START')
        // creative
        bot.game.gameMode = 'creative'
        setBlock(A, 'stone')
        setBlock(B, 'stone')
        received.length = 0
        await bot.dig(bot.blockAt(A))
        await bot.dig(bot.blockAt(B))
        await ticksOf(2)
        const dig = digs()
        assert.deepStrictEqual(dig.map(p => p.data.status), [0, 0])
        assert.strictEqual(dig[1].tick - dig[0].tick, 6, 'a creative START sets the same destroy delay')
      })

      flow('a dig refuses what a client could not click: a block that is gone, out of reach, or hidden', async () => {
        received.length = 0
        await assert.rejects(bot.dig(bot.blockAt(vec3(1, 65, 3))), err => err.code === 'no-sight') // air
        setBlock(vec3(1, 65, 12), 'stone')
        await assert.rejects(bot.dig(bot.blockAt(vec3(1, 65, 12))), err => err.code === 'too-far')
        setBlock(vec3(1, 62, 3), 'stone') // under the floor
        await assert.rejects(bot.dig(bot.blockAt(vec3(1, 62, 3))), err => err.code === 'no-sight')
        assert.deepStrictEqual(digs(), [])
        assert.strictEqual(bot.targetDigBlock, null)
        // the eyes' reach is 4.5, not the old 5.1 from the block's middle
        assert.strictEqual(bot.canDigBlock(bot.blockAt(vec3(1, 65, 12))), false)
        assert.strictEqual(bot.canDigBlock(bot.blockAt(vec3(1, 64, 3))), true)
      })

      flow('attacking: the head turns to the hitbox first, then the attack and the swing leave together', async () => {
        const target = addEntity(77, vec3(2.5, 65, 2.5))
        received.length = 0
        await bot.attack(target)
        await ticksOf(2)
        const t = timeline()
        const at = t.findIndex(p => p.name === 'attack' || (p.name === 'use_entity' && p.data.mouse === 1))
        assert.ok(at > 0, 'no attack')
        assert.strictEqual(t[at + 1].name, 'arm_animation')
        // the rotation the server has when the attack arrives points into the hitbox, within 3 blocks
        const rotation = t.slice(0, at).reverse().find(p => p.data.yaw !== undefined && p.data.pitch !== undefined)
        assert.ok(rotation, 'no rotation was sent before the attack')
        const eye = bot.entity.position.offset(0, bot.entity.eyeHeight, 0)
        const box = bot._aim.entityBox(target)
        const hit = bot._aim.rayBox(eye, bot._aim.rotationDirection(rotation.data), box.min, box.max)
        assert.ok(hit && hit.t <= 3, `the rotation does not hit the box within reach (${hit?.t})`)
        assert.ok(rotation.tick < t[at].tick, 'the rotation was settled in an earlier tick')
      })

      flow('attacking refuses an entity that is gone or out of reach, releases a used item first, and can skip the aim', async () => {
        const target = addEntity(77, vec3(2.5, 65, 2.5))
        const far = addEntity(78, vec3(1.5, 65, -6))
        received.length = 0
        await assert.rejects(bot.attack(far), err => err.code === 'too-far')
        assert.deepStrictEqual(await bot.vanilla.attackEntity(far), { ok: false, reason: 'too-far' })
        delete bot.entities[77]
        await assert.rejects(bot.attack(target), err => err.code === 'gone')
        await assert.rejects(bot.attack({ id: 999, position: vec3(0, 0, 0) }), err => err.code === 'gone')
        assert.deepStrictEqual(await bot.vanilla.attackEntity(target), { ok: false, reason: 'gone' })
        await ticksOf(2)
        assert.ok(!names(received).includes('attack') && !received.some(p => p.name === 'use_entity'), 'nothing was attacked')

        // eating: the use is released in a tick of its own, before the attack
        addEntity(77, vec3(2.5, 65, 2.5))
        give(0, 'bread', 3)
        bot.food = 10
        await bot.activateItem()
        assert.strictEqual(bot.usingHeldItem, true)
        received.length = 0
        await bot.attack(bot.entities[77])
        assert.strictEqual(bot.usingHeldItem, false)
        await ticksOf(2)
        const t = timeline()
        const release = t.find(p => p.name === 'block_dig' && p.data.status === 5 + statusShift)
        const attackPacket = t.find(p => p.name === 'attack' || (p.name === 'use_entity' && p.data.mouse === 1))
        assert.ok(release && attackPacket && release.tick < attackPacket.tick, 'the release comes in an earlier tick')

        // aim: false leaves the head alone
        await ticksOf(2)
        const yaw = bot.entity.yaw
        const pitch = bot.entity.pitch
        received.length = 0
        await bot.attack(bot.entities[77], { aim: false })
        await ticksOf(2)
        assert.deepStrictEqual([bot.entity.yaw, bot.entity.pitch], [yaw, pitch])
        assert.ok(received.some(p => p.name === 'attack' || (p.name === 'use_entity' && p.data.mouse === 1)))
        await assert.rejects(bot.attack(far, { aim: false }), err => err.code === 'too-far')
      })

      flow('interacting: the hit point lies inside the hitbox, INTERACT_AT and INTERACT agree', async () => {
        const target = addEntity(79, vec3(0.5, 65, 2.5), { type: 'player', username: 'other' })
        received.length = 0
        await bot.useOn(target)
        await bot.activateEntityAt(target, vec3(0.5, 90, 2.5)) // far above the hitbox: clamped into it
        assert.deepStrictEqual(await bot.vanilla.interactEntity(target), { ok: true })
        await ticksOf(2)
        const uses = timeline().filter(p => p.name === 'use_entity')
        const paired = !bot.supportFeature('attackUsesOwnPacket')
        assert.strictEqual(uses.length, paired ? 6 : 3)
        for (let i = 0; i < uses.length; i += paired ? 2 : 1) {
          const at = uses[i].data
          const point = paired ? at : at.location
          assert.ok(Math.abs(point.x) < 0.3001 && Math.abs(point.z) < 0.3001 && point.y > -0.0001 && point.y < 1.8001, `hit point ${point.x} ${point.y} ${point.z}`)
          if (paired) {
            assert.strictEqual(at.mouse, 2)
            assert.strictEqual(uses[i + 1].data.mouse, 0)
            assert.deepStrictEqual([uses[i + 1].data.target, uses[i + 1].data.hand, uses[i + 1].data.sneaking], [at.target, at.hand, at.sneaking])
            assert.strictEqual(uses[i + 1].tick, uses[i].tick, 'the pair leaves in one tick')
          }
        }
        // a stale id is refused
        delete bot.entities[79]
        await assert.rejects(bot.useOn(target), err => err.code === 'gone')
        await assert.rejects(bot.mount(target), err => err.code === 'gone')
      })

      flow('placing: the face and the point come from the ray-cast, a hidden face, a missing block and a far one are refused', async () => {
        give(0, 'stone', 9)
        const floor = bot.blockAt(vec3(2, 64, 3))
        received.length = 0
        await bot._genericPlace(floor, vec3(0, 1, 0), { swingArm: 'right' })
        await ticksOf(2)
        const t = timeline()
        const place = t.find(p => p.name === 'block_place')
        assert.ok(place)
        assert.strictEqual(place.data.direction, 1)
        const cursor = vec3(place.data.cursorX, place.data.cursorY, place.data.cursorZ)
        assert.ok(Math.abs(cursor.y - 1) < 1e-6, `the cursor ${cursor} is on the top face`)
        assert.ok(cursor.x > 0 && cursor.x < 1 && cursor.z > 0 && cursor.z < 1)
        assert.strictEqual(t[t.indexOf(place) + 1].name, 'arm_animation')
        // the rotation on the server points at that very point
        const rotation = t.slice(0, t.indexOf(place)).reverse().find(p => p.data.yaw !== undefined && p.data.pitch !== undefined)
        const eye = bot.entity.position.offset(0, bot.entity.eyeHeight, 0)
        const dir = bot._aim.rotationDirection(rotation.data)
        const k = (floor.position.y + 1 - eye.y) / dir.y
        assert.ok(eye.plus(dir.scaled(k)).distanceTo(floor.position.plus(cursor)) < 0.05, 'the head does not face the reported point')

        received.length = 0
        await assert.rejects(bot._genericPlace(floor, vec3(0, -1, 0), {}), err => err.code === 'no-sight') // the underside, from above
        await assert.rejects(bot._genericPlace({ position: vec3(5, 70, 5) }, vec3(0, 1, 0), {}), err => ['too-far', 'no-sight'].includes(err.code))
        await assert.rejects(bot._genericPlace(bot.blockAt(vec3(1, 64, 14)), vec3(0, 1, 0), {}), err => err.code === 'too-far')
        await ticksOf(2)
        assert.ok(!names(received).includes('block_place'), 'nothing was placed')

        // two placements asked for together go out in two ticks
        received.length = 0
        await Promise.all([
          bot._genericPlace(floor, vec3(0, 1, 0), { swingArm: 'right' }),
          bot._genericPlace(floor, vec3(0, 1, 0), { swingArm: 'right' })
        ])
        await ticksOf(2)
        const places = timeline().filter(p => p.name === 'block_place')
        assert.strictEqual(places.length, 2)
        assert.notStrictEqual(places[0].tick, places[1].tick)
      })

      flow('a click without a face aims for one: no default top face', async () => {
        give(0, 'stone')
        received.length = 0
        // the chest at (1, 65, 2) is seen from the south; a default top face would be above the eyes' plane
        await bot.activateBlock(bot.blockAt(chestPos))
        await ticksOf(2)
        const click = received.find(p => p.name === 'block_place')
        assert.ok(click)
        assert.strictEqual(click.data.direction, 3)
      })

      flow('starting to glide: the jump key is up when the start leaves, and goes down in the same tick', async () => {
        if (!bot.supportFeature('newPlayerInputPacket')) return
        bot.inventory.updateSlot(bot.getEquipmentDestSlot('torso'), new Item(registry.itemsByName.elytra.id, 1))
        bot.setControlState('jump', true)
        await ticksOf(3)
        assert.strictEqual(bot.entity.onGround, false)
        received.length = 0
        await bot.elytraFly()
        await ticksOf(3)
        const t = timeline().filter(p => ['entity_action', 'player_input'].includes(p.name))
        const names = t.map(p => p.name === 'entity_action' ? p.data.actionId : `input:${p.data.inputs.jump}`)
        // jump released (if it was down), then the start with the key going down right behind it
        const start = names.findIndex(n => /elytra|fall_flying/.test(n))
        assert.ok(start >= 0, names.join())
        assert.strictEqual(names[start + 1], 'input:true')
        assert.ok(!names.slice(0, start).includes('input:true'), 'the key was up when the start left')
        assert.strictEqual(t[start].tick, t[start + 1].tick, 'in one tick')
      })

      flow('riding: the keys go out once when they change, the shift key leaves, no sneak or sprint action', async () => {
        if (!bot.supportFeature('newPlayerInputPacket')) return
        bot.vehicle = addEntity(90, vec3(1.5, 65, 4.5), { type: 'object' })
        bot.emit('mount')
        received.length = 0
        bot.moveVehicle(1, 1)
        await ticksOf(4)
        bot.dismount()
        await ticksOf(6)
        bot.vehicle = null
        bot.emit('dismount')
        await ticksOf(3)
        const inputs = received.filter(p => p.name === 'player_input').map(p => p.data.inputs)
        assert.deepStrictEqual(inputs.map(i => [i.forward, i.left, i.shift]), [[true, true, false], [true, true, true], [true, true, false]])
        assert.ok(!received.some(p => p.name === 'entity_action'), 'no sneak or sprint action while riding')
        assert.strictEqual(bot.getControlState('forward'), false, 'the steering keys are released on the way out')
      })

      it('before 1.21.2 the keys of a ride go out as steer_vehicle in every tick, at most 0.98, the shift key leaves', async function () {
        if (bot.supportFeature('newPlayerInputPacket')) return this.skip()
        await join(undefined, { withLint: false })
        const boat = addEntity(90, vec3(1.5, 65, 4.5), { type: 'object' })
        bot.vehicle = boat
        bot.emit('mount')
        received.length = 0
        bot.moveVehicle(1, -1)
        await ticksOf(4)
        bot.dismount()
        await ticksOf(5)
        bot.vehicle = null
        bot.emit('dismount')
        await ticksOf(2)
        const steer = received.filter(p => p.name === 'steer_vehicle').map(p => p.data)
        assert.ok(steer.length >= 8, `${steer.length} steer_vehicle packets in 9 ticks`)
        for (const p of steer) assert.ok(Math.abs(p.sideways) <= Math.fround(0.98) && Math.abs(p.forward) <= Math.fround(0.98))
        assert.deepStrictEqual([steer[0].sideways, steer[0].forward, steer[0].jump], [Math.fround(0.98), -Math.fround(0.98), 0])
        assert.ok(steer.some(p => p.jump & 2), 'the shift key (unmount) is sent')
        assert.ok(!received.some(p => p.name === 'entity_action'), 'no sneak or sprint action while riding')
      })

      flow('a window: opened with a click, clicked and closed only once the movement keys are released', async function () {
        // the server answers the click with a chest window
        const pWindows = require('prismarine-windows')(supportedVersion)
        const chestData = pWindows.windows['minecraft:generic_9x3'] ?? { type: 'minecraft:chest', slots: 63 }
        client.on('packet', (data, meta) => {
          if (meta.name !== 'block_place') return
          client.write('open_window', { windowId: 1, inventoryType: chestData.type, windowTitle: chatText(''), slotCount: chestData.slots - 36, entityId: 0 })
          client.write('window_items', { windowId: 1, stateId: 1, items: Array.from({ length: chestData.slots }, () => Item.toNotch(null)), carriedItem: Item.toNotch(null) })
        })
        const window = await bot.vanilla.openContainer(bot.blockAt(chestPos))
        bot.setControlState('forward', true)
        await bot.waitForTicks(3)
        received.length = 0
        const closing = window.close()
        let closed = false
        closing.then(() => { closed = true })
        await bot.waitForTicks(2)
        assert.strictEqual(closed, false, 'the window stays open while a key is held')
        assert.ok(!names(received).includes('close_window'))
        bot.setControlState('forward', false)
        await closing
        await sleep(100)
        const order = names(received).filter(n => n === 'player_input' || n === 'close_window')
        assert.deepStrictEqual(order, ['player_input', 'close_window'], 'the zero input is out before the close')
        assert.strictEqual(received.filter(p => p.name === 'player_input').pop().data.inputs.forward, false)
        // and a click waits the same way
        bot.setControlState('forward', true)
        await bot.waitForTicks(2)
        received.length = 0
        const clicking = bot.clickWindow(5, 0, 0).catch(() => {})
        bot.setControlState('forward', false)
        await clicking
        const clickOrder = names(received).filter(n => n === 'player_input' || n === 'window_click')
        assert.ok(clickOrder.indexOf('player_input') < clickOrder.indexOf('window_click') || !clickOrder.includes('window_click'))
      })

      flow('a teleport and a server rotation are answered like the vanilla client does', async () => {
        const teleport = { x: 3.5, y: 65, z: 4.5, dx: 0, dy: 0, dz: 0, yaw: 30, pitch: 5, flags: bot.registry.version['>=']('1.21.3') ? {} : 0, teleportId: 1 }
        received.length = 0
        client.write('position', teleport)
        await once(bot, 'forcedMove')
        await bot.waitForTicks(2)
        const reply = received.find(p => p.name === 'position_look')
        assert.ok(reply)
        assert.strictEqual(reply.data.x, 3.5)
        assert.strictEqual(reply.data.yaw, 30)
        const confirm = names(received).indexOf('teleport_confirm')
        assert.ok(confirm >= 0 && confirm < names(received).indexOf('position_look'))
        // the bot kept the ground it stands on: the next steps use ground acceleration (keep-ground)
        assert.strictEqual(bot.entity.onGround, true)
        if (!hasRotationPacket) return
        received.length = 0
        client.write('player_rotation', { yaw: 90, pitch: 10, ...(registry.version['>=']('26.1') ? { relativeYaw: false, relativePitch: false } : {}) })
        await bot.waitForTicks(3)
        const rot = received.find(p => p.name === 'look' || p.name === 'position_look')
        assert.ok(rot, 'the server rotation is answered')
        assert.strictEqual(rot.data.yaw, 90)
        assert.strictEqual(rot.data.pitch, 10)
        assert.deepStrictEqual([rot.data.flags.onGround, rot.data.flags.hasHorizontalCollision], [false, false])
      })

      flow('a respawn starts again from nothing sent', async () => {
        const loginPacket = bot.test.generateLoginPacket()
        loginPacket.worldName = 'minecraft:overworld'
        bot.food = 20
        bot.setControlState('forward', true)
        bot.setControlState('sprint', true)
        await bot.waitForTicks(3)
        assert.strictEqual(bot.sprinting, true)
        received.length = 0
        bot.emit('death')
        bot.emit('respawn')
        client.write('position', { x: 1.5, y: 65, z: 4.5, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: bot.registry.version['>=']('1.21.3') ? {} : 0, teleportId: 7 })
        await once(bot, 'forcedMove')
        await bot.waitForTicks(3)
        const out = received.filter(p => ['player_input', 'entity_action'].includes(p.name)).map(p => p.name === 'entity_action' ? p.data.actionId : 'player_input')
        assert.deepStrictEqual(out, ['player_input', 'start_sprinting'], 'the keys held across the respawn are reported again')
        bot.clearControlStates()
        await bot.waitForTicks(2)
      })

      flow('looking: the pitch stays within +-90 degrees, the yaw takes the short way, a forced look does not jump', async () => {
        await assert.rejects(bot.look(NaN, 0), /finite/)
        await assert.rejects(bot.lookAt(vec3(NaN, 65, 0)), /finite/)
        const pitches = [Math.PI / 2, -Math.PI / 2, 1.5707, -1.5709, 3, -3, 0]
        for (let i = 0; i < 60; i++) {
          const yaw = (Math.random() - 0.5) * 30
          const pitch = i < pitches.length ? pitches[i] : (Math.random() - 0.5) * 4
          await bot.look(yaw, pitch, i % 2 === 0)
          assert.ok(Math.abs(bot.entity.pitch) <= Math.PI / 2 + 1e-9, `pitch ${bot.entity.pitch}`)
        }
        for (const packet of received.filter(p => p.data.yaw !== undefined && p.data.pitch !== undefined)) {
          assert.ok(Math.abs(packet.data.pitch) <= 90, `pitch ${packet.data.pitch}`)
        }
        // forcing over the wrap: 5.5 radians and then -0.5 are 0.28 radians apart
        await bot.look(5.5, 0)
        received.length = 0
        await bot.look(-0.5, 0, true)
        const yaws = received.filter(p => p.data.yaw !== undefined).map(p => p.data.yaw)
        assert.ok(yaws.length >= 1)
      })

      flow('easing a turn keeps the packets and the simulation on the same rotation', async () => {
        bot.physics.yawSpeed = 3 // rad/s: 8.6 degrees a tick
        bot.physics.pitchSpeed = 3
        try {
          await bot.look(2.5, 0.3)
          const yaws = received.filter(p => p.data.yaw !== undefined).map(p => p.data.yaw)
          assert.ok(yaws.length >= 3, 'the turn takes several ticks')
          for (let i = 1; i < yaws.length; i++) assert.ok(Math.abs(yaws[i] - yaws[i - 1]) <= 8.7, `${yaws[i - 1]} -> ${yaws[i]}`)
        } finally {
          bot.physics.yawSpeed = bot.physics.pitchSpeed = Infinity
        }
      })

      flow('the hotbar selection leaves first in a tick, a server selection is echoed with the next tick', async () => {
        give(0, 'bread')
        give(1, 'stone')
        received.length = 0
        client.write('held_item_slot', { slot: 5 })
        await bot.waitForTicks(3)
        assert.deepStrictEqual(received.filter(p => p.name === 'held_item_slot').map(p => p.data.slotId), [5])
        received.length = 0
        const selected = bot.setQuickBarSlot(1)
        const used = bot.activateItem()
        await Promise.all([selected, used])
        await sleep(100)
        const out = names(received).filter(n => ['held_item_slot', 'use_item', 'block_place'].includes(n))
        assert.deepStrictEqual(out, ['held_item_slot', registry.supportFeature('useItemWithOwnPacket') ? 'use_item' : 'block_place'])
      })

      flow('after a stall the ticks catch up by at most two', async () => {
        const stallUntil = Date.now() + 600
        while (Date.now() < stallUntil) { /* busy wait */ }
        await sleep(1000)
        assert.ok(lint.ticksPerSecond() <= 22, `${lint.ticksPerSecond()} ticks in a second`)
      })
    })

    describe('guards against what the Grim anticheat flags', () => {
      it('refuses a view distance below 2, a tab complete it would cancel', async () => {
        await bot.test.pluginsLoaded
        for (const viewDistance of [1, 0, -3, 1.5, 200]) {
          assert.throws(() => bot.setSettings({ viewDistance }), /invalid view distance/, `${viewDistance}`)
        }
        bot.settings.viewDistance = 'far'
        await assert.rejects(bot.tabComplete('x'.repeat(257), false, false), /at most 256/)
        await assert.rejects(bot.tabComplete('x'.repeat(65), false, false), /needs a space/)
        await assert.rejects(bot.tabComplete(`${'x'.repeat(70)} y`, false, false), /needs a space/)
      })

      it('knows how long an anvil name may be', () => {
        const anvilNameLimit = require('../lib/plugins/anvil').nameLimit
        assert.strictEqual(anvilNameLimit(registry), version['>=']('1.17') ? 50 : version['>=']('1.12') ? 35 : version['>=']('1.11.1') ? 31 : 30)
      })
    })

    describe('onceWithCleanup', () => {
      it('rejects instead of throwing out of emit when checkCondition throws', async () => {
        // A condition that throws used to unwind whatever was emitting. For a
        // client event that is the socket read path, which then stops delivering
        // packets entirely and the bot dies on the next keepalive.
        const emitter = new EventEmitter()
        const boom = new Error('condition blew up')
        const promise = onceWithCleanup(emitter, 'thing', {
          checkCondition: () => { throw boom }
        })
        assert.doesNotThrow(() => emitter.emit('thing'))
        await assert.rejects(promise, err => err === boom)
        assert.strictEqual(emitter.listenerCount('thing'), 0)
      })

      it('rejects and removes the listener when the signal is aborted', async () => {
        const emitter = new EventEmitter()
        const abort = new AbortController()
        const reason = new Error('no longer interested')
        const promise = onceWithCleanup(emitter, 'thing', { signal: abort.signal })
        abort.abort(reason)
        await assert.rejects(promise, err => err === reason)
        assert.strictEqual(emitter.listenerCount('thing'), 0)
      })
    })
  })
}

describe('mcdata overlay (26.2, 26.3)', () => {
  const overlay = require('../lib/mcdata/overlay')
  const minecraftData = require('minecraft-data')

  it('registers the data of each shipped version, and a second install changes nothing', () => {
    assert.deepStrictEqual(overlay.VERSIONS, ['26.2', '26.3'])
    const again = overlay.install()
    assert.ok(again.length >= 1 && again.every(r => r.data['26.2'] === 'installed' && r.data['26.3'] === 'installed'), JSON.stringify(again))
    for (const [version, protocol, blocks, items, entities] of [['26.2', 776, 1196, 1537, 158], ['26.3', 777, 1286, 1658, 161]]) {
      const data = minecraftData(version)
      assert.strictEqual(data.version.version, protocol)
      assert.strictEqual(minecraftData(String(protocol)).version.minecraftVersion, version, 'found by protocol number too')
      assert.deepStrictEqual([data.blocksArray.length, data.itemsArray.length, data.entitiesArray.length], [blocks, items, entities])
      assert.ok(data.attributesArray.length >= 40 && data.biomesArray.length === 66 && data.windowsByName.Crafter, 'inherited files')
      assert.ok(data.isNewerOrEqualTo('26.1') && data.supportFeature('newPlayerInputPacket'))
    }
    assert.ok(minecraftData('26.3').isNewerOrEqualTo('26.2') && minecraftData('26.2').isOlderThan('26.3'))
    // the old module name keeps working
    assert.strictEqual(require('../lib/mcdata/overlay26_2').install, overlay.install)
  })

  it('26.3 tool materials use the 26.3 item ids', () => {
    const data = minecraftData('26.3')
    const stone = data.blocksByName.stone
    const speeds = data.materials[stone.material]
    assert.strictEqual(speeds[data.itemsByName.diamond_pickaxe.id], 8)
    assert.strictEqual(speeds[data.itemsByName.wooden_pickaxe.id], 2)
    for (const block of data.blocksArray) {
      for (const id of Object.keys(block.harvestTools ?? {})) assert.ok(data.items[id], `${block.name} names tool item ${id}`)
    }
  })

  it('reads and writes the 26.3 entityDelta: flat and stepped, with the bytes of the wire format', () => {
    const serializer = mc.createSerializer({ state: 'play', isServer: true, version: '26.3' })
    const parser = mc.createDeserializer({ state: 'play', isServer: false, version: '26.3' })
    const encode = (name, params) => serializer.createPacketBuffer({ name, params })
    const flat = encode('rel_entity_move', { entityId: 5, move: { onGround: true, steps: [{ dX: 769, dY: -145, dZ: 0, ticks: 0 }] } })
    assert.deepStrictEqual([...flat.subarray(1)], [5, 1, 0x03, 0x01, 0xff, 0x6f, 0, 0], 'entity id, properties (on ground, no steps), three i16')
    const stepped = encode('entity_move_look', { entityId: 5, move: { onGround: false, steps: [{ dX: 1, dY: 2, dZ: 3, ticks: 2 }, { dX: 4, dY: 5, dZ: 6, ticks: 1 }] }, yaw: 1, pitch: 2 })
    assert.deepStrictEqual([...stepped.subarray(1)], [5, 4, 2, 0, 1, 0, 2, 0, 3, 1, 0, 4, 0, 5, 0, 6, 1, 2], 'properties 2 steps << 1, each ticks + three i16, yaw, pitch')
    for (const buffer of [flat, stepped]) {
      const back = parser.parsePacketBuffer(buffer).data.params
      assert.ok(back.move.steps.length >= 1)
      assert.ok(encode(parser.parsePacketBuffer(buffer).data.name, back).equals(buffer))
    }
    // a cut-off delta is a partial read (the fork's protodef guard may turn the throw into a skipped packet), never a packet
    const quiet = mc.createDeserializer({ state: 'play', isServer: false, version: '26.3', noErrorLogging: true })
    let cut = null
    try { cut = quiet.parsePacketBuffer(flat.subarray(0, flat.length - 2)) } catch (err) { assert.match(err.message, /entityDelta/) }
    assert.ok(!cut?.data?.params?.move)
  })
})
