# Adversarial review of 9bFlayer, second wave (4351c6a..70800b6), committed state

Reviewer: Claude (Fable 5.1), 2026-10-08. Read-only. The committed tree is archived in
`/home/user/ref/review-scratch2/committed/` (`git archive 70800b6`); line numbers below are from it. Repro scripts:
`/home/user/ref/review-scratch2/{budgetrace,doublechest,lateclose}.js` (run with
`NODE_PATH=/home/user/EldiaMineflayer/node_modules node <script>`). First-wave findings
(`review-fable.md`) are not repeated.

Ground truth: Grim @ f5bbe9c (`/home/user/ref/grim`), minecraft-protocol 1.68.0, minecraft-data 3.117.0. Offline suites on
70800b6 all pass: `internalTest -g 1.21.4v` 118 (4 pending), `physicsVanillaTest` 110, `connectionTest` 33,
`vanillaUnitTest + bench/bench.test.js` 40.

## Ranked findings

### 1. `bot.elytraFly()` glides one round trip late: Grim predicts a glide from the START packet, the fork still simulates a fall  (severity: high for anyone using the elytra, confidence: high on the mechanism, not run live)

`lib/plugins/physics.js:227` runs `physics.simulatePlayer` with `PlayerState.elytraFlying = bot.entity.elytraFlying`
(`engine.js:1788`), and only *afterwards* `syncInputState(controls, tapped, elytra !== null)` (`:236`, `:602-607`) writes
`start_elytra_flying`, then the movement packet. `bot.entity.elytraFlying` is set nowhere locally: it only becomes true
when the server's shared-flags metadata arrives (`entities.js:433-441`, `:516`, `:568`). The engine itself never sets it
(`engine.js:1704` only clears it).

The vanilla client sets the fall-flying flag itself in the tick of the start (`LocalPlayer.aiStep` →
`tryToStartFallFlying()` → `startFallFlying()` before `super.aiStep()` travels), so the movement packet of that tick is
already a glide. Grim does the same: `PacketEntityAction.java:49-69` sets `player.isGliding = true` on
`START_FLYING_WITH_ELYTRA` (1.15+ client, `canGlide()`), and `PacketSelfMetadataListener.java:92-95` only re-syncs later
from the metadata. There is no leniency window for a gliding change (`lastFlyingStatusChange`,
`PredictionEngine.java:511`, is creative flight only; `UncertaintyHandler` mentions gliding only for fireworks and 0.03).

So from the START tick until the metadata is back (1 RTT, 1-4 ticks on 9b9t) Grim predicts
`travelFallFlying` while the bot sends falling physics. At level pitch: glide `vy += g * (-1 + 0.75) = -0.02`, fall
`vy -= 0.08`: 0.06 blocks off in the first tick, horizontal too. That is a Simulation flag and setback every time
the bot starts gliding (`checks/impl/prediction`, threshold 1e-4..1e-3).

Fix: start the glide locally like vanilla, in the same tick, before the simulation:

```text
// physics.js runTick, before physics.simulatePlayer:
const elytra = elytraStart; elytraStart = null
if (elytra && !bot.entity.onGround && !bot.entity.isInWater && bot.inventory.slots[6]?.name === 'elytra') {
  bot.entity.elytraFlying = true          // LocalPlayer.startFallFlying(): the client glides in this tick
}
...
syncInputState(controls, tapped, elytra !== null)   // the START still goes out ahead of player_input / movement
```

and keep the metadata as the authority afterwards (the server clears the flag when it refuses). `physicsVanillaTest.js`
sets `e.elytraFlying = true` by hand (`:944`, `:1112`), which is why the suite does not see this.

### 2. Dimension change (respawn with "keep tracked data"): the fork forgets the sprint the server and Grim keep  (severity: medium, confidence: high on fork + Grim, medium-high on the vanilla client)

`physics.js:995-1005` `bot.on('respawn')` → `resetClientPlayer()` (`:109-120`) sets `sprinting = false` and
`sent.sprint = false` on **every** respawn. Grim's `PacketPlayerRespawn.java:168-190` only resets `isSprinting` when the
respawn packet lacks `KEEP_TRACKED_DATA`, i.e. on death; on a portal / `/execute in` respawn (1.20.2+ servers set the
keep-metadata bit) Grim keeps `isSprinting = true`. The vanilla client agrees: `handleRespawn` creates the new
`LocalPlayer` with `createPlayer(level, stats, book, isShiftKeyDown(), isSprinting())`, whose constructor stores the
second flag as `wasSprinting` (the "last sent" state), and with keep-tracked-data it copies the entity data
(`assignValues(getNonDefaultValues())`), so the sprinting shared flag survives too. Result on vanilla: no packet is sent
and the player keeps sprinting; the first tick without forward impulse sends STOP_SPRINTING.

