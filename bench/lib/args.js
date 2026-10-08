const { parseDuration } = require('./util')

const DEFAULTS = {
  host: 'localhost',
  port: 25565,
  version: null, // null: detect from the server
  auth: 'offline',
  username: 'BenchBot',
  scenarios: null, // null: the default list
  modify: false,
  commands: false,
  radius: 16,
  json: null,
  duration: 60000, // the soak length
  idle: 10000, // how long the idle scenario stands still
  timeout: 120000, // per scenario
  loginTimeout: 120000,
  spacing: null, // between logins; null: 15 s for microsoft, 2 s otherwise
  maxContainers: 6,
  maxLogins: 6, // per hour, the soak stops rather than log in more often (the keeper's per-bot default)
  out: null,
  profiles: null,
  pathfinderFrom: null,
  mock: false,
  absolute: false,
  verbose: false,
  list: false,
  help: false
}

const FLAGS = new Set(['modify', 'commands', 'mock', 'absolute', 'verbose', 'list', 'help'])
const CAMEL = (k) => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())

function parseArgs (argv) {
  const opts = { ...DEFAULTS }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument "${arg}"`)
    let [key, value] = arg.slice(2).split(/=(.*)/s)
    key = CAMEL(key)
    if (!(key in DEFAULTS)) throw new Error(`unknown option --${arg.slice(2).split('=')[0]}`)
    if (FLAGS.has(key)) {
      opts[key] = value === undefined ? true : value !== 'false'
      continue
    }
    if (value === undefined) {
      value = argv[++i]
      if (value === undefined) throw new Error(`--${key} needs a value`)
    }
    opts[key] = value
  }
  opts.port = Number(opts.port)
  opts.radius = Number(opts.radius)
  opts.maxContainers = Number(opts.maxContainers)
  opts.maxLogins = Number(opts.maxLogins)
  for (const k of ['duration', 'idle', 'timeout', 'loginTimeout']) if (typeof opts[k] === 'string') opts[k] = parseDuration(opts[k])
  if (opts.spacing !== null) opts.spacing = parseDuration(opts.spacing)
  if (!['offline', 'microsoft'].includes(opts.auth)) throw new Error('--auth must be offline or microsoft')
  if (!Number.isFinite(opts.port) || !Number.isFinite(opts.radius)) throw new Error('--port and --radius must be numbers')
  if (typeof opts.scenarios === 'string') opts.scenarios = opts.scenarios.split(',').map(s => s.trim()).filter(Boolean)
  return opts
}

const USAGE = `usage: node bench/run.js --host H --port P --version V --auth offline|microsoft --username U [options]

  --scenarios a,b,c   which scenarios to run (default: all but soak; "all" includes soak; --list shows them)
  --modify            allow scenarios that change the world (dig, place)
  --commands          allow chat commands (never use on 9b9t: the bot must not talk there)
  --radius N          search radius for blocks and features around the bot (default 16)
  --duration T        soak length: 90, 90s, 5m, 1h (default 60s)
  --idle T            how long the idle scenario stands still (default 10s)
  --timeout T         limit per scenario (default 120s)
  --login-timeout T   limit for a login, microsoft device code and 9b9t queue included (default 120s)
  --spacing T         minimum time between two logins (default 15s for microsoft, 2s otherwise)
  --max-containers N  containers the container scenario opens (default 6)
  --max-logins N      logins per hour the soak may make before it stops (default 6; 0 = no limit)
  --json FILE         also write the report to FILE
  --out DIR           where traces go (default bench/out/<timestamp>)
  --profiles DIR      microsoft token cache (default bench/.auth)
  --pathfinder-from D where to find mineflayer-pathfinder (default: the bench's cwd)
  --absolute          write real coordinates (default: positions relative to where the bot first stood)
  --mock              run against an in-process mock server (a check of the bench itself)
  --verbose           print every step as it happens
`

module.exports = { parseArgs, USAGE, DEFAULTS }
