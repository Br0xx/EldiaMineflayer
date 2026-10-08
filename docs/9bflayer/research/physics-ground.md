# Ground and air movement: prismarine-physics 1.11.1 / mineflayer fork vs vanilla 1.21.4+ vs Grim

Scope: a plain walking, sprinting, sneaking and jumping player (no fluids, climbing, effects, elytra). Target: 1.21.4 (9b9t), then 26.1/26.2.
Read-only research. No repo was modified. Suggested order of work: F3, F2, F1 (as far as the bot sprints or sneaks), F4, F5, F7, then F6 when moving to 26.x. `E:` line numbers and the stock-behaviour measurements are for `/home/user/EldiaMineflayer` at commit e8b56ab. While I worked, someone else rewrote `lib/plugins/physics.js` in the working tree (uncommitted, plus new `lib/plugins/input_queue.js`, `test/grimLint.js`); `P:` line numbers refer to the committed driver, and section 4 cross-checks the rewrite. `lib/physics/engine.js` is unchanged in both. All patches, tests and the numbers quoted below are in `/home/user/ref/notes/physics-ground/`.

Path shorthand:

- `G:` = `/home/user/ref/grim/common/src/main/java/ac/grim/grimac/`
- `E:` = `/home/user/EldiaMineflayer/lib/physics/engine.js` (vendored prismarine-physics 1.11.1, byte-identical to `node_modules/prismarine-physics/index.js` apart from `require` paths, so the line numbers match)
- `P:` = `/home/user/EldiaMineflayer/lib/plugins/physics.js` as committed at e8b56ab (the fork's driver; `git show HEAD:lib/plugins/physics.js` for these line numbers)

## 0. Method and limits

- Mojang hosts are blocked from this box, so there is no vanilla source or jar. "Vanilla" below means Grim's mirror of it (the actual adversary) plus my knowledge of the 1.21.x mappings. Each finding carries a confidence.
- I re-implemented Grim's pipeline for the normal ground and air case as a small model (`sim/vanilla.js`, `sim/vanillaCollide.js`, `sim/sprintMachine.js`) and ran the real vendored engine against it. These checks show where the engine and the model differ. They do not show that the model equals vanilla.
- Nothing was run against a live Grim. The EBSlab sandbox (flying-squid) has no Grim, and `/grim debug` (P/A/O lines, `G:checks/impl/prediction/DebugHandler.java`) on a Paper+Grim box is the real validation I would do next.
- I assumed 9b9t's Grim sees a 1.21.4 client on a >= 1.21.2 server, so `supportsEndTick()` is true (`G:player/GrimPlayer.java:881`). The lab's finding that `tick_end` and `player_input` were needed agrees with that. If it is false, Grim uses "0.03 skip" lenience and several packet checks below are inactive.

### What Grim tolerates, and what that means for ranking

| Quantity | Value | Source |
|---|---|---|
| Offset that flags (VL) | `>= 0.001` per tick | `G:checks/impl/prediction/OffsetHandler.java:105` |
| Offset that sets back at once | `>= 0.1` | `:106` |
| Accumulated offset that sets back | `advantage >= 1`, decays x0.999 on clean ticks | `:107` |
| Uncertainty for plain ground or air movement | about 0 (point box). Extras: previous tick's offset is carried as lenience (`:45`, `:85-93`), 0.08 per colliding entity, 0.15 sneak-edge hidden velocity (`SneakingEstimator`), 0.0002-skip handling | `G:predictionengine/UncertaintyHandler.java` |
| Position-skip threshold, client >= 1.18.2 | 0.0002 (`isPointThree()` is only for < 1.18.2) | `G:player/GrimPlayer.java:651-657` |
| Inputs | brute-forced for old clients, taken from `player_input` for 1.21.2+; sprinting forces forward = +1 | `G:predictionengine/predictions/PredictionEngine.java:727-760` |
| Slow-movement flip (sneak or crawl) | not tried unless the tick is a 0.03 tick, `force-slow-movement` defaults to true | `PredictionEngine.java:773`, `G:manager/player/features/types/ForceSlowMovementFeature.java:30` |

Consequence: float versus double noise (below 1e-4) is irrelevant. What flags is a logic difference of 1e-3 or more: sprint or sneak state, constants, collision and step semantics, and packet cadence. Findings are ranked by that.

## 1. Tick order, operation by operation (vanilla 1.21.4 vs mineflayer fork)

Vanilla is as mirrored by Grim. "ok" means equal for Grim's purposes.

| # | vanilla (LocalPlayer.tick) | mineflayer / prismarine | verdict |
|---|---|---|---|
| 1 | `baseTick` (fluid, in-block, pose lag) | top of `simulatePlayer` `E:705-713` | fluids are the other agent's scope |
| 2 | `crouching` is computed from the **previous** tick's shift key; impulse is +-1; x0.3F if crouching; x0.2F if using an item (26.x: item `use_effects.speed_multiplier`) | `E:743-748`: `* 0.98`, then `* 0.3` with the **current** key; item slowdown not modelled | **F2** (sneak lag), use-item not modelled |
| 3 | sprint block: start needs forwardImpulse >= 0.8, food > 6, not using item, not blind; stop on no forward impulse, food <= 6, hard horizontal collision (previous tick) | `controlState.sprint` is used verbatim, packet written at `setControlState` time `P:272-276` | **F1** |
| 4 | `noJumpDelay--`; 0.003 threshold: per axis in 1.21.4; players in 1.21.5+: horizontal length^2 < 9e-6 (y per axis) | `E:716-718` per axis | ok for 1.21.4, **F6** for 26.x |
| 5 | jump if `onGround(N-1) && noJumpDelay == 0`: `vy = max((float)0.42 * blockJumpFactor + boost, vy)`; sprint boost `(-sin, cos) * 0.2` | `E:720-736`; honey factor 0.4 instead of 0.5 and looked up below the feet; plain assignment not `max` | **F11** |
| 6 | `xxa, zza *= 0.98F`, no clamp | `E:743` double 0.98 | ok (<1e-8) |
| 7 | `travel`: friction from the block column below (y = floor(y - 0.500001F)) at the **start** position; speed = `getSpeed() * (0.21600002F / f^3)`, air 0.02F / 0.025999999F; `moveRelative` (normalise only if |v|^2 > 1); `move`; gravity 0.08; x0.98F; horizontal x `f*0.91F` | `E:545-600`, same order. Block is `floor(y-1)`, constants are doubles, trig is `Math.sin` | ok in order; float and trig in section 2 |
| 8 | `Entity.move`: edge back-off (shift key of **this** tick); `collide` (Y, then larger of |x|,|z| first; 1e-7 epsilon; 1.21 step candidates); tiny result (< 3e-4) not applied (1.21.2+); `Mth.equal` 1e-5 for horizontal collision and velocity zeroing; vy=0 on vertical collision; **then block speed factor** | `E:157-346`: Y,X,Z fixed; no epsilon; legacy step; exact compares; speed factor only via `velocityBlocksOnTop` (1.15-1.20) | **F3, F4, F5, F9, F10** |
| 9 | `sendPosition`: shift action (< 1.21.6) and sprint action (shift first on >= 1.21.2), then Pos/Rot when moved > 2e-4 or 20 ticks; `tick_end` | `P:174-229`: any change, or 1000 ms by wall clock; sprint and sneak written at call time | **F7, F8** |
| 10 | `Player.tick` end: `updatePlayerPose` sets the pose (box 1.5 when crouching) for tick N+1 | none | F2 |

## 2. Float vs double (Grim places `(float)` here; the engine does not)

Measured with `sim/t2_flat.js` (flat ground, walk, sprint, diagonal, bunny hop, 360 degree sweep of yaw), per-tick movement difference between the stock engine and the Grim-style model:

| Setup | max per-tick diff |
|---|---|
| stock engine | walk 2.0e-5, sprint 2.6e-5, **bunny hop 5.7e-5** (cumulative position drift 2-4e-3 over 100 ticks, irrelevant to Grim) |
| model with exact `Math.sin/cos` instead of the table | 6e-8 ... 1.1e-7 (this is the pure float-constant error) |
| patched engine | 0 (bit-equal to the model) |

More than 99 % of the stock error is the **`Mth.sin/cos` lookup table** (index `(int)(rad * 10430.378F) & 0xFFFF` is truncated, angle error up to 9.6e-5 rad), not the floats. It is 17x below the 1e-3 flag line, so this is cosmetic. It is cheap to make exact, and `G:utils/math/TrigHandler.java:setOffset` tries to learn "which trig the client uses" from offsets between 5e-5 and 1e-3, so staying in the table's world avoids confusing it.

Exact placements (all verified against Grim's code):

| Quantity | vanilla | stock engine | exact JS |
|---|---|---|---|
| impulse | +-1, `*0.3F` if crouching (lagged), `*0.2F` using item, then `*0.98F`, all float | double `*0.98`, `*0.3` | `s=F(F(right-left)); if(slow) s=F(s*F(0.3)); s=F(s*F(0.98))` |
| input vector | `len2<1e-7` -> 0; `len2>1` -> `/sqrt(len2)`; `*speed` | `applyHeading` threshold 0.01 | see `moveRelativeVanilla` below |
| yaw | float degrees from the packet; `rad = F(yaw*F(PI/180))`; `Mth.sin/cos` table | double `PI - entity.yaw`, `Math.sin` | `rad = F(F(((PI-yaw)*180)/PI) * F(PI/180))`, table lookup |
| movement speed | `(float)(a + a*0.3F)` with `a = (double)0.1F`; walk 0.10000000149, sprint 0.1300000101 | 0.1 / 0.13 doubles | `playerSpeed=F(0.1)`, `sprintSpeed=F(0.3)`, then `F(attr)` |
| ground acceleration | `speed * (0.21600002F / (f*f*f))`, `f` = block friction float | `speed * (0.1627714 / (f*0.91)^3)` (+3.9e-7 rel.) | `F(speed*F(F(0.21600002)/F(F(slip*slip)*slip)))` (= `speed` exactly for 0.6F) |
| friction | `f*0.91F` float (0.6F -> 0.54600006) | `0.6*0.91` double | `F(slip*F(0.91))`; slipperiness table values `F(0.8)`, `F(0.98)`, `F(0.989)` |
| air acceleration | 0.02F / 0.025999999F | 0.02 / 0.026 | constants |
| air inertia | 0.91F | 0.91 | `F(0.91)` |
| jump | `(float)0.42 * f_block + 0.1F*(lvl)`, `max(.., vy)`; sprint boost `(double)(-sin)*0.2` | `Math.fround(0.42) * 0.4` on honey, `0.1 * level` in double, `-Math.sin(yaw) * 0.2` | see F11 |
| gravity / drag y | 0.08 double, x`0.98F` (as double 0.9800000190734863) | already `Math.fround(0.98)` | **already exact** |
| hitbox | half-width `F(0.6)/2` = 0.30000001192, height `F(1.8)` | 0.3 / 1.8 | the lab's `float-hitbox` patch; I put it in the engine defaults (`E:76-77`) |
| `negligeableVelocity` 0.003 | double | double | exact for 1.21.4 |
| step height | `(float)0.6` | 0.6 | irrelevant (no block is 0.6 high) |

`moveRelativeVanilla` plus the trig table (tested bit-equal against the model):

```js
const F = Math.fround
const DEG2RAD = F(Math.PI / 180)
const SIN = new Float32Array(65536)
for (let i = 0; i < 65536; i++) SIN[i] = F(Math.sin(i * Math.PI * 2 / 65536))      // <= 1.21.10
const K = F(10430.378)
const mthSin = r => SIN[(F(r * K) | 0) & 0xFFFF]
const mthCos = r => SIN[(F(F(r * K) + 16384) | 0) & 0xFFFF]
const yawRad = yaw => F(F(((Math.PI - yaw) * 180) / Math.PI) * DEG2RAD)               // the float yaw that goes into the packet
function moveRelativeVanilla (entity, strafe /* mineflayer sign: right-left */, forward, speed /* float */) {
  let x = -strafe, z = forward                                  // vanilla leftImpulse is + to the left
  const l2 = x * x + z * z
  if (l2 < 1.0E-7) return
  if (l2 > 1.0) { const l = Math.sqrt(l2); x /= l; z /= l }     // Vec3.normalize
  x *= speed; z *= speed
  const rad = yawRad(entity.yaw), s = mthSin(rad), c = mthCos(rad)
  entity.vel.x += x * c - z * s
  entity.vel.z += z * c + x * s
}
```

1.21.11+/26.x (`G:utils/math/ModernVanillaMath.java`): different table and double index math, so gate it:

```js
const SIN26 = new Float32Array(65536); for (let i = 0; i < 65536; i++) SIN26[i] = F(Math.sin(i / 10430.378350470453))
const idx = v => ((Math.trunc(v) % 65536) + 65536) % 65536
const mthSin26 = r => SIN26[idx(r * 10430.378350470453)]
const mthCos26 = r => SIN26[idx(r * 10430.378350470453 + 16384.0)]
```

The 1.21.4 -> 26.x input transformers (`DoubleInputTransformer` vs `ModernInputTransformer`) give the same vector for every key combination, sneak and item (max difference 1.0e-7, `sim/t13_input.js`). No normalisation change is needed.

## 3. Findings, ranked by impact

Severity is the chance Grim flags or sets back, for a bot that does the thing in the title. Confidence is mine in that the fix is right.

### F1. Sprint is a raw flag; vanilla's sprint rules are not modelled (HIGH if the bot ever sprints; confidence 80-85 %; committed driver only, the working-tree rewrite implements it)

- Vanilla stops sprinting with no forward impulse, food <= 6, a hard horizontal collision on the previous tick (soft or "minor" collisions within 8 degrees of the pressed direction do not stop it), and can only start with forwardImpulse >= 0.8 (so not while crouched, not while using an item).
- Grim: while `isSprinting` it fixes forward = +1 (`PredictionEngine.java:732,742`), `SprintA` (food <= 6; `G:checks/impl/sprint/SprintA.java`), `SprintE` (sprinting on the tick after a hard wall hit, setback 5; `SprintE.java:35-46`, soft-collision test `MovementTicker.java:99-141`).
- Mineflayer: `setControlState('sprint')` writes `entity_action` immediately (`P:272-276`) and the physics applies sprint speed to any input (`E:556-566,576-579`). Both are visible: the stock mock bot sent `start_sprinting` with only `left` pressed (`sim/t8_stock.js` case 2).
- First-tick offsets (model): sprint + strafe-only **0.0985**, sprint + back **0.255** (above the 0.1 immediate-setback line). Sprinting after a wall hit is `SprintE` (setback after 5).
- Related ordering rules: `BadPacketsX` (more than one sprint or sneak action between two movement packets, `BadPacketsX.java:40-70`), `BadPacketsF` (duplicate start/stop), `PacketOrderF` (an interaction packet **after** a sprint/sneak `entity_action` in the same tick window is flagged and **cancelled**, `PacketOrderF.java:72-79`), `PacketOrderO` (nothing between a movement packet and `tick_end`). So the sprint and shift packets must go out last, right before the movement packet, once per tick. Order inside a tick window: interactions first; then, for clients >= 1.21.2, the shift action **before** the sprint action (`PacketOrderH.java:35-52`; older clients the reverse), then the movement packet, then `tick_end`. (Another agent's `lib/plugins/input_queue.js` and `test/grimLint.js` in the same repo implement the interaction side of this; `sendInputActions` in my patch is the sprint/shift side and has to run after that queue.)
- Fix on the committed driver (reference implementation: `sim/patched_plugins/physics.js`, exercised by `sim/t8_mockbot.js`): keep the key (`controlState.sprint`) separate from `sprinting`, evaluate the vanilla block once per tick before `simulatePlayer`, send the packet in `updatePosition` first thing:

```js
function updateSprint () {
  let fwd = (c.forward ? 1 : 0) - (c.back ? 1 : 0)
  if (crouching) fwd = F(fwd * F(0.3));  if (bot.usingHeldItem) fwd = F(fwd * F(0.2))
  const hasFwd = fwd > 1.0E-5, food = (bot.food ?? 20) > 6 || bot.game?.gameMode === 'creative'
  if (!sprinting && controlState.sprint && !bot.entity.isInWater && fwd >= 0.8 && food && !bot.usingHeldItem && !blind) sprinting = true
  if (sprinting && (!hasFwd || !food || (bot.entity.isCollidedHorizontally && !bot.entity.minorHorizontalCollision))) sprinting = false
}
// physics gets { ...controlState, sprint: sprinting }; sendInputActions() writes start/stop_sprinting once, before the position packet
```

  Needs `entity.minorHorizontalCollision` from the engine (patched: `isHorizontalCollisionMinor`, mirror of `MovementTicker.java:132-141`, 0.13962634 rad).
- Working tree: the same rules are implemented (`updateSprint`, `recordMovement`, `syncInputState`). It also ends sprinting while the sneak key is held and never starts it then (stricter than vanilla, never flaggable), reads the soft collision from the movement actually made rather than the collide vector (equal except around steps and the 1e-7 rule), and uses `Math.sin` instead of the table there (only the 8-degree test, negligible).
- Tested: `sim/t6_sprint.js` (head-on wall: sprint -> hard collision -> off; 5 degrees off the wall: keeps sprinting; back, strafe-only, hunger 6, crouch, item: never starts), `sim/t8_mockbot.js` (no packet at call time; strafe-only + sprint key sends nothing; start/stop are emitted once, before the position packet; sneak and sprint changing in one tick go out shift first).
- Open points: sprint while crouched (Grim only flags it in water, `SprintB.java:21-45`) and swimming sprint are not modelled; in water the machine neither starts nor stops sprinting.

### F2. Sneak: entity_action is never sent on 1.21.3-1.21.5, and the slowdown and pose lag one tick (HIGH if the bot sneaks; confidence 95 % for the packet, 80 % for the lag; points 1-2 are fixed in the working-tree rewrite, 3-4 are not)

1. `P:277` branches on `newPlayerInputPacket`, which minecraft-data says is true from 1.21.3 (comment says 1.21.6). On 1.21.4, `setControlState('sneak')` writes **only** `player_input {shift}` (confirmed in the mock, `sim/t8_stock.js` case 3). Grim only reads sneak from `entity_action` before 1.21.6 (`G:events/packets/PacketEntityAction.java:47`; `PacketPlayerSteer.java:79` sets it only for >= 1.21.6). So Grim never sees the bot sneaking: no slow movement, no edge back-off, no crouch pose. Sneak-walking is then mispredicted every tick. minecraft-data 3.117 already has the right flag: **`sneakUsesEntityAction`** (1.8-1.21.5).
2. The shift-only `player_input` has all other keys false. If the lab plugin also sends the full input in the same tick, `BadPacketsZ` (duplicate `player_input` per tick, `BadPacketsZ.java:28-35`) flags, and a mid-tick packet carries the wrong keys.
3. Lag: vanilla computes `crouching` from the previous tick's shift key before `input.tick`, and `updatePlayerPose` runs at the end of the tick. Grim: `isSlowMovement = ... wasSneaking ...` (`G:predictionengine/PlayerBaseTick.java:84-90`). Pressing shift at tick N is **not** slowed on N, slowed from N+1 (same for release and for the 1.5 box). The engine slows on N (`E:743-748`): offset on that tick **0.0686** (0.098 vs 0.0294), repeated on release (measured in the mock: -0.0926 stock vs -0.1612 patched on tick N).
4. Crouch box is `F(1.5)` (eye 1.27). The engine keeps 1.8 forever (`E:77`): a bot cannot pass a 1.5-high gap and ray-casts from 1.62 instead of 1.27. Crawling (box 0.6, speed x0.3, `isVisuallyCrawling`) is not modelled.

Fix: the shift action must be sent with the other input actions and chosen by `sneakUsesEntityAction` / version, and the ad-hoc shift-only `player_input` removed from `setControlState`: **done in the working tree** (`syncInputState`: one full `player_input` per tick, `entity_action` shift for < 1.21.6, shift before sprint on >= 1.21.2). **Still open there**: track `crouching` one tick behind and set the pose box. `physics-crouch.diff` (against the working-tree driver, tested with `sim/t14_wt.js`; the engine patch reads `entity.slowMovement` and falls back to the old current-key behaviour if the driver does not set it):

```js
physics.playerHeight = Math.fround(crouching ? 1.5 : 1.8)   // the pose box of the previous tick
const state = new PlayerState(bot, controls); state.slowMovement = crouching
physics.simulatePlayer(state, world).apply(bot)
crouching = controls.sneak                                   // updatePlayerPose (ignores "no room to stand")
```

and in the engine `if (entity.slowMovement ?? entity.control.sneak) { strafe = F(strafe * F(0.3)); forward = F(forward * F(0.3)) }` before the `*F(0.98)`. With it the first tick of `sim/t14_wt.js` case C moves -0.1807 (unslowed, as Grim expects) instead of -0.1121. Not modelled: staying crouched under a 1.5 ceiling after release. If the server config has `force-slow-movement: false`, the lag stops mattering.

### F3. Soul sand and honey are never slowed on 1.21; honey jump factor wrong (HIGH where they occur; confidence 95 %)

- `E:348`: speed factor only if feature `velocityBlocksOnTop`, whose versions in `lib/physics/features.json` stop at "1.20". Nothing on 1.21.x or 26.1. Even on 1.20.4 the lookup `entity.pos.floored().offset(0,-0.5,0)` reads the block **below** the soul sand (feet are inside the soul-sand voxel), so the bot is not slowed while standing on it, only a one-tick dip at the step-up (`sim/t5_soul.js`).
- Vanilla and Grim: factor of the block **at the feet** (`blockPosition()`), else of the block below that affects movement (`y = floor(y - 0.500001F)`), x0.4 on vx and vz, applied after collision and before gravity and friction (`G:utils/nmsutil/BlockProperties.java:108-125`, honey/soul sand 0.4 at `:217`; `MovementTicker.java:252`).
- Measured: bot walks 0.2159 b/t on soul sand, vanilla 0.1254 b/t (x1.72) -> offset about 0.09 per tick, setback after about 11 ticks.
- Honey jump factor: Grim 0.5 (`JumpPower.java:55-57`), engine 0.4 (`E:73,727`) and also looked up under the feet.
- Fix (in `engine.diff`): `speedFactorOf` / `blockBelowThatAffectsMovement` as in the patched file, applied after the collision flags:

```js
const speedFactorOf = b => (b && (b.type === soulsandId || b.type === honeyblockId)) ? Math.fround(0.4) : 1
const feet = world.getBlock(pos); let f = speedFactorOf(feet)
if (f === 1 && !(feet && (waterIds.includes(feet.type) || feet.type === bubblecolumnId))) f = speedFactorOf(blockBelowThatAffectsMovement(world, pos))
if (f !== 1) { vel.x *= f; vel.z *= f }
```

  Verified: 0.1254 b/t. `movement_efficiency` lerp ignored (default 0).

### F4. Step-up uses the pre-1.21 algorithm; falling past a ledge steps up (MEDIUM; confidence 85 %)

- Grim for >= 1.21 uses the new `Entity.collide`: when `vertical collision && vy < 0` the step is evaluated from the **landed** box, candidate heights are the float y breakpoints of colliders (`G:utils/nmsutil/Collisions.java:133-186`, `collectStepHeights :191`), first candidate whose horizontal distance beats the plain collision wins. Prismarine (`E:225-296`) is the 1.8-1.20 algorithm: raise 0.6 from the pre-move box, move, drop back.
- Same result for stairs, slabs, carpet and full blocks (0 mismatches in 30k random scenarios per set, `sim/t3_step.js`, both axis orders allowed as Grim does). It differs for mixed heights (carpet on slab: 0.0625 higher; 0.15 % of random slab+carpet worlds, 0.5 % with every shape).
- It also differs when **falling** next to a block: `sim/t3b_fall.js` (vy -0.3...-1.5, pushing into a 1-high block): **3.7 % mismatches, and in 3.1 % of all trials the stock bot is moved UP 0.4-0.6 while falling** (vanilla lands, Grim expects the landed step). Offsets 0.5-1.0 -> immediate setback. For a 0.5 block 2.8 % mismatch.
- Fix: `collideVanilla` in `engine.patched.js` (a port of the 1.21 algorithm using prismarine's AABB). After it: 0 mismatches in every set above.

### F5. Collision arithmetic: no 1e-7 epsilon, strict compares, no tiny-move rule (LOW-MEDIUM; confidence 85 %)

- Vanilla `Shapes.collide` treats a box as "ahead" if it penetrates less than 1e-7 and overlap in the other axes must exceed 1e-7 (`G:utils/collisions/datatypes/SimpleCollisionBox.java:334-384`); prismarine `aabb.js:67-100` is exact. In a synthetic case (bot placed 1.2e-8 inside a block's cell) the stock engine ignores that block and walks through it, while Grim treats it as a wall. Real positions come from collision clamps, so it is rare (flush stops measured exactly 0 gap in `sim/t1b.js`); the lab's float-hitbox patch covers the common case.
- 1.21.2+: if the collided move has length^2 <= 1e-7 and the wanted move exceeds it by >= 1e-7, **vanilla does not move at all** (`MovementTicker.java:238-240`). The stock engine applies those last <= 3e-4 blocks up to a wall and then sends them as tiny positions (feeds F7).
- Horizontal collision and velocity zeroing use `Mth.equal` (1e-5) in >= 1.18.2 (`MovementTicker.java:152-153`, `GrimMath.java:228`); the engine zeroes on any inequality (`E:299,305`).
- Vanilla axis order is Y then the larger of |x|,|z| (the engine uses Y,X,Z). **Grim tries both orders** (`Collisions.java:60,118`), so this alone is safe; the patch uses vanilla's order anyway.
- Fix: replaced `moveEntity` in `engine.patched.js` (cX/cY/cZ with epsilon, `sweep`, `collideWithShapes`, tiny-move rule, `hitX/hitZ` with 1e-5). 60000 random-terrain ticks, no exceptions; collision tests 0 mismatches. Flat walk into a wall now stops up to 3e-4 short, as vanilla does.

### F6. 1.21.5+ velocity threshold is by horizontal length, not per axis (MEDIUM for 26.x only; confidence 90 %)

`G:predictionengine/predictions/PredictionEngine.java:381-400`. For players: if `vx^2+vz^2 < 9.0E-6` both are zeroed, otherwise neither; y stays per axis 0.003. Stock zeroes the small cross component alone: after turning from a diagonal to a straight line it drops a 0.0022, 0.0012, 0.0007 movement over three ticks (`sim/t10_threshold.js`). Flags (>= 0.001) twice per turn, no setback. Fix:

```js
if (physics.modernMinMovement) { if (vel.x * vel.x + vel.z * vel.z < 9.0E-6) { vel.x = 0; vel.z = 0 } }
else { if (Math.abs(vel.x) < 0.003) vel.x = 0; if (Math.abs(vel.z) < 0.003) vel.z = 0 }
if (Math.abs(vel.y) < 0.003) vel.y = 0
// physics.modernMinMovement = bot.registry.version['>=']('1.21.5')
```

The engine patch defaults `modernMinMovement = false` and `modernJump = true` (valid from 1.21.2); the driver has to set `physics.modernMinMovement = bot.registry.version['>=']('1.21.5')` (and `modernJump` false below 1.21.2) after `Physics(...)`. Not done in any driver yet.

### F7. Position cadence: BadPacketsV and BadPacketsE (MEDIUM/LOW, both `experimental`; confidence 95 % on semantics; committed driver only)

- Vanilla: send a position when `lengthSqr(delta since last SENT) > (2.0E-4)^2` or the 20th tick since the last one (`positionReminder`).
- `BadPacketsV` (`BadPacketsV.java:29-41`, for end-tick clients): a **position** packet whose delta from the previous position is <= 0.0002 and that is not a reminder (< 19 non-position movement packets since) is flagged. The mineflayer rule (`P:196-199`) sends on any bit of change: 14-27 flaggable packets per 24 000 ticks of wall approaches (`sim/t7_send.js`), 0 after the vanilla rule.
- `BadPacketsE` (`BadPacketsE.java:33`): more than 19 non-position flying packets between positions. The mineflayer reminder is wall-clock (`>= 1000 ms`) and catch-up ticks share one `now` (`P:65-76`), so a burst can put 20+ look-only packets before the reminder.
- Fix on the committed driver (working tree: done, `POSITION_EPSILON_SQ = 4e-8`, `positionReminder >= 20`):

```js
const dx = position.x - lastSent.x, dy = position.y - lastSent.y, dz = position.z - lastSent.z
positionReminder++
const positionUpdated = (dx*dx + dy*dy + dz*dz) > 2.0E-4 * 2.0E-4 || positionReminder >= 20
if (positionUpdated) positionReminder = 0
```

  (`lastSent` is already the last *sent* position, as vanilla's `xLast`.) Test: 1e-4 move sends nothing, 2.5e-4 accumulated sends, a stand-still bot sends a reminder on the 20th tick.

### F8. Rotation constraints (LOW; confidence 80 %; mostly fixed in the working tree)

- Active aim checks are only `AimDuplicateLook` (a rotation-flagged packet with the same yaw and pitch as the previous; `AimDuplicateLook.java:29`) and `AimModulo360` (|delta yaw| > 320 after a delta < 30, only while |yaw| < 360; `AimModulo360.java:31`). `Baritone` is disabled by its own comment. The GCD/sensitivity estimate (`AimProcessor`) is informational here: mineflayer's 0.15-degree steps decode as sensitivity 0.5 (vanilla default, shown as 100 %), a valid value.
- Continuity: the sent yaw is unwrapped and continuous (`lastSentYaw += clamp(deltaYaw)`, `P:180-190`), so no modulo-360 flag; vanilla never wraps either.
- **Pitch is not clamped** (`P:347-360`): `bot.look(0, 2.5)` sends 143 degrees (measured). `BadPacketsD` is commented "Ban." and fires for any pitch outside [-90, 90] (`BadPacketsD.java:26-31`). Clamp in `bot.look`; the working tree clamps in `packetPitch` and `bot.look`.
- `player_rotation` (server-set rotation, 1.21.3+) sets `entity.yaw` but not `lastSentYaw`, so the next packet is eased (measured: asked 170/30, sent 98.6/8.6). Grim expects the exact rotation (`BadPacketsB`, `CheckManagerListener.java:425-433`, `RotationData.allowRotation` exact float compare). The working tree answers it with a `look` packet in the air, as vanilla does and `BadPacketsB` expects (better than my `lastSent*` sync).
- The EBSlab `vanillaTick` `exactRotation` hook writes the *simulated* yaw into the packet after mineflayer decided `look`/`position_look` from the *newer* yaw; at the first tick of a turn made in a `physicsTick` listener the packet then repeats the previous yaw -> `AimDuplicateLook` (VL only). The working-tree driver captures the rotation once per tick (`captureRotation`) and decides `lookUpdated` from that same value, so the problem does not exist there and the hook is redundant.

### F9. Sneak edge back-off with partial-height supports (LOW; confidence 80 %)

`E:175-205` uses y offset 0 and `getSurroundingBBs(...).length === 0` (any block in the rows, no intersection test), vanilla and Grim use the box shifted down by the step height and an intersection test (`Collisions.java:385-431`, `isAboveGround :433` also allows `fallDistance < stepHeight`). Equal on full-block platforms (0 of 27 867, `sim/t4_sneak.js`), different next to carpet, snow, trapdoors, slabs, fences (415 of 25 321, offsets 0.05-0.15). Fixed in `engine.patched.js`; `isAboveGround`'s `fallDistance` branch is not modelled (needs fall distance in `PlayerState`).

### F10. Friction and speed-factor block column (LOW; confidence 90 % on formula)

Vanilla `getBlockPosBelowThatAffectsMyMovement`: x/z of the **main supporting block** (closest collider under the box), y = `floor(y - 0.500001F)` (`BlockProperties.java:141-162`). The engine: `floor(y-1)` under the **centre** (`E:545`). Same for full-block floors; different on soul sand/farmland tops (y), and when the box straddles ice and stone (column). I only fixed y (`blockBelowThatAffectsMovement`); the supporting-block column needs a closest-collider search. Only matters on ice highways.

### F11. Jump details (LOW; confidence 90 %)

Vanilla 1.21.2+: `vy = max(jumpPower, vy)`; `(float)jump_strength * blockJumpFactor + 0.1F*level`; skipped if `<= 1e-5`; `noJumpDelay = 10` regardless (`JumpPower.java:17-52`). Engine: assignment, honey 0.4, effect added in double. Already equal: the `noJumpDelay` / `jumpTicks` countdown, reset on release, threshold-then-jump-then-travel order, `Math.fround(0.42)`. `jumpQueued` lets a sub-tick tap jump; vanilla cannot, so the lab sends `jump` in `player_input` for that tick, which is the right fix.

### F12. Attribute plumbing (INFO, will bite on a minecraft-data update; confidence 85 %)

minecraft-data 3.117's `entity_update_attributes` mapper for 1.21.4 has 22 keys (minecraft-data's own `attributesByName` lists 30) and names them `generic.movement_speed` while prismarine looks up `minecraft:movement_speed` (`E:99,548`), so server attributes are ignored today (default 0.1 + own sprint modifier; no double sprint). Modifier identity is `uuid` string in the data, but the sprint modifier in 1.20.5+ is `minecraft:sprinting`, not `662a6b8d-...` (`E:100,557`). When the key mapping gets fixed, server attributes include the vanilla server's sprint modifier and the engine would apply it twice (x1.69 speed). Compare against both identifiers when that day comes.

### F13. Catch-up ticks and Grim's timers (LOW)

`Timer` adds 50 ms per movement packet and flags when ahead of the transaction clock by more than the 120 ms drift (`Timer.java:69,75,111`), `TickTimer` wants exactly one flying packet per `tick_end` (setback 1; teleport replies are exempt), `NegativeTimer` allows 1200 ms behind (`NegativeTimer.java:54`). `maxCatchupTicks` 4 (`P:19`) can emit a 4-tick burst after a 200 ms event-loop stall; 2 matches the drift budget. The working tree uses `MAX_BURST = 2` and drops the rest.

### F14. Teleport velocity on 1.21.2+ (LOW; confidence 85 %)

The 1.21.2+ `position` packet carries `dx, dy, dz` and the relative flags `dx, dy, dz, yawDelta` (minecraft-data `PositionUpdateRelatives`). Vanilla sets the velocity to the packet delta (added to the old one for the `dx/dy/dz` flags) and Grim mirrors it (`G:utils/data/TeleportData.java:27-62`). Both drivers (`P:411-465` at HEAD, the same block in the working tree) use the *position* flags `x/y/z` to decide "keep the old velocity, else 0" and ignore `dx/dy/dz`. That equals Grim for its own setbacks (absolute, zero delta) but is wrong for a relative teleport or one with a non-zero delta. Fix, 1.21.2+ only: `vel.set(flags.dx ? vel.x + packet.dx : packet.dx, flags.dy ? vel.y + packet.dy : packet.dy, flags.dz ? vel.z + packet.dz : packet.dz)` (and rotate the old velocity by the yaw change when `flags.yawDelta`).

## 4. Status of the uncommitted working-tree driver (cross-check)

I read `lib/plugins/physics.js` / `input_queue.js` as they were at about 08:55 and ran them with the patched engine on a virtual clock (`sim/t14_wt.js`, built by `sim/make-wt.sh`; sprint start, strafe-only sprint and sneak packet order behave as intended).

| Finding | Working tree |
|---|---|
| F1 sprint rules and packet timing | implemented (stricter on sneak) |
| F2.1/2.2 sneak packet, duplicate `player_input` | implemented |
| F2.3/2.4 crouch lag and pose box | **open** -> `physics-crouch.diff` |
| F3 soul sand / honey, F4 step-up, F5 collision epsilon / tiny move / `Mth.equal`, F6 threshold, F9-F12 | **open** (engine, `engine.diff`) |
| F7 position cadence | implemented |
| F8 pitch clamp, `player_rotation`, duplicate rotation | implemented |
| F13 burst | implemented (2) |
| F14 teleport velocity | open |

The engine patch only needs `PlayerState(bot, controls)`, `state.yaw/pitch`, `simulatePlayer(...).apply(bot)` and `physics.yawSpeed`, which the rewrite already uses; `entity.minorHorizontalCollision` and `entity.xxa/zza` are produced but unused there.

## 5. Things that are already right (do not touch)

Tick order (threshold, jump, input, travel, gravity-then-drag); gravity 0.08; vertical drag `fround(0.98)`; `0.003` for 1.21.4; `Math.fround(0.42)`; jump-delay logic; 0.98 factor; input normalisation (|v|^2 > 1); step 0.6 for stairs, slabs, carpet and full blocks; ground/air selection by last tick's `onGround`; `onGround = verticalCollision && vy < 0`; vy zeroing on landing; sprint-jump yaw boost; the lab's float hitbox, `player_input`, `tick_end`, exact rotation, keep-ground.

Lab's open item (last step off the stairs, momentum 0.246 -> 0.036): I could **not** reproduce it in physics. Walking and sprinting off a platform edge and up and down a staircase of full blocks give identical movement in stock and patched engines (`sim/t11_edge.js`: 4000 runs, max diff 9e-7; `sim/t12_stairs.js`: 1500 runs, max 3e-4, no divergence). Candidates that remain outside the collision code: a tick that sends no position and then two ticks of movement, a key release by the pathfinder (momentum-only in Grim means no input), sprint state (F1) or a sneak flag (F2) on that tick.

## 6. 26.1 / 26.2 deltas relevant here (all from Grim's version gates)

| Version | Change | Where | Status in the patch |
|---|---|---|---|
| 1.21.2 | `tick_end`, `player_input` carries keys; tiny-move rule; `max(jumpPower, vy)` | `Collisions`, `MovementTicker:238`, `JumpPower:35` | done (`physics.modernJump`) |
| 1.21.5 | players' threshold by horizontal length; `ModernInputTransformer` (same vector) | `PredictionEngine:381` | F6 |
| 1.21.6 | sneak only in `player_input` (no `entity_action`) | `PacketPlayerSteer:79` | `sneakUsesEntityAction` is false there |
| 1.21.11 | new sin/cos table; `use_effects.speed_multiplier` and `can_sprint` item component | `ModernVanillaMath`, `ModernInputTransformer:58-68` | snippet in section 2; item multiplier not modelled |
| 26.2 | `friction_modifier`/`air_drag_modifier`/`bounciness` attributes (all identity at default); `getFrictionInfluencedSpeed` returns plain `speed` for friction <= 0.6 | `BlockProperties:40,236-285` | equal to the formula at 0.6F |
| 26.3 | shelf-mushroom bounce, mining fatigue, ... | | n/a |

## 7. Packet and ordering constraints Grim enforces for a walking bot (summary)

| Check | Rule | Setback? |
|---|---|---|
| `Simulation` (OffsetHandler) | offset >= 0.001 flags, >= 0.1 or advantage >= 1 sets back | yes |
| `GroundSpoof` / `NoFall` | packet `onGround` equals the predicted one | 10 |
| `Phase` | new box intersects a block that the old box did not (tolerance 1e-7) | 1 |
| `TickTimer` | one flying packet per `tick_end`; nothing but async packets between a movement packet and `tick_end` (`PacketOrderO`) | 1 |
| `Timer` / `NegativeTimer` | 20 packets/s +120 ms / -1200 ms | 10 / experimental |
| `BadPacketsE` / `V` / `X` / `Z` / `F` / `D` | position at least every 20 ticks; no sub-0.0002 position unless reminder; <= 1 sprint and 1 sneak action per tick; <= 1 `player_input` per tick; no duplicate sprint state; pitch in [-90, 90] | flag only (D: "Ban.") |
| `SprintA/B/C/E/G` | food > 6; no sprint in water while crouching (B) or using an item (C); no sprint after a hard wall hit (E); no sprint in water (G) | A 0, B 5, C 5, E 5, G none |
| `PacketOrderF` / `H` | interaction packets before sprint/sneak actions in a tick window, else cancelled; on >= 1.21.2 the shift action before the sprint action | flag + cancel / flag |
| `AimDuplicateLook` / `AimModulo360` | rotation packet must change rotation; no 320+ degree single-tick yaw jump | flag only |

## 8. Evidence index (`/home/user/ref/notes/physics-ground/`)

Setup: `ln -sfn /home/user/EldiaMineflayer/node_modules sim/node_modules` (already present). Tests take `ENGINE=patched` to use `sim/patched/engine.js` instead of the vendored stock engine. `EXACT=1` makes the model use exact trig.

| Script | Shows | Key numbers |
|---|---|---|
| `t2_flat.js` | float/trig error vs model | stock 2e-5...5.7e-5; patched 0 |
| `t3_step.js` | step-up vs 1.21 algorithm (both axis orders) | stock 0 diffs for full/slab/carpet/stairs, 0.15-0.5 % mixed; patched 0 |
| `t3b_fall.js` | falling into a ledge | stock 3.7 % mismatch (3.1 % step UP); patched 0 |
| `t4_sneak.js` | edge back-off | stock 0 / 1.6 % (full / partial); patched 0 |
| `t5_soul.js` | soul sand | stock 0.2159 b/t, vanilla/patched 0.1254 b/t |
| `t6_sprint.js` | sprint state machine | transitions listed in section F1 |
| `t7_send.js` | BadPacketsV-eligible packets | stock 14-27 per 24k ticks, vanilla rule 0 |
| `t8_mockbot.js` / `t8_stock.js` | my reference driver vs the committed (HEAD) driver, packet streams on a virtual clock | stock: sprint written at call time, shift-only `player_input`, tiny positions, pitch 143 degrees, eased `player_rotation`; reference: none of these |
| `t14_wt.js` (+ `make-wt.sh`) | the uncommitted working-tree driver with the patched engine (and `CROUCH=1` for `physics-crouch.diff`) | sprint start, strafe-only sprint, sneak packet order, first sneak tick -0.1121 -> -0.1807 |
| `t10_threshold.js` | 26.x threshold | 0.0022 / 0.0012 / 0.0007 |
| `t11_edge.js`, `t12_stairs.js` | lab's stairs and edge | no divergence |
| `t13_input.js` | 1.21.4 vs 1.21.5+ input vector | <= 1e-7 |

Apply (not applied by me): `cd /home/user/EldiaMineflayer && patch -p1 < /home/user/ref/notes/physics-ground/engine.diff` for the engine, and `patch -p1 < /home/user/ref/notes/physics-ground/physics-crouch.diff` for the working-tree driver (both dry-run clean against the current files; `physics-crouch.diff` is against an uncommitted file that is still being edited). The earlier full driver patch was dropped because the working-tree rewrite supersedes it; its reference implementation stays in `sim/patched_plugins/`. `engine.patched.js` assumes >= 1.21.2 semantics (the old 1.8-1.14 soul-sand-on-collision branch is dropped; the 1.8-1.20 behaviour is not kept). Not tested: the full mineflayer stack with pathfinder against a server.

## 9. Summary (10 lines)

1. Float vs double is not the problem: stock error is 2e-5...6e-5 per tick, almost all of it the `Mth.sin` lookup table, against a 1e-3 flag line. Exact placements are in section 2; the engine patch is bit-equal to the Grim-style model.
2. Sprint was a raw flag at HEAD (strafe-only+sprint 0.0985 off, sprint+back 0.255, SprintE after a wall hit); the uncommitted driver rewrite implements the vanilla rules and packet timing (F1).
3. Sneak on 1.21.3-1.21.5 sent only `player_input`, which Grim ignores before 1.21.6 (fixed in the rewrite); still open: slowdown and pose lag one tick (0.0686 offset on press and release) and the 1.5 box (`physics-crouch.diff`) (F2).
4. Soul sand and honey are never slowed on 1.21 (feature list stops at 1.20, wrong block lookup): 0.216 vs 0.125 b/t; honey jump factor 0.5 not 0.4 (F3, `engine.diff`).
5. Step-up is the pre-1.21 algorithm: falling beside a 1-high block the stock bot is moved UP in 3 % of cases (offset 0.5-1.0), mixed heights differ 0.15-0.5 %; stairs, slabs and full blocks are identical (F4, `engine.diff`).
6. Collision lacks the 1e-7 epsilon, the 1.21.2 "tiny move is not applied" rule and the `Mth.equal` 1e-5 gate for velocity zeroing; small, but they feed BadPacketsV (F5).
7. Position cadence (> 2e-4 or the 20th tick, BadPacketsV/E) was wrong at HEAD (14-27 flaggable packets per 24k ticks) and is fixed in the rewrite (F7).
8. 26.x: the player velocity threshold is by horizontal length (two flagged ticks per turn) and the sin table changes at 1.21.11 (F6, section 2); the teleport packet's velocity delta is ignored on 1.21.2+ (F14).
9. Rotation: pitch clamp (BadPacketsD says "Ban."), the `player_rotation` reply and duplicate rotation packets are all handled in the rewrite (F8).
10. The lab's stairs/edge setback is not reproduced by any physics difference (4000 edge runs, 1500 stair runs identical): look at tick/packet timing, key release and sprint/sneak state. Confidence: Grim-code and packet facts high, sprint/sneak lag 80 %, nothing validated against a live Grim.
