# Adversarial review of 9bFlayer (f2b236a..f8875d0), committed state

Reviewer: Claude (Fable 5.1), 2026-10-08. Read-only. Scripts used for the repros are in `/home/user/ref/review-scratch/`
(`digrace.js`, `edgefriction.js`; `committed/` is `git archive f8875d0`). Line numbers below are the **committed** files
(`git show f8875d0:<path>`); the working tree already diverged in `digging.js`, `vanilla_interact.js`, `input_queue.js`,
`loader.js` (another agent), so re-check findings 1 and 5 against the new `digging.js`.

Ground truth used: Grim @ f5bbe9cf (`/home/user/ref/grim`), mineflayer-pathfinder 2.4.5 (scratchpad `pf/`),
minecraft-data 3.117.0, minecraft-protocol 1.68.0. `npx mocha --exit test/internalTest.js -g "1.21.4v"`: 79 passing.

## Ranked findings

### 1. `digging.js`: a queued FINISH outlives `stopDigging()` and hijacks the next dig  (severity: high, confidence: high)

`lib/plugins/digging.js:160-173` (committed). `finishDigging()` fires from the `waitTimeout` and *enqueues* the FINISH;
the packet is only written at the next tick. The enqueued callback re-reads `bot.targetDigBlock` instead of the `block`
it was created for:

```text
bot._input.enqueue('dig', () => {
  if (!bot.targetDigBlock) return            // only guards against null
  bot._client.write('block_dig', { status: 2, location: bot.targetDigBlock.position, ... })
  bot._writeSwing()
  bot.targetDigBlock = null                 // nulls whatever dig is current now
  ...
})
```

Scenario (one tick window, 50 ms): dig(A) is started; the finish timer fires; before the next tick user code (or a plugin)
calls `bot.stopDigging()` / `bot.dig(B)`. `dig(B)` sets `bot.targetDigBlock = B` and enqueues START(B). Pending queue:
`[FINISH(A-callback), ABORT(A), START(B)]`, one primary per tick. Observed with the committed code
(`node /home/user/ref/review-scratch/digrace.js`):

```
block_dig {"status":0,"location":{"x":1,...},"sequence":1}      START A
arm_animation
block_dig {"status":2,"location":{"x":2,...},"sequence":2}      FINISH written for B's position
arm_animation
block_dig {"status":1,"location":{"x":1,...},"sequence":0}      abort A, after the finish
targetDigBlock = null | dig(B) promise: pending                 START(B) never written: dig(B) hangs forever
```

Consequences: a FINISH_DIGGING for a block that was never started (Grim `MultiBreak`/breaking checks, `PositionBreak*`,
BadPacketsH stays in sync but the server rejects the break), `bot._updateBlockState(A, 0)` fakes A as air, and `dig(B)`
never settles (no `waitTimeout`, `started` stays false so no abort either). mineflayer-pathfinder is not affected (it awaits
`bot.dig` before the next one), but any caller that cancels and re-digs within a tick is. Fix: capture the block in the
closure and check identity, like START does:

```text
bot._input.enqueue('dig', () => {
  if (bot.targetDigBlock !== block) return
  bot._client.write('block_dig', { status: 2, location: block.position, face: bot.targetDigFace, sequence: bot._nextSequence() })
  ...
})
```

and in `stopDigging`, drop a FINISH that is still pending (a `cancelled` flag the FINISH callback checks).

### 2. Engine: friction / block speed factor taken from the bot's centre column, not the supporting block  (severity: medium, confidence: high on the divergence, medium on how often it bites)

`lib/physics/engine.js:352-356` (`blockBelowThatAffectsMovement`: `floor(y - 0.500001)` at `pos.x, pos.z`), used by
`travelInAir` (`:951-958`) for friction and by `blockSpeedFactor`/`blockJumpFactor` (`:361-371`). Vanilla 1.21.4
`Entity.getBlockPosBelowThatAffectsMyMovement()` = `getOnPos(0.500001F)` takes **x/z from `mainSupportingBlockPos`**
(the collider under the box closest to the position) and only the y from `floor(y - 0.500001)`; Grim does the same
(`MainSupportingBlockPosFinder.findMainSupportingBlockPos`, `BlockProperties.getFriction(player, mainSupportingBlockData, …)`,
`MovementTicker.java:221,508,526`). The comment in the engine says it "differs only when straddling two kinds of floor",
but the common case is the bot's centre being **past the edge over air** while its 0.3-wide box still rests on the block:
the fork then reads air below (default friction 0.6, factor 1) while vanilla/Grim keep the block the bot stands on.

