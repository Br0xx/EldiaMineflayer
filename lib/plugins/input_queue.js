module.exports = inject

// The vanilla client does all of its input inside the client tick, in a fixed order, and a packet written at any
// other moment is something the Grim anticheat can tell (Post, PacketOrder*, Multi*). The physics tick therefore
// opens the tick with this queue. Every API that makes the bot act (use an item, place, attack, swap hands, dig...)
// enqueues its packets here and its promise settles once they have gone out, inside a tick:
//
//   frame start   pong / teleport / player_rotation replies      (physics.js flushReplies)
//   1             held_item_slot, if the selection changed        (bot._ensureHasSentCarriedItem)
//   2             swap offhand and drop, client commands (respawn, player_loaded)
//   3             at most ONE primary action with its swing: release | attack | use | dig | pick
//   4             a bare swing
//   then          the simulation, player_input / sneak / sprint, the movement packet, tick_end
//
// Primary actions are mutually exclusive within a tick (PacketOrderI/J/M/N, MultiPlace, MultiActionsF): the
// first one queued goes out, the others wait for the next tick, which is what a person clicking twice costs too.
// What the vanilla order forbids can then not be written.

// Position in the tick. The primary actions share one phase and keep the order they were queued in.
const PHASE = { swap: 2, drop: 2, command: 2, release: 3, attack: 3, use: 3, dig: 3, pick: 3, swing: 4 }
const PRIMARY = new Set(['release', 'attack', 'use', 'dig', 'pick'])

function noop () {}

function inject (bot) {
  let pending = []
  const settled = []
  const hooks = []
  const carriedWaiters = []
  const tickWaiters = []
  let active = false
  let closed = false

  // A rejected promise nobody handles would take the process down: callers that fire and forget (activateItem(),
  // swingArm()) keep working, callers that await still see the error.
  function task (cls, send) {
    const item = { cls, send, phase: PHASE[cls] }
    item.promise = new Promise((resolve, reject) => { item.resolve = resolve; item.reject = reject })
    item.promise.catch(noop)
    return item
  }

  function conflicts (cls, sent) {
    if (PRIMARY.has(cls)) return sent.primary
    if (cls === 'swap') return sent.classes.has('drop') // PacketOrderL: no swap after a drop
    if (cls === 'swing') return sent.classes.has('swing')
    return false
  }

  bot._input = {
    // send(rot) runs inside a tick, after the replies and before the movement packet. rot is the rotation that
    // tick's movement packet carries: { yaw, pitch } in degrees as the float the packet holds. The promise resolves
    // with send's return value once the tick is over, and rejects with what send threw.
    enqueue (cls, send) {
      if (!(cls in PHASE)) throw new Error(`unknown input class ${cls}`)
      const item = task(cls, send)
      if (closed) item.reject(new Error('The bot has ended'))
      else pending.push(item)
      return item.promise
    },

    // Work that has to run every tick after the queue (a dig's progress). fn(rot, primarySent)
    onTick (fn) {
      hooks.push(fn)
    },

    // Resolves once the next held_item_slot packet (if one is due) has gone out. Called by setQuickBarSlot.
    carriedSent (due) {
      if (!due || closed) return Promise.resolve()
      return new Promise(resolve => carriedWaiters.push(resolve))
    },

    // Resolves when the current/next tick is over, whether or not the bot is simulated (waitForTicks needs a simulation)
    nextTick () {
      if (closed) return Promise.reject(new Error('The bot has ended'))
      return new Promise((resolve, reject) => tickWaiters.push({ resolve, reject }))
    },

    // Runs the input phase of one tick. Called by the physics tick only.
    flush (rot) {
      active = true
      try {
        if (bot._ensureHasSentCarriedItem) bot._ensureHasSentCarriedItem()
        for (const resolve of carriedWaiters.splice(0)) settled.push(resolve)
        const batch = pending
        pending = []
        // Stable: first come first served within a phase
        batch.sort((a, b) => a.phase - b.phase)
        const sent = { classes: new Set(), primary: false }
        const waiting = []
        for (const item of batch) {
          if (conflicts(item.cls, sent)) {
            waiting.push(item)
            continue
          }
          try {
            const result = item.send(rot)
            settled.push(() => item.resolve(result))
          } catch (err) {
            settled.push(() => item.reject(err))
          }
          sent.classes.add(item.cls)
          if (PRIMARY.has(item.cls)) sent.primary = true
        }
        // what waited is older than whatever the sends queued meanwhile
        pending = waiting.concat(pending)
        for (const hook of hooks) hook(rot, sent.primary)
      } finally {
        active = false
      }
    },

    // The tick is over (tick_end is written): let the callers continue.
    afterTick () {
      while (settled.length) settled.shift()()
      for (const waiter of tickWaiters.splice(0)) waiter.resolve()
    },

    // true while flush() runs: a packet written now is part of the input phase
    get active () {
      return active
    },

    get pending () {
      return pending.length
    },

    // The connection is gone: nothing queued will ever be written
    abort (err = new Error('The bot has ended')) {
      closed = true
      const dropped = pending
      pending = []
      for (const item of dropped) item.reject(err)
      for (const resolve of carriedWaiters.splice(0)) resolve()
      for (const waiter of tickWaiters.splice(0)) waiter.reject(err)
    }
  }

  bot.on('end', () => bot._input.abort())
}
