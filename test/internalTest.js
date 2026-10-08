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

  const hasSignedChat = registry.supportFeature('signedChat')
  function chatText (text) {
    // TODO: move this to prismarine-chat in a new ChatMessage(text).toNotch(asNbt) method
    return registry.supportFeature('chatPacketsUseNbtComponents')
      ? nbt.comp({ text: nbt.string(text) })
      : JSON.stringify({ text })
  }

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
      skyLightMask: lights?.skyLightMask,
      blockLightMask: lights?.blockLightMask,
      emptySkyLightMask: lights?.emptySkyLightMask,
      emptyBlockLightMask: lights?.emptyBlockLightMask,
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
      it('swapHands writes block_dig status 6 with sequence 0', async function () {
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
        assert.strictEqual(dig[0].params.status, 6)
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
        assert.deepStrictEqual(relevant.map(w => [w.name, w.params.slotId ?? w.params.status]), [['held_item_slot', 3], ['block_dig', 6], ['held_item_slot', 0]])
        assert.strictEqual(await bot.vanilla.offhandFromHotbar(item => item.name === 'diamond'), false)
      })

      function hasSequenceField () {
        return registry.version['>=']('1.19')
      }
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
            const placed = bot.placeEntity({ position: vec3(1, 64, 1) }, vec3(0, 1, 0))
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

      // A stone floor at y = 64, a chest at (1, 65, 2), the bot standing at (1.5, 65, 4.5)
      async function join (onBlockPlace) {
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
        lint = grimLint(bot)
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