Measured with the committed engine (`node /home/user/ref/review-scratch/edgefriction.js`, 1.21.4, forward from rest):

```
ice   centre inside block (x=0.5): dx = 0.02249 | centre 0.2 past the edge (x=1.2, box still on it): dx = 0.09800
stone centre inside block (x=0.5): dx = 0.09800 | centre 0.2 past the edge:                            dx = 0.09800
```

0.098 vs 0.0225 is a 0.075-block offset in one tick: a guaranteed setback whenever the bot walks or jumps off the edge of
ice / packed ice / blue ice / slime, and the same for the 0.4 speed factor on soul sand and honey (the fork drops the
slowdown half a block early). Plain stone/obsidian/netherrack paths are unaffected (0.6 everywhere), which is why the
9b9t rig tour never showed it. Fix: track the supporting block as vanilla does. After `collideVanilla`, when
`entity.onGround`:

```text
// Entity.checkSupportingBlock: the collider under the box (minY-1e-6 .. minY) whose centre is closest to the position
function findSupportingBlock (world, bb, pos) {
  const slab = new AABB(bb.minX, bb.minY - 1e-6, bb.minZ, bb.maxX, bb.minY, bb.maxZ)
  let best = null; let bestD = Infinity
  for (const s of collidersIn(world, slab)) { // needs the block position: keep it on the AABB in getSurroundingBBs
    const d = (s.blockX + 0.5 - pos.x) ** 2 + (s.blockY + 0.5 - pos.y) ** 2 + (s.blockZ + 0.5 - pos.z) ** 2
    if (d < bestD) { bestD = d; best = s } // ties: lowest y, then x, then z, as vanilla's loop order
  }
  return best && new Vec3(best.blockX, best.blockY, best.blockZ)
}
// getOnPos(0.500001F): supporting block's x/z (if any), y = floor(pos.y - 0.500001F)
function blockBelowThatAffectsMovement (world, entity) {
  const s = entity.supportingBlock
  const y = Math.floor(entity.pos.y - F(0.500001))
  return world.getBlock(s ? new Vec3(s.x, y, s.z) : new Vec3(entity.pos.x, y, entity.pos.z))
}
```

(`entity.supportingBlock` is remembered across ticks like `mainSupportingBlockPos`: vanilla keeps the previous one when the
new slab finds nothing but the player is still on ground after a move, offsetting the slab by `-movement`.) The
fence/wall special case of `getOnPos` can be ignored for friction (same 0.6).

### 3. `bot.look` / `bot.lookAt` never resolve while physics is off  (severity: medium-low, confidence: high)

`lib/plugins/physics.js:552-578` and `:324-327`. `lookingTask` is only finished inside `updatePosition()`, which runs only
when `shouldUsePhysics` is true, the chunk is loaded and `!isEntityRemoved()`. So a (forced or not) look made before the
first teleport, while riding (`bot.on('mount')` clears `shouldUsePhysics`), while the chunk is unloaded, or more than 20
ticks after death waits for the next teleport or forever. Upstream `look(…, force=true)` returned at once. Repro (fake bot
after `login`, no `position` packet yet): `lookAt(force)` still pending after 400 ms while `tick_end` flows. Every
`vanilla_interact` click inherits this (`lookSettled` awaits `lookAt(point, true)`), as does `bot.dig(block, true)` and
`activateEntity`. Fix: finish the task when it cannot be carried by a packet, e.g. at the top of `runTick` / in `bot.look`:

```text
if (!shouldUsePhysics || isEntityRemoved()) {           // nothing will carry the rotation: behave like upstream's force
  lastSentYaw = bot.entity.yaw; lastSentPitch = bot.entity.pitch
  lookingTask.finish(); return
}
```

### 4. `clickWindow` / `closeWindow` now reject after 2 s if any movement key is held  (severity: low-medium, confidence: high; API semantics)

`lib/plugins/inventory.js:663` (`clickWindow`) and `:522` (`closeWindow`) call `bot._input.idle()` (`physics.js:521-526`),
which throws `The movement keys are still held…` after 40 ticks. This is right for Grim (MultiActionsC/D read
`knownInput.moving()`, which includes jump, and `isSprinting`), and mineflayer-pathfinder is safe because it calls
`fullStop()` (keys released) before `bot.equip`/`bot.dig`. But every other caller that equips/clicks while the pathfinder or
its own code is walking (auto-eat, auto-armor, totem plugins, `bot.equip` from a chat command) used to work and now rejects
after 2 s with a message nobody expects, and `bot.closeWindow(w)` returns a promise that can reject (upstream: sync, void
on 1.17+). Not a bug per se, but it needs to be in the API notes and `window.close()` should not emit `'close'` before the
packet actually left (`inventory.js:447-451` emits at once).

