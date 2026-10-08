module.exports = inject

// How long the vanilla loading screen waits for the level before it closes anyway
const LOADING_TIMEOUT_MS = 30000

function inject (bot, options) {
  bot.isAlive = true
  // Whether the server has placed the bot (a teleport was answered) since the last login / respawn
  let positioned = false
  let loadedWatch = 0
  let respawning = null

  bot.on('login', () => { positioned = false })
  bot.on('forcedMove', () => { positioned = true })

  // Whether the new player keeps the tracked data (the sprint and sneak flags) of the old one, as Grim reads it
  // (PacketPlayerRespawn.hasFlag). 1.20.5+: a bit mask (1 attributes, 2 metadata); 1.16-1.20.4: one flag for all of
  // it; before 1.16 the packet has no such field, and a server older than 1.15 (ViaVersion) keeps everything.
  function keepsTrackedData (packet) {
    const kept = packet.copyMetadata
    if (typeof kept === 'number') return (kept & 2) !== 0
    if (typeof kept === 'boolean') return kept
    return bot.registry.version['<']('1.15')
  }

  bot._client.on('respawn', (packet) => {
    bot.isAlive = false
    positioned = false
    bot.emit('respawn', { keepTrackedData: keepsTrackedData(packet) })
  })

  // 1.21.4+ servers ignore block and item interactions until the client has sent player_loaded (or 60 ticks have
  // passed). The vanilla client sends it when its loading screen closes: the server has placed the player and the
  // chunk it stands in is there (or 30 s are over). Sent in the input phase of a tick, behind the pong replies.
  const isLoaded = () => positioned && !!bot.entity?.position && bot.blockAt(bot.entity.position) != null
  async function sendPlayerLoaded () {
    if (!bot.supportFeature('sendsPlayerLoadedPacket')) return
    const mine = ++loadedWatch
    const deadline = Date.now() + LOADING_TIMEOUT_MS
    try {
      while (!isLoaded() && Date.now() < deadline) {
        await bot._input.nextTick()
        if (mine !== loadedWatch) return // another spawn took over
      }
      let written = false
      await bot._input.enqueue('command', () => {
        if (mine !== loadedWatch) return
        bot._client.write('player_loaded', {})
        written = true
      })
      if (written) bot.emit('playerLoaded') // after the tick it was written in
    } catch { /* the connection ended */ }
  }

  function spawn () {
    bot.emit('spawn')
    sendPlayerLoaded()
  }

  bot._client.once('update_health', (packet) => {
    if (packet.health > 0) {
      spawn()
    }
  })

  bot._client.on('update_health', (packet) => {
    bot.health = packet.health
    bot.food = packet.food
    bot.foodSaturation = packet.foodSaturation
    bot.emit('health')
    if (bot.health <= 0) {
      if (bot.isAlive) {
        bot.isAlive = false
        bot.emit('death')
      }
      if (!options.respawn) return
      bot.respawn()
    } else if (bot.health > 0 && !bot.isAlive) {
      bot.isAlive = true
      spawn()
    }
  })

  // PERFORM_RESPAWN. A player clicks the button some time after the death screen came up, never ahead of the
  // answers to the packets that announced the death: Grim sees the death only once those are answered
  // (BadPacketsM), and the pongs go out at the start of a tick. So it is written in the input phase of a tick.
  // onlyIfDead: nothing to ask for when the bot lives again by the time the tick comes.
  function requestRespawn (onlyIfDead) {
    if (respawning) return respawning
    const done = () => { respawning = null }
    respawning = bot._input.enqueue('command', () => {
      if (onlyIfDead && bot.isAlive) return
      bot._client.write('client_command', bot.supportFeature('respawnIsPayload') ? { payload: 0 } : { actionId: 0 })
    })
    respawning.then(done, done)
    return respawning
  }

  bot.respawn = () => {
    if (bot.isAlive) return
    return requestRespawn(true)
  }
  bot._requestRespawn = () => requestRespawn(false)
}
