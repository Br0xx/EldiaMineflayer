#!/usr/bin/env node
// 9bFlayer live test bench. See docs/9bflayer/bench.md.
const { parseArgs, USAGE } = require('./lib/args')
const { scenarios, DEFAULT_ORDER } = require('./scenarios')

async function main () {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`)
    process.exit(2)
  }
  if (opts.help) return console.log(USAGE)
  if (opts.list) {
    for (const s of scenarios) console.log(`${s.name.padEnd(11)} ${DEFAULT_ORDER.includes(s.name) ? ' ' : '*'} ${s.title}\n${' '.repeat(14)}needs: ${s.needs}${s.modify ? ' [--modify]' : ''}`)
    return console.log('\n* only when named in --scenarios (or "all")')
  }
  const { runBench } = require('./lib/runner')
  const { render } = require('./report')
  let mock = null
  if (opts.mock) {
    mock = await require('./mock').startMock({ version: opts.version ?? '1.21.4' })
    Object.assign(opts, { host: '127.0.0.1', port: mock.port, version: opts.version ?? '1.21.4' })
  }
  process.once('SIGINT', () => {
    console.error('\ninterrupted: report.json in the output folder holds the scenarios that finished')
    process.exit(130)
  })
  try {
    const report = await runBench(opts, { onScenario: (e) => console.log(`${e.status.toUpperCase().padEnd(5)} ${e.name} (${(e.durationMs / 1000).toFixed(1)} s)${e.status === 'skipped' ? ': ' + e.reason : e.reasons ? ': ' + e.reasons.join('; ') : ''}`) })
    console.log('\n' + render(report))
    process.exitCode = report.summary.failed ? 1 : 0
  } catch (err) {
    console.error(err.stack)
    process.exitCode = 2
  } finally {
    mock?.close()
    setTimeout(() => process.exit(), 200).unref()
  }
}

main()
