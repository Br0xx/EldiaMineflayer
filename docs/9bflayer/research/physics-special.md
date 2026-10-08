# Bit-exact physics: items, fluids, climbing, effects/attributes, knockback, 26.x

Scope: everything except plain ground/air walking, jump, block collision, sprint speed and per-tick send rules (another
agent). Target: 1.21.4 (what 9b9t speaks) and 26.1/26.2. Use case: AFK/stash bot that walks around a base, opens chests,
eats, swaps totems.

Nothing in any repo was modified. Scratch experiments live in
`/tmp/claude-0/-home-user/eb66a42d-ef81-5c8a-86f1-9b20b3abaff7/scratchpad/` (soultest.js, fixmapper.js, fluid.js, snippets.js).

## Conventions

* `grim:` = `/home/user/ref/grim/common/src/main/java/ac/grim/grimac/`
* `pp:` = `/home/user/EldiaMineflayer/lib/physics/engine.js`. This is the vendored copy of prismarine-physics 1.11.1
  (commit eed689d "vendor prismarine-physics into lib/physics"). It is byte-identical to
  `node_modules/prismarine-physics/index.js` apart from the require paths, so every line number also holds for the
  node_modules copy (`index.js`). `pp-features:` = `lib/physics/features.json`.
* `mf:` = `/home/user/EldiaMineflayer/lib/plugins/` (mineflayer 4.39.0 fork; minecraft-data 3.117.0, nmp 1.68.0).
  Line numbers are as of commit eed689d; the repo is being edited concurrently, so they may drift by a few lines.
* Confidence tags: **[RUN]** I executed code here and saw the result. **[READ]** I read both sides and the logic is
  unambiguous. **[INFER]** Grim is the only evidence for vanilla behaviour (vanilla source is not in the sandbox).
  Grim is a faithful port, so I trust it, but I did not diff against decompiled Minecraft.
* "Flag" means a Grim check fires. A setback needs accumulated VL (NoSlow setback=5, AntiKB 10, simulation per config).

## 0. Ranked findings for an AFK/stash bot

| # | Finding | Grim reaction | How likely at a base | Conf. |
|---|---|---|---|---|
| 0 | **26.2: `Physics()` throws at construction** (`features.json` has no `26.2`). Blocker for 26.2 only. | n/a (bot cannot start) | certain on 26.2 | READ |
| 1 | **A1. `update_attributes` is decoded with a stale key table on every 1.20.5-26.x version, and physics looks for another key anyway: server-side attribute modifiers never reach physics.** Speed/Slowness, soul speed, swift sneak, depth strider (1.21 form), powder snow slow, `movement_efficiency`, `sneaking_speed`, `jump_strength`, `gravity`, `step_height` are all ignored. Fixing the keys alone makes sprint double count (1.3^2). | Simulation offset on every tick the modifier is active (Speed II: 40 % too slow) | any beacon, potion, slowness source, DS boots | RUN |
| 2 | **U1. Physics has no concept of "using an item"** (no 0.2 input factor). `bot.usingHeldItem` is a loose flag nothing reads, and it is wrong in 3 ways. Needs a vanilla-faithful `bot.itemInUse` (design below). | `NoSlow` (setback 5) when moving while eating/drinking/blocking; `MultiActions A/B/E` when attacking/breaking/swinging while "using"; `MultiActions C/D` when clicking/closing windows while moving/sprinting/jumping | eats on the move: only if a code path allows it; standing-still eating is safe | READ |
| 3 | **B1. Block speed/jump factors are missing on 1.21+**: soul sand 0.4, honey 0.4, honey jump factor 0.5 (pp uses 0.4), movement-efficiency lerp. Even when the feature is on (1.15-1.20) pp looks up the wrong block for soul sand. | Simulation (horizontal too fast, 2.5x) | soul sand (bubble elevators, decor) / honey: low-moderate | RUN |
| 4 | **W1-W3. Fluids are 1.12-style**: sprint swim friction 0.9 and no gravity-while-sprinting, depth strider (0.7 constant, NBT only), push vector = normalize(sum) instead of vanilla average, shrunken detection box. Plus the bot-side rule that vanilla drops sprint in water (SprintG). | `SprintG` immediately when a sprinting bot wades; simulation offsets in flowing water | water streams/pearl-chamber water: moderate | READ / RUN for sprint-key |
| 5 | **K1. Knockback/explosion timing is right** (applied on receipt, replies flushed in order). Two real bugs: `entity_velocity`/`spawn_entity` still divide by 8000 on **1.21.9+ (lpVec3)**, and the `position` handler uses pre-1.21.2 velocity-reset semantics (ignores `dx,dy,dz`/delta flags). | AntiKB on 26.x (velocity ~0); setback velocity mismatch only for non-zero-delta teleports | 26.x only / rare | READ |
| 6 | **C1-C3. Climbing**: `climbable` tag has 9 blocks, pp knows 3 (+ trapdoor rule disabled for 1.21+). Scaffolding sneaking differs. | Simulation (stuck/falls vs expected) | ladders ok; vines (nether/ weeping) rare | READ |
| 7 | **C4-C7. Misc blocks**: web/berry/powder-snow multipliers (only cobweb), bubble column applied before friction (vanilla 1.21.2+: after), bed bounce (0.66 / 0.75 in 26.2), supporting-block friction at edges. | Simulation, only on contact | rare | READ |
| 8 | E1. Elytra/firework/riptide/creative flight: pp covers elytra core; riptide/flight absent. | n/a for stash bot | negligible | READ |
| 9 | N1. 26.2: `friction_modifier`, `air_drag_modifier`, `bounciness` attributes, speed formula change for friction <= 0.6, potent-sulfur geysers, per-version block-effect resolver, `use_effects` item component. | only if server changes the attributes / bot in sulfur biome | negligible at a base | READ |

Things I checked and found **correct** (do not touch): knockback arrival moment, explosion add (1.21.4 `playerKnockback`),
levitation, slow falling (also in water: 0.125 x 0.005 = 0.000625 = 0.01/16), dolphin's grace 0.96, jump boost order,
ladder speed clamp and climb 0.2, web multipliers, water gravity 0.08/16, jump-in-water +0.04, swim-hop 0.3 rule
(`doesNotCollide` includes the "no liquid in box" test like `Entity.isFree`).

---

## 1. Effects and attributes (finding A1)

### 1.1 What is wrong

1. The decoder. `minecraft-data/.../pc/1.21.4/protocol.json` `packet_entity_update_attributes.properties[].key` is a
   `mapper` with the **1.20.5 table (22 names, `generic.*`)**. Real 1.21.4 uses the registry table (32 entries). The same
   stale table ships for 1.21.5 (27), 1.21.6-26.1 (31). I fed the real 1.21.4 wire id into the deserializer **[RUN]**:

   | wire id (registry order from `attributes.json`) | real attribute | what mineflayer stores |
   |---|---|---|
   | 13 | gravity | `generic.knockback_resistance` |
   | 14 | jump_strength | `generic.luck` |
   | 21 | **movement_speed** | **`generic.step_height`** |
   | 25 | sneaking_speed | raw number `25` |
   | 31 | water_movement_efficiency | raw number `31` |

