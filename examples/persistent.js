/*
 * Keeps a bot on a server and brings it back when it drops, within a login budget (6 an hour, kept in a file so a
 * restart of this script cannot spend it again; Microsoft logins 15 s apart across every bot in the process).
 *
 * Usage : node persistent.js <host> <port> <name> [microsoft]
 */
const mineflayer = require('mineflayer')

if (process.argv.length < 5) {
  console.log('Usage : node persistent.js <host> <port> <name> [microsoft]')
  process.exit(1)
}

const [host, port, username, auth] = process.argv.slice(2)

const pb = mineflayer.createPersistentBot({
  host,
  port: parseInt(port),
  username,
  auth: auth === 'microsoft' ? 'microsoft' : 'offline',
  reconnect: {
    store: mineflayer.fileStore('./logins.json', { key: username }),
    // add your own rules on top of the built-in ones: return nothing to keep them
    classify: (reason) => /maintenance/i.test(reason) ? 'wait' : undefined
  }
})

// every new bot, before it connects: load plugins and listeners here
pb.on('bot', (bot) => {
  bot.on('chat', (name, message) => console.log(`<${name}> ${message}`))
})

pb.on('msaCode', (data) => console.log(`Sign in: open ${data.verification_uri} and enter ${data.user_code}`))
pb.on('spawn', (bot) => console.log(`online as ${bot.username}`))
pb.on('end', (reason, decision) => {
  const when = decision.at ? `, next login at ${new Date(decision.at).toLocaleTimeString()}` : ''
  console.log(`disconnected (${reason}): ${decision.action} [${decision.cause}]${when}`)
})
pb.on('waiting', ({ until, loginsLastHour, perHour }) => {
  console.log(`login budget spent (${loginsLastHour}/${perHour} this hour), waiting until ${new Date(until).toLocaleTimeString()}`)
})
pb.on('stopped', (reason) => {
  console.log(`stopped: ${reason}`)
  process.exit(0)
})
pb.on('error', (err) => console.log('error:', err.message))

// a task that is cut short if the bot drops while it runs
async function loop () {
  for (;;) {
    try {
      await pb.run(async (bot, signal) => {
        while (!signal.aborted) {
          console.log(`health ${bot.health}, ${Object.keys(bot.players).length} players`)
          await new Promise(resolve => setTimeout(resolve, 30_000))
        }
      })
    } catch (err) {
      if (err.code === 'stopped') return
      if (err.code !== 'disconnected') throw err
    }
  }
}
loop().catch(err => { console.log(err); process.exit(1) })

process.on('SIGINT', () => pb.stop('interrupted'))