### 5. Digging swing cadence: the 350 ms bare swing can share a tick with a FINISH/START swing  (severity: low, confidence: high)

`digging.js:150-155` keeps upstream's `setInterval(bot.swingArm, 350)`; `bot.swingArm` enqueues class `swing` (phase 4),
while the START/FINISH callbacks write their own `bot._writeSwing()` directly without registering the `swing` class
(`input_queue.js` `conflicts()` only sees `sent.classes`). When the interval fires in the same tick as the FINISH, the
tick carries two `arm_animation`s. Vanilla never writes two swings in one tick (`LivingEntity.swing` rate-limits on
`swingTime`), and it swings every tick while `continueDestroyBlock` runs (one packet per ~3 ticks on the wire, not 350 ms).
I found no Grim check that flags either today, so this is fidelity only. Fix: have the START/FINISH callbacks go through
`bot.swingArm()` (which writes immediately while `_input.active` is true) and mark `sent.classes.add('swing')` from the
hook, or simpler: replace the interval with an `onTick` hook that swings every 3rd tick while `bot.targetDigBlock` is set.

### 6. Typings and exports disagree  (severity: low, confidence: high)

- `index.d.ts:1305` declares `export function installProtodefGuard(): boolean`; `lib/loader.js:67-71` exports only
  `protodefSkipped`. TS callers get `undefined` at runtime.
- `VanillaInteract.closeAnyWindow: () => void` and `swapHands: () => void` (`index.d.ts:1230,1241`) both return promises
  (`vanilla_interact.js:124,192`), and `closeAnyWindow` is the one you must await before walking.
- `bot.attack(entity, swing)`: the second parameter is silently ignored now (`entities.js`), fine for Grim (PacketOrderB)
  but the d.ts still documents `attack: (entity) => Promise<void>` without saying the swing can't be suppressed.

### 7. Comment claims the code does not match  (severity: low, confidence: high)

- `lib/protodef_guard.js:1-4` / `loader.js:95`: "A vanilla client ignores packets it cannot decode". It does not: a
  `DecoderException` disconnects the vanilla client. The real justification is protodef's incomplete 1.21.4 schema for the
  item components ViaBackwards emits; the vanilla client decodes those fine. Keep the guard, fix the sentence, and note the
  consequence it hides: a skipped `set_slot`/`window_items` leaves the inventory model stale with no signal except
  `protodefSkipped()`.
