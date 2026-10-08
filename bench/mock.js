// A small in-process server (minecraft-protocol's server) for testing the bench itself: it accepts every
// movement, never sets the bot back unless asked to, sends a flat world with a few features and opens
// containers. It has no physics and no anticheat, so it proves the bench works, not that Grim is satisfied.
//
// World (blocks), the bot spawns at 8.5 65 8.5 on a stone floor (top at y 65):
//   a one-block step at 12..13 / 6..7, three stairs climbing east at 3..5 / 3, a pool at 2..4 / 12..14,
//   a pit (an edge) at 16..18 / 11..13, a chest at 10 65 3, a barrel at 3 65 8, an ender chest at 14 65 10
const mc = require('minecraft-protocol')
const crypto = require('crypto')
const { getPort } = require('../test/common/util')
const { sleep } = require('./lib/util')

const SPAWN = { x: 8.5, y: 65, z: 8.5 }
const CHEST = [10, 65, 3]
const BARREL = [3, 65, 8]
const ENDER = [14, 65, 10]

async function startMock ({ version = '1.21.4', chunks = 1 } = {}) {
  const registry = require('prismarine-registry')(version)
  if (!registry.supportFeature('usesLoginPacket')) throw new Error('the mock server speaks 1.16 and later')
  const Chunk = require('prismarine-chunk')(version)
  const Block = require('prismarine-block')(registry)
  const Item = require('prismarine-item')(registry)
  const vec3 = require('vec3')
  const id = (name) => registry.blocksByName[name].id
  const port = await getPort()
  const server = mc.createServer({ 'online-mode': false, version, port, host: '127.0.0.1' })
  // 26.2's login success carries a session id that minecraft-protocol's server doesn't fill in yet
  server.on('connection', client => {
    const write = client.write
    client.write = function (name, params) {
      if (name === 'success' && params.sessionId === undefined) params = { ...params, sessionId: crypto.randomUUID() }
      return write.call(this, name, params)
    }
  })

  const world = new Map() // 'x,y,z' -> block for the features
  const set = (x, y, z, block) => world.set(`${x},${y},${z}`, block)
  const simple = (name) => new Block(id(name), 0, 0)
  for (let x = 12; x <= 13; x++) for (let z = 6; z <= 7; z++) set(x, 65, z, simple('stone'))
  for (let i = 0; i < 3; i++) set(3 + i, 65 + i, 3, Block.fromProperties('oak_stairs', { facing: 'east', half: 'bottom', shape: 'straight', waterlogged: false }, 0))
  for (let x = 2; x <= 4; x++) for (let z = 12; z <= 14; z++) set(x, 64, z, Block.fromProperties('water', { level: 0 }, 0))
  for (let x = 16; x <= 18; x++) for (let z = 11; z <= 13; z++) { set(x, 64, z, simple('air')); set(x, 63, z, simple('air')) }
  set(...CHEST, Block.fromProperties('chest', { facing: 'south', type: 'single', waterlogged: false }, 0))
  set(...BARREL, Block.fromProperties('barrel', { facing: 'up', open: false }, 0))
  set(...ENDER, Block.fromProperties('ender_chest', { facing: 'south', waterlogged: false }, 0))

  function buildChunk (cx, cz) {
    const chunk = registry.supportFeature('tallWorld') ? new Chunk({ minY: -64, worldHeight: 384 }) : new Chunk()
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (const y of [63, 64]) chunk.setBlockType(vec3(x, y, z), id('stone'))
    for (const [key, block] of world) {
      const [x, y, z] = key.split(',').map(Number)
      if (Math.floor(x / 16) !== cx || Math.floor(z / 16) !== cz) continue
      chunk.setBlock(vec3(x - cx * 16, y, z - cz * 16), block)
    }
    const lights = chunk.dumpLight()
    return {
      x: cx,
      z: cz,
      groundUp: true,
      biomes: chunk.dumpBiomes !== undefined ? chunk.dumpBiomes() : undefined,
      heightmaps: { type: 'compound', name: '', value: { MOTION_BLOCKING: { type: 'longArray', value: new Array(36).fill([0, 0]) } } },
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

  const clients = new Set()
  let teleportId = 100
  const positionPacket = (x, y, z, flags = {}) => ({ x, y, z, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: registry.version['>=']('1.21.3') ? flags : 0, teleportId: ++teleportId })

  // Items shown in the containers: bread, a diamond, and a shulker box holding stone
  function containerItems () {
    const items = new Array(27).fill(null)
    items[0] = new Item(registry.itemsByName.bread.id, 3)
    items[1] = new Item(registry.itemsByName.diamond.id, 2)
    const shulker = new Item(registry.itemsByName.white_shulker_box.id, 1)
    if (registry.supportFeature('itemsWithComponents')) {
      shulker.components = [{ type: 'container', data: { contents: [Item.toNotch(new Item(registry.itemsByName.stone.id, 5))] } }]
      shulker.componentMap = new Map(shulker.components.map(c => [c.type, c]))
    }
    items[2] = shulker
    return items
  }

  server.on('playerJoin', async (client) => {
    clients.add(client)
    client.once('end', () => clients.delete(client))
    client.on('error', () => {})
    client.mock = { pos: { ...SPAWN }, windowId: 0, packets: [] }
    await sleep(20)
    const login = { ...registry.loginPacket, entityId: 0 }
    client.write('login', login)
    for (let cx = -chunks; cx <= chunks; cx++) for (let cz = -chunks; cz <= chunks; cz++) client.write('map_chunk', buildChunk(cx, cz))
    client.write('position', positionPacket(SPAWN.x, SPAWN.y, SPAWN.z))
    client.write('update_health', { health: 20, food: 20, foodSaturation: 5 })

    client.on('packet', (p, meta) => {
      client.mock.packets.push(meta.name)
      if (['position', 'position_look'].includes(meta.name)) client.mock.pos = { x: p.x, y: p.y, z: p.z }
      if (meta.name === 'block_place') {
        if (p.sequence !== undefined) client.write('acknowledge_player_digging', { sequenceId: p.sequence })
        const key = `${p.location.x},${p.location.y},${p.location.z}`
        const block = world.get(key)
        if (block && ['chest', 'barrel', 'ender_chest'].includes(block.name)) {
          const windowId = (client.mock.windowId = (client.mock.windowId % 100) + 1)
          client.write('open_window', { windowId, inventoryType: 2, windowTitle: { type: 'string', value: block.name } })
          client.write('window_items', { windowId, stateId: 1, items: [...containerItems(), ...new Array(36).fill(null)].map(i => Item.toNotch(i)), carriedItem: Item.toNotch(null) })
        }
      }
      if (meta.name === 'block_dig' && p.status === 2) {
        const loc = p.location
        set(loc.x, loc.y, loc.z, simple('air'))
        client.write('block_change', { location: loc, type: 0 })
        if (p.sequence !== undefined) client.write('acknowledge_player_digging', { sequenceId: p.sequence })
      }
    })
  })

  return {
    port,
    server,
    clients,
    features: { CHEST, BARREL, ENDER },
    // A setback: put every client somewhere else
    setback (dx = 0.5, dz = 0) {
      for (const c of clients) c.write('position', positionPacket(c.mock.pos.x + dx, c.mock.pos.y, c.mock.pos.z + dz))
    },
    kick (reason = 'bench mock kick') {
      for (const c of clients) c.end(reason)
    },
    say (text) {
      for (const c of clients) c.write('system_chat', { content: { type: 'string', value: text }, isActionBar: false })
    },
    close () {
      for (const c of clients) { try { c.end('mock closed') } catch { /* gone */ } }
      server.close()
    }
  }
}

module.exports = { startMock, SPAWN }
