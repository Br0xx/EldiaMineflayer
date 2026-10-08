'use strict'

// A dead TCP connection (a NAT or proxy that dropped the flow, a TCPShield node that went away) never errors:
// the socket just stays quiet, and `read ETIMEDOUT` can take minutes to surface. The keep-alive check of
// minecraft-protocol only arms after the first keep-alive and does not run in every state, so this watches the
// one thing every live connection does, which is receive bytes.
//
// minecraft-protocol answers a keep-alive synchronously from the packet handler, ahead of any bot logic, so the
// reply is as early as the event loop allows. A stalled loop delays the read as well, and nothing here can change
// that; what it must not do is blame the server for the stall (see `stalled` below).

const DEFAULTS = { enabled: true, silenceMs: 90_000 }

function resolveWatchdog (option) {
  if (option === false) return { ...DEFAULTS, enabled: false }
  const given = option && typeof option === 'object' ? option : {}
  const silenceMs = given.silenceMs ?? DEFAULTS.silenceMs
  return {
    enabled: given.enabled ?? true,
    silenceMs,
    // a server may stay quiet while it moves the client through the configuration phase (transfer, registry resync)
    configurationSilenceMs: given.configurationSilenceMs ?? silenceMs * 2,
    checkIntervalMs: given.checkIntervalMs ?? Math.max(10, Math.min(5000, silenceMs / 4))
  }
}

// Tracks `bot.lastPacketAt` always, and ends the client with reason 'watchdog' when the bot is logged in and
// nothing has arrived for `silenceMs`. It only starts at 'login': before that the server may legitimately hold a
// connection silent (the 9b9t queue), and PersistentBot's loginTimeoutMs covers that part.
function installWatchdog (bot, options = {}) {
  const config = resolveWatchdog(options.watchdog)
  const client = bot._client
  bot.lastPacketAt = null
  let timer = null
  let attached = false

  const touch = () => { bot.lastPacketAt = Date.now() }
  client.on('packet', touch)
  // the socket sees partial packets and bundles that the packet event holds back
  const attachSocket = () => {
    if (attached || !client.socket?.on) return
    attached = true
    client.socket.on('data', touch)
  }
  attachSocket()
  client.on('connect', attachSocket)
  client.once('end', stop)

  if (config.enabled) bot.once('login', start)

  function stop () {
    clearInterval(timer)
    timer = null
  }

  function start () {
    if (timer || client.ended) return
    touch()
    let lastCheck = Date.now()
    let graceFrom = 0
    timer = setInterval(() => {
      const now = Date.now()
      // A blocked event loop runs this timer before it reads the packets that arrived meanwhile. A check that
      // came far too late forgives the silence up to now instead of ending a healthy connection.
      const stalled = now - lastCheck > config.checkIntervalMs * 3
      lastCheck = now
      if (stalled) { graceFrom = now; return }
      const limit = client.state === 'configuration' ? config.configurationSilenceMs : config.silenceMs
      const silentMs = now - Math.max(bot.lastPacketAt ?? 0, graceFrom)
      if (silentMs < limit) return
      stop()
      bot.emit('watchdog', silentMs)
      // end() alone waits for the dead socket to flush and close, which is what never happens
      client.end('watchdog')
      client.socket?.destroy()
    }, config.checkIntervalMs)
    timer.unref?.()
  }
}

module.exports = { installWatchdog, resolveWatchdog }