2. The consumer. `pp:99` `movementSpeedAttribute = mcData.attributesByName.movementSpeed.resource`, which is
   `minecraft:movement_speed` on 1.21.2+ (1.21.4 `attributes.json`), read at `pp:548-553` as
   `entity.attributes['minecraft:movement_speed']`. Even a correct mapper (`generic.movement_speed`) would not match.
   So `playerSpeedAttribute` is always the fallback `createAttributeValue(0.1)`.
3. `mf:entities.js` `updateAttributes` (~L580-592) does keep `{value, modifiers}` per entity, including the bot. It
   tracks the packet fine; only the key naming is broken. Modifier ids arrive in the field named `uuid` (it is a string
   such as `minecraft:effect.speed`; `operation` is numeric 0/1/2, so `attribute.js` algebra works).
4. Effects: `PlayerState.speed` / `.slowness` (`pp:832-833`) are computed and **never used**. Speed/Slowness only exist
   as attribute modifiers, so they are dropped. Experiment **[RUN]** (30 ticks forward on stone, 1.21.4):
   * no attributes: 6.10 blocks;
   * Speed II modifier under the key physics expects: 8.52 blocks (what vanilla/Grim expect);
   * the same modifier under the key mineflayer actually stores: 6.10 blocks (ignored).

### 1.2 Hazard: fixing only the keys double counts sprint

The server's `update_attributes` for `movement_speed` contains a sprint modifier whose id is `minecraft:sprinting`
(1.21+) once it has processed `start_sprinting`. pp strips only the old UUID (`pp:557`, `physics.sprintingUUID`) and then
adds its own. **[RUN]**: key fixed + server sprint modifier present + `control.sprint`: 10.29 blocks in 30 ticks vs
7.93 blocks correct (1.3^2 instead of 1.3). Grim strips both ids: `grim:utils/data/attribute/ValuedAttribute.java:111-112`
(`SPRINTING_MODIFIER_UUID` or name `sprinting`) and applies its own `+0.3F` only if `hasSprintingAttributeEnabled`
(`grim:predictionengine/MovementCheckRunner.java:362-368`).

### 1.3 Fix A: repair the key mapper once, before the first `createClient`

The compiled deserializer embeds the mapping, so patch the shared minecraft-data object before the first
`mineflayer.createBot` of the process (all bots then benefit; same module instance nmp requires). **[RUN]**: after
the patch, wire ids 13/14/21/25/31 decode to `minecraft:gravity`, `jump_strength`, `movement_speed`, `sneaking_speed`,
`water_movement_efficiency` (script `fixmapper.js`).

```js
// run once per process, before createBot()/createClient(), for the version you connect with
function fixAttributeKeyMapper (version) {
  const mcData = require('minecraft-data')(version)
  if (!mcData.isNewerOrEqualTo('1.20.5')) return                // <= 1.20.4 table is correct ('generic.*' == resource)
  const t = mcData.protocol.play.toClient.types.packet_entity_update_attributes
  const keyField = t[1][1].type[1].type[1][0]                  // properties[].key
  if (keyField.name !== 'key' || keyField.type[0] !== 'mapper') return
  const mappings = {}
  mcData.attributesArray.forEach((a, i) => { mappings[i] = a.resource })   // wire id == registry order
  keyField.type[1].mappings = mappings
}
```

If the process cannot guarantee the order (client already created), re-key in `mf:entities.js` `updateAttributes`
instead:

```js
const STALE = (() => {                     // name the stale mapper produced -> wire id it came from
  const t = bot.registry.protocol.play.toClient.types.packet_entity_update_attributes
  const f = t[1][1].type[1].type[1][0]
  const m = f.type[0] === 'mapper' ? f.type[1].mappings : {}
  return new Map(Object.entries(m).map(([id, name]) => [name, Number(id)]))
})()
const resourceOf = (key) => {
  const id = typeof key === 'number' ? key : STALE.get(key)
  return (id !== undefined && bot.registry.attributesArray[id]?.resource) || key
}
// ...in updateAttributes: entity.attributes[resourceOf(prop.key)] = { value: prop.value, modifiers: prop.modifiers }
// guard with bot.registry.isNewerOrEqualTo('1.20.5') so older versions keep their (correct) names
```

Assumption to verify on the first login (cheap, 10 s in the lab console): with Fix A,
`bot.entity.attributes` must contain `minecraft:movement_speed` ~0.1, `minecraft:jump_strength` 0.42,
`minecraft:gravity` 0.08, `minecraft:step_height` 0.6, `minecraft:max_health` 20. Without the fix the same values show
up under `generic.step_height`(0.1), `generic.luck`(0.42), `generic.knockback_resistance`(0.08).
That check proves wire id == `attributes.json` order on the live protocol. Confidence in the order: high
(vanilla registers in that order, and the 1.21.3 file lists `explosionKnockbackResistance` before
`entityInteractionRange`, i.e. registration order, not alphabetical).

EBS pins mineflayer 4.27.0 / minecraft-data 3.84.1: that era's 1.21.4 table is the same 1.20.5 one, so the bug and the fix
carry over. Run the same console check there.

### 1.4 Fix B: physics reads attributes through one helper

Replace `pp:545-570` (speed) and use the same helper for the other attributes. Vanilla algebra is
`clamp((base + sum(add)) * (1 + sum(mulBase)) * prod(1 + mulTotal), min, max)`; `attribute.js` is equivalent
(op 2 applied sequentially == product) but has no clamp.

```js
const SPRINT_IDS = new Set([physics.sprintingUUID, 'minecraft:sprinting', 'sprinting'])
function attr (entity, resource, def, min = -Infinity, max = Infinity) {
  const prop = entity.attributes?.[resource]
  if (!prop) return def
  const modifiers = resource.endsWith('movement_speed')
    ? prop.modifiers.filter(m => !SPRINT_IDS.has(m.uuid)) : prop.modifiers
  return Math.min(max, Math.max(min, attribute.getAttributeValue({ value: prop.value, modifiers })))
}
// speed incl. our own sprint modifier; 0.3F is the float literal vanilla uses
let speed = attr(entity, physics.movementSpeedAttribute, 0.1, 0, 1024)
if (entity.control.sprint) speed += speed * Math.fround(0.3)
speed = Math.fround(speed)                                  // LivingEntity.getSpeed() returns float
```

(`grim:predictionengine/MovementCheckRunner.java:363-367` does exactly `speed += speed * 0.3F; (float)`.) Also
requires the resource names of the 1.20.5-1.21.1 tables (`generic.movement_speed`) to come from
`attributesByName.*.resource`, not hard coded; the snippets below use short names via a tiny lookup:

```js
const R = (n) => mcData.attributesByName[n]?.resource      // 'sneakingSpeed' -> 'minecraft:sneaking_speed'
```