The fork after a portal while sprinting: `sprinting = false` with `sent.sprint = false`, so when the pathfinder's goal is
reached (keys released) nothing is sent, and Grim stays at `isSprinting = true` (×1.3 speed in its prediction) until the
fork's next full sprint cycle (START, then STOP). Any walking in between is predicted 0.02-0.03 blocks/tick too fast →
Simulation setbacks. The sneak reset is fine (Grim resets `isSneaking` on every respawn for 1.20+).

Fix: read the respawn packet's flags and keep the sprint state when metadata is kept:

```text
// health.js already has bot._client.on('respawn', packet => …): pass the flag along
bot.emit('respawn', { keepTrackedData: !!(packet.dataKept & 2 /* 1.20.2+ */ || packet.copyMetadata) })
// physics.js
bot.on('respawn', (info) => {
  const keepSprint = info?.keepTrackedData ? sprinting : false
  resetClientPlayer(); sprinting = sent.sprint = keepSprint
  ...
})
```

(`dataKept` bit 1 = attributes, bit 2 = metadata on 1.20.2+; `copyMetadata` on 1.19.3-1.20.1.)

### 3. Connection keeper: the login budget is checked before the wait, not when the login is made: several bots spend one slot  (severity: medium, confidence: high; demonstrated)

`lib/connection.js:405-424` `_attempt`: `budgetMs = this._budgetWaitMs()` (`:409`) is evaluated **before**
`await scheduler.take(...)` (`:417`), and the login is only recorded in `_launch` → `_noteLogin()` (`:435`). Two ways to
overspend:

- Bots created in the same turn of the event loop (the normal `for (const name of names) createPersistentBot(...)`
  at startup, after a crash): every `_begin` runs from `process.nextTick` (`:224`), and all of them pass the synchronous
  check before the first `_launch` runs in a microtask. `/home/user/ref/review-scratch2/budgetrace.js`: host budget 20,
  19 spent per the ledger, 3 offline bots → **3 logins made** (22 of 20). Same with `minSpacingMs: 0` and `100`.
- Microsoft bots: each passes the check at its own time, then waits in `scheduler` 15 s apart; the one that waited
  finds the budget consumed by the others and logs in anyway. This is the "4 bots × 6/h > 20/h after a restart kicks
  all of them" case the host budget exists for.

Fix: reserve before waiting, re-check after:

```text
async _attempt ({ ignoreBudget = false, transfer = false }) {
  ...
  if (!ignoreBudget && !transfer) {
    if (this._budgetWaitMs() > 0) { this._plan(0, { reason: 'budget' }); return }
    this._noteLogin()                       // the slot is taken now, before anybody else looks
    this._counters.attempts++
  }
  try { await scheduler.take(...) } catch { /* give the slot back: pop the timestamp from _logins and the ledger */ return }
  ...
  this._launch({ transfer, counted: true })  // _launch no longer calls _noteLogin
}
```

(and `_recentHostLogins` must read the ledger that other instances append to, which it does.)

### 4. `vanilla_interact.openOnce`: the late-window close is a promise nobody catches → unhandled rejection takes the host process down  (severity: medium, confidence: high; demonstrated)

`lib/plugins/vanilla_interact.js:112`: `const late = (w) => { try { bot.closeWindow(w) } catch { } }`. Since this
wave `closeWindow` (`inventory.js:524-527`) returns `bot._input.idle().then(...)`, which rejects after 40 ticks when a
movement key is held ("The movement keys are still held") and at once when the bot ended (`nextTick` rejects, `input_queue.js:75`).
The `try/catch` only covers a synchronous throw. The scenario is exactly the one the comment describes: 9b9t ignores an
open, `openContainer` times out after 8 s, the caller (stash scan with `approach`, pathfinder) walks on, the window
arrives late while keys are held → rejection with no handler → Node ≥ 15 exits.
`/home/user/ref/review-scratch2/lateclose.js` prints `UNHANDLED REJECTION -> The movement keys are still held…`.

The same promise escapes from `window.close()` (`inventory.js:447-451` returns it; every upstream example and plugin
calls `chest.close()` without awaiting) and from `bench/lib/runner.js:232`
(`session.bot.closeWindow(session.bot.currentWindow)` in a `finally`, right after `clearControlStates()`; it rejects when
the session ended meanwhile).

