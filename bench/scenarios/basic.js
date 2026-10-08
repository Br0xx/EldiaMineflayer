const { recordOut, isMovement } = require('./common')
const { round } = require('../lib/util')

// Poll (not tick based: the physics may not run yet)
async function waitFor (ctx, pred, ms, what) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return true
    await ctx.sleep(50)
  }
  ctx.fail(`${what} did not happen within ${ms / 1000} s`)
  return false
}

const login = {
  name: 'login',
  title: 'login, spawn, first chunk, state readable, player_loaded',
  needs: 'a reachable server',
  manageConnection: true,
  async run (ctx) {
    const info = await ctx.connect()
    const bot = ctx.bot
    const s = ctx.session
    ctx.metric('msToLogin', info.loginMs)
    ctx.metric('msToSpawn', info.spawnMs)
    await waitFor(ctx, () => info.firstChunkMs, 15000, 'the first chunk')
    ctx.metric('msToFirstChunk', info.firstChunkMs)
    await waitFor(ctx, () => info.firstForcedMoveMs, 15000, 'the placement teleport being answered')
    ctx.metric('msToFirstTeleport', info.firstForcedMoveMs)

    ctx.expect(Number.isFinite(bot.health) && bot.health > 0, `health is not readable (${bot.health})`)
    ctx.expect(Number.isFinite(bot.food) && bot.food >= 0 && bot.food <= 20, `food is not readable (${bot.food})`)
    const p = bot.entity?.position
    ctx.expect(p && Number.isFinite(p.x + p.y + p.z), 'the position is not readable')
    ctx.expect(typeof bot.game?.dimension === 'string' && bot.game.dimension.length > 0, `the dimension is not readable (${bot.game?.dimension})`)
    ctx.metric('version', bot.version)
    ctx.metric('protocol', bot.protocolVersion)
    ctx.metric('gameMode', bot.game?.gameMode)
    ctx.metric('dimension', bot.game?.dimension)
    ctx.metric('health', bot.health)
    ctx.metric('food', bot.food)
    ctx.metric('viewDistance', bot.game?.serverViewDistance)

    if (bot.supportFeature('sendsPlayerLoadedPacket')) {
      const seen = await waitFor(ctx, () => s.ring.some(r => r.dir === 'out' && r.name === 'player_loaded'), 10000, 'the player_loaded packet')
      if (seen) ctx.metric('playerLoaded', true)
    } else {
      ctx.note('this version has no player_loaded packet (1.21.4 and later send it)')
    }
    if (bot.supportFeature('sendsClientTickEndPacket')) {
      const rec = recordOut(ctx)
      await ctx.ticks(10)
      rec.stop()
      ctx.expect(rec.list.filter(r => r.rec.name === 'tick_end').length >= 9, 'tick_end is not sent every tick')
    }
    // a few quiet seconds after the placement: a server that is going to set the bot back usually does it now
    await ctx.ticks(40)
  }
}

const idle = {
  name: 'idle',
  title: 'stand still: no setbacks, one position per 20 ticks',
  needs: 'any ground to stand on',
  async run (ctx) {
    const bot = ctx.bot
    const s = ctx.session
    await ctx.grounded()
    await ctx.ticks(25) // the position reminder rhythm starts from the landing
    const rec = recordOut(ctx)
    const tick0 = s.tick
    const setbacks0 = ctx.frame.setbacks.length
    const t0 = Date.now()
    await ctx.sleep(ctx.opts.idle)
    const elapsed = (Date.now() - t0) / 1000
    rec.stop()
    const ticks = s.tick - tick0
    const tps = ticks / elapsed
    ctx.metric('seconds', round(elapsed, 2))
    ctx.metric('ticksPerSecond', round(tps, 2))
    ctx.expect(tps > 18 && tps < 21.5, `the tick rate is ${tps.toFixed(2)} per second (vanilla: 20)`)

    const moves = rec.list.filter(r => isMovement(r.rec.name))
    ctx.metric('movementPackets', moves.length)
    if (ctx.frame.setbacks.length > setbacks0) {
      ctx.note('a setback came during the idle window: its teleport reply upsets the movement packet cadence, which was not checked')
      return
    }
    const others = rec.list.filter(r => ['player_input', 'entity_action', 'arm_animation', 'block_dig', 'block_place', 'use_item', 'held_item_slot', 'window_click'].includes(r.rec.name))
    ctx.expect(others.length === 0, `an idle bot sent ${[...new Set(others.map(r => r.rec.name))].join(', ')}`)
    if (bot.supportFeature('positionUpdateSentEveryTick')) {
      ctx.note('this version sends a movement packet every tick: the cadence check is skipped')
      return
    }
    ctx.expect(!moves.some(r => r.rec.name === 'look'), 'an idle bot sent a look packet')
    const gaps = moves.slice(1).map((r, i) => r.rec.tick - moves[i].rec.tick)
    ctx.metric('positionGapsTicks', gaps)
    const wrong = gaps.filter(g => g !== 20)
    ctx.expect(wrong.length === 0, `idle movement packets should come every 20 ticks; gaps were ${gaps.join(', ')}`)
    const expected = Math.floor(ticks / 20)
    ctx.expect(Math.abs(moves.length - expected) <= 1, `${moves.length} movement packets in ${ticks} ticks, expected about ${expected} (one per 20 ticks)`)
  }
}

const look = {
  name: 'look',
  title: 'look in every direction, straight up and down',
  needs: 'nothing',
  async run (ctx) {
    const bot = ctx.bot
    const P = Math.PI
    await ctx.ready()
    const rec = recordOut(ctx)
    const turns = [
      [0, 0], [P / 2, 0], [P, 0], [1.5 * P, 0], [2 * P, 0], [2.5 * P, 0.3],
      [0, -P / 2], [P / 2, -P / 2], [0, P / 2], [P, P / 2], [0, 5], [0, -5], [3, 0.2], [-4, -0.4], [0, 0]
    ]
    for (const [yaw, pitch] of turns) {
      await bot.look(yaw, pitch)
      await ctx.ticks(4)
    }
    rec.stop()
    const rotations = rec.list.filter(r => r.params.yaw !== undefined && isMovement(r.rec.name)).map(r => r.params)
    const pitches = rotations.map(r => r.pitch)
    const max = Math.max(...pitches.map(Math.abs))
    ctx.metric('rotationPackets', rotations.length)
    ctx.metric('maxAbsPitch', round(max, 4))
    ctx.expect(rotations.every(r => Number.isFinite(r.yaw) && Number.isFinite(r.pitch)), 'a movement packet carried a non-finite rotation')
    ctx.expect(max <= 90, `a packet carried pitch ${max} (limit 90)`)
    ctx.expect(max > 89.5, `looking straight up or down reached only ${max} degrees of pitch`)
    const jumps = rotations.slice(1).map((r, i) => Math.abs(r.yaw - rotations[i].yaw))
    ctx.metric('maxYawStep', round(Math.max(0, ...jumps), 2))
    ctx.expect(Math.max(0, ...jumps) <= 180, 'the yaw jumped by more than 180 degrees in one packet')
    const pitch = bot.entity.pitch
    ctx.expect(Math.abs(pitch) < 0.01, `the head did not return to level (pitch ${pitch})`)
  }
}

module.exports = { login, idle, look, waitFor }