### 1.5 Which attributes the engine should read (with Grim reference)

| Attribute (resource) | Default | Grim use | pp today | Change |
|---|---|---|---|---|
| movement_speed | 0.1 | `MovementCheckRunner.java:264,363-367` | read, broken key (1.21+) | Fix A + B |
| sneaking_speed | 0.3 (swift sneak 0.3+0.15/lvl) | `MovementCheckRunner.java:508`, input transformers (`DoubleInputTransformer.java:19-20`, `ModernInputTransformer.java:31-33`) | constant `physics.sneakSpeed = 0.3` (`pp:747-748`) | `strafe *= attr(.., R('sneakingSpeed'), 0.3, 0, 1)` |
| jump_strength | 0.42 | `JumpPower.java:48-53` | `Math.fround(0.42)` (`pp:727`) | `attr(.., R('jumpStrength'), 0.42, 0, 32)`; 1.20.5+: if power <= 1e-5 do not jump (`JumpPower.java:32`) |
| gravity | 0.08 | `MovementTicker.java:429-440`, `PredictionEngineNormal.java:30-38` | constant `physics.gravity` | optional; slow falling = `Math.min(g, 0.01)` |
| step_height | 0.6 | `GrimPlayer.java:468` | constant `physics.stepHeight` (`pp:69`) | optional |
| movement_efficiency | 0 | `BlockProperties.java:231-234` (lerp of block speed factor) | none | with B1 |
| water_movement_efficiency | 0 (DS III = 1.0) | `MovementCheckRunner.java:507`, `MovementTicker.java:455-467` | none; DS from boots NBT (`pp:840-847`) which is **null on 1.20.5+** (item components), so always 0 | W3 |
| safe_fall_distance, fall_damage_multiplier | 3 / 1 | fall damage only | n/a | none |
| scale | 1 | box size/eye height (`PlayerBaseTick.java:38-44`) | n/a | out of scope |
| (26.2) friction_modifier, air_drag_modifier, bounciness | 1 / 1 / 0 | `BlockProperties.java:236-298` | none | N1 |

### 1.6 How effects enter (vanilla 1.21.4) and status

| Effect | Path | pp | Status |
|---|---|---|---|
| Speed (+20 %/lvl), Slowness (-15 %/lvl) | attribute modifier on movement_speed (`minecraft:effect.speed` / `.slowness`, mul-total). Vanilla adds them locally on `entity_effect` **and** the server re-syncs them in `update_attributes`; Grim uses the attribute packet only | attribute path broken | A1 |
| Jump Boost | direct: `+0.1F*(amp+1)` added to jump power | `pp:728-730` | ok (1.21.2+ `max(power, vel.y)` missing, `pp:727`; matters only if `vel.y > 0.42` when jumping, e.g. bubble column) |
| Levitation | direct `vy += (0.05*(amp+1)-vy)*0.2`, not in fluids | `pp:598-600` | ok |
| Slow Falling | direct, `gravity = min(g, 0.01)` when `vy <= 0` | `pp:470` | ok |
| Dolphin's Grace | direct, water friction 0.96 after depth strider | `pp:489` | ok |
| Weaving | direct, cobweb multiplier (0.5, 0.25, 0.5) (`grim:utils/nmsutil/StuckSpeed.java:18,53`) | none | C4 |
| Blindness | cannot start sprinting (`SprintD`) | n/a | bot rule: no `sprint=true` while Blindness |
| Soul Speed, Depth Strider, Swift Sneak (1.21) | enchantment -> attribute modifiers synced by the server | broken with A1 | A1 |

### 1.7 Optional: exact sprint-modifier lifecycle (small)

Vanilla's sprint modifier is client-side state that a server `update_attributes` **overwrites** (bug MC-69459). Grim
models it as `hasSprintingAttributeEnabled`: set to `isSprinting` on every local sprint transition
(`MovementCheckRunner.java:329-331`), overwritten with "does the packet's list contain the sprint modifier" on every
`update_attributes` for movement_speed (`grim:utils/latency/CompensatedEntities.java:112-135`). The bot can copy this
instead of reading `control.sprint`: keep `bot._sprintModifier`, set it in `setControlState('sprint', ...)` and in
`updateAttributes`. Only matters in the tick window where the server pushes an attribute update (effect applied/expired,
armour swap) while sprinting. Low priority.

---

## 2. Using an item (finding U1)

### 2.1 What vanilla/Grim do

* Input factor 0.2 on both axes while `isUsingItem()` (any hand, any item that started using). 1.14-1.21.4:
  `grim:predictionengine/predictions/input/impl/DoubleInputTransformer.java:26-29`; 1.21.5+:
  `ModernInputTransformer.java:27-29` with factor from the item (`:58-66`; from 1.21.11 the `use_effects` component's
  `speed_multiplier`, default 0.2; the 26.1 protocol has `use_effects {can_sprint, interact_vibrations, speed_multiplier}`).
  Order versus the 0.3 sneak factor and 0.98 is irrelevant (all multiplicative).
* Grim's state: `PacketStateData.slowedByUsingItem`, driven by
  * start: `use_item` / `block_place(face=other)` if the item "can be used": `grim:events/packets/PacketPlayerDigging.java:36-58`
    and `grim:utils/item/ItemBehaviour.java`/`ItemBehaviourRegistry.java` (consumable component with
    `consume_seconds > 0`; food needs `canAlwaysEat || food < 20 || creative`; `shield`, `goat_horn`, `spyglass` always;
    bow/crossbow "unsupported" = treated as not slowing; trident only without riptide and if not about to break; 1.21.5+
    `blocks_attacks` unless swappable equippable; not usable while the item is on cooldown);
  * stop: `block_dig RELEASE_USE_ITEM` (`PacketPlayerDigging.java:65-79`), selected-slot change for a main-hand use
    (`:87-95` on the next flying/tick_end packet and `:98-123` on `held_item_slot`), and any server
    `living_entity_flags` metadata for the player (bit 1 = active, bit 2 = offhand), which overrides the client state
    (`grim:events/packets/PacketSelfMetadataListener.java:188-223`).
* Grim brute-forces both states each tick (`PredictionEngine.java:764-806`, `Flip_Use_Item`) and only complains if the
  best *non-flipped* (slowed) prediction is off while it believes the player is slowed:
  `grim:checks/impl/movement/NoSlow.java:26-47` (threshold 0.001, needs 2 consecutive ticks, setback 5).
  Consequences: moving normally while Grim thinks you eat -> NoSlow; moving slowly while it thinks you do not
  (bow draw, uncertain items) -> accepted.
* Sprint: Grim does not enforce "stop sprinting when using an item" on land for 1.21.4 (`SprintC` only fires in water:
  `grim:checks/impl/sprint/SprintC.java:19-40`, MC-152728, applicable to <=1.14.1 and exactly 1.21.4). Vanilla <=1.21.1
  loses sprint because the 0.2 factor drops forward impulse under 0.8. The conservative bot rule is to clear sprint
  when an item use starts (harmless on 1.21.4, required before). [INFER for the land case.]