Fix: in `closeWindow`, make the forced path never reject for fire-and-forget callers: `return bot._input.idle().then(() =>
closeWindow(window), () => {})` is wrong for callers that need to know; better keep the rejection but catch it at the
three fire-and-forget sites (`late`: `.catch(() => {})`; `window.close`: `closed.catch(() => {})` and still return it;
runner.js: `.catch(() => {})`), and note in api.md that `closeWindow` / `window.close()` return a promise that can reject.

### 5. `scanContainers` mis-pairs double chests in a row: a half is skipped, another window is read twice  (severity: medium (stash index wrong), confidence: high; demonstrated)

`lib/plugins/containers.js:77-89`: for a `left`/`right` chest it takes **any** of the four neighbours with the same
facing and the other type as the partner. Vanilla's partner is one specific side:
`ChestBlock.getConnectedDirection(state) = type == LEFT ? facing.getClockWise() : facing.getCounterClockWise()`. In a
row of double chests A(left) B(right) C(left) D(right), B's neighbours A and C both qualify and the loop keeps the last
one. `/home/user/ref/review-scratch2/doublechest.js` (facing north, x = 0..3):

```
entries: 0+1 1+2 2+3 | opened at x = 0,1,2
```

Three opens for two chests: entry `1+2` opens B (the A/B window again, listed twice with the same contents) and marks C
as seen, D is never visited. Fix:

```text
const CW = { north: [1, 0], east: [0, 1], south: [-1, 0], west: [0, -1] } // facing.getClockWise()
const [dx, dz] = CW[facing]; const sign = type === 'left' ? 1 : -1
const next = bot.blockAt(position.offset(dx * sign, 0, dz * sign))
const props = next?.name === block.name ? next.getProperties() : null
if (props && props.facing === facing && props.type === (type === 'left' ? 'right' : 'left')) other = next
```

