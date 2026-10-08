module.exports = inject

function inject (bot) {
  // The reason as plain text (bot.kickReason), set before 'kicked' is emitted; null while not kicked
  bot.kickReason = null
  const kicked = (reason, loggedIn) => {
    try {
      bot.kickReason = require('prismarine-chat')(bot.registry).fromNotch(reason).toString()
    } catch {
      bot.kickReason = typeof reason === 'string' ? reason : JSON.stringify(reason)
    }
    bot.emit('kicked', reason, loggedIn)
  }
  bot._client.on('kick_disconnect', (packet) => kicked(packet.reason, true))
  bot._client.on('disconnect', (packet) => kicked(packet.reason, false))
  bot.quit = (reason) => {
    reason = reason ?? 'disconnect.quitting'
    bot.end(reason)
  }
}
