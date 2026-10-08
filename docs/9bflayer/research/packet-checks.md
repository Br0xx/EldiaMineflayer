# Grim non-movement checks vs the 9bFlayer fork: packet-level audit

Scope: every check class under `checks/impl/*` of Grim, plus the packet listeners that feed them, compared with what
`/home/user/EldiaMineflayer/lib/plugins/*.js` writes. Target: a bot whose packets cannot be told from a vanilla 1.21.4 / 26.x client.
Nothing in any repo was modified. The only files written are this report and throw-away scripts in the session scratchpad.

Snapshot (the fork is being edited while this was written, so everything below is "as of 2026-10-08 08:21 UTC"):

- Grim: `/home/user/ref/grim` @ f5bbe9cf (2026-10-07). Source paths below are relative to
  `common/src/main/java/ac/grim/grimac/` (abbreviated `G/`).
- Fork: `/home/user/EldiaMineflayer` HEAD eed689d ("9bFlayer: rename the package, vendor prismarine-physics") **plus uncommitted work**:
  `lib/entity_action.js` (id resolver), `lib/plugins/vanilla_interact.js` (port of EBSlab `vanillaInteract.ts`), 26.2 overlay, pathfinder wrapper,
  `inventory.js`/`physics.js`/`bed.js` edits. Where that work already removes a problem I say "(WIP fixed)".
- `minecraft-data` in the fork's `node_modules` is a **locally patched** 3.117.0 (git HEAD there is a commit by "Claude"): it carries a feature
  `sneakUsesEntityAction` (1.8 to 1.21.5) that upstream does not have. Do not rely on it from published code.
- Facts marked "(ran)" were verified by executing code against the fork's `node_modules` (scripts in the scratchpad), not just by reading.
- "(E)" = the check is `experimental = true`. Grim's default `config/en.yml` has `experimental-checks: false`, so those are **off by default**.
  I do not know 9b9t's config, so every row is still audited, but severity below is ranked with this in mind.
- Default Grim punishments (`punishments/en.yml`): Post and BadPackets/PacketOrder/Crash only alert at 20 VL and log at 1; Timer/Simulation/NoFall/GroundSpoof alert at 100.
  Setback-capable checks (Timer, TickTimer, NoSlow, Sprint*, GroundSpoof, NoFall, Phase) are the ones that visibly hurt a bot.

Contents: 1 Summary, 2 How Grim sees a tick, 3 Vanilla order and the target design, 4 Per-check tables, 5 Fix catalogue (concrete JS),
6 Timer deep dive, 7 vanillaTick / vanillaInteract on this fork, 8 Local validator, 9 Prioritised list (top 15), 10 Uncertainties.

---

## 1. Summary of what matters most

