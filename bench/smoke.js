#!/usr/bin/env node
// A real-server smoke run: starts flying-squid (see squid.js) and runs the bench against it.
//   node bench/smoke.js [--scenarios login,idle,...] [bench options]
const { getPort } = require('../test/common/util')
const { startSquid } = require('./squid')
const { parseArgs } = require('./lib/args')
const { runBench } = require('./lib/runner')
const { render } = require('./report')

async function main () {
  const port = await getPort()
  const squid = await startSquid({ port })
  if (!squid) {
    console.error('flying-squid not found: set BENCH_SQUID_DIR to a folder with flying-squid in its node_modules')
    process.exit(3)
  }
  const argv = process.argv.slice(2)
  if (!argv.includes('--scenarios')) argv.push('--scenarios', 'login,idle,look,walk,sprint,jump,sprintjump,sneak,reconnect')
  const opts = parseArgs([...argv, '--host', '127.0.0.1', '--port', String(port), '--version', '1.21.4', '--auth', 'offline', '--idle', '5s'])
  try {
    const report = await runBench(opts, { onScenario: (e) => console.log(`${e.status.toUpperCase().padEnd(5)} ${e.name}${e.reasons ? ': ' + e.reasons.join('; ') : e.reason ? ': ' + e.reason : ''}`) })
    console.log('\n' + render(report))
    process.exitCode = report.summary.failed ? 1 : 0
  } finally {
    squid.close()
    setTimeout(() => process.exit(), 200).unref()
  }
}

main()
