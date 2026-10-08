// flying-squid (a vanilla-like Node server, 1.21.4, no anticheat, no container support) for a smoke run of the bench.
// It is not a dependency of this repo: point BENCH_SQUID_DIR at a folder whose node_modules has flying-squid 1.12
// (EBS Lab's sandbox-server/ does), or install flying-squid next to the bench.
const fs = require('fs')
const path = require('path')
const Module = require('module')
const { EventEmitter } = require('events')

function findSquid () {
  const candidates = [process.env.BENCH_SQUID_DIR, path.join(process.cwd(), 'sandbox-server'), path.join(__dirname, '..', '..', 'EBSlab', 'sandbox-server'), '/home/user/EBSlab/sandbox-server', process.cwd()].filter(Boolean)
  for (const dir of candidates) {
    try {
      const req = Module.createRequire(path.join(path.resolve(dir), 'package.json'))
      req.resolve('flying-squid')
      return req
    } catch { /* next */ }
  }
  return null
}

// flying-squid opens a readline interface on stdin (which swallows Ctrl+C), and exits the process on any uncaught
// exception unless serv.debug is set
function quietStdin (fn) {
  const readline = require('readline')
  const original = readline.createInterface
  readline.createInterface = (o) => o?.input !== process.stdin
    ? original.call(readline, o)
    : Object.assign(new EventEmitter(), { setPrompt () {}, prompt () {}, close () {}, write () {}, line: '' })
  try { return fn() } finally { readline.createInterface = original }
}

async function startSquid ({ port, version = '1.21.4' } = {}) {
  const req = findSquid()
  if (!req) return null
  const { createMCServer } = quietStdin(() => req('flying-squid'))
  const serv = quietStdin(() => createMCServer({
    'online-mode': false,
    port,
    host: '127.0.0.1',
    'max-players': 5,
    version,
    motd: 'bench',
    logging: false,
    gameMode: 0,
    difficulty: 0,
    generation: { name: 'superflat', options: {} },
    kickTimeout: 30000,
    plugins: {},
    modpe: false,
    'view-distance': 4,
    'player-list-text': { header: { text: 'bench' }, footer: { text: '' } },
    'everybody-op': true,
    'max-entities': 100
  }))
  serv.debug = serv.debug ?? (() => {})
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('flying-squid did not start within 15 s')), 15000)
    const check = setInterval(() => { if (serv.isReady || serv.pluginsReady) { clearInterval(check); clearTimeout(timer); resolve() } }, 50)
  })
  return { serv, port, close: () => { try { serv._server.close() } catch { /* closed */ } } }
}

module.exports = { startSquid, findSquid, fs }
