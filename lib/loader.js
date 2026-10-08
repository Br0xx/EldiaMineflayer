require('./mcdata/overlay26_2').install() // Minecraft 26.2 (protocol 776); no-op once minecraft-data ships it
const mc = require('minecraft-protocol')
const { EventEmitter } = require('events')
const pluginLoader = require('./plugin_loader')
const { installProtodefGuard, protodefSkipped } = require('./protodef_guard')
const { installWatchdog } = require('./watchdog')
const { createPersistentBot, PersistentBot, fileStore } = require('./connection')
const plugins = {
  // the queue every action goes through (see input_queue.js): before the plugins that use it
  input_queue: require('./plugins/input_queue'),
  // where the crosshair ray hits, for the plugins that click, dig, place and attack
  aim: require('./plugins/aim'),
  abilities: require('./plugins/abilities'),
  bed: require('./plugins/bed'),
  title: require('./plugins/title'),
  block_actions: require('./plugins/block_actions'),
  blocks: require('./plugins/blocks'),
  book: require('./plugins/book'),
  boss_bar: require('./plugins/boss_bar'),
  breath: require('./plugins/breath'),
  chat: require('./plugins/chat'),
  chest: require('./plugins/chest'),
  command_block: require('./plugins/command_block'),
  craft: require('./plugins/craft'),
  creative: require('./plugins/creative'),
  digging: require('./plugins/digging'),
  enchantment_table: require('./plugins/enchantment_table'),
  entities: require('./plugins/entities'),
  experience: require('./plugins/experience'),
  explosion: require('./plugins/explosion'),
  fishing: require('./plugins/fishing'),
  furnace: require('./plugins/furnace'),
  game: require('./plugins/game'),
  health: require('./plugins/health'),
  inventory: require('./plugins/inventory'),
  kick: require('./plugins/kick'),
  physics: require('./plugins/physics'),
  place_block: require('./plugins/place_block'),
  rain: require('./plugins/rain'),
  ray_trace: require('./plugins/ray_trace'),
  resource_pack: require('./plugins/resource_pack'),
  scoreboard: require('./plugins/scoreboard'),
  team: require('./plugins/team'),
  settings: require('./plugins/settings'),
  simple_inventory: require('./plugins/simple_inventory'),
  sound: require('./plugins/sound'),
  spawn_point: require('./plugins/spawn_point'),
  tablist: require('./plugins/tablist'),
  time: require('./plugins/time'),
  villager: require('./plugins/villager'),
  anvil: require('./plugins/anvil'),
  place_entity: require('./plugins/place_entity'),
  generic_place: require('./plugins/generic_place'),
  particle: require('./plugins/particle'),
  sequence: require('./plugins/sequence'),
  vanilla_interact: require('./plugins/vanilla_interact')
}

const minecraftData = require('minecraft-data')
const { testedVersions, latestSupportedVersion, oldestSupportedVersion } = require('./version')
const latestSupportedProtocolVersion = minecraftData.versionsByMinecraftVersion.pc[latestSupportedVersion].version
if (!latestSupportedProtocolVersion) throw new Error(`Version '${latestSupportedVersion}' not supported by minecraft-data - is it up to date?`)

module.exports = {
  createBot,
  Location: require('./location'),
  Painting: require('./painting'),
  ScoreBoard: require('./scoreboard'),
  BossBar: require('./bossbar'),
  Particle: require('./particle'),
  createPersistentBot,
  PersistentBot,
  fileStore,
  latestSupportedVersion,
  oldestSupportedVersion,
  testedVersions,
  protodefSkipped,
  installProtodefGuard,
  supportFeature: (feature, version) => minecraftData(version).supportFeature(feature)
}

