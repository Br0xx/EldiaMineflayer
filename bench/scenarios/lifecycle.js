const path = require('path')
const Module = require('module')
const { cellOf, center } = require('../lib/nav')
const { Inconclusive, hdist, round } = require('../lib/util')
const { openGround, outAndBack } = require('./common')

const pathfinder = {
  name: 'pathfinder',
  title: 'mineflayer-pathfinder (without the snap): go to a point 8 blocks away and back',
  needs: 'mineflayer-pathfinder installed in the working directory (or --pathfinder-from), and walkable ground',
  async run (ctx) {
    const bot = ctx.bot
    let api
    try {
      const from = path.resolve(ctx.opts.pathfinderFrom ?? process.cwd(), 'noop.js')
      api = require('../../pathfinder').loadPathfinder(Module.createRequire(from))
    } catch (err) {
      ctx.skip(`mineflayer-pathfinder is not available (${String(err.message).split('\n')[0]})`)
    }
    await ctx.grounded()
    const start = cellOf(bot.entity.position)
    const far = ctx.nav.search(start, (c) => hdist(center(c), center(start)) >= 8, { radius: 14, maxNodes: 4000 })
    if (!far) throw new Inconclusive('no walkable cell 8 blocks away')
    bot.loadPlugin(api.pathfinder)
    bot.pathfinder.setMovements(new api.Movements(bot))
    const go = async (c, what) => {
      let timer
      try {
        await Promise.race([
          bot.pathfinder.goto(new api.goals.GoalBlock(c.x, c.y, c.z)),
          new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`${what} took more than 40 s`)), 40000) })
        ])
      } catch (err) {
        ctx.fail(`pathfinder ${what}: ${err.message}`)
        bot.pathfinder.stop()
      } finally {
        clearTimeout(timer)
        bot.clearControlStates()
      }
      await ctx.ticks(10)
    }
    const t0 = Date.now()
    await go(far.cell, 'there')
    ctx.metric('thereMs', Date.now() - t0)
    ctx.expect(hdist(bot.entity.position, center(far.cell)) < 1.5, `the pathfinder stopped ${hdist(bot.entity.position, center(far.cell)).toFixed(2)} blocks from its goal`)
    await go(start, 'back')
    ctx.expect(hdist(bot.entity.position, center(start)) < 1.5, `the pathfinder stopped ${hdist(bot.entity.position, center(start)).toFixed(2)} blocks from where it started`)
    bot.pathfinder.setGoal(null)
  }
}

const reconnect = {
  name: 'reconnect',
  title: 'end the bot and log in again once',
  needs: 'a server that lets the account log in twice in a row (spaced as set with --spacing)',
  manageConnection: true,
  async run (ctx) {
    if (!ctx.session.alive) await ctx.connect()
    await ctx.ready()
    await ctx.ticks(10)
    const t0 = Date.now()
    const info = await ctx.reconnect()
    ctx.metric('msToSpawn', info.spawnMs)
    ctx.metric('msIncludingSpacing', Date.now() - t0)
    ctx.expect(!!ctx.bot.entity && Number.isFinite(ctx.bot.entity.position.x), 'no position after logging in again')
    await ctx.ready()
    await ctx.ticks(60)
  }
}

const soak = {
  name: 'soak',
  title: 'stay online for --duration: idle, look and short walks in a cycle',
  needs: 'ground to stand on; flat ground for the walks',
  manageConnection: true,
  timeout: (opts) => opts.duration + 300000,
  async run (ctx) {
    const end = Date.now() + ctx.opts.duration
    let revives = 0
    let cycles = 0
    if (!ctx.session.alive) await ctx.connect()
    const turn = async (yaw, pitch) => { await ctx.bot.look(yaw, pitch); await ctx.ticks(10) }
    while (Date.now() < end) {
      try {
        await ctx.ready()
        await ctx.sleep(Math.min(8000, Math.max(0, end - Date.now())))
        await turn(cycles * 1.3, 0.3)
        await turn(cycles * 1.3 + 2, -0.5)
        await turn(0, 0)
        if (Date.now() < end) {
          try {
            await ctx.grounded()
            const runs = await openGround(ctx, { minRun: 3, maxRun: 3, prefer: 1 })
            await outAndBack(ctx, runs[cycles % runs.length].dir, 2)
          } catch (err) {
            if (!(err instanceof Inconclusive)) throw err
            if (cycles === 0) ctx.note(`no walk in the cycle: ${err.reason}`)
          }
        }
        cycles++
      } catch (err) {
        if (!/^(disconnected|aborted)/.test(err.message) && !ctx.session.ended) throw err
        // A server that keeps kicking must not make the bench a login loop: stop at the keeper's hourly default
        const logins = ctx.loginsLastHour()
        if (ctx.opts.maxLogins > 0 && logins >= ctx.opts.maxLogins) {
          ctx.fail(`stopped: login budget (${logins} logins in the last hour, --max-logins ${ctx.opts.maxLogins})`)
          ctx.metric('stopped', 'login budget')
          break
        }
        if (++revives > 5) {
          ctx.fail('the bot was disconnected more than 5 times, soak stopped')
          break
        }
        ctx.note(`disconnected (${ctx.session.kickReason ?? 'no reason'}), logging in again`)
        await ctx.revive()
      }
    }
    ctx.metric('cycles', cycles)
    ctx.metric('relogins', revives)
    const mins = Math.max(1, ctx.frame.elapsed / 60000)
    ctx.metric('setbacksPerMinute', round(ctx.frame.setbacks.length / mins, 2))
    ctx.metric('kicksPerMinute', round(ctx.frame.kicks.length / mins, 2))
  }
}

module.exports = { pathfinder, reconnect, soak }
