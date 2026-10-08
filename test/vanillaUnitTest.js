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
})