* Related checks that read the same state and matter for a stash bot:
  `MultiActionsA` (attack), `B` (block break), `E` (swing/arm animation) while using; `MultiActionsC/D` flag
  **window click / close while sprinting, or while `player_input` shows forward/back/left/right/jump held**
  (`grim:checks/impl/multiactions/MultiActionsC.java`, `utils/data/KnownInput.java` `moving()` includes jump) and
  cancel the click packet. `SprintA` flags sprinting at food <= 6.

### 2.2 What mineflayer/pp do (all **[READ]**)

* pp never reads any item state (grep: no `using`/`usingHeldItem` in `engine.js`, `mf:physics.js`).
* `mf:inventory.js` has `bot.usingHeldItem` (L52, 78, 93, 101, 123, 160), but it is only a boolean
  and it is wrong in three ways: (1) set by `activateItem()` for **any** non-empty hand even when vanilla would not start
  using (pearl, totem, full-hunger food, item on cooldown); (2) cleared by **any** entity's `entity_status` (L74-79 has no
  `packet.entityId === bot.entity.id` guard) and by any count change of the stack (L82-94); (3) never cleared by the
  server's metadata or by a slot switch to a different slot of the same item.

### 2.3 Proposed design: `bot.itemInUse`

State: `{ hand: 0|1, slot: quickBarSlot (main) or -1 (off), type: itemId }` or `null`.
Where it lives: `mf:inventory.js` (owner of use/release/held slot/cooldown/metadata), read by `mf:physics.js`
`PlayerState` and applied in `pp:743-750`.

Start (client prediction, same tick as the `use_item` write, `activateItem`): only if `canUse(item)`; clear sprint.
Stop on: `deactivateItem()` (`block_dig` status 5); `entity_status` 9 for **self**; `entity_metadata` of self where
`living_entity_flags & 1 == 0` (key index 8 in 1.21.4, `living_entity_flags` in `metadataKeys`); `held_item_slot`
change (client or server) when `hand == 0`; `heldItemChanged` where the type differs from `type` (do **not** react to
count changes); `death`, `respawn`, `end`. Adopt a server-forced use (flag bit set while `itemInUse == null`).

```js
// mf:inventory.js
bot.itemInUse = null
const comp = (item, name) => item?.componentMap?.get(name)?.data          // 1.20.5+ item components
function canUse (item) {                                                  // grim ItemBehaviour/Registry, 1.21.4+
  if (!item || bot.game.gameMode === 'spectator') return false
  if (['shield', 'goat_horn', 'spyglass'].includes(item.name)) return true
  const consumable = comp(item, 'consumable'); const food = comp(item, 'food')
  if (consumable) {
    if (food && !(food.canAlwaysEat || bot.food < 20 || bot.game.gameMode === 'creative')) return false
    return consumable.consume_seconds > 0
  }
  const blocks = comp(item, 'blocks_attacks')                             // 1.21.5+
  if (blocks) return !comp(item, 'equippable')?.swappable
  return false                  // bow/crossbow/trident: Grim does not treat them as slowing either
}
function beginUse (hand) {        // call at the end of activateItem(offHand) after the use_item write
  const item = hand === 1 ? bot.inventory.slots[45] : bot.heldItem
  if (!canUse(item) || isOnCooldown(item)) return
  bot.itemInUse = { hand, slot: hand === 1 ? -1 : bot.quickBarSlot, type: item.type }
  if (bot.getControlState('sprint')) bot.setControlState('sprint', false)  // sends stop_sprinting
}
const endUse = () => { bot.itemInUse = null }                             // call from deactivateItem etc.
bot._client.on('entity_status', (p) => { if (p.entityId === bot.entity?.id && p.entityStatus === 9) endUse() })
bot._client.on('entity_metadata', (p) => {
  if (p.entityId !== bot.entity?.id) return
  const f = p.metadata.find(m => m.key === 8)                             // living_entity_flags (verify key via metadataKeys)
  if (!f) return
  if (!(f.value & 1)) endUse()
  else if (!bot.itemInUse) bot.itemInUse = { hand: (f.value & 2) ? 1 : 0, slot: (f.value & 2) ? -1 : bot.quickBarSlot, type: -1 }
})
// held_item_slot handler (mf:inventory.js ~L744) and 'heldItemChanged': if (bot.itemInUse?.hand === 0 && slotChanged || typeChanged) endUse()
// isOnCooldown: remember set_cooldown packets (itemID until now+ticks) in a Map; the existing handler at L96 only clears the flag.
```

Physics side:

```js
// mf:physics.js PlayerState constructor
this.usingItem = !!bot.itemInUse
this.useSpeedMultiplier = 0.2            // >= 1.21.11 / 26.x: use_effects component .speed_multiplier of the used item
// pp:746-749, after the sneak factor
if (entity.usingItem) { strafe *= entity.useSpeedMultiplier; forward *= entity.useSpeedMultiplier }
```

Other rules the bot/lab should enforce (cheap, remove most flags):

* Do not start `use_item_on`, swing, dig or attack while `bot.itemInUse` (MultiActions A/B/E). Wait for the server's
  flag clear (metadata) after `deactivateItem()`.