(Double-check the clockwise table against prismarine-block's `facing` values once on the sandbox: the mapping of
`left` to `facing.getClockWise()` is vanilla's; what matters is that only one side is tried.)

### 6. `DEFAULT_GIVE_UP_ON` stops the keeper for good on a transient session-server outage  (severity: medium-low, confidence: medium-high)

`lib/connection.js:46`: `/invalid session|failed to verify username|multiplayer\.disconnect\.unverified_username|…/`.
`multiplayer.disconnect.unverified_username` ("Failed to verify username!") is what every online-mode server (and
TCPShield's auth) sends when Mojang's session server times out or returns 5xx, which happens for minutes a few times a
month and is not account-specific. The keeper then stops with cause `give-up` and nobody logs in again until a person
calls `reconnectNow()`; for a bot meant to "live on a server for days" that is the wrong default. "Invalid session"
with a cached token that prismarine-auth refreshes on the next attempt is the same story.

Fix: move the two patterns out of `giveUpOn` into the conflict-like branch: `wait` `longWaitMs`, and stop only after
`conflictLimit` in a row (`_decide`, `:636-640`), e.g. a `SESSION = /invalid session|failed to verify username|unverified_username/i`
with its own counter.

### 7. 26.3: a `position_look` is still sent after the positional `teleport_confirm`  (severity: medium on 26.3 only, confidence: medium-low: depends on the 26.3 client, which nobody has seen)

`physics.js:922-950` `answerTeleport`: writes `teleport_confirm {teleportId, x, y, z, yRot, xRot}` (`:925`) and then
`sendTeleportReply(pos, yaw, pitch)` (`:948`), the PosRot with onGround false. Grim on a ≥ 26.3 server
(`CheckManagerListener.java:47`, `:400-412`, `:422`, `:444`) takes the **confirm** as the teleport
(`checkTeleportQueue` from the confirm's position) and, with `TELEPORT_CONTAINS_POSITION`, explicitly stops treating a
PosRot as a teleport reply (`teleportData = !TELEPORT_CONTAINS_POSITION && … ? checkTeleportQueue : new TeleportAcceptData()`).
The fork's PosRot is then an ordinary movement at the teleport position with `onGround: false`: Grim predicts a tick of
gravity from a standstill, the packet says no motion → offset ≈ 0.08 → setback right after every teleport (login, respawn,
setbacks themselves: a setback loop). Grim's change only makes sense if the 26.3 client no longer sends that PosRot, so
on 26.3 the fork should send the confirm alone (and update `lastSent` from the teleport, since nothing else will).

Also `docs/9bflayer/research/v26_3.md:36` still says "`physics.js` still writes only `teleportId` … Not fixed here"; the
code does write the five fields now (docs claim out of date).

### 8. `loginTimeoutMs` vs a queue that does not spawn the player  (severity: medium if it triggers, confidence: low-medium on the trigger, high on the consequence)

`connection.js:25`, `:467-477`: a connection that has not emitted mineflayer's `spawn` within 180 s is ended as
"hung", counted towards `hungLoginLimit: 3`, and three in a row park the bot for an hour. `spawn` needs the first
`update_health` with health > 0 (`health.js:46-49`). The watchdog is fine here (it needs `login` first and the queue sends
keep-alives), but if 9b9t's queue limbo does not send `update_health` (limbo servers often send only `login`,
`position`, `keep_alive` and chat), every queue wait longer than 3 minutes is cut off from the back of the queue,
costs a budget login, and three such waits stop the bot for an hour. The comment at `:24` ("the 9b9t queue holds a
login much longer") suggests this was seen. Verify once on 9b9t whether `spawn` fires in the queue; if it does not,
make "hung" mean "no play-state `login` packet (and no bytes) within `loginTimeoutMs`", and let a logged-in, ticking
connection wait as long as the queue takes.

### 9. Bench, `bench/lib/runner.js:232` and library: `closeWindow` from a `finally` (see 4), and nothing else harmful  (severity: low, confidence: high)

Checked: chat is blocked at the `client.write` level unless `--commands` (`session.js:184-188`, covers `chat`,
`chat_message`, `chat_command`, `chat_command_signed`); `dig`/`place` scenarios are `modify: true` and skipped without
`--modify` (`runner.js:190`); positions in reports and traces are relative to the first teleport unless `--absolute`
(`session.js:49-56`, `trace.js` uses `shift`); logins are spaced (15 s Microsoft / 2 s offline), the soak revives at most 5
times, two login failures stop the run. The bench does not use `createPersistentBot`, so it has no hourly budget: a soak
against a server that kicks every minute makes 6 logins plus one per other scenario, under TCPShield's ~20/h but not by a
lot; worth a `--max-logins` or reusing the host ledger.

### 10. `_launch` spends a budget login and retries forever on a synchronous `createBot` error  (severity: low, confidence: high)

`connection.js:434-457`: `_noteLogin()` runs before `createBot(opts)`; when `createBot` throws (unsupported version,
bad option, the overlay's "no 26.1 base") no TCP connection was made, yet a login is recorded and the error is classified
as a plain retry (`cause: 'error'`), so the keeper backs off to 5 min and repeats forever, 6 "logins" an hour, for a
configuration error that will never change. Fix: don't `_noteLogin` on a synchronous throw, and treat a `TypeError` /
version error from `createBot` as `stop('give-up')` (or at least count it towards `maxAttempts` regardless of the 0 default).

### 11. Small ones, no action strictly needed

- `physics.js:520` comment says `underWater` is `Entity.isUnderWater`; vanilla's is `wasUnderwater && isEyeInFluid(now)`.
  The fork's `wasEyeInWater(prev) && isInWater` is **Grim's** formula (`PlayerBaseTick.updateFluidOnEyes`: Grim's
  `wasEyeInWater` is the previous tick's value for 1.16+, `updateSwimming` and `SprintG` read it), so the bot and the
  anticheat agree; only the comment is off.
- `engine.js:1470` `updatePose` leaves out vanilla's `isPassenger()` in the fit check; physics does not run while
  riding, so it cannot matter.
- `digging.js:210` swings every tick while digging (api.md says so too); vanilla's `swing()` puts a packet on the wire
  every 3 ticks (`swingTime >= duration / 2`). No Grim check counts swings (NoSwingBreak wants at least one per tick
  packet with a break), so fidelity only; the first wave's note on the extra swing in a tick still stands.
- `connection.js:46-49` `/outdated (client|server)|incompatible/` and `/is not supported/` are broad substrings; a
  server MOTD-style kick text containing "incompatible" would stop the keeper. Fine for 9b9t.
- `watchdog.js`: default on in `createBot` cannot bite a healthy vanilla or proxied connection: it arms only after the
  play-state `login`, after which keep-alives come every 15 s (Velocity/Bungee send their own during a server switch, and
  the configuration state gets 180 s), and nmp's own `checkTimeoutInterval` (60 s here) would already have ended the
  client before 90 s of silence. A server with `pause-when-empty` still has this player, so it ticks.
- `overlay.js`: the require.cache swap and the protodef type registration are per minecraft-data copy and idempotent
  (`__overlay`, `__patchedOverlay`, `types.entityDelta` guards); a second copy reached through a dependency is patched
  too. A copy loaded later than `require('9bflayer')` (another package's own `minecraft-protocol`) is not, which only
  matters for 26.2/26.3. No change from the first-wave note.
- `blocks.js:44-56` `maskLongs`: only converts a `Uint8Array`; pre-26.3 long arrays pass through untouched.
  `entities.js:321-331` `moveDeltas`: pre-26.3 packets have no `move`, unchanged path. `sync_entity_position`: `steps`
  absent before 26.3, `dx` kept. OK.
- `player_action.js`: the 26.3 shift (+1 above `start_digging`) matches the research note; whether PacketEvents / Grim
  26.3 use the same numbering could not be checked offline (no PacketEvents source on this machine). Grim's own 26.3
  branches (`PacketOrderB` STAB, `MultiActionsE` drop) show it reads the 26.3 enum through PacketEvents.

## Verified correct (skip next time)

- Window-while-moving guard (`physics.js:706-748`): with keys reported held, the tick sends zero `player_input` and
  `stop_sprinting` and the `close_window` goes out in the next tick after `inputIdle()`; with nothing reported, it closes
  at once. Grim `MultiActionsC/D` read `isSprinting`, `isSneaking` (<1.15 or ≥1.21.9 only) and
  `knownInput.moving()` = forward|backward|left|right|jump (no shift), which is exactly the fork's `MOVEMENT_INPUT` and
  the 1.21.9 sneak gate. `internalTest.js:4104` asserts the `player_input` → `close_window` order.
- Sprint rules vs Grim: `SprintB`/`SprintC` apply only in water on 1.21.4 and the fork never sprints with impulse < 0.8;
  `SprintG` (sprinting while touching water with the eyes out, not swimming) is stopped the same tick by
  `(state.isInWater && !underWater)`; `updateSwimming` and `isSlowMovement` are Grim's formulas line for line
  (`PlayerBaseTick.java`). Item use: `use_item` goes out in the primary slot before the simulation, so the 0.2 impulse
  and the sprint stop land in the same tick as the packet, matching `startUseItem` before `aiStep` and Grim's
  `setSlowedByUsingItem` on receipt; the release likewise.
- Supporting block: `findSupportingBlock` / `firstHasPriority` / `checkSupportingBlock` are
  `MainSupportingBlockPosFinder.java` ported as is (slab `minY - 1e-6`, second search offset by `-movement`,
  `onGroundNoBlocks`), `AABB.intersects` is strict like `joinIsNotEmpty`, `onPos` keeps fences (≤ 0.5), walls and
  fence gates as vanilla's `getOnPos`, and the bounce reads `getOnPos(0.2)`. Used for friction, speed/jump factor and
  the legacy 1.20 path.
- Stuck multipliers and bubble columns: applied at the next move and spent (velocity zeroed) like `Entity.move`;
  effects evaluated after the travel from 1.21.2 (Grim `BlockEffectsResolverV1_21_4` is box-only, path walking is
  V1_21_5, as the engine comment says); powder snow only from the feet block, cobweb/weaving floats.
- Poses: `updatePlayerPose` incl. the fit fallbacks and the swimming-box precondition; dimensions set at the end of
  the tick (`setDimensions`), eye height used by `aim.js` and `lookAt`; `resetPose` on login/respawn matches Grim's
  `pose = STANDING`. A teleport does not touch the pose, as in Grim.
- Dig timing vs `FastBreak`: FINISH `ceil(1/damage)` ticks after START (one tick slower than vanilla, never faster),
  next START on the 6th tick after FINISH (300 ms ≥ Grim's 275 ms floor), START/FINISH each with a swing in the same
  tick (`NoSwingBreak`), ABORT face DOWN sequence 0, re-START on an item change (`sameDestroyTarget`).
- Connection keeper: `stop()` ends every path (pending timer, scheduler slot via `AbortController`, a sign-in without a
  socket via `guardLateSocket`, a live socket via `destroy()`, `finalize` fallback after 2 s); `reconnectNow` and the
  timer path cannot double-create (`_gen` fences); transfers are followed once per `end`, not counted, loop-guarded, and
  minecraft-protocol 1.68 does not follow `transfer` itself; `hungLoginLimit` / `hungLoginResumeMs` behave as
  documented (tests); the error listener is only emitted with a listener; per-bot listeners die with the bot.
  Kick texts: "You are already connected to this proxy!" → conflict, "Server closed" → restart, "Timed out" / full /
  flying → retry, 429 → wait + scheduler penalty.
- `blocks.js` light masks, `entityDelta` read/write symmetry, `maskLongs` endianness (`[hi, lo]` of a little-endian
  BitSet word) look right; the mock-server tests exercise them.