- `engine.js:352-353`: "differs only when straddling two kinds of floor" understates finding 2 (the centre-over-air case).
- `input_queue.js` header promises that "What the vanilla order forbids can then not be written": true for the queue,
  but `bot._client.write` is still reachable from `move`/`physicsTick` listeners after `tick_end`; the `moveEvents` deferral
  only covers `move`. (`Post` is safe because the next tick's replies come first; just do not promise more than that.)

### 8. `overlay26_2.install()` runs at `require('9bflayer')` time and throws instead of degrading  (severity: low, confidence: medium)

`lib/loader.js:1` → `overlay26_2.js:716` throws `minecraft-data has no 26.1 entry` when the installed minecraft-data is
older than the one that shipped 26.1, which makes the whole package unloadable for every version, not just 26.2. The
dependency floor is `^3.114.0`; if that release lacks `pc/26.1` (I could not confirm offline), raise the floor or catch and
skip the overlay. It also swaps `require.cache['prismarine-chunk'].exports` and pushes to prismarine-physics's
`features.json` for every copy it can resolve: harmless for 1.21.4, but anything that required `prismarine-chunk` before
9bflayer keeps the unpatched function (only matters on 26.2).

### 9. Notes, no action needed

- `sequence.js` restarts the counter on a **world name** change (vanilla: new `ClientLevel`); Grim's `BadPacketsH.onWorldChange`
  fires on a **dimension type** change. Two worlds of the same type (multiworld plugins) would make Grim false on a vanilla
  client too; irrelevant on 9b9t.
- `hideErrors` now defaults to `true` (`loader.js:79`): `bot.on('error')` logging and `bot._warn` go silent unless the
  caller opts back in. Intentional, but surprising for a drop-in.
- `updateSprint` stops sprinting when the shift key is pressed (`physics.js:424`). Vanilla 1.21.4 keeps sprinting
  (`!input.hasForwardImpulse()` is false at 0.3 × 0.98) and Grim's SprintB only applies in water for 1.21.4, so this is a
  fidelity deviation that cannot flag; the one-tick-early sprint start after releasing sneak (fork checks `c.sneak`, vanilla
  checks the previous tick's crouch pose) likewise cannot flag because Grim takes the sprint state from the packet.
- `moveEntityVanilla`'s `maybeBackOffFromEdge` ignores vanilla's `vec3.y <= 0` condition, but so does Grim's
  (`Collisions.maybeBackOffFromEdge`), so the bot and the anticheat agree.
- `inventory.js` keeps `itemInUse = true` when the server never starts the use (no living-flags metadata arrives because
  nothing changed). With `bot.food` fresh this cannot happen for food; shields/bows are fine. Worth a timeout anyway.

## Verified correct (so the next reviewer can skip them)

- Tick order (`physics.js:157-186`, `input_queue.js:flush`): replies → `held_item_slot` → swap/drop → one primary → simulation
  → `player_input` → sneak → sprint (sneak first on ≥1.21.2, sprint first before: matches `PacketOrderH`) → movement → `tick_end`.
  Pongs go through `_replyOnNextTick` (`game.js:144-150`), so `Post`/`PacketOrderO` cannot fire from the queue.
- Timer: `MAX_BURST = 2` with the fixed 50 ms grid (`physics.js:118-136`). Against `Timer.java` (balance floor
  `lastMovementPlayerClock − 120 ms`), a 2-tick burst is +100 ms from the floor, never above `nanoTime()` at any ping; a
  3-tick burst would flag under ~30 ms RTT. The clamp means lost ticks are never replayed, so the average rate cannot exceed 20/s.
- Sneak timing vs Grim: fork `crouching` = key of the previous tick (speed and 1.5 box); Grim `isSlowMovement` uses
  `wasSneaking` (`PlayerBaseTick.java:84`, `MovementCheckRunner.java:637`) and recomputes the pose/box at the **end** of the
  tick (`MovementCheckRunner.java:539`) from the sneak packet of that tick → both lag one tick. Consistent.
- Attribute re-keying (`entities.js:593-622`): 1.21.4's protocol mapper is the stale 1.20.5 list (22 names); wire id 21 decodes
  as `generic.step_height`, ids ≥ 22 come through as raw numbers (protodef does not throw: tested), and
  `registry.attributesArray[21].resource === 'minecraft:movement_speed'` (32 entries in registry order). Movement speed, jump
  strength, gravity, sneaking speed, water movement efficiency now reach the engine; the server's `minecraft:sprinting`
  modifier is skipped and re-applied as `speed += speed * 0.3F` → `(float)` (identical to Grim's `MovementCheckRunner.java:362-366`).
- `getFrictionInfluencedSpeed`, `moveRelative` (Mth table, float yaw), `collide()` step-up candidates, the 1.21.2 tiny-move
  rule, `Mth.equal` collision flags, `updateEntityMovementAfterFallOn`, `getBlockSpeedFactor` with `movement_efficiency`
  lerp, jump power `(float)attr * factor + 0.1F * boost`, `max(jumpPower, vy)` on 1.21.2+: all match Grim/vanilla 1.21.4.
- Teleport reply (`position_look`, onGround=false, no collision flag, exact values), `lastSent` not updated by the reply
  (vanilla `handleMovePlayer` leaves `xLast`/`yRotLast` alone, so the next tick resends), `player_rotation` reply, respawn
  resets of `sent.*`/`sprinting`/`crouching`/`lastSent`, `carriedIndex` only reset on login (vanilla `MultiPlayerGameMode`
  survives respawn): all consistent with Grim's `PacketPlayerRespawn`.
- `input_queue` settles exactly once (`settled` runs in the `finally` of `tickPhysics`; `abort` on `end` rejects what is pending);
  promises queued outside the play state wait for play again rather than leak; no unhandled rejection path found.
- 1.8–1.20 gating: `sendsTickEnd`, `hasPlayerInput`, `sneakByEntityAction`, `hasCollisionFlag`, `POSITION_EPSILON_SQ`
  (0.03² before 1.21.2), `entity_action` legacy ids, `use_entity` shapes (extra fields ignored by older protodef schemas),
  legacy engine untouched except the `velocityBlocksOnTop` fix. The `1.21.4v` internal suite passes (79).
- mineflayer-pathfinder 2.4.5: `bot.look(yaw, 0)` (not awaited) in `physicsTick` → next tick's packet; `fullStop()` before
  `dig`/`equip`/`placeBlock`, so the idle gate is satisfied; `bot.dig(block, true)`, `bot.placeBlock`, `bot.activateBlock`
  (doors) all go through the queue. Only the unpatched `fullStop()` snap remains a setback source, and `lib/pathfinder.js`
  handles that when the caller uses `loadPathfinder()`.