* Window clicks/close (chest scan, shift-clicks, totem refill by click) only with all of: `sprint` off, no
  forward/back/left/right/**jump** held, i.e. `player_input` all-false. The anti-AFK jump must not overlap a click.
  `swap_hands` (what `offhandFromHotbar` uses) is not a window click, so MultiActionsC does not apply.
* Never `sprint` at `food <= 6` (SprintA) or while Blindness.
* Eating while moving is fine for Grim *iff* the 0.2 factor is applied (and the tracker agrees with the server flag);
  until U1 exists, eating only while stationary (current auto-eat) stays the safe rule.

Confidence: design [READ]; no live test. Residual risk: when the server's view disagrees (cooldown, creative, full
hunger) the metadata handler resyncs within a tick.

---

## 3. Fluids

All in `pp:466-504` (travel), `pp:635-703` (flow/detection), `pp:705-718` (simulatePlayer) versus
`grim:predictionengine/movementtick/MovementTicker.java:428-536`, `PlayerBaseTick.java:46-76,411-565`,
`grim:utils/nmsutil/FluidTypeFlowing.java:24-77`, `FluidFallingAdjustedMovement.java:17-19`.

### W0. Bot-side rule (cheapest, do first): never sprint with feet in water and head out of it

Vanilla stops sprinting when `isInWater() && !isUnderWater()`. A bot that keeps `control.sprint` while wading is flagged
by `SprintG` ("sprinting in water", `grim:checks/impl/sprint/SprintG.java`; on exactly 1.21.4 it needs no second tick) and
`SprintE` after wall contact. In `tickPhysics` after `simulatePlayer`:
`if (controlState.sprint && st.isInWater && !eyeInWater) bot.setControlState('sprint', false)`
(pathfinder re-sets it each tick: also gate in the movement class, `canSprint = false` while `bot.entity.isInWater`).
Sprint **under** water starts the swimming pose (box 0.6 high, look-dependent vertical motion, Grim
`PlayerBaseTick.java:265-282`, `PredictionEngineWater.java:30-62`): pp has neither, so never sprint submerged either.
Conf. [READ]

### W1. Detection box and push vector (1.13+ algorithm)

| | vanilla 1.13+ (Grim) | pp |
|---|---|---|
| box | player box deflated by 0.001 on all axes (`PlayerBaseTick.java:466`) | `contract(0.001, 0.401, 0.001)` = 1.12-style vertical shrink (`pp:709`) |
| touching | any water cell with `y + height >= box.minY`; height is 1.0 if water above, 8/9 for source/falling, `(8-level)/9` flowing (`CompensatedWorld.getWaterFluidLevelAt`) | `Math.ceil(bb.maxY) >= waterLevel` test (`pp:670-685`), no "water above -> 1.0" |
| current | `sum_i(flow_i * (d2<0.4 ? d2 : 1)) / n`, then `*0.014`, **not normalised** for the player; if both horizontal speeds < 0.003 and push < 0.0045 -> normalise to 0.0045 (`PlayerBaseTick.java:513-535`) | `normalize(sum(flow_i)) * 0.014` always (`pp:687-703`) |
| flow of a falling cell | normalise, add (0,-6,0), `break` after the first solid face (`FluidTypeFlowing.java:67-74`) | the `translate(0,-6,0)` runs once **per solid neighbour** (`pp:660-665`, no `break`) -> slightly different direction |
| d2 | kept for `getFluidHeight(WATER) <= 0.4` swim-hop test | not kept |

Impact: error up to 0.014 b/t in streams that are shallow (< 0.4), at stream edges, or beside non-flowing cells; zero in a
uniform deep stream. Flowing water is not unusual in bases (item streams, water elevators). Confidence [READ].
Port ready to drop into `pp` (run in a fake pool **[RUN]**: still water gives 0 push, a uniform flow gives 0.014):

```js
// replaces isInWaterApplyCurrent(); call from simulatePlayer before the 0.003 reset, as now (pp:709-718)
function waterHeightAt (x, y, z) {                               // == CompensatedWorld.getWaterFluidLevelAt
  const b = world.getBlock(new Vec3(x, y, z)); if (!isWaterCell(b)) return 0
  if (isWaterCell(world.getBlock(new Vec3(x, y + 1, z)))) return 1
  if (waterIds.includes(b.type)) return (b.metadata & 8) ? 8 / 9 : (8 - b.metadata) / 9
  return 8 / 9                                                   // waterlogged, kelp, seagrass, bubble column
}
function updateWaterState (entity) {
  const bb = getPlayerBB(entity.pos).contract(0.001, 0.001, 0.001)
  let d2 = 0; let touched = false; let n = 0; const push = new Vec3(0, 0, 0)
  for (let y = Math.floor(bb.minY); y < Math.ceil(bb.maxY); y++) {
    for (let z = Math.floor(bb.minZ); z < Math.ceil(bb.maxZ); z++) {
      for (let x = Math.floor(bb.minX); x < Math.ceil(bb.maxX); x++) {
        const h = waterHeightAt(x, y, z)
        if (h === 0 || y + h < bb.minY) continue
        touched = true; d2 = Math.max(y + h - bb.minY, d2)
        let flow = getFlow(world, world.getBlock(new Vec3(x, y, z)))   // keep pp getFlow, add the `break`
        if (d2 < 0.4) flow = flow.scaled(d2)
        push.add(flow); n++
      }
    }
  }
  if (push.norm() > 0) {
    push.scale(0.014 / Math.max(n, 1))
    if (Math.abs(entity.vel.x) < 0.003 && Math.abs(entity.vel.z) < 0.003 && push.norm() < 0.0045) push.scale(0.0045 / push.norm())
    entity.vel.add(push)
  }
  entity.waterHeight = d2
  return touched
}
// getFlow: in the `block.metadata >= 8` loop, `break` after the first solid face (vanilla does)
```

(`isWaterCell(b)` = `b && (waterIds.includes(b.type) || waterLike.has(b.type) || b.isWaterlogged)`.)

### W2. Travel in water

Vanilla 1.21.4 `LivingEntity.travelInWater` (mirrored by `MovementTicker.java:448-485`):

```
f  = sprinting ? 0.9 : 0.8          (pp: always 0.8)
f1 = 0.02;  eff = water_movement_efficiency attribute; if (!onGround) eff *= 0.5
if (eff > 0) { f += (0.54600006 - f) * eff;  f1 += (getSpeed() - f1) * eff }     (<=1.20: eff = min(DS level,3)/3)
if dolphinsGrace: f = 0.96
moveRelative(f1); move()
if (horizontalCollision && onClimbable) vy = 0.2
v *= (f, 0.8, f); then fluidFallingAdjusted: if (!sprinting) vy -= g/16  (see below)
jumpOutOfFluid (0.3 if horizontal collision and box shifted up by 0.6 is free)
```

Differences in pp (`pp:472-503`): sprint ignored (friction 0.8; and vanilla *skips gravity* while sprinting:
`FluidFallingAdjustedMovement.java:17`); depth strider uses a bogus constant `acceleration += (0.7 - acceleration) * strider/3`
(`pp:485-487`; vanilla uses the movement speed 0.1 / 0.13, not 0.7) and reads the enchant from boots NBT, which is null on
1.20.5+ (so always 0 there); no ladder/vine case in water; the g/16 snap to -0.003
(`FluidFallingAdjustedMovement.java:19`) only triggers with slow falling (with g=0.08 its two conditions contradict), skip.
Patch:

```js
// pp:472-499
let inertia = entity.isInWater ? (entity.control.sprint ? 0.9 : 0.8) : physics.lavaInertia   // lava: see W5
let horizontalInertia = inertia
let acceleration = physics.liquidAcceleration
if (entity.isInWater) {
  let eff = entity.waterMovementEfficiency                 // attr(R('waterMovementEfficiency'), 0, 0, 1); pre-1.21: min(DS,3)/3
  if (!entity.onGround) eff *= 0.5
  if (eff > 0) { horizontalInertia += (0.54600006 - horizontalInertia) * eff; acceleration += (entity.speedAttr - acceleration) * eff }
  if (entity.dolphinsGrace > 0) horizontalInertia = 0.96
}
applyHeading(entity, strafe, forward, acceleration)
moveEntity(entity, world, vel.x, vel.y, vel.z)
if (isOnLadder(world, pos) && entity.isCollidedHorizontally) vel.y = 0.2
vel.y *= 0.8; vel.x *= horizontalInertia; vel.z *= horizontalInertia
if (!entity.control.sprint) vel.y -= (entity.isInWater ? physics.waterGravity : physics.lavaGravity) * gravityMultiplier
// ... existing jump-out-of-liquid block unchanged
```

(`entity.speedAttr` = the sprint-inclusive speed from 1.4; `waterMovementEfficiency` added to `PlayerState`.)
Note on lava: vanilla lava has its own branch (`MovementTicker.java:487-505`: 0.5 horizontal; `vy*0.8` and g/16 when lava
depth <= 0.4, else 0.5; then `-g/4`); keep pp's as is, a bot must never be in lava.
Confidence [READ]; depth-strider/attribute part depends on Fix A.

### W3. Other water details

* Sneaking in water sinks: `baseTickAddVector(0, -0.04, 0)` when `wasTouchingWater && sneaking && !flying`
  (`PlayerBaseTick.java:72-76`). pp has none. Rule: do not sneak in water (pathfinder: `sneak=false`).
* Fall distance reset, `wasEyeInWater`: no movement effect.
* Bubble columns (also see C6): applies **after** friction on 1.21.2+.
* Waterlogged blocks: pp handles via `block.isWaterlogged` (`prismarine-block:197`), source-like blocks via `waterLike`. ok.

### W4. Priority within fluids

W0 (bot rule) -> W2 sprint term + Fix A -> W1. If the bot never enters water at the base, W1/W2 are dormant; W0 costs
nothing.

---

## 4. Climbing, stuck multipliers, block factors, bounce

### B1. Soul sand / honey (speed factor, jump factor) **[RUN]**

* `pp-features:12-21`: `velocityBlocksOnCollision` = 1.8-1.14, `velocityBlocksOnTop` = 1.15-1.20. `majorVersion` of 1.21.x is
  `"1.21"` -> **neither is active on 1.21.4**, and `"26.x"` is in neither list. Soul sand/honey slowdown (`pp:323-330`,
  `pp:348-360`) never runs.
* Even where it is active it looks up the wrong block: `entity.pos.floored().offset(0, -0.5, 0)` (`pp:349`) is the cell
  *below* soul sand (top at 0.875, standing y = 63.875 -> cell 62). **[RUN]** (`soultest.js`): soul sand floor, 30 ticks
  forward: identical to stone on both `1.20.4` and `1.21.4` (6.10 blocks).
* Honey jump factor: pp uses 0.4 (`pp:73`, `pp:727`); vanilla/Grim 0.5 (`grim:utils/nmsutil/JumpPower.java:55-57`).
  Lookup also wrong block (`pp:726`).
* Vanilla (1.21.4): `getBlockSpeedFactor()` looks at the block **containing the position** first (`floor(pos)`), and only if
  that is 1.0 and not water/bubble column at the block affecting movement (`getOnPos(0.500001)` using the main supporting
  block): `grim:utils/nmsutil/BlockProperties.java:108-125,141-162,216-229,231-234`. Result is applied at the end of
  `move()` (`grim:MovementTicker.java:252-253`) as `vx*=f, vz*=f`, with `f = lerp(movement_efficiency, f, 1)` on 1.21+.

```js
// pp: add near moveEntity's tail (replace pp:348-360), enable for every version (drop the two features)
function speedFactorOf (b) { return !b ? 1 : b.type === honeyblockId ? 0.4 : b.type === soulsandId ? 0.4 : 1 }
function blockFactor (entity, world, factorOf) {               // used for speed (0.4) and, with honey only, jump (0.5)
  const inBlock = world.getBlock(entity.pos)                   // Vec3 floors
  const f = factorOf(inBlock)
  if (f !== 1 || (inBlock && (waterIds.includes(inBlock.type) || inBlock.type === bubblecolumnId))) return f
  const below = world.getBlock(new Vec3(entity.pos.x, Math.floor(entity.pos.y - 0.500001), entity.pos.z)) // + supporting-block x/z, see C5
  return factorOf(below)
}
const eff = entity.movementEfficiency                          // attr(R('movementEfficiency'), 0, 0, 1)
const f = blockFactor(entity, world, speedFactorOf); const fl = f + (1 - f) * eff   // Mth.lerp(eff, f, 1)
vel.x *= fl; vel.z *= fl                                       // after collisions/flags, before friction
// jump (pp:726-727): const jf = blockFactor(entity, world, b => b?.type === honeyblockId ? 0.5 : 1);  vel.y = jumpPower * jf (+ jump boost)
```

Soul speed (boots) arrives as `movement_efficiency`/speed modifiers via Fix A; no extra code. Conf. high [READ+RUN].

### C1. Climbable set

Vanilla `#minecraft:climbable` (1.21.4): ladder, vine, scaffolding, weeping_vines(_plant), twisting_vines(_plant),
cave_vines(_plant) (`grim:utils/nmsutil/Collisions.java:862-886` via the synced tag). pp: ladder, vine, scaffolding only
(`pp:35-37,439-460`). Use the block tag if available (`bot.registry.blocksByName[...]` list):

```js
const climbable = new Set(['ladder','vine','scaffolding','weeping_vines','weeping_vines_plant','twisting_vines',
  'twisting_vines_plant','cave_vines','cave_vines_plant'].map(n => blocksByName[n]?.id).filter(x => x !== undefined))
```

### C2. Trapdoor above a ladder

`climbableTrapdoor` lists only 1.9-1.20 (`pp-features:27-31`). Grim keeps the rule for every client >= 1.9
(`Collisions.java:888-902` `trapdoorUsableAsLadder`: open trapdoor, ladder directly below, same facing), so on 1.21+/26.x
pp refuses to climb. Fix: add `"1.21","26.1","26.2"` to the feature, build `trapdoorIds` from `blocksByName` names ending in
`_trapdoor` (pp lists only 12 old woods; bamboo, pale_oak and the copper trapdoors are missing), and guard
`blockBelow` against `null` (`pp:449-453` dereferences it).

### C3. Ladder specifics

* Sneaking on a ladder/vine holds position (`vy = max(vy, 0)`); vanilla excludes **scaffolding** (sneak descends on scaffolding):
  `PredictionEngineNormal.java:107-120`. pp (`pp:587`) holds on scaffolding too. Change:
  `entity.control.sneak && !isScaffoldingAtFeet ? 0 : -0.15`.
* Powder snow with leather boots climbs like a ladder (vanilla `vy = 0.2` on horizontal collision/jump,
  `PredictionEngineNormal.java:82-98`). Not modelled; keep the bot off powder snow.

### C4. Stuck multipliers

Grim table (`grim:utils/nmsutil/StuckSpeed.java:16-21`): cobweb (0.25, 0.05, 0.25), cobweb+Weaving (0.5, 0.25, 0.5), sweet
berry bush (0.8, 0.75, 0.8), powder snow (0.9, 1.5, 0.9, only when the block is the feet cell). pp has cobweb only
(`pp:161-168,333`). Contact test box in 1.21.2+ is the final box deflated 1e-5 over the swept path
(`BlockEffectsResolverV1_21_4.java:33-34`), pp uses a 0.001 contraction. Cheap addition (berries/powder snow/Weaving)
via a `stuck = {x,y,z}` field: set when a berry/powder-snow cell intersects the box, applied at the start of the next
`moveEntity` exactly like `isInWeb` (`pp:161-168`). Rare at a base; skip unless pathing through farms.

### C5. Friction / speed block lookup at edges

1.19.4+: block under = `getOnPos(0.500001)` using the **main supporting block** (the block that actually supports the
box, `grim:utils/nmsutil/MainSupportingBlockPosFinder.java`), x/z of that block, y = `floor(y - 0.500001)`;
pp uses the block under the feet **centre** (`pp:545`). Differs only when the centre is over air/other block while the box
overlaps ice/slime/soul sand/honey edge. Skip unless the base has ice/slime floors.

### C6. Bubble columns

pp applies the drag inside `moveEntity` (`pp:333-345`) i.e. before inertia+gravity. On 1.21.2+ block effects are resolved
at the end of the travel (`grim:MovementTicker.java:534`, `Collisions.applyEffectsFromBlocks`), i.e. **after** friction
and gravity (`velY = (0.8*v - 0.005) + 0.06`, steady state 0.275, vs pp 0.215). Also vanilla's "surface" case is
`collision shape empty && no fluid above` (`Collisions.java:509-533` uses air), pp checks block id 0 only (not
`cave_air`). Fix: record `entity.bubble = {down, surface}` in `moveEntity`, apply at the end of
`moveEntityWithHeading` for `supportFeature('insideBlocksAfterTravel')` (add 1.21.2+ to features.json).
Constants are right (0.7/-0.3, 1.8/-0.9, +0.06/+0.1, -0.03). Rare; only for water elevators.

### C7. Bounce

* Slime: pp bounces `-vy` when the block at feet-0.2 is slime and not sneaking (`pp:312-316`). ok.
* Beds: vanilla/Grim bounce `-vy * 0.66` (26.2: `0.75`, with the new `restitution`/gravity compensation formula,
  `BlockProperties.java:311-335`, `MovementTicker.java:224-233,402-426`). pp has none. Standing/walking on a bed shows no
  position difference (the hook only reshapes `vy`, the box never leaves the floor); landing from a jump/fall does. Rare.
* 26.2 `bounciness` attribute and `SUPPRESSES_BOUNCE` tag: N1.

---

## 5. Elytra, firework, riptide, flight (brief)

* Elytra core matches vanilla (`pp:505-541` vs `grim:predictionengine/predictions/PredictionEngineElytra.java:20-116`):
  same gravity term, descent conversion, look-down/look-up terms, 0.99/0.98/0.99 friction. Differences: pp uses exact
  `Math.sin/cos` for the look vector, vanilla uses its table (error ~1e-4 x speed; Grim also brute-forces OptiFine maths,
  tolerance covers it); firework duration is *guessed* (`mf:entities.js` `handleBotUsedFireworkRocket`,
  `10*(flight+1)+rand`) while vanilla is bound to the rocket entity's life: end the boost on that rocket's `entity_destroy`
  (`bot.on('entityGone', e => e.id === rocketId && (bot.fireworkRocketDuration = 0))`). Start rule: server decides; Grim
  resyncs `start_elytra_flying` from the ground (`PacketEntityAction.java:49-70`).
* Riptide: not modelled in pp. Grim adds `look * 3*(1+lvl)/4` at release and a 1.2 push (`utils/nmsutil/Riptide.java`).
  Irrelevant to a stash bot.
* Creative/spectator flight: `mf:abilities.js` stores `bot.entity.flying/flyingSpeed` with a comment that
  "prismarine-physics reads the flight state off the entity", but prismarine-physics 1.11.1 / `engine.js` does **not**.
  Grim: accel `flySpeed*20*(sprint ? 0.1 : 0.05)`, vertical `+/- flySpeed*3` on jump/sneak
  (`BlockProperties.java:65-67`, `PredictionEngineNormal.java:54-70`, `PlayerBaseTick.java:51-55`, vy x 0.6). 9b9t is survival; skip.

---

## 6. Knockback, explosions, teleport velocity (K1)

### 6.1 Timing: correct

* Vanilla processes packets on the client thread at the start of a frame, before the tick, so `entity_velocity`
  (`lerpMotion` = replace `deltaMovement`) and `explosion` (`playerKnockback` = **add**, 1.21.2+; `playerMotionX..` before) take effect for the
  next tick's `travel`; the client answers pings in the same pass, in arrival order.
* Grim's model (a "velocity sandwich"): ping, velocity, ping around each `entity_velocity` for the player
  (`grim:checks/impl/velocity/KnockbackHandler.java:42-70,92-150`). Pong 1 seen -> "first bread" (kb possible, not
  required); pong 2 seen -> required in the next movement; offset threshold 0.001 (`:253`), VL decays; setback after 10.
  `ExplosionHandler.java` is the same for explosions. Teleports override both (`MovementCheckRunner.java:130-133`).
* mineflayer: `mf:entities.js:285-290` applies `entity.velocity.update(...)` on receipt; `mf:physics.js:329-345` adds explosion
  knockback on receipt; pongs/teleport replies are queued and flushed at the start of the next physics tick
  (`flushReplies`, `physics.js:85-87`), then the tick simulates with the updated velocity. Observable order to the server:
  pong1, pong2, movement(with velocity). Identical to vanilla. `PlayerState` copies `bot.entity.velocity` at tick start
  and `apply()` replaces the object, so the handler's `fetchEntity(...).velocity` is always the live one. **No change needed.**
  The only pitfall is `physicsEnabled=false`/`shouldUsePhysics=false` (velocity is stored but never consumed).
* Precision 1.21.4: `short / 8000` (`conv.fromNotchVelocity`, multiply by 1/8000 vs divide: 1-ulp difference, irrelevant).
  Grim sees the same quantised value (and nudges `vy == -0.04`, client bug, `KnockbackHandler.java:60-64`).
  ViaBackwards in front of a newer server: Grim converts the server's lp-vec3 to short/8000 for <=1.21.7 clients
  (`VectorPrecisionConverter.java`), so the 1.21.4 bot receives exactly what the vanilla 1.21.4 client does.

### 6.2 Bug: lpVec3 on 1.21.9+ / 26.x

Protocol: `entity_velocity.velocity` and `spawn_entity.velocity` are `lpVec3` from 1.21.9 (decoded by
`nmp/src/datatypes/lpVec3.js` straight to blocks/tick doubles), `vec3i16` before. `mf:entities.js` (~L233-235, 278-279, 285-290;
identical in mf-262) still runs `conv.fromNotchVelocity` (x 1/8000): knockback becomes ~0 on 26.x -> AntiKB. Fix:

```js
const velUnit = bot.registry.isNewerOrEqualTo('1.21.9') ? 1 : 1 / 8000     // lpVec3 is already blocks/tick
const toVel = (v) => new Vec3(v.x * velUnit, v.y * velUnit, v.z * velUnit)
// spawn_entity (x2) and entity_velocity: entity.velocity.update(toVel(packet.velocity))
```

### 6.3 Bug: `position` handler uses pre-1.21.2 semantics

`mf:physics.js:411-446` zeroes velocity unless the *position* relative flag is set (`packet.flags.x ? vel.x : 0`). Since 1.21.2 the
packet carries `dx,dy,dz` and flags `dx,dy,dz,yawDelta`: new velocity = `flags.dx ? vel.x + packet.dx : packet.dx` per axis
(Grim: `grim:utils/data/TeleportData.java:27-57`; Grim's own setbacks send absolute position, delta 0, then a separate
`entity_velocity`, `SetbackTeleportUtil.java:286-296`, so the current code is right for setbacks). Wrong only for plugin
teleports with a non-zero delta or relative-position flags. Fix for `supportFeature('sendsClientTickEndPacket')` (1.21.2+):

```js
const f = packet.flags
vel.set(f.dx ? vel.x + packet.dx : packet.dx, f.dy ? vel.y + packet.dy : packet.dy, f.dz ? vel.z + packet.dz : packet.dz)
// (yawDelta: rotate vel by the yaw change when set; rare)
```

### 6.4 Smaller

* `mf:inventory.js:74-79` clears `usingHeldItem` for any entity (see U1).
* `mf:physics.js:329` `explosion`: `bot.game.gameMode !== 'creative'` is a server-side rule in vanilla (client always adds);
  harmless.
* Teleports reset `bot.entity.onGround = false` (`physics.js:~448`); the lab's `keepGround` patch handles that.

---

## 7. 26.x specifics (26.1 / 26.2)

Target is mineflayer on 26.2; Grim also references 26.3 (shelf mushrooms, straw bed, fluid tags). Only 26.1/26.2 below.

1. **Crash**: `pp-features` has `"26.1"` but not `"26.2"` (`majorVersion` of 26.2 is `"26.2"`, `mcdata-262/.../version.json`).
   `Physics()` then throws `No liquid gravity settings` (`pp:102-110`). Add `"26.2"` to `proportionalLiquidGravity`,
   `climbUsingJump`, and the new `climbableTrapdoor`/insideBlocks lists. Better: derive features from
   `mcData.isNewerOrEqualTo(...)` instead of the list. [READ]
2. Attribute mapper stale for 26.x as well (`protocol.json` 31 names, movement_speed id 20 vs real registry): Fix A applies
   (the 26.2 `attributes.json` has 41 entries including `air_drag_modifier`, `bounciness`, `friction_modifier`).
3. New attributes (26.2): `grim:utils/nmsutil/BlockProperties.java:236-298`:
   `friction' = clamp(1 - (1 - f) * friction_modifier, 0, 1)` (block friction), `airDrag' = clamp(1 - (1 - 0.91) * air_drag_modifier, 0, 1)`
   and the 0.98 vertical drag likewise; vertical/horizontal bounce `-v * bounciness` (not when sneaking). Defaults 1/1/0
   give today's behaviour, so only matters if a server sets them. Needed read hooks: `inertia`, `airdrag` in `pp:569,603`.
4. 26.2 ground acceleration: `getFrictionInfluencedSpeed` returns `speed` **unscaled** when the (modified) block friction
   is <= 0.6 (`BlockProperties.java:40-42`) instead of `speed * 0.21600002/f^3`. For f = 0.6 the old factor is
   1.0000001, i.e. a float-rounding difference only; for ice (0.98) unchanged. Port:
   `acceleration = f <= 0.6 ? speed : speed * (0.21600002 / (f*f*f))` (pp today multiplies via 0.1627714/inertia^3, equal to 1e-7).
5. Input: 1.21.5+ clients normalise the raw key vector first and then apply 0.98 / sneak / use-item with a "square movement"
   re-projection (`ModernInputTransformer.java:16-56`); pp's `*0.98` then `applyHeading` normalisation differs for
   diagonals. Belongs to the walking agent, listed here because it changes the use-item multiplier site.
6. Block effects: per-version resolver (1.21.4 / 1.21.5 sub-movement splitting `movementThisTick` / 1.21.6-8 / 1.21.10+,
   `Collisions.java:557-640`). Affects only cobweb/berry/bubble/honey contact timing; ignore.
7. Potent sulfur geysers (26.2, `grim:predictionengine/blockeffects/PotentSulfurGeyser.java`): block `potent_sulfur`
   (state `erupting`/`continuous`) with a water source within 5 blocks above creates a column of height `6*waterBlocks`;
   inside it `vy += 0.2` when `vy < 0.3 + 0.1*waterBlocks` (applied every tick after travel, `MovementTicker.java:535`). Needs
   block-entity ticker data (`CompensatedGeysers`). Only in sulfur caves: do not implement, make the pathfinder treat a
   `potent_sulfur` column as no-go. `sulfur_spike` etc. have no movement effect in data.
8. Happy ghast: rideable vehicle (`MovementTickerHappyGhast`). `mf:physics.js:529` `bot.on('mount') -> shouldUsePhysics=false`
   stops movement packets while riding; fine unless the bot rides.
9. Block names changed: `chain` -> `iron_chain` (+ copper chains/bars/lanterns, shelves, copper chests, golem statues): no
   movement effect; collision shapes come from the data file.
10. Item use: `use_effects {can_sprint, speed_multiplier}` component (see U1); respect `can_sprint` for the "clear sprint on use" rule.
11. lpVec3 velocities (6.2).

---

## 8. Verification recipes

1. **Attributes** (lab console, after login, before/after Fix A):
   `Object.entries(bot.entity.attributes).map(([k,v]) => k+'='+v.value+' ['+v.modifiers.map(m=>m.uuid+':'+m.amount).join(',')+']')`
   Expect `minecraft:movement_speed=0.1`, `minecraft:jump_strength=0.42`, `minecraft:gravity=0.08`, `minecraft:step_height=0.6`.
   Stand in a beacon/give Speed II: modifier `minecraft:effect.speed:0.4` (op 2) must appear on movement_speed.
2. **Sprint double count** after Fix A: the sprint modifier id on the list is `minecraft:sprinting`; `attr()` must drop it.
3. **Soul sand / honey**: walk 20 ticks on soul sand and on stone with a Grim-style A/B: speed ratio must be 0.4.
4. **Item use**: `console` -> `bot.itemInUse` must be non-null from the `use_item` write until the server's metadata clears
   bit 1 (1.6 s for food); while set, `forward` for 10 ticks should move ~0.2 x the normal distance.
5. **Teleport/knockback on 26.x**: after a hit, `bot.entity.velocity` must be ~0.3-0.5 (not ~1e-5).

## 9. Suggested order of work

1. Fix A (+ B for speed/sprint ids) and the 26.2 feature list: pure data, high value, quick to verify.
2. U1 tracker + 0.2 factor + MultiActions rules (sprint off and no input while clicking windows; no swing/interact while using).
3. W0 sprint-in-water rule; W2 sprint/efficiency; W1 port.
4. B1 (soul sand/honey) + jump factor; C1/C2 tables.
5. K1 lpVec3 + teleport delta (needed for 26.x).
6. The rest only if the base has the blocks.