function createBot (options = {}) {
  options.username = options.username ?? 'Player'
  options.version = options.version ?? false
  options.plugins = options.plugins ?? {}
  // Dumping undecodable packets as hex to the console helps nobody on a server behind ViaBackwards
  options.hideErrors = options.hideErrors ?? true
  options.logErrors = options.logErrors ?? true
  options.loadInternalPlugins = options.loadInternalPlugins ?? true
  options.client = options.client ?? null
  options.brand = options.brand ?? 'vanilla'
  options.respawn = options.respawn ?? true
  // ViaBackwards sends packets minecraft-data's schema can't decode (vanilla can); the parse error would drop the bot
  options.skipUndecodablePackets = options.skipUndecodablePackets ?? true
  // Queue lag on 9b9t can exceed the 30 s the keep-alive check allows by default
  options.checkTimeoutInterval = options.checkTimeoutInterval ?? 60 * 1000
  options.socketTimeoutAfterLogin = options.socketTimeoutAfterLogin ?? true
  if (options.skipUndecodablePackets) installProtodefGuard()
  const bot = new EventEmitter()
  bot._client = options.client
  bot.end = (reason) => bot._client.end(reason)
  bot._warn = function (...message) {
    if (options.hideErrors) return
    console.warn('[mineflayer]', ...message)
  }
  if (options.logErrors) {
    bot.on('error', err => {
      if (!options.hideErrors) {
        console.log(err)
      }
    })
  }

  pluginLoader(bot, options)
  const internalPlugins = Object.keys(plugins)
    .filter(key => {
      if (typeof options.plugins[key] === 'function') return false
      if (options.plugins[key] === false) return false
      return options.plugins[key] || options.loadInternalPlugins
    }).map(key => plugins[key])
  const externalPlugins = Object.keys(options.plugins)
    .filter(key => {
      return typeof options.plugins[key] === 'function'
    }).map(key => options.plugins[key])
  bot.loadPlugins([...internalPlugins, ...externalPlugins])

  options.validateChannelProtocol = false
  if (!bot._client) {
    bot._client = mc.createClient(options)
    guardLateSocket(bot._client)
  }
  // Queue lag can leave the socket silent for longer than its idle timeout; keep-alive packets are the health check
  if (options.socketTimeoutAfterLogin) {
    bot.once('login', () => {
      try { bot._client.socket?.setTimeout(0) } catch { /* no real socket (custom stream) */ }
    })
  }
  bot._client.on('connect', () => {
    bot.emit('connect')
  })
  bot._client.on('error', (err) => {
    bot.emit('error', err)
  })
  bot._client.on('end', (reason) => {
    bot.emit('end', reason)
  })
  // ends a connection that went silent without erroring (see watchdog.js); `watchdog: false` turns it off
  installWatchdog(bot, options)
  if (!bot._client.wait_connect) next()
  else bot._client.once('connect_allowed', next)
  function next () {
    const serverPingVersion = bot._client.version
    bot.registry = require('prismarine-registry')(serverPingVersion)
    if (!bot.registry?.version) throw new Error(`Server version '${serverPingVersion}' is not supported, no data for version`)

    const versionData = bot.registry.version
    if (versionData['>'](latestSupportedVersion) && (versionData.version !== latestSupportedProtocolVersion)) {
      throw new Error(`Server version '${serverPingVersion}' is not supported. Latest supported version is '${latestSupportedVersion}'.`)
    } else if (versionData['<'](oldestSupportedVersion)) {
      throw new Error(`Server version '${serverPingVersion}' is not supported. Oldest supported version is '${oldestSupportedVersion}'.`)
    }

    bot.protocolVersion = versionData.version
    bot.majorVersion = versionData.majorVersion
    bot.version = versionData.minecraftVersion
    options.version = versionData.minecraftVersion
    bot.supportFeature = bot.registry.supportFeature
    setTimeout(() => bot.emit('inject_allowed'), 0)
  }
  return bot
}

// bot.end() during authentication (Microsoft sign-in takes a while) used to be forgotten: nothing ever reported
// 'end', and the socket still opened once the auth resolved (and, on other minecraft-protocol versions, the
// account logged in anyway). A socket handed to the client after end() is destroyed before it connects, and the
// bot reports 'end' at once.
function guardLateSocket (client) {
  let endedEarly = false
  const end = client.end
  client.end = function (reason) {
    if (!this.socket && !endedEarly) {
      endedEarly = true
      process.nextTick(() => this.emit('end', reason ?? 'socketClosed'))
    }
    return end.call(this, reason)
  }
  const setSocket = client.setSocket
  client.setSocket = function (socket) {
    if (!endedEarly) return setSocket.call(this, socket)
    socket.on('error', () => {})
    socket.destroy()
  }
}