| # | Finding | Checks hit | Evidence |
|---|---|---|---|
| 1 | Every API-initiated packet (swing, use_item, block_place, block_dig, held slot, entity_action, use_entity) is written whenever the awaiting promise resumes, which is **after `tick_end` and before the next tick's pong**. Vanilla sends them inside the tick, after the pongs and before the movement packet. | Post (non-E), PacketOrderO/E/F/G/I/J/M/N (E), MultiPlace/MultiBreak/MultiInteract/MultiActionsF (E) | `physics.js:85-100`, `game.js:149` (pong deferred to next tick), `Post.java` |
| 2 | Pitch can leave [-90, 90] after `bot.look`'s grid rounding (49.6 % of looks at exactly +-90, max +0.075 deg) (ran) and `look()` has no clamp. Grim cancels the packet. | BadPacketsD (non-E) | `physics.js:354-363`, `BadPacketsD.java` |
| 3 | `bot.look(..., force=true)` (used by `vanilla_interact.lookSettled`) jumps the sent yaw by the raw difference, up to 343.8 deg for cur=5.5, target=-0.5 (ran). | AimModulo360 (non-E) | `physics.js:365-368`, `AimModulo360.java` |
| 4 | 1.21.4 sneaking: fork gates on `newPlayerInputPacket` (1.21.3+), so it sends `player_input{shift}` **only** and never `start/stop_sneaking`. Grim reads sneak for clients < 1.21.6 from the entity_action. | prediction (NoSlow/Simulation), PacketOrderH/F, BadPacketsX/Z | `physics.js:278-293`, `G/events/packets/PacketEntityAction.java`, `PacketPlayerSteer.java:79` |
| 5 | Sprint/sneak entity_actions are written on every `setControlState` call, with no once-per-tick diff, no vanilla stop rules (no forward, food <= 6, wall, blindness, water) and no reset on respawn. | BadPacketsX (E), PacketOrderF/H (E), SprintA (non-E), SprintD/E/G (E), MultiActionsC/D (non-E) | `physics.js:263-296`, `SprintA.java`, `PacketPlayerRespawn.java:176-196` |
| 6 | Dig: FINISH has no swing (NoSwingBreak), instant/creative blocks get an extra FINISH on air (AirLiquidBreak), default face is always TOP (PositionBreakA), user aborts carry the dig face instead of 0 (PositionBreakB), no 6-tick delay between breaks (FastBreak), swing every 350 ms instead of every tick. | AirLiquidBreak, FastBreak, PositionBreakA/B (non-E); NoSwingBreak, MultiBreak, RotationBreak, FarBreak (E) | `digging.js:18-213` |
| 7 | Entity interaction: only INTERACT (`useOn`, `mount`, `activateEntity`) or only INTERACT_AT (`activateEntityAt`) is sent. Vanilla (< 26.1) sends INTERACT_AT then INTERACT with equal entity/hand/sneaking. `attack()` never aims. | PacketOrderC (non-E), Reach/Hitboxes (non-E), InvalidInteractTarget (E) | `entities.js:838-929`, `inventory.js:264-286` |
| 8 | `use_item` rotation is `toNotchianYaw(bot.entity.yaw)` (unrounded, not the rotation the tick's movement packet carries). | BadPacketsJ (non-E) | `inventory.js:136-141`, `BadPacketsJ.java` |
| 9 | Timer budget: `maxCatchupTicks` 4 means bursts of up to 4 ticks, at the edge of Grim's 120 ms drift for low RTT; running `vanillaTick` on top doubles `tick_end` and therefore the Timer balance. | Timer/TimerLimit (non-E, setback) | `physics.js:19,65-80`, `Timer.java`, `vanillaTick.ts:endTick` |
| 10 | Server `player_rotation` is applied but never answered with the `Rot(onGround=false, collision=false)` Grim expects; `entity.onGround=false` after a teleport; delayed respawn reply = "ignored teleport". | BadPacketsB, BadPacketsN (non-E), GroundSpoof/NoFall chain | `physics.js:383-387, 459, 483-491`, `CheckManagerListener.java:424-434`, `SetbackTeleportUtil.java:340-352` |
| 11 | Prediction sequence counter is never reset on world change (Grim resets its expectation), and the EBSlab `vanillaTick` plugin also numbers aborts. | BadPacketsH (E), BadPacketsL/CrashG | `sequence.js`, `PacketPlayerRespawn.java:208`, `vanillaTick.ts:predicted` |
| 12 | Item-use slowdown is not simulated (`engine.js` has no `usingItem`), sprint is applied whatever the bot state. | NoSlow (non-E, setback 5), Sprint* | `lib/physics/engine.js:555-580,746` |

Things that are already right in the fork (credit, do not touch): deferred pong/teleport replies in arrival order, `tick_end` written on every tick
(incl. ticks with no movement), one shared prediction sequence counter, abort/release/swap sequence 0, `use_item` skips empty hand, swing after
`block_place`, `carriedIndex` de-dup of `held_item_slot`, dropped (not replayed) tick backlog, `attack` followed immediately by its swing,
finite-position guards, `entityActionId()` (WIP), `vanilla_interact` face/cursor ray-cast (WIP).

---

## 2. How Grim sees a tick (needed to read every row below)

Source: `G/checks/GrimProcessor.java:58-97`, `G/checks/impl/packetorder/PacketOrderProcessor.java`, `G/events/packets/CheckManagerListener.java`.

- **Tick packet** (what closes a "window"): a non-teleport, non-duplicate movement packet (`position`, `position_look`, `look`, `flying`), or, for clients >= 1.21.2
  on a >= 1.21.2 server (`supportsEndTick`, true for 9b9t 1.21.4), a `tick_end` **when no movement packet was seen since the last `tick_end`** (`didSendMovementBeforeTickEnd`).
  `canSkipTicks()` is false in that case, so every "queued" variant (`canSkipTicks() ? queue : flag now`) takes the **immediate** branch. No buffering, no "ticking reliably" excuse.
- **Window** = packets between two tick packets. `PacketOrderProcessor` keeps booleans (attacking, interacting, placing, using, digging, releasing, sprinting, sneaking, swapping,
  dropping, picking, window click/close...) and clears them on every tick packet (and while spectating another entity).
- **Async (exempt) packets** (`isAsync`): `keep_alive`, `chunk_batch_received`, `resource_pack_receive`. **`pong` is not async.**
- `tick_end` after a movement packet is *not* a tick packet. Anything non-async between the movement packet and `tick_end` is PacketOrderO (E).
- Place and break packets are **queued until the next movement packet** (`placeUseItemPackets`, `queuedBreaks`) for the post-flying checks (RotationPlace/Break, DuplicateRotPlace);
  pre-flying checks (FarPlace, PositionPlace, AirLiquidPlace, FabricatedPlace, MultiPlace, ...) run on arrival with the **previous tick's position**.
  Queued places/breaks use the new flying packet's yaw/pitch only if the place arrived < 15 ms (server wall clock) before that flying packet (`CheckManagerListener.handleQueuedPlaces:~100-115`).
  So the place must leave the bot in the same JS tick as the movement packet, not 40 ms earlier.
- `Post` clears its list on every tick packet, then records the packet types listed in `Post.java:98-119` (abilities, held_item_slot, interact/attack, block_place, use_item, block_dig, entity_action
  except leave_bed) **if a movement packet has been seen since the last pong**, and flags when the next `pong` arrives. Vanilla answers pings at the start of the frame, before any input packet of the tick.
- Version gates that matter for "1.21.4 vs 26.x": `PacketOrderC` stops at 26.1 (merged use_entity), `PacketOrderB`/`MultiActionsE` drop-swing rule ends at 26.3, `SprintB/C/F` apply to 1.21.4 only,
  `MultiActionsC.isVerboseSneaking` only >= 1.21.9, `BadPacketsG`/`PacketOrderH` sneak entries only < 1.21.2 / < 1.21.6.
- Not registered in `CheckManager` (so inactive): `Baritone`, `FlightA`, `PacketOrderP` (commented out), `BadPacketsB` is only a flag sink for the rotation reply (see table), `BadPacketsN`/`TransactionOrder`/`InvalidInteractTarget` are sinks that other code flags.

---

## 3. Vanilla 1.21.4 order inside one tick, and the target design

### 3.1 Order a vanilla client produces (hard constraints from Grim, soft ones from Minecraft.tick)

```
frame start  (Minecraft.runAllTasks: ClientPacketListener handlers run on the main thread, in arrival order)
   pong(s)                      <- Post, PacketOrderO: before anything below
   teleport_confirm + PosRot(onGround=false, collision=false)   per server teleport, same order as the pings around it  <- SetbackTeleportUtil
   Rot(onGround=false, collision=false) per server player_rotation                                                    <- CheckManagerListener:425
   chunk_batch_received / keep_alive / resource_pack (async, anywhere)
tick:
 1 gameMode.tick: ensureHasSentCarriedItem -> held_item_slot (only if selected != carriedIndex)   <- E: before everything in 3-9; A: never twice the same
 2 handleKeybinds (GUI clicks/closes are NOT here: they come from the render thread, any time between frames)
   2a swap offhand -> block_dig status 6 (pos 0,0,0 face 0 seq 0)                                  <- G: nothing of {attack,release,use,pick,dig} before it
   2b drop        -> block_dig status 3/4, then arm_animation (clients < 26.3)                       <- G, L (swap after drop is flagged)
   2c using item and key released -> block_dig status 5 (release)                                    <- I: excludes attack/use/pick/dig in the tick
   2d else ONE of:
        attack entity:  attack / use_entity(ATTACK), then arm_animation immediately                  <- B (nothing between them), I, J
        attack block:   [block_dig ABORT(old pos, NEW face, seq 0) if switching] block_dig START(seq n) + arm_animation
        use:            per hand: block -> block_place(seq n) [+ arm_animation if client-swinging success]; entity -> use_entity INTERACT_AT then INTERACT; then use_item(seq n+1, yaw, pitch)
        pick block:     pick_item
   2e held-key continuation: continueDestroyBlock -> arm_animation EVERY tick while mining, block_dig FINISH (seq n) on the completing tick + arm_animation; 5 ticks of destroyDelay afterwards (next START on the 6th tick)
 3 LocalPlayer.tick:  [elytra start entity_action] [player_input if the key set changed] [start/stop_sneaking (clients < 1.21.6) BEFORE start/stop_sprinting (>= 1.21.2)]
   movement packet (position / position_look / look / status-only), chosen by delta^2 > 4e-8 or reminder >= 20 ticks, rotation delta != 0, onGround/collision change
 4 tick_end  (right behind the movement packet; nothing else in between)
```

Confidence: 1, 2a-2e ordering is forced by PacketOrderE/G/I/J/L/M/N/B/F/H (read in section 4). The frame-start/tick split and the "player_input before sprint/sneak" detail come from
Minecraft's `Minecraft.tick`/`LocalPlayer.tick` as I remember them and from the EBSlab GRIM.md experiments (player_input then movement then tick_end works on 9b9t); Grim does not check player_input vs entity_action order.

### 3.2 What the fork does today

| Source of packet | When it is written | Where that lands in Grim's windows |
|---|---|---|
| movement packet, `tick_end`, `player_input`(sneak only) | `tickPhysics` (50 ms grid) | correct |
| pong, teleport_confirm + PosRot | `flushReplies()` at the start of `tickPhysics` (`physics.js:87`) | correct (this is the fork's best feature) |
| `entity_action` sprint / sneak | inside `bot.setControlState`, i.e. whenever user code, a timer or a `physicsTick` listener calls it | before the pong, after the pong, after the movement packet: arbitrary |
| `swingArm`, `attack`, `useOn`, `activateEntity*`, `activateItem`, `deactivateItem`, `closeWindow`, `setQuickBarSlot`, `dig` (START, FINISH, swing interval, abort), `activateBlock` after `await lookAt` | synchronously in the calling stack; for awaited APIs this is a microtask after `tickPhysics` returned, i.e. **after `tick_end`** | next window, before that tick's pong |
| `bot.emit('move')` | inside `sendPacketPosition*`, i.e. **between the movement packet and `tick_end`** (`physics.js:127,139,155`) | any synchronous `move` listener that writes is PacketOrderO |
| `window_click` | immediately | allowed anywhere (GUI thread) as long as the bot is not moving/sprinting (MultiActionsC) |

### 3.3 Target: an input phase inside `tickPhysics`

```js
// lib/plugins/physics.js (target shape)
function tickPhysics (now) {
  if (bot._client.state !== 'play') return
  flushReplies()                                         // frame-start work: pong, teleports, player_rotation reply
  if (!bot.entity?.position || !Number.isFinite(bot.entity.position.x)) return
  const loaded = bot.blockAt(bot.entity.position) != null
  if (loaded && shouldUsePhysics) {
    const rot = captureRotation()                        // the yaw/pitch (f32 degrees) this tick's movement packet WILL carry
    bot._input.flush(rot)                                // 1-2: held slot, swap, drop, release, ONE primary (attack|use|pick|dig) + its swing
    const controls = effectiveControls()                 // sprint after the vanilla stop rules (section 5, F2)
    if (bot.physicsEnabled) {
      physics.simulatePlayer(new PlayerState(bot, controls), world).apply(bot)
      bot.emit('physicsTick')                            // listeners may call look()/setControlState(): they apply to the NEXT tick
    }
    syncInputState()                                     // 3: elytra, player_input, sneak, sprint: once each, only on change
    updatePosition(now, rot)                             // 3: movement packet built from the captured rotation
  }
  if (sendsTickEnd) bot._client.write('tick_end', {})    // 4
  bot._input.afterTick()                                 // resolve the API promises, emit deferred 'move' events now
}
```

`bot._input.enqueue(cls, send)` returns a promise that resolves after `send(rot)` ran inside a tick. Classes and rules (every rule is a Grim constraint):

| class | phase | rule |
|---|---|---|
| `carried` | 1 | before anything else (PacketOrderE); skip if equal to `carriedIndex` (BadPacketsA) |
| `swap`, `drop` | 2 | before every primary and release (PacketOrderG); never a swap after a drop in one tick (PacketOrderL) |
| `release` | 2 | exclusive with every primary (PacketOrderI) |
| `attack` | 3 | one primary per tick; `[attack, arm_animation]` is written atomically (PacketOrderB) |
| `use` | 3 | one primary; chains are fixed: `block_place` then `use_item`, or `use_entity(AT)` then `use_entity(INTERACT)` then `use_item` (PacketOrderM/N/C); never two `block_place` with different pos/face/cursor (MultiPlace) |
| `dig` | 3 | one primary; START and FINISH never with a use/attack in the same tick (PacketOrderI, MultiActionsF); every tick of a dig swings (NoSwingBreak) |
| `pick` | 3 | one primary |

If the next queued item conflicts with an already used primary, it waits for the next tick (50 ms, which is what a human clicking twice would also cost).
No conflict ever has to be "fixed" at the Grim side; the queue makes the bad window unrepresentable.

---

## 4. Per-check tables

Legend: **V** = the fork can violate it in a normal flow, **r** = only in a rarer flow, **OK** = cannot (or only by misuse). F-numbers refer to the fix catalogue in section 5.
Fork line numbers are for the 08:21 snapshot (`physics.js` = `lib/plugins/physics.js`, etc.). Grim file = `G/checks/impl/<group>/<Name>.java` unless noted.

### 4.1 PacketOrder* (`packetorder/`)

| Check | Vanilla behaviour it enforces | Fork | Fix |
|---|---|---|---|
| PacketOrderA (E) | pre-1.13 only (pickup/quick-move click order) | OK, not applicable to 1.21 | - |
| PacketOrderB | **an attack must be followed immediately by `arm_animation` (main hand)**: any non-async packet between attack and swing is flagged (`sentAttack` then next packet); and at least one swing since the previous attack. 26.3 adds STAB only | `entities.js:843-856` `attack()` writes `use_entity`(attack) then `swingArm()` back to back: **OK**. r: `attack(target, false)` (no swing) is flagged; any queue that interleaves a pong/entity_action between the two is flagged | F1: enqueue the pair atomically; remove the `swing=false` option or make it a no-op |
| PacketOrderC | < 26.1: INTERACT_AT must be followed by INTERACT for the **same entity, hand and sneaking flag** in the same window; armor stands exempt; INTERACT without a preceding INTERACT_AT = "Skipped Interact-At"; INTERACT_AT still open at the next tick packet = "Skipped Interact (Tick)" | **V**. `entities.js:905-929 useEntity(target, 0)` sends INTERACT only (`useOn`, `mount`, `inventory.js:264 activateEntity` which backs `openEntity` for villagers/horses). `inventory.js:276 activateEntityAt` sends INTERACT_AT only (`mouse:2`) and never the INTERACT | F7 |
| PacketOrderD (E) | off-hand entity interaction needs the main-hand one first in the same tick | OK, fork only uses hand 0 | - |
| PacketOrderE (E) | `held_item_slot` after any of attack / right-click / release / sneak / sprint / bed / glide / mount-jump in the same window | **V**. `simple_inventory.js:51-58 setQuickBarSlot` -> `inventory.js:737 _ensureHasSentCarriedItem` writes at once; `physics.js:263-296` sprint/sneak also at once. Server-sent `held_item_slot` is echoed from the packet handler (immediately), vanilla echoes at the next `gameMode.tick` | F1 (carried slot is phase 1), F13 |
| PacketOrderF (E) | sprint/sneak entity_action seen in the window, then attack / interact / place / use / pick / dig / open-inventory = flagged. So **sprint/sneak must be written after the input actions** | **V**. `setControlState` writes immediately; AFK/pearl code toggles sneak (BehaviorAfk crouch every 2-4 s) and clicks (BehaviorPearl) in the same window | F1 + F2 (sync after the primary) |
| PacketOrderG (E) | swap-offhand / drop / open-inventory after attack / release / right-click / pick / dig in the window | r. `vanilla_interact.swapHands` (`block_dig` 6) is immediate; `offhandFromHotbar` waits one tick after `setQuickBarSlot` (correct) but nothing stops a place from landing in the same window | F1 |
| PacketOrderH (E) | clients < 1.21.6: for >= 1.21.2, START/STOP_SNEAKING after a sprint packet in the same window is flagged (< 1.21.2: the reverse) | **V** once sneak entity_actions exist (finding 4): independent immediate writes in either order | F2 (order: sneak, then sprint) |
| PacketOrderI (E) | per window only one of: release / attack / right-click(place, use, interact) / pick / dig. Release after attack/use/pick/dig, attack after use/pick/release/dig, use after release/dig (also dig started with damage < 1, or cancelled) are all flagged. `exempt-placing-while-digging: false` | **V**. `digging.js` START + `consume()`/`activateItem()` in the same window; `deactivateItem()` + `attack()`; pearl `attemptClick` doing `activateBlock` and `activateItem` fallback in one call | F1 |
| PacketOrderJ (E) | `use_item`/`block_place` after an attack without an INTERACT in the same window | **V** when `attack()` and `activateItem()/placeBlock()` share a window | F1 |
| PacketOrderK (E) | < 1.12 only | OK | - |
| PacketOrderL (E) | open-inventory / swap-offhand after a drop in the same window | OK (the fork has no drop packet helper; `toss` is a window click) | - |
| PacketOrderM (E) | `use_item` before an INTERACT (non-attack) in the same window | r. `activateItem()` + `activateEntity()` in one window | F1, F7 |
| PacketOrderN (E) | `use_item` then `block_place` in the same window (vanilla: block_place first, `use_item` only when the block use returned PASS) | OK for `place_entity.js:41-61` boat (block_place then use_item). **V** for `activateItem()` followed by `activateBlock()` (e.g. pearl throw + noteblock click) | F1 |
| PacketOrderO (E) | **any non-async, non-vehicle packet between a non-teleport movement packet and the next `tick_end`** (pong included) | `tick_end` is written synchronously after `updatePosition` (`physics.js:99`) so the fork itself is OK. **V** through `bot.emit('move')` inside `sendPacketPosition/Look/PositionAndLook` (`physics.js:127,139,155`): a synchronous `move` listener (pathfinder, user code) that writes anything lands before `tick_end` | F1 (`afterTick` emits `move`), F16 |
| PacketOrderP (E, not registered) | chunk-batch ack ordering | OK (`blocks.js:296` answers on the same stack as the batch end, async-exempt anyway) | - |
| PacketOrderProcessor | state holder described in section 2 | - | - |

### 4.2 BadPackets* (`badpackets/`)

| Check | Enforces | Fork | Fix |
|---|---|---|---|
| BadPacketsA | `held_item_slot` with the same slot as the previous **serverbound** one (initial -1) | OK. `inventory.js:737-742` only writes when `quickBarSlot !== carriedIndex`. r: `carriedIndex` is reset on `login` only (`inventory.js:742`), a respawn that resets the server-side selection can desync it | F13 |
| BadPacketsB | after a server `player_rotation`, the next `look` with `!onGround && !horizontalCollision` must carry exactly that yaw/pitch (unless relative), else flagged; unanswered rotations just stay queued | **V** `physics.js:383-387` applies the rotation, sends nothing; the next regular `look` is eased (yawSpeed 3.0 = 8.6 deg/tick) and, in the air, carries `onGround=false`, which is compared with the stale pending rotation | F9 |
| BadPacketsC (E) | LEAVE_BED while not in bed | OK. `bed.js` `wake()` guards `isSleeping`; id via `entityActionId` (WIP fixed; numeric `2` was `stop_sprinting` on 1.21.6+) | - |
| BadPacketsD | `position_look`/`look` pitch outside [-90, 90] -> flagged **and the packet is cancelled** | **V** `physics.js:354-363`: `Math.round((pitch - entity.pitch)/sens)*sens` overshoots +-90 by up to 0.075 deg in 49.6 % of straight up/down looks (ran, 20 000 samples); `bot.look` also accepts any pitch (no clamp), and `lastSentPitch` is never clamped (`:188`) | F3 |
| BadPacketsE | > 19 movement packets without position in a row (position/position_look reset it) | OK. position every >= 975 ms (`physics.js:196-199`). Note it counts look-only and status-only packets too. See F8 for the exact tick-count version | F8 |
| BadPacketsF | START_SPRINTING while last was start / STOP while last was stop (first one exempt; exempt again after a respawn) | OK in the fork (`:266` de-dups). Risk is the *effective* sprint model (F2): never write a stop that Grim already knows | F2 |
| BadPacketsG | < 1.21.2 only duplicate sneak | OK for 1.21.4 (not applicable) | - |
| BadPacketsH (E) | prediction sequence = previous + 1 for use_item, block_place, START and FINISH digging (CANCEL must be 0); expectation resets to 0 on a dimension/world change (`PacketPlayerRespawn.java:208`) | r. `sequence.js` is one monotonic counter (good) but never resets on `respawn` into another world (vanilla creates a new `ClientLevel`, counter restarts); a sequence value consumed by a write that then throws desyncs forever; EBSlab `vanillaTick` re-numbers and also counts aborts | F11, F16 |
| BadPacketsI | `player_abilities` with flying=true when the server did not allow flight | OK, the fork never writes abilities | - |
| BadPacketsJ | `use_item` yaw/pitch must equal the yaw/pitch of **this tick's** movement packet (immediate mode: strict compare with `player.yaw/pitch` at the tick packet) | **V** `inventory.js:136-141` uses `toNotchianYaw(bot.entity.yaw)` (unrounded, not eased); the packet is sent after `tick_end`, compared with the *next* tick's rotation, which is `lastSentYaw` eased/fround'ed. Same for `place_entity.js:41-49`. Mismatch whenever a turn is in flight (finite `yawSpeed`, `look` just called) | F1+F4 (rotation comes from `captureRotation()`) |
| BadPacketsK | spectate while not spectator | OK | - |
| BadPacketsL | non-dig `block_dig` (drop, release, swap): position (0,0,0), face 0 (or 0..5 only for CHANGE_DESTROY_DIRECTION), **sequence 0** | OK: `deactivateItem` `inventory.js:146-161` and `vanilla_interact.swapHands` conform. Hazard: EBSlab `vanillaTick.sequence` only numbers status 0/1/2 (OK for L) but numbers **1 (abort)** which BadPacketsH wants to be 0 | F16 |
| BadPacketsM (E) | PERFORM_RESPAWN while not dead (exempt: credits, death screen) | OK: `health.js` guards `isAlive`; `game.js:126` credits | - |
| BadPacketsN | sink: teleport "ignored" = a later pong arrived before the PosRot reply (`SetbackTeleportUtil.checkTeleportQueue:340-352`: reply must come when `lastTransactionReceived == teleport.transaction`, i.e. after the pong preceding the teleport and before the one following it) | OK for the normal path (reply queue keeps arrival order, `physics.js:394-410`). **V** after death: `answerTeleport:483-491` confirms now but sends the PosRot **1.5 s later**, so Grim sees pongs overtake the teleport -> flag + a fresh setback teleport | F10 |
| BadPacketsO | keep-alive id must have been sent by the server | OK (minecraft-protocol echoes) | - |
| BadPacketsP (E) | click type/button validity (PICKUP/QUICK_MOVE/CLONE 0-2, SWAP 0-8 or 40, THROW 0-1, QUICK_CRAFT not 3/7/>10, PICKUP_ALL 0) | OK. `inventory.js` `syncWindow` sends mode 5 button 2 (valid). `toHotbar` uses mode 2 with button 0-8 | - |
| BadPacketsQ | entity_action: jumpBoost only for START_JUMPING_WITH_HORSE, abs(boost) <= 100, entityId = own | OK now. Before the WIP `entity_action.js`, sprint went out as `start_riding_jump` on 1.21.6+/26.x (ran: 26.1 `actionId:3` -> `start_riding_jump`; 1.21.4 `3` -> `start_sprinting`). `bot.elytraFly` resolves `start_elytra_flying`/`start_fall_flying` through the alias table | - |
| BadPacketsR (E) | >= 1 position packet per ~2 s of pong traffic while not riding/dead | OK (reminder every 1 s) except while `shouldUsePhysics` is false (waiting for a teleport, dead, chunk not loaded) | - |
| BadPacketsS, U | 1.8-era (window confirmation, legacy use item) | OK, not applicable | - |
| BadPacketsV (E) | a position packet whose abs(delta) <= 0.0002 (client >= 1.21.2 threshold) before the 19-tick reminder | **r** `physics.js:196` sends a position whenever `lastSent.x !== position.x` (exact). Sub-0.0002 drifts (float-hitbox residue, negligible-velocity rounding) are sent; vanilla's rule is `lengthSq > 4e-8 OR reminder >= 20` | F8 |
| BadPacketsX (E) | two START/STOP_SPRINTING or two START/STOP_SNEAKING in one window | **V**. `setControlState('sprint', true)` then `false` (pathfinder/AFK) inside one window writes both | F2 |
| BadPacketsY | slot outside 0..8 | OK (asserts in `setQuickBarSlot`) | - |
| BadPacketsZ (E) | two `player_input` between `tick_end`s (>= 1.21.2) | **V** on 1.21.4: `physics.js:279-285` writes `player_input{shift}` immediately on every sneak toggle, `moveVehicle`/`dismount` (`entities.js:863-903`) too, and EBSlab `vanillaTick` writes its own at `physicsTick` -> two in one window | F2, F16 |

### 4.3 MultiActions* and Sprint* (`multiactions/`, `sprint/`)

| Check | Enforces | Fork | Fix |
|---|---|---|---|
| MultiActionsA (E) | attack while `slowedByUsingItem` (eating, bow, shield...) of the held slot / offhand | r. nothing in `attack()` checks `bot.usingHeldItem` | F7 (release first, wait a tick) |
| MultiActionsB (E) | START/FINISH digging while using an item | r. `dig()` has no guard | F5 |
| MultiActionsC | `window_click` while `isSprinting` (entity_action state), or `knownInput.moving()` (forward/back/left/right/**jump** from the last `player_input`), or (>= 1.21.9) sneaking; exempt only in the tick the server opened a window | **V**. `clickWindow` (`inventory.js:593`) never looks at input. `controlState.sprint` stays true while standing still (vanilla would have sent STOP_SPRINTING), the EBSlab `player_input` for `forward` is only refreshed at the next `physicsTick` | F12, F2 |
| MultiActionsD | `close_window` while moving (same state; nether-portal exemption) | **V** `closeWindow` (`inventory.js:454`) and `vanilla_interact.closeAnyWindow` are immediate; the tasks close the window right before walking | F12 |
| MultiActionsE (E) | `arm_animation` while using an item (except directly after a drop, < 26.3) | r. dig swing interval (`digging.js:140`), pearl `swingArm` fallback, `consume()` plus any swing | F7, F5 |
| MultiActionsF (E) | block interaction (place, START/FINISH dig) and entity interaction in one window | r. | F1 |
| MultiActionsG (E) | attack/use while rowing a boat with input | OK (bot does not row) | - |
| SprintA | sprinting with food <= 6 unless it can fly (checked after prediction) | **V**. vanilla stops sprinting at food <= 6 (`hasEnoughFoodToStartSprinting`); `controlState.sprint` and the speed modifier (`engine.js:555-580`) stay on | F2 |
| SprintB (E, 1.21.4 only) | sprinting while slowed by sneaking in water | r | F2 |
| SprintC (E, 1.21.4 only) | sprinting while using an item in water for 2 ticks | r | F2 |
| SprintD (E) | sprinting while blind unless sprint started before blindness | r | F2 |
| SprintE (E) | still sprinting after a hard horizontal collision (not a START this tick) | **V** when pathfinding into walls with sprint on: no STOP_SPRINTING on collision | F2 |
| SprintF (E, 1.21.4) | sprinting while gliding | OK (no glide helper that keeps sprint), r with `elytraFly` | F2, F15 |
| SprintG (E) | sprinting in water (touching, not eye-in-water, not swimming) | r | F2 |

### 4.4 Timer, Post, misc (`timer/`, `misc/`)

| Check | Enforces | Fork | Fix |
|---|---|---|---|
| Timer / TimerLimit (setback 10) | each tick packet adds 50 ms to a balance that may not run ahead of the server clock, allowance = ping-clock - 120 ms drift. A burst after a stall is only legal up to what the lagging pong clock allows | `physics.js:19,65-80` bursts up to 4 ticks at the same `now`. Legal at ~50 ms RTT, borderline at < 30 ms RTT. EBSlab `vanillaTick` adds a second `tick_end` per tick which counts as a **second tick packet** (`isTickPacketIncludingNonMovement`) -> balance +100 ms per 50 ms | F8, F16 |
| TickTimer (setback 1) | exactly one `tick_end` after each non-teleport movement packet, and never > 1 movement packet per tick | OK. `physics.js:99` always writes it; teleport replies are exempt (`lastPacketWasTeleport`). Early `return`s at `:86`/`:88` skip it only before login | - |
| NegativeTimer (E, setback -1) | falling > 1200 ms behind the pong clock | r. dropping the tick backlog after long stalls accumulates; cosmetic | F8 |
| VehicleTimer | vehicle packets rate | OK (no vehicle driving) | - |
| ClientBrand | `minecraft:brand`, <= 64 bytes, non-empty; "vanilla" is in the ignored list | OK. `game.js` writes `options.brand` ('vanilla', `loader.js:81`) after `login`; vanilla sends it during configuration (cosmetic) | - |
| GhostBlockMitigation | resync only (`exploit.allow-building-on-ghostblocks: true` by default) | OK | - |
| **Post** | after a movement packet, if any of abilities / held_item_slot / interact / attack / block_place / use_item / block_dig / entity_action arrives **before the next pong**, flag at the pong | **V, systematic.** Awaited APIs resume after `tick_end` and the pong is flushed at the start of the next tick (`game.js:149` -> `physics.js:403`), so `[flying][tick_end][block_place][swing][pong]` = flag. Hits `placeBlock`, `activateBlock`, `openContainer`, `dig` START/FINISH, `attack`, `activateItem`, sprint/sneak toggles from timers, held-slot changes | F1 |
| TransactionOrder | sink only | OK (order preserved by the reply queue) | - |

### 4.5 Aim (`aim/`)

| Check | Enforces | Fork | Fix |
|---|---|---|---|
| AimDuplicateLook | a rotation-carrying packet whose yaw and pitch both equal the previous ones (teleports exempt one tick) | OK in the fork: `lookUpdated` (`physics.js:200`) compares the fround'ed last sent values. **V in EBSlab `vanillaTick` exactRotation**: it rewrites yaw/pitch *after* mineflayer decided to send, so the packet can equal the previous rotation | F16 |
| AimModulo360 | abs(delta yaw) > 320 deg after a small previous delta, while abs(yaw) < 360 | **V** with `force=true`: `physics.js:362-368` adds the **unwrapped** difference to `entity.yaw` and sets `lastSentYaw = yaw`, so the next packet jumps by `cur - target` (ran: 343.8 deg for entity.yaw 5.5 -> atan2 -0.5). `entity.yaw` lives in [0, 2pi) after any server teleport, `atan2` in (-pi, pi]. `vanilla_interact.lookSettled` always forces. The unforced path is fine (updatePosition wraps with `deltaYaw`) | F3 |
| AimProcessor (processor) | estimates the mouse sensitivity from the GCD of rotation deltas (needs >= 15 samples with 0 < abs(delta) < 5 deg). Consumers today: DuplicateRotPlace (only the raw delta), `Baritone` (not registered). Vanilla deltas are integer multiples of `0.15 * (0.6s+0.2)^3 * 8` | `bot.look` snaps *requests* to a 0.15 deg grid (= 100 % sensitivity, correct constant). The per-tick easing clamp `maxDeltaYaw = 0.05 * 3.0 = 0.15 rad = 8.594 deg` is **not a multiple of 0.15 deg** (57.3 steps), so clamped ticks break the GCD. No active check reads it | F3 (grid-aligned clamp) |
| Baritone (not registered) | tiny pitch-only deltas with the GCD below `MINIMUM_DIVISOR` | OK | - |

### 4.6 Placing (`scaffolding/`)

All use the *previous* tick's position for the pre-flying part, the new flying packet for the post-flying part (section 2).

| Check | Enforces | Fork | Fix |
|---|---|---|---|
| AirLiquidPlace | clicked block must not be air / a non-placeable liquid (creative exempt; tolerates a block broken by START in the last 2 ticks) | r. stale world after own break, ghost blocks | F6 (re-check `bot.blockAt` at write time) |
| DuplicateRotPlace (E) | two consecutive placements with the same abs(delta yaw) (> 2 deg, difference < 0.0001) | **r/V** deterministic aiming at the face centre from a fixed pose gives bit-identical deltas when a behaviour alternates between two targets (pearl rig, bridging) | F6 (aim jitter) |
| FabricatedPlace | cursor in [0,1] per axis (1.5 for extended shapes) +- float epsilon | OK (face centre or ray hit). `delta` option of `_genericPlace` can break it if a caller passes > 1 | - |
| FarPlace | eye -> block box distance <= BLOCK_INTERACTION_RANGE (4.5) + 0.0003 from the previous position | r. `canDigBlock` allows 5.1 from y+1.65 (`digging.js:223-229`); `vanilla_interact` reach 3 is fine | F6 |
| InvalidPlaceCursor | cursor finite | OK, guard against NaN from a ray-cast miss | - |
| InvalidPlaceFace | face 0..5 | OK (`vectorToDirection` asserts) | - |
| MultiPlace (E) | two `block_place` with different face / cursor / pos in one window | r. Two placements in one window: un-awaited `activateBlock/placeBlock` calls whose `lookAt` is a no-op (rotation already there, `physics.js:358-360` returns at once) or loops that place twice per tick. EBSlab `BehaviorPearl.attemptClick` (`BehaviorPearl.ts:113-146`) calls `activateBlock(primary)` and then `activateBlock(candidate)` in one JS turn: the second `bot.look` finishes the first look task, so the first `block_place` is written at once with the head already turned to the second target (RotationPlace), the second leaves after the next movement packet | F1, F6 |
| PositionPlace | eye must lie on the outer side of the clicked face plane | **V (legacy path)** `inventory.js` `activateBlock(block)` with no direction defaults to face TOP at (0.5,1,0.5): for a block whose top is above the eye (pearl rig slots at +2/+4 above the feet; eye at +1.62) that is flagged. The WIP route through `bot.vanilla.clickBlock` picks a visible face and is fine; `placeBlock` / `_genericPlace` still takes the caller's face | F6 |
| RotationPlace | the ray from the eye along (yaw, pitch) of the closing flying packet (or the previous rotation) must hit the clicked block's box within 4.5; pre-flying pass only when the buffer is armed | r. `lookAt(..., false)` resolves when yaw is within 0.001 rad of the *eased* value (`physics.js:323-327`), pitch is ignored; the place then leaves after `tick_end`, and the next movement packet may still be easing pitch (8.6 deg/tick) | F3, F6 |

### 4.7 Breaking (`breaking/`)

| Check | Enforces | Fork (`digging.js`) | Fix |
|---|---|---|---|
| AirLiquidBreak | START/FINISH on air, water, lava, bubble column, moving piston, unbreakable (FINISH), light block without light item | **V** instant/creative breaks: `dig` sends START and then `setTimeout(finishDigging, 0)` FINISH (`:136,144-156`). Grim already removed the block at START (damage >= 1), so FINISH hits air. Vanilla never sends FINISH for instant breaks | F5 |
| FarBreak (E) | eye -> block distance <= 4.5 | r. `canDigBlock` 5.1 | F5 |
| FastBreak | (a) FINISH earlier than `ceil(1/damage)*50 ms - 25` after START (1 s balance) (b) START less than ~275 ms after the previous FINISH on average (vanilla: 5 ticks of destroyDelay, next START on the 6th = 300 ms) | **V (b)**: pathfinder/task code calls `dig` again as soon as `diggingCompleted` fires (`:195-210`), no 6-tick gap. (a) is only wall-clock `setTimeout(waitTime)` (not tick-aligned, jitter +-1 tick) | F5 |
| InvalidBreak | face 0..5 | OK | - |
| MultiBreak (E) | two START/FINISH with different face or pos in one window (CANCEL ignored) | r. FINISH(A) timer and the next `dig(B)` START in the same window | F5, F1 |
| NoSwingBreak (E) | a window with START/FINISH must contain an `arm_animation` | **V** FINISH (`:149-156`) has no swing; START is followed by `swingArm()` (`:138`) but the follow-up swings come from a 350 ms interval (`:140-142`). Vanilla: START tick swings, **every held tick swings**, FINISH tick swings | F5 |
| PositionBreakA | eye must be on the outer side of the START/FINISH face | **V** `dig(block)` default `digFace='auto'`: `bot.targetDigFace = 1` (TOP) for every block (`:32,121`). Blocks at or above eye level are flagged; `'raycast'` mode picks real faces | F5 (face from the crosshair ray-cast) |
| PositionBreakB | after a CANCEL whose face != 0, the next break packet must be a START with the same face (vanilla: abort is always face DOWN, except when switching target, where it carries the new START's face) | **V** `stopDigging` (`:167-193`) intends exactly that rule, but `stoppedBecauseOfNewDigRequest = !currentBlock.position.equals(bot.targetDigBlock.position)` compares the closure's own block with itself, so it is always false and every abort carries `bot.targetDigFace` (usually 1) | F5 |
| RotationBreak (E) | like RotationPlace for START/FINISH | r. same easing risk | F3 |
| WrongBreak | FINISH must be the block of the last START (unless instant), no CANCEL of a block that is not the current one / twice | OK for the fork's own sequences (FINISH uses `targetDigBlock`; `stopDigging` becomes a no-op after one call) | - |

### 4.8 Combat and interaction (`combat/`)

| Check | Enforces | Fork | Fix |
|---|---|---|---|
| Reach | ray along the (current / previous) look from the eye must hit the target box within 3.0 (+0.0005) at the tick's position; attack on unknown entity cancelled | **V** `attack()` never aims, uses the entity position the client interpolated, not the server-tracked one | F7 |
| Hitboxes | same ray must hit the box at all | **V** same | F7 |
| SelfInteract | entity id != own | OK | - |
| InvalidInteractCursor | INTERACT_AT hit point on a **player** within +-0.3 horizontally, y in (-0.0001, 1.8001) of the target's position | r. `activateEntityAt` passes `position - entity.position` unclamped; `useEntity` default (0,0,0) is accepted | F7 |
| InvalidInteractTarget (E) | attack/interact on an id Grim does not track (despawned, not yet spawned) | r. attack on a stale `bot.entities[id]` (client removal is applied at the tick) | F7 |
| MultiInteractA/B (E) | different entity or sneaking / different hit point in one window | r. | F1 |

### 4.9 Crash, Exploit, Chat, Flight (`crash/`, `exploit/`, `chat/`, `flight/`)

| Check | Enforces | Fork | Fix |
|---|---|---|---|
| CrashA | abs(x), abs(z) <= 2.9999999E7 | OK | - |
| CrashB | `set_creative_slot` outside creative | OK unless `bot.creative.*` is misused | - |
| CrashC | non-finite position / rotation in a movement packet | position guarded (`physics.js:118,144`), **rotation is not**: `bot.look(NaN, ...)` or `lookAt` on own position (atan2(0,0)=0 is fine, `Infinity` is not) would send NaN | F3 (finite guard in `look`) |
| CrashD | clicks in a lectern window | OK | - |
| CrashE | `settings.viewDistance` < 2 (Grim rewrites it to 2 and flags) | r. `settings.js` accepts any positive number (`:33-35`), e.g. 1 | validate >= 2 |
| CrashF | QUICK_MOVE/SWAP with a negative button; SWAP with slot < 0 | OK | - |
| CrashG | negative sequence | OK (counter is positive) | - |
| CrashH | tab-complete > 256 chars (or > 64 without a space) | r. `bot.tabComplete(text)` unguarded | cap in `chat.js:197` |
| CrashI | bundle select < -1 | OK | - |
| ExploitA | anvil item name > 50 chars (>= 1.17) | r. `anvil.js` `addCustomName` sends every prefix (`:27-35`) | cap at 50 |
| ExploitB | `edit_book` must follow a `use_item` on the writable book, slot = selected slot (or 40 for off hand), page/title limits | **V if used**: `book.js:45-65` writes `edit_book` with no preceding `use_item` ("not editing book") | send `activateItem()` first (in a tick, F1) |
| ChatA | tab-complete text "/" or blank | r, same cap | - |
| ChatB | empty / padded / "/..." chat message, padded commands | N/A: the project rule is that the bot never talks (`chatLock`) | - |
| ChatC (E) | chatting while sprinting/moving | N/A (no chat) | - |
| ChatD | chat while `chat visibility = hidden` | N/A | - |
| FlightA (not registered) | any flying packet while not flying | OK, inactive | - |

### 4.10 NoFall, prediction, movement, vehicle, elytra (non-packet-order, listed for completeness)

| Check | Enforces | Fork | Fix |
|---|---|---|---|
| NoFall (setback 10) | onGround=true in a rotation-only / status-only packet requires ground within the feet box (+0.0002) | OK in steady state. `physics.js:459` sets `bot.entity.onGround = false` on every server teleport, which then makes the next tick airborne (GRIM.md "keep-ground") | F10 |
| GroundSpoof, Phase, OffsetHandler, DebugHandler, PredictionRunner, SetbackBlocker | movement prediction (not a packet-shape rule) | see `engine/patches/GRIM.md` (float hitbox 0.6F/2, exact rotation, no pathfinder snap). The fork's vendored `lib/physics/engine.js:76-77` still has `playerHalfWidth: 0.3` / `playerHeight: 1.8` | not in scope here |
| NoSlow (setback 5) | while `slowedByUsingItem` (food, drink, bow, shield, spyglass...) horizontal input must be x0.2 (offset < 0.001 allowed) | **V** `engine.js` has no item-use slowdown; walking while `bot.usingHeldItem` is flagged. Workaround in EBSlab: eat only standing still | F12b |
| VehicleA (steer_vehicle < 1.21.2) | abs(forward), abs(sideways) <= 0.98 | r. `entities.js:863-882 moveVehicle` writes +-1 on < 1.21.2 | clamp 0.98 |
| VehicleB | steer_vehicle while not in a vehicle | r. `dismount` guards `bot.vehicle` | - |
| VehicleC, VehicleTimer | vehicle movement prediction / rate | OK, bot does not ride | - |
| VehicleD/E/F (E) | horse jump / boat paddle packets in the right vehicle with the right state | OK; the fork never sends paddles (vanilla sends them every tick in a boat). `dismount()` sends `jump` where vanilla uses the shift bit (functional bug, `entities.js:885-903`) | F15 |
| ElytraA..I | start-glide rules; **B**: needs `knownInput.jump == false` at the entity_action and a `player_input{jump:true}` before the next tick packet; C frequency; D elytra equipped; F not on ground; G no levitation; H not in vehicle; I not in water | **V** `elytraFly()` (`physics.js:237-261`) writes the entity_action only; B flags every time. Not used by the stash bot | F15 |
| KnockbackHandler, ExplosionHandler (velocity) | expected velocity application | OK (`physics.js` explosion + `entity_velocity` handlers) | - |

---

## 5. Fix catalogue (concrete JS)

Names follow the fork (`bot`, `controlState`, `lastSent`, `lastSentYaw/Pitch`, `conv`, `physics`). Snippets are written to be pasted, not run
against the repo; the pieces I could test in isolation (look maths, id mapping, packet shapes, the lint harness) were run.

### F1. Input queue + one fixed tick order (new `lib/plugins/input_queue.js`, edit `physics.js`)

```js
// lib/plugins/input_queue.js   (load before physics, inventory, digging, entities, generic_place, place_entity)
module.exports = inject
// phase = vanilla order inside the tick; PRIMARY classes are mutually exclusive within one tick (PacketOrderI/J/M/N, MultiActionsF, MultiPlace, MultiBreak, MultiInteract)
const PHASE = { swap: 2, drop: 2, release: 2, attack: 3, use: 3, dig: 3, pick: 3 }
const PRIMARY = new Set(['release', 'attack', 'use', 'dig', 'pick'])

function inject (bot) {
  const pending = []
  const hooks = []                       // per-tick work (dig progress)
  const settled = []
  bot._input = {
    // send(rot) runs inside a tick, after pong/teleport replies and before the movement packet. rot = { yawDeg, pitchDeg } of that packet.
    enqueue (cls, send) { return new Promise((resolve, reject) => pending.push({ cls, send, resolve, reject, phase: PHASE[cls] ?? 9 })) },
    onTick (fn) { hooks.push(fn) },
    flush (rot) {
      bot._ensureHasSentCarriedItem()    // phase 1: held_item_slot, never before this point, never twice with the same slot
      pending.sort((a, b) => a.phase - b.phase)        // stable in Node >= 11: FIFO inside a phase
      let primary = false
      for (let i = 0; i < pending.length;) {
        const a = pending[i]
        if (PRIMARY.has(a.cls) && primary) { i++; continue }     // conflicts with what already left: next tick
        pending.splice(i, 1)
        try { a.send(rot); settled.push(a.resolve) } catch (e) { settled.push(() => a.reject(e)) }
        if (PRIMARY.has(a.cls)) primary = true
      }
      for (const h of hooks) h(rot, primary)
    },
    afterTick () { while (settled.length) settled.shift()() }, // callers resume after tick_end, but their packets are already out
    // true when nothing is held: used before inventory clicks and window closes (MultiActionsC/D)
    get pending () { return pending.length }
  }
}
```

Route through it (every one of these is today an immediate `_client.write`):

| API | class | notes |
|---|---|---|
| `setQuickBarSlot`, server `held_item_slot` echo | none (phase 1) | only set `bot.quickBarSlot`; `flush` writes. Remove the direct `_ensureHasSentCarriedItem()` calls at `simple_inventory.js:56` and `inventory.js` (server handler) |
| `activateBlock` / `placeBlock` / `vanilla.clickBlock` | `use` | `block_place` then `arm_animation`, atomically |
| `activateItem` | `use` | `use_item` with `rotation: { x: rot.yawDeg, y: rot.pitchDeg }` (F4), no swing for CONSUME items |
| `deactivateItem` | `release` | |
| `swapHands` helper | `swap` | |
| `attack` | `attack` | `[attack, arm_animation]` in one `send` (PacketOrderB) |
| `useOn`, `mount`, `activateEntity`, `activateEntityAt` | `use` | F7 |
| `dig` START / abort-with-new-target / FINISH | `dig` | F5 |
| `swingArm` (public) | class `swing`, phase 4, not a primary; inside a `send` it is written directly | a bare swing is legal anywhere in the window except while using an item (MultiActionsE) |

`physics.js` changes (see section 3.3 for the full function): `bot.emit('move')` moves from `sendPacketPosition/Look/PositionAndLook` (`:127,139,155`) to the end of `tickPhysics`
after `tick_end`, with the old position (it is the only emit that can put a listener's writes between the movement packet and `tick_end`).
`window_click` / `close_window` stay immediate (they are GUI-thread packets in vanilla) but go through F12.

### F2. Sprint, sneak, player_input: state, not events (`physics.js`, `lib/physics/engine.js`)

```js
// state mirrored from what has been SENT; setControlState no longer writes anything
const sent = { input: 0, sneak: false, sprint: false }
let sprinting = false
const sneakViaEntityAction = bot.registry.version['<=']('1.21.5')   // not the local-only feature `sneakUsesEntityAction`
const hasPlayerInput = bot.supportFeature('newPlayerInputPacket')    // 1.21.3+
const blindnessId = bot.registry.effectsByName.Blindness?.id

function effectiveSprint () {                    // vanilla LocalPlayer.aiStep rules; computed BEFORE the physics step so engine and packet agree
  const c = controlState
  const impulse = c.forward && !c.back
  const eyeInWater = bot.blockAt(bot.entity.position.offset(0, bot.entity.eyeHeight, 0))?.name === 'water'
  const keep = impulse &&
    (bot.food > 6 || bot.abilities?.mayFly) &&                   // SprintA
    !(blindnessId !== undefined && bot.entity.effects?.[blindnessId]) &&   // SprintD
    !(bot.entity.isCollidedHorizontally && !minorCollision()) && // SprintE (hard wall contact of the previous tick)
    !(bot.entity.isInWater && !eyeInWater) &&                    // SprintG
    !bot.entity.elytraFlying                                     // SprintF
  if (sprinting) return (sprinting = keep && c.sprint)
  return (sprinting = c.sprint && keep && !c.sneak && !bot.usingHeldItem)   // vanilla cannot START while sneaking/using an item
}
const effectiveControls = () => ({ ...controlState, sprint: sprinting })   // PlayerState reads .sprint

function syncInputState () {                     // once per tick, only on change, in this order
  const c = controlState
  if (hasPlayerInput) {
    const bits = (c.forward ? 1 : 0) | (c.back ? 2 : 0) | (c.left ? 4 : 0) | (c.right ? 8 : 0) | (c.jump ? 16 : 0) | (c.sneak ? 32 : 0) | (c.sprint ? 64 : 0)   // bit 6 = the sprint KEY, bit 5 = the shift key
    if (bits !== sent.input) {
      bot._client.write('player_input', { inputs: { forward: !!(bits & 1), backward: !!(bits & 2), left: !!(bits & 4), right: !!(bits & 8), jump: !!(bits & 16), shift: !!(bits & 32), sprint: !!(bits & 64) } })
      sent.input = bits
    }
  }
  if (sneakViaEntityAction && c.sneak !== sent.sneak) {          // BEFORE sprint (PacketOrderH, >= 1.21.2)
    bot._client.write('entity_action', { entityId: bot.entity.id, actionId: entityActionId(bot.registry, c.sneak ? 'start_sneaking' : 'stop_sneaking'), jumpBoost: 0 })
    sent.sneak = c.sneak
  }
  if (sprinting !== sent.sprint) {
    bot._client.write('entity_action', { entityId: bot.entity.id, actionId: entityActionId(bot.registry, sprinting ? 'start_sprinting' : 'stop_sprinting'), jumpBoost: 0 })
    sent.sprint = sprinting
  }
}
bot.setControlState = (control, state) => { assert.ok(control in controlState); assert.ok(typeof state === 'boolean'); controlState[control] = state; if (control === 'jump' && state) bot.jumpQueued = true }
// Grim: respawn (non-keep) sets isSprinting=false, knownInput=DEFAULT, isSneaking=false; vanilla's new LocalPlayer restarts all three
bot._client.on('respawn', () => { sent.input = 0; sent.sneak = false; sent.sprint = false; sprinting = false })
bot._client.on('login', () => { sent.input = 0; sent.sneak = false; sent.sprint = false; sprinting = false })
```

Fixes BadPacketsX/Z/F, PacketOrderF/H, SprintA/D/E/G, the 1.21.4 sneak gap (Grim reads `isSneaking` from START/STOP_SNEAKING for clients < 1.21.6; the shift bit
alone only matters from 1.21.6), and gives MultiActionsC/D a truthful `knownInput`. `minorCollision()` = the horizontal contact where the velocity component into the wall is below the
vanilla minor-collision limit; stopping sprint on every contact is safe for SprintE (Grim only flags *continued* sprinting) but then physics must use the same state, which `effectiveControls()` guarantees.

### F3. `bot.look` (`physics.js:346-372`, `:174-221`)

```js
const STEP = (Math.PI / 180) * 0.15                       // one mouse count at 100 % sensitivity (vanilla default 0.5)
const wrap = (a) => a - PI_2 * Math.round(a / PI_2)       // shortest way round
let forceSend = false

bot.look = async (yaw, pitch, force) => {
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) throw new Error('look: non-finite rotation')   // CrashC
  if (!lookingTask.done) lookingTask.finish()
  lookingTask = createTask()
  pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch))
  const yawChange = Math.round(wrap(yaw - bot.entity.yaw) / STEP) * STEP        // never the long way (AimModulo360)
  let pitchChange = Math.round((pitch - bot.entity.pitch) / STEP) * STEP
  const p = bot.entity.pitch + pitchChange                                      // the grid may step over the pole (BadPacketsD)
  if (p > Math.PI / 2) pitchChange -= STEP
  else if (p < -Math.PI / 2) pitchChange += STEP
  if (yawChange === 0 && pitchChange === 0) { lookingTask.finish(); return }
  bot.entity.yaw += yawChange
  bot.entity.pitch += pitchChange
  if (force) { forceSend = true; return }                                       // updatePosition sends it unclamped, still continuous
  await lookingTask.promise
}
// 'move' listener: finish when BOTH axes arrived (today only yaw is compared, physics.js:323-327)
// updatePosition: grid-aligned clamp, and no jump on force
const maxStep = (speed) => forceSend ? Infinity : Math.floor((PHYSICS_TIMESTEP * speed) / STEP) * STEP
lastSentYaw += math.clamp(-maxStep(physics.yawSpeed), deltaYaw(bot.entity.yaw, lastSentYaw), maxStep(physics.yawSpeed))
lastSentPitch += math.clamp(-maxStep(physics.pitchSpeed), bot.entity.pitch - lastSentPitch, maxStep(physics.pitchSpeed))
forceSend = false
```
Run result for the old code (ran): straight up/down look overshoots 90 deg in 49.6 % of 20 000 random starts (max +0.075 deg); force jump `entity.yaw 5.5 -> target -0.5` = -343.8 deg in one packet. The rewritten rounding above: 0 of 20 000 overshoots, max yaw step 180 deg (ran).
Also set the default `physics.yawSpeed = physics.pitchSpeed = Infinity` (EBSlab "exact-rotation"): the rotation the simulation used must be the one in the packet (Grim predicts movement from the packet's yaw).

### F4. `use_item` rotation

`rotation: { x: rot.yawDeg, y: rot.pitchDeg }` taken from `flush(rot)` (F1), where `rot` is the pair `updatePosition` is about to send (`Math.fround(conv.toNotchianYaw(y))`).
Same in `place_entity.js:41-49` and `vanilla_interact`. BadPacketsJ compares with `==` on floats, so both sides must be the same `Math.fround` value.

### F5. Digging as a tick-driven state machine (`digging.js`)

Vanilla facts used: START(seq) on the click tick + swing; every following tick `continueDestroyBlock` adds `damage` and swings; the tick where progress >= 1 sends FINISH(seq) + swing;
`destroyDelay = 5` afterwards (next START on the 6th tick); a break whose first-tick damage >= 1 (instant, creative) sends START only; abort = face DOWN(0) seq 0, except when the
click switches target, then it carries the new START's face; the START face is the face the crosshair ray hits.

```js
let d = null; let notBefore = 0; let tickNo = 0
const swing = () => bot.swingArm('right')                  // inside a tick/`send` this writes directly (F1)
bot._input.onTick(() => {
  tickNo++
  if (!d || d.instant) return
  d.progress += d.perTick()                                  // recompute: held item, onGround, in water can change mid-dig
  swing()                                                    // arm_animation EVERY tick of the dig
  if (d.progress >= 1) {
    bot._client.write('block_dig', { status: 2, location: d.block.position, face: d.face, sequence: bot._nextSequence() })
    notBefore = tickNo + 6; d = null
  }
})
async function dig (block) {
  const aim = await aimAt(block)                            // visible point -> look (F3) -> settle 1 tick -> ray-cast -> { face, point }
  if (tickNo < notBefore) await bot.waitForTicks(notBefore - tickNo)       // FastBreak (b)
  if (bot.usingHeldItem) { await bot.deactivateItem(); await bot.waitForTicks(1) }   // MultiActionsB
  await bot._input.enqueue('dig', () => {
    if (d) bot._client.write('block_dig', { status: 1, location: d.block.position, face: aim.face, sequence: 0 })   // switching target: NEW face, seq 0
    const perTick = () => 1 / Math.max(1, Math.ceil(bot.digTime(block) / 50))                                      // bot.digTime is ms
    const instant = bot.digTime(block) <= 50
    bot._client.write('block_dig', { status: 0, location: block.position, face: aim.face, sequence: bot._nextSequence() })
    swing()
    d = { block, face: aim.face, progress: 0, perTick, instant }
  })
  await once(bot, `blockUpdate:${block.position}`)           // done when the block turned to air (server confirms)
}
bot.stopDigging = () => { if (!d) return; bot._client.write('block_dig', { status: 1, location: d.block.position, face: 0, sequence: 0 }); d = null }   // user abort: DOWN
```
Reach: use `eye.distanceTo(aim.point) <= 4.5` from the **last sent** position; vanilla_interact's 3.0 is a safe default. Replace `canDigBlock`'s 5.1.

### F6. Placing / clicking (`generic_place.js`, `inventory.js activateBlock`, `vanilla_interact.js`)

1. Never fall back to "TOP face at (0.5,1,0.5)": always ray-cast from the eye along the exact rotation and send the face and point that the ray reports (`vanilla_interact.clickBlock` does; make `placeBlock`/`_genericPlace` do the same when `faceVector` is not forced).
2. One `block_place` per tick (F1 `use` class). A second call waits one tick.
3. Aim jitter inside the face so repeated placements do not repeat bit-identical rotation deltas (DuplicateRotPlace): pick the aim point uniformly in the central 60 % of the visible face, not the centre.
4. At write time (inside `send`): `if (!bot.blockAt(pos) || bot.blockAt(pos).boundingBox === 'empty') throw` (AirLiquidPlace), distance eye->box <= 4.5 from `lastSent` (FarPlace), `bot.entity.onGround` irrelevant.
5. Wait one settle tick after the turn (`vanilla.options.settleTicks` is 2; 1 is enough with exact rotation) so the pre-flying RotationPlace pass also sees the rotation.
6. Sneak: vanilla uses `sneaking` for interactables; `clickBlock` already clears sneak first, keep that but wait until the stop is *sent* (F2 `sent.sneak === false`) before the click (PacketOrderF).

### F7. Entity interaction and attack (`entities.js`, `inventory.js activateEntity*`)

```js
function interactEntity (entity, hit /* Vec3 on the entity box */, swing = true) {
  return bot._input.enqueue('use', () => {
    const sneaking = !!controlState.sneak
    const rel = hit.minus(entity.position)                      // relative to the entity's feet; players: |x|,|z| < 0.3, 0 <= y < 1.8
    if (bot.supportFeature('attackUsesOwnPacket')) {            // 26.1+: INTERACT_AT only, no INTERACT
      bot._client.write('use_entity', { target: entity.id, hand: 0, location: rel, sneaking })
    } else {                                                    // <= 1.21.11: INTERACT_AT then INTERACT, same entity/hand/sneaking (PacketOrderC)
      bot._client.write('use_entity', { target: entity.id, mouse: 2, x: rel.x, y: rel.y, z: rel.z, hand: 0, sneaking })
      bot._client.write('use_entity', { target: entity.id, mouse: 0, hand: 0, sneaking })
    }
    if (swing) bot.swingArm('right')
  })
}
async function attackEntity (entity) {
  if (!bot.entities[entity.id]) throw new Error('entity is gone')                   // InvalidInteractTarget
  const box = entityBox(entity)                                                      // width/height from bot.registry.entitiesByName
  const aim = box.center()
  if (bot.entity.position.offset(0, bot.entity.eyeHeight, 0).distanceTo(closestPoint(box)) > 2.9) throw new Error('out of reach')   // Reach: 3.0 + margins
  await bot.lookAt(aim, true); await bot.waitForTicks(1)                             // Reach/Hitboxes need the ray on the box in the tick's rotation
  if (bot.usingHeldItem) { await bot.deactivateItem(); await bot.waitForTicks(1) }  // MultiActionsA/E
  await bot._input.enqueue('attack', () => { writeAttack(entity); bot.swingArm('right') })   // pair, nothing in between (PacketOrderB)
}
```
`useOn(target)`, `mount(target)`, `activateEntity(entity)` become `interactEntity(entity, entityBox(entity).center())`; `activateEntityAt(entity, position)` keeps the caller's point but clamps it to the box.

### F8. Tick scheduling, position/status packets (`physics.js:19,65-80,174-221`)

```js
const STEP_MS = 50; const MAX_BURST = 2                       // see section 6: safe for any RTT >= 0 against the 120 ms drift
let due = performance.now() + STEP_MS
function doPhysics () {
  const now = performance.now()
  if (now - due > STEP_MS * (MAX_BURST - 1)) due = now - STEP_MS * (MAX_BURST - 1)   // forget the rest of a stall instead of replaying it
  while (due <= now) { tickPhysics(now); due += STEP_MS }
}

// updatePosition: vanilla LocalPlayer.sendPosition
let reminder = 0
const dsq = (position.x - lastSent.x) ** 2 + (position.y - lastSent.y) ** 2 + (position.z - lastSent.z) ** 2
reminder++
const positionUpdated = dsq > 4e-8 || reminder >= 20          // 2.0E-4 blocks or the 20th tick (BadPacketsV/E)
const lookUpdated = yaw !== lastSent.yaw || pitch !== lastSent.pitch
const collision = !!bot.entity.isCollidedHorizontally
if (positionUpdated) reminder = 0
// ... position / position_look / look as today, with flags: { onGround, hasHorizontalCollision: collision }
// final branch of the existing if-chain: status-only packet when onGround OR collision changed (today only onGround, compared with the previous tick's value):
// else if (onGround !== lastSent.onGround || collision !== lastSent.collision) bot._client.write('flying', { flags: { onGround, hasHorizontalCollision: collision } })
lastSent.collision = collision
```
Keep `lastSent.x/y/z` updated only when a position packet is sent (vanilla's `xLast`), so sub-threshold drift accumulates until it crosses 2e-4.

### F9/F10. `player_rotation` reply and teleports (`physics.js:383-387, 459, 468-495`)

```js
bot._client.on('player_rotation', (p) => {                       // 26.1 adds relativeYaw/relativePitch: today they are ignored
  const yaw = p.relativeYaw ? conv.toNotchianYaw(bot.entity.yaw) + p.yaw : p.yaw
  const pitch = p.relativePitch ? conv.toNotchianPitch(bot.entity.pitch) + p.pitch : p.pitch
  bot.entity.yaw = conv.fromNotchianYaw(yaw); bot.entity.pitch = conv.fromNotchianPitch(pitch)
  lastSentYaw = bot.entity.yaw; lastSentPitch = bot.entity.pitch                   // no easing back from the old value
  bot._replyOnNextTick(() => sendPacketLook(Math.fround(yaw), Math.fround(pitch), false))   // Rot(onGround=false, collision=false): CheckManagerListener:425-433
})
```
Teleports (F10): delete `bot.entity.onGround = false` at `:459` (the packet still says `false`; vanilla keeps the entity's own flag) and answer the post-death teleport at once like every other one
(`respawnTimer` path `:483-491`): Grim treats the 1.5 s gap as an ignored teleport (BadPacketsN) and sends a second one. If a server older than 1.19 really kicks, gate the delay on `bot.registry.version['<']('1.19')`.

### F11. Sequence counter (`sequence.js`)

```js
module.exports = function inject (bot) {
  let sequence = 0; let world = null
  bot._nextSequence = () => ++sequence                      // call it inside the same expression as the write; on a throw: sequence--
  bot._client.on('login', (p) => { sequence = 0; world = (p.worldState ?? p).worldName ?? (p.worldState ?? p).name ?? null })
  bot._client.on('respawn', (p) => {                        // vanilla: new ClientLevel only when the world changes; Grim: PacketPlayerRespawn.isWorldChange
    const w = (p.worldState ?? p).name ?? (p.worldState ?? p).dimension ?? null
    if (w !== world) sequence = 0
    world = w
  })
}
```
(field names for the world are per version; take whatever `handleRespawnPacketData` in `game.js` already reads.)

### F12. Window clicks and closes (`inventory.js:454, 593`; `vanilla_interact.js`)

```js
bot._input.idle = async (maxTicks = 40) => {                 // MultiActionsC/D: no sprint, no movement input, and the stop packets have LEFT
  for (let i = 0; i < maxTicks; i++) {
    const c = controlState
    if (!c.forward && !c.back && !c.left && !c.right && !c.jump && !sprinting && sent.input === 0 && !sent.sprint) return
    await bot.waitForTicks(1)
  }
  throw new Error('inputs did not settle before the window action')
}
// clickWindow(): await bot._input.idle()  ...  closeWindow(): await bot._input.idle()   (exempt when the server opened the window this very tick)
```
Also: `tossStack` closes `bot.inventory` (id 0) after a drop click. Vanilla sends `close_window(0)` only after the inventory screen was open: it is harmless for Grim (no check), but only do it when a click on window 0 happened in this "screen session".

### F12b. Item-use slowdown (`lib/physics/engine.js` near `:746`)

```js
if (entity.usingItem && !entity.vehicle) { strafe *= 0.2; forward *= 0.2 }   // before the sneak multiplier; NoSlow offset must stay < 0.001
// PlayerState: this.usingItem = bot.usingHeldItem   (cleared on entity_status 9 / heldItemChanged / set_cooldown, already done in inventory.js:74-102)
```
Sprint may not START while using an item; it may continue (slowed) once started. This is what lets `auto-eat` stop requiring "stand still" in the EBSlab behaviours.

### F13. Held slot

`simple_inventory.js:51-58`: set `bot.quickBarSlot = slot; bot.updateHeldItem()` only. `inventory.js` server `held_item_slot` handler: set `quickBarSlot` only. `bot._input.flush` calls `_ensureHasSentCarriedItem()`.
Reset `carriedIndex` as vanilla does on a new `MultiPlayerGameMode` (login) only; verify with a capture whether a respawn needs it (see section 10).

### F14. entity_action ids

Use `entityActionId()` everywhere (WIP file already exists): sprint/sneak/leave_bed/elytra/horse. Pin it with a unit test per tested version (1.21.4 `3/4`, 1.21.6 `1/2`, 26.1/26.2 names).

### F15. Elytra and vehicles (low priority, not used by the stash bot)

```js
bot.elytraFly = async () => {
  /* existing guards */
  if (controlState.jump) { bot.setControlState('jump', false); await bot.waitForTicks(2) }          // ElytraB: jump must be RELEASED when the action leaves
  await bot._input.enqueue('use', () => {
    bot._client.write('entity_action', { entityId: bot.entity.id, actionId: entityActionId(bot.registry, 'start_elytra_flying'), jumpBoost: 0 })
    controlState.jump = true                                                                          // syncInputState() then emits player_input{jump:true} before the movement packet
  })
}
```
`dismount()`: `player_input { shift: true }` from 1.21.2 (`entities.js:885-903` sends `jump`); `moveVehicle`: clamp +-0.98 on < 1.21.2.

---

## 6. Timer deep dive (what vanilla does, what the fork does, what to change)

Grim `Timer` (`timer/Timer.java`): every tick packet (non-teleport movement, or `tick_end` without movement) does `balance += 50 ms`; if `balance > now` it flags (and cancels / sets back
at VL 10); then `balance = max(balance, lastMovementPlayerClock - drift)` with drift = 120 ms. `lastMovementPlayerClock` is the **server send time of the transaction the client answered
just before that movement**, i.e. `now - RTT - (client delay in answering)`. Consequences:

- Being slow is free (the clamp lifts `balance` up to `clock - 120`). Only `NegativeTimer` (E, no setback) counts it, after 1200 ms.
- After a stall of any length, a legal burst is about `n <= (RTT + 120 + delay_of_pong) / 50` ticks (derived from reading `Timer.java`, not measured against a live Grim). RTT 10 ms -> 2, 50 ms -> 3, 80 ms -> 4. `maxCatchupTicks = 4` is therefore safe only above ~80 ms RTT;
  `MAX_BURST = 2` is safe for every RTT. The fork already *drops* the backlog (commit 124a9cb), the only change is the cap.
- Vanilla `Minecraft.runTick` replays up to 10 ticks per frame after a lag spike and it is not flagged because the pong that precedes the burst is equally late (`clock` stays old). The fork gets the
  same effect from `flushReplies()` being the first thing in `tickPhysics`: **never answer pings on a separate timer while ticks are being dropped**, or the clock catches up and the allowance disappears.
- One tick packet per 50 ms tick: movement + `tick_end` counts once, a tick with no movement counts once through `tick_end`. A **second `tick_end`** (EBSlab `vanillaTick` on top of this fork) is a
  second tick packet (`isTickPacketIncludingNonMovement` is true again because `didSendMovementBeforeTickEnd` was reset by the first), so the balance gains 100 ms per 50 ms and Timer flags within
  3 ticks. `TickTimer` does not notice (it counts movement packets between tick_ends).
- Pong, teleport PosRot, `player_rotation` Rot and chunk-batch acks are not tick packets (teleport replies are exempt via `lastPacketWasTeleport`; the rotation reply is accepted as a teleport only
  when it matches the pending rotation, otherwise it is a normal movement packet and counts: send it exactly once and with the exact values, F9).
- `setInterval(50)` drifts: it fires every 50 + execution time. The accumulator in `doPhysics` corrects that, so over 1 s there are 20 ticks on average, with an occasional 2-tick call. The `due` scheduler in F8
  has the same behaviour with an explicit burst cap. Optional: chain `setTimeout(next, max(0, due - performance.now()))` instead of `setInterval` to avoid the 2-tick calls.
- What can legitimately take > 120 ms in this bot: chunk parsing on teleport/login, GC, `JSON.stringify` of big state, synchronous disk writes. Each is a stall -> burst. With the cap at 2 the worst
  effect is a few lost ticks (cosmetic, NegativeTimer only).
- Position reminders: Grim `BadPacketsE` allows 19 flying packets without a position; the fork's wall-clock rule (>= 975 ms) sends it at the 20th tick in the steady state; F8 replaces it by vanilla's
  tick counter so the two cannot disagree after a stall.

---

## 7. (F16) EBSlab `vanillaTick` / `vanillaInteract` when running on this fork

`/home/user/EBSlab/engine/patches/plugins/vanillaTick.ts` was written for mineflayer 4.27 (which has none of this). On the fork:

| Switch | Action | Why |
|---|---|---|
| `tickEnd` | **off** | the fork already writes `tick_end` (`physics.js:99`). The plugin's second one is an extra tick packet -> Timer x2 |
| `playerLoaded` | **off** | `health.js:14` already writes `player_loaded` in `spawn()` |
| `sequence` | **off** | the fork has one counter; the plugin keeps its own and renumbers. It also numbers **aborts** (`predicted` includes `status 1`, `vanillaTick.ts:144-145`), but vanilla abort has sequence 0 and Grim (BadPacketsH, E) expects 0 and `lastSequence+1` for the next START; after one abort every later START mismatches |
| `useItemRotation` | **off** | the fork writes the rotation; fix the source (F4) instead of overwriting after the fact |
| `playerInput` | **off once F2 lands**; until then the fork's immediate `player_input{shift}` and the plugin's per-tick one can share a window (BadPacketsZ) | |
| `exactRotation` | **off once F3 lands**; it rewrites yaw/pitch after mineflayer decided to send, so a `look`/`position_look` can leave unchanged (AimDuplicateLook) and `lastSent` disagrees with the wire | |
| `collisionFlag`, `keepGround`, `floatHitbox` | keep until F8/F10 and a float-hitbox patch of `lib/physics/engine.js:76-77` | the fork still has `0.3`/`1.8` |

`vanillaInteract.ts` / `vanilla_interact.js` (WIP port): correct face/cursor ray-cast and 1.5 s container spacing. Remaining Grim exposure: `lookSettled` forces the look (AimModulo360, F3);
`clickBlock`'s `_writeBlockPlace` + `swingArm` leave from an awaited continuation (Post, F1); `closeAnyWindow` before walking has no input-idle guard (MultiActionsD, F12);
`offhandFromHotbar` = `setQuickBarSlot` + `waitForTicks(1)` + swap + `waitForTicks(1)` + `setQuickBarSlot(previous)`: the order held-slot -> swap is right, but each is an immediate write (F1).

---

## 8. Local validator: replay Grim's order rules on our own outgoing stream

`grimLint.js` (tested against synthetic good/bad sequences, scratchpad `t5.js`): wrap it around `bot._client.write` in `test/internalTest.js` flows (open chest, dig, place, eat, attack, teleport, respawn) and fail on any report.
It implements, with Grim's window semantics (section 2): BadPacketsA/D/H/J/L/X/Z, AimDuplicateLook, AimModulo360, PacketOrderB/C/E/F/G/H/I/J/M/N/O, MultiPlace, NoSwingBreak, PositionBreakB (abort face),
TickTimer (two movements before `tick_end`), Post.

```js
// test/grimLint.js
const MOVE = new Set(['position', 'position_look', 'look', 'flying'])
const ASYNC = new Set(['keep_alive', 'chunk_batch_received', 'resource_pack_receive'])
const POST = new Set(['held_item_slot', 'use_entity', 'attack', 'block_place', 'use_item', 'block_dig', 'entity_action', 'abilities'])

module.exports = function grimLint (bot, report = (id, msg) => { throw new Error(`[grimLint ${id}] ${msg}`) }) {
  const w = {}
  let moved = false; let sentFlying = false; let post = []; let teleportNext = false
  let inputsThisTick = 0; let lastSlot = -1; let lastSeq = 0; let lastRot = null; let pendingUseRot = null
  const reset = () => Object.assign(w, { names: [], primary: new Set(), sprint: 0, sneak: 0, place: null, swing: false, digPkt: false, sprintSeen: false, sneakSeen: false, entityAt: null, swingDue: false, useItem: false, attacked: false, interacted: false })
  reset()
  const bad = (id, m) => report(id, `${m}  [window: ${w.names.join(' ')}]`)
  const primary = (cls) => {
    const clash = [...w.primary].filter(c => c !== cls || cls === 'release')
    if (clash.length) bad('PacketOrderI/J/M/MultiActionsF', `${cls} after ${clash.join('+')} in one tick`)
    w.primary.add(cls)
  }
  function tickPacket () {
    if (w.digPkt && !w.swing) bad('NoSwingBreak', 'START/FINISH dig without arm_animation in the window')
    if (w.entityAt) bad('PacketOrderC', 'INTERACT_AT without INTERACT in the window')
    reset(); sentFlying = true
  }
  function feed (name, p) {
    if (ASYNC.has(name)) return
    if (w.swingDue && name !== 'arm_animation') { bad('PacketOrderB', `${name} between attack and arm_animation`); w.swingDue = false }
    if (name === 'pong') {
      if (moved) bad('PacketOrderO', 'pong between the movement packet and tick_end')
      if (sentFlying && post.length) bad('Post', `${post.join(',')} sent after the movement packet and before this pong`)
      post = []; sentFlying = false; return
    }
    if (name === 'teleport_confirm') { teleportNext = true; return }
    if (name === 'tick_end') { if (!moved) tickPacket(); moved = false; inputsThisTick = 0; return }
    if (MOVE.has(name)) {
      if (teleportNext) { teleportNext = false; return }
      if (moved) bad('TickTimer', 'two movement packets before tick_end')
      if (p.pitch !== undefined && Math.abs(p.pitch) > 90) bad('BadPacketsD', `pitch ${p.pitch}`)
      if (p.yaw !== undefined) {
        if (lastRot && lastRot.yaw === p.yaw && lastRot.pitch === p.pitch) bad('AimDuplicateLook', 'rotation unchanged')
        if (lastRot && Math.abs(p.yaw - lastRot.yaw) > 320) bad('AimModulo360', `yaw jump ${(p.yaw - lastRot.yaw).toFixed(1)}`)
        if (pendingUseRot && (pendingUseRot.x !== p.yaw || pendingUseRot.y !== p.pitch)) bad('BadPacketsJ', "use_item rotation differs from this tick's movement rotation")
        lastRot = { yaw: p.yaw, pitch: p.pitch }
      } else if (pendingUseRot && lastRot && (pendingUseRot.x !== lastRot.yaw || pendingUseRot.y !== lastRot.pitch)) bad('BadPacketsJ', 'use_item rotation differs from the current rotation')
      pendingUseRot = null
      moved = true; tickPacket(); return
    }
    if (moved) bad('PacketOrderO', `${name} between the movement packet and tick_end`)
    if (sentFlying && POST.has(name) && !(name === 'entity_action' && p.actionId === 'leave_bed')) post.push(name)
    w.names.push(name === 'entity_action' || name === 'block_dig' ? `${name}:${p.actionId ?? p.status}` : name)
    switch (name) {
      case 'held_item_slot':
        if (p.slotId === lastSlot) bad('BadPacketsA', `slot ${p.slotId} twice`)
        lastSlot = p.slotId
        if (w.primary.size || w.sprintSeen || w.sneakSeen) bad('PacketOrderE', 'held_item_slot after another action')
        break
      case 'entity_action': {
        const sprint = /sprinting/.test(p.actionId); const sneak = /sneaking/.test(p.actionId)
        if (sprint) { if (w.sprint++) bad('BadPacketsX', 'two sprint packets'); w.sprintSeen = true }
        if (sneak) { if (w.sneak++) bad('BadPacketsX', 'two sneak packets'); if (w.sprintSeen) bad('PacketOrderH', 'sneak after sprint'); w.sneakSeen = true }
        break
      }
      case 'player_input': if (inputsThisTick++) bad('BadPacketsZ', 'two player_input in one tick'); break
      case 'block_dig':
        if ([0, 2].includes(p.status)) { primary('dig'); w.digPkt = true; if (p.sequence !== lastSeq + 1) bad('BadPacketsH', `sequence ${p.sequence}, expected ${lastSeq + 1}`); lastSeq = p.sequence }
        else if (p.status === 1) { if (p.sequence !== 0) bad('BadPacketsH', 'abort must carry sequence 0'); if (p.face !== 0 && !w.primary.has('dig')) bad('PositionBreakB', `abort face ${p.face}`) }
        else {
          if (p.sequence !== 0 || p.face !== 0 || p.location.x || p.location.y || p.location.z) bad('BadPacketsL', 'non-dig block_dig must be (0,0,0) face 0 seq 0')
          if (p.status === 5) primary('release')
          if (w.primary.size && [3, 4, 6].includes(p.status)) bad('PacketOrderG', 'drop/swap after another action')
        }
        break
      case 'block_place': {
        primary('use'); if (w.useItem) bad('PacketOrderN', 'use_item before block_place')
        if (p.sequence !== lastSeq + 1) bad('BadPacketsH', `sequence ${p.sequence}, expected ${lastSeq + 1}`); lastSeq = p.sequence
        const key = JSON.stringify([p.location, p.direction, p.cursorX, p.cursorY, p.cursorZ])
        if (w.place && w.place !== key) bad('MultiPlace', 'two different placements'); w.place = key
        if (w.attacked) bad('PacketOrderJ', 'block_place after attack')
        if (w.sprintSeen || w.sneakSeen) bad('PacketOrderF', 'action after sprint/sneak')
        break
      }
      case 'use_item':
        primary('use'); if (p.sequence !== lastSeq + 1) bad('BadPacketsH', `sequence ${p.sequence}, expected ${lastSeq + 1}`); lastSeq = p.sequence
        if (w.attacked && !w.interacted) bad('PacketOrderJ', 'use_item after attack'); w.useItem = true; pendingUseRot = p.rotation
        if (w.sprintSeen || w.sneakSeen) bad('PacketOrderF', 'action after sprint/sneak')
        break
      case 'attack': primary('attack'); w.attacked = true; w.swingDue = true; if (w.sprintSeen || w.sneakSeen) bad('PacketOrderF', 'attack after sprint/sneak'); break
      case 'use_entity':
        if (p.mouse === 1) { primary('attack'); w.attacked = true; w.swingDue = true; break }
        primary('use'); if (w.sprintSeen || w.sneakSeen) bad('PacketOrderF', 'interact after sprint/sneak')
        if (p.mouse === 2) w.entityAt = p.target
        else { if (w.entityAt !== p.target) bad('PacketOrderC', 'INTERACT without matching INTERACT_AT'); w.entityAt = null; w.interacted = true }
        break
      case 'arm_animation': w.swing = true; w.swingDue = false; break
      case 'pick_item': primary('pick'); break
    }
  }
  const orig = bot._client.write
  bot._client.write = function (name, params) { feed(name, params || {}); return orig.apply(this, arguments) }
  return { feed }
}
```
Known gaps of the lint (documented, not bugs): no Timer budget model (use F8's `due` scheduler plus a rolling `ticks in last 1000 ms <= 22` assertion), no per-version gates (it assumes 1.21.2..1.21.11 semantics; for 26.1+ drop the PacketOrderC rules), no reach/hitbox geometry.

---

## 9. Prioritised implementation list (top 15) for a "vanilla-exact" fork

Ranking = (non-experimental and certain to fire in normal flows) first, then (setback-capable), then (experimental / rare). Items 1-5 are one body of work: land 1 first, the others sit on it.

| # | Change | Checks it retires | Files |
|---|---|---|---|
| 1 | **Input queue + fixed in-tick order** (F1): held slot, swap/drop/release, one primary action with its swing, all inside `tickPhysics` after the pong/teleport flush and before the movement packet; defer `bot.emit('move')` until after `tick_end` | Post; PacketOrderE/F/G/I/J/M/N/O; MultiPlace, MultiBreak, MultiInteractA/B, MultiActionsF; BadPacketsJ (with 2) | new `lib/plugins/input_queue.js`; `lib/loader.js` (register before physics); `lib/plugins/physics.js` (`tickPhysics`, `sendPacket*`); route `inventory.js` (`activateItem/deactivateItem/activateBlock/activateEntity*`), `simple_inventory.js:51-58`, `entities.js` (`swingArm`, `attack`, `useEntity`), `digging.js`, `generic_place.js`, `place_entity.js`, `vanilla_interact.js` |
| 2 | **`bot.look` rewrite** (F3): shortest-path yaw, pitch clamp that survives grid rounding, `force` without a raw jump, grid-aligned clamp, finite guard, finish on both axes; default `yawSpeed = pitchSpeed = Infinity`; `use_item` rotation from the packet's own values (F4) | BadPacketsD (cancels packets), AimModulo360, BadPacketsJ, RotationPlace/Break, CrashC | `lib/plugins/physics.js:346-372,174-221,323-327`; `inventory.js:136-141`; `place_entity.js:41-49`; `vanilla_interact.js:lookSettled` |
| 3 | **Sprint / sneak / player_input as state** (F2): once per tick, only on change, sneak before sprint, vanilla stop rules, respawn reset, sneak entity_action on <= 1.21.5 gated by version not by `newPlayerInputPacket` | BadPacketsX/Z/F, PacketOrderF/H, SprintA (+D/E/G), MultiActionsC/D input state, prediction of sneaking on 1.21.4 | `physics.js:263-296` (+ `PlayerState` input in `lib/physics/engine.js`), `entity_action.js` |
| 4 | **Entity interaction/attack** (F7): INTERACT_AT + INTERACT pair (26.1+ merged form), aim + settle + range check before an attack, release item first, stale-id guard | PacketOrderC/B/M, Reach, Hitboxes, InvalidInteractCursor/Target, MultiActionsA/E | `entities.js:831-929`, `inventory.js:264-286`, `vanilla_interact.js` (add `interactEntity/attackEntity`) |
| 5 | **Dig state machine** (F5): face from the crosshair ray, swing every tick, no FINISH for instant/creative, FINISH on the completing tick, 6-tick gap, abort face DOWN / new face, reach 4.5 | NoSwingBreak, AirLiquidBreak, FastBreak, PositionBreakA/B, MultiBreak, RotationBreak, FarBreak, MultiActionsB | `digging.js` (whole file), `canDigBlock` |
| 6 | **Make EBSlab's `vanillaTick` fork-aware**: `tickEnd`, `playerLoaded`, `sequence`, `useItemRotation` off; fix `predicted` to `[0, 2]` (aborts keep sequence 0); `playerInput`/`exactRotation` off after 2-3 land | Timer x2 (double `tick_end`), BadPacketsH, AimDuplicateLook | `/home/user/EBSlab/engine/patches/plugins/vanillaTick.ts`, `engine/patches/index.ts` (switch defaults), `engine/patches/GRIM.md` ("start/abort/finish" row) |
| 7 | **Tick scheduling and position packets** (F8): burst cap 2 via `due` scheduler, vanilla `positionReminder`/2e-4 rule, status-only packet on collision change, real `hasHorizontalCollision` | Timer/TimerLimit, BadPacketsE/V, (NegativeTimer) | `physics.js:19,65-80,174-221` |
| 8 | **Server rotation and teleport replies** (F9/F10): answer `player_rotation` with exact `Rot(false,false)` (+ relative flags on 26.x), keep `entity.onGround` on teleport, no 1.5 s respawn delay on Grim servers | BadPacketsB, BadPacketsN, NoFall/GroundSpoof chain | `physics.js:383-387, 459, 468-495` |
| 9 | **Window click/close gating** (F12): wait until the stop-sprint/zero-input packets have left; close the player inventory only if it was "open" | MultiActionsC/D | `inventory.js:454, 593`, `vanilla_interact.js` (`closeAnyWindow`, `windowClick`), `input_queue.js` (`idle`) |
| 10 | **Place hardening** (F6): ray-cast face/cursor always, aim jitter, one place per tick, stale-block and reach check at write time, no TOP-face default | PositionPlace, DuplicateRotPlace, AirLiquidPlace, FarPlace, RotationPlace | `generic_place.js:12-90`, `inventory.js activateBlock` legacy branch, `vanilla_interact.js:clickBlock` |
| 11 | **Sequence counter reset on world change**, roll back on a failed write | BadPacketsH, CrashG | `sequence.js`, `game.js` (world name), `digging.js`/`inventory.js` call sites |
| 12 | **Item-use slowdown + sprint cancel on use** in the vendored engine | NoSlow (setback 5), SprintC | `lib/physics/engine.js:~746`, `PlayerState` (`usingItem`), `inventory.js:74-102` |
| 13 | **Held slot at tick start, echo deferred**; `entityActionId` unit tests per tested version (1.21.4, 1.21.6, 26.1, 26.2) | PacketOrderE, BadPacketsA/Q/C | `inventory.js:734-751`, `simple_inventory.js:51-58`, `test/vanillaUnitTest.js` |
| 14 | **Misc guards**: `viewDistance >= 2`, tab-complete cap 256, anvil name <= 50, `edit_book` preceded by `use_item` in-slot, vehicle input +-0.98 (< 1.21.2) and shift for `dismount`, elytra start sequence (F15) | CrashE/H, ChatA, ExploitA/B, VehicleA, ElytraB | `settings.js:33-35`, `chat.js:197`, `anvil.js:27-35`, `book.js:45-65`, `entities.js:863-903`, `physics.js:237-261` |
| 15 | **`test/grimLint.js` in CI** (section 8): wrap every internal-test flow (chest open, dig, place, eat, attack, teleport, respawn, 26.x mock server) and assert zero reports; add a rolling "<= 22 tick packets per second" assertion | regression guard for everything above | `test/grimLint.js`, `test/internalTest.js`, `test/vanillaUnitTest.js` |

Movement-adjacent items from `engine/patches/GRIM.md` that are still missing in the fork (not packet checks, listed so they are not lost): float hitbox (`engine.js:76-77`), exact-rotation default (item 2),
keep-ground (item 8), collision flag (item 7), pathfinder no-snap (WIP `lib/pathfinder.js`).

---

## 10. Uncertainties and things I could not verify

1. **No live Grim run.** Everything is source reading plus local execution of the fork's packet serializer and the look/scheduler maths. Whether 9b9t enables experimental checks, changes the default punishments,
   or runs a modified Grim is unknown; I audited all of them and marked (E).
2. **Vanilla order details taken from memory of `Minecraft.tick` / `LocalPlayer.tick`**, not from decompiled 1.21.4 in this sandbox: (a) player_input vs sneak/sprint entity_action order (Grim does not check it; EBSlab's
   experiments work with player_input first), (b) `rightClickDelay`/`missTime` semantics, (c) which interactions swing (`SwingSource.CLIENT` vs `SERVER`: entity interactions, `use_item` of non-consumable items),
   (d) sprint continues after the sprint key is released while W is held. Everything Grim actually enforces was taken from Grim's source, not from memory.
3. `minorCollision()` in F2 needs vanilla's `minorHorizontalCollision` (collision where the component into the wall is tiny). Treating every contact as hard is safe for Grim (SprintE only flags continued sprinting)
   but changes the bot's speed relative to a vanilla client in grazing contact; check against a capture.
4. Whether `carriedIndex` must be reset on `respawn` (new `LocalPlayer.selected = 0` while `MultiPlayerGameMode.carriedIndex` survives) - needs a capture of a death on a vanilla client.
5. Pong timing for Post: I assume Grim sends at least one transaction per tick (it does around every flying packet and on most server packets); if a given server sends them rarer, the Post hit rate is lower but the cause is identical.
6. 26.x: PacketOrderC/B/MultiActionsE have version gates at 26.1/26.3; the fork's `use_entity` shape for 26.1+ was verified by serialising (`hand`/`location(lpVec3)`/`sneaking`), but not the swing-after-interact rule on 26.x.
7. The fork changed under me (uncommitted `vanilla_interact.js`, `entity_action.js`, `mcdata/overlay26_2.js`). Line numbers are from 08:21 UTC; the function names are stable anchors.
8. `node_modules/minecraft-data` in the fork is locally patched; `sneakUsesEntityAction` does not exist upstream (F2 uses a version compare instead).
