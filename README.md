# 9bFlayer

A fork of [mineflayer](https://github.com/PrismarineJS/mineflayer) 4.39 whose bots play like the vanilla client, so
the [Grim](https://github.com/GrimAnticheat/Grim) anticheat has nothing to flag. Built for 9b9t (1.21.4 behind
ViaBackwards), and it speaks Minecraft 1.8 to **26.3**.

It is a drop-in replacement: same API, same events, same plugins (mineflayer-pathfinder and friends work).
The upstream docs in [docs/](docs/README.md) still apply. This file lists what is different.

```js
const mineflayer = require('9bflayer')
const bot = mineflayer.createBot({ host: '9b9t.org', username: 'Bot', auth: 'microsoft', version: '1.21.4' })
```

Install from git until it is published: `npm install github:Br0xx/EldiaMineflayer#9bflayer`. Needs Node 22.

## Why

Grim re-simulates every movement a client reports with vanilla's own physics and checks the order of the packets
inside each tick. Stock mineflayer differs from the vanilla client in dozens of small ways. Each one is harmless alone,
but Grim answers a mismatch with a setback, and on 9b9t that meant a bot that could not walk up a staircase or open a
row of chests. The fixes started as switchable patches in EBS Lab, where each was proven live on 9b9t
([GRIM.md](https://github.com/Br0xx/EBSlab/blob/main/engine/patches/GRIM.md)). Here they are native, and the rest of
the client was audited against Grim's source.

## What is different from mineflayer

**Movement (1.21+, `lib/physics/`).** The physics engine is vendored and does what the 1.21.x client does, line by
line:

- float arithmetic where vanilla uses floats;
- the `Mth` sin/cos lookup table (the new table from 1.21.11);
- the float hitbox (half-width 0.30000001192…);
- 1.21's collision and step-up;
- the tiny-move and velocity-zeroing rules of 1.21.2 and 1.21.5;
- soul sand and honey;
- item-use slowdown;
- fluid current averaging;
- sprint-swimming;
- the full climbable set;
- server attributes (speed, slowness, jump strength, gravity…).

Walking from rest gives 0.098, 0.1515, 0.1807 blocks per tick and a jump 0.42, 0.7532, 1.0013, 1.1661, 1.2492, the
values recorded on 9b9t. Versions before 1.21 keep prismarine-physics' behaviour.

**One tick, in vanilla order (`lib/plugins/input_queue.js`, `physics.js`).** API calls no longer write packets the
moment they run. Every action is queued and goes out inside the next tick, in the order the vanilla client writes
them:

1. pongs and teleport/rotation replies;
2. held slot;
3. swap/drop;
4. one primary action (use, attack, dig, place) with its swing;
5. `player_input` (whenever the held keys change), then sneak, then sprint;
6. the movement packet;
7. `tick_end`.

The promises of these APIs settle after that tick, so a call now takes up to 50 ms longer.

**Movement packets.**

- **Rotation:** each movement packet carries exactly the rotation its tick was simulated with. The yaw is unwrapped,
  pitch is clamped to ±90 after the sensitivity rounding, and there is no easing by default.
- **When a packet is sent:** a position goes out when the bot moved more than 2e-4 blocks, or on the 20th tick. A
  status-only packet goes out when the ground or the wall-collision flag changes, and the collision flag is the real
  one.
- **Teleports:** the bot stays on the ground after a setback, and `player_rotation` is answered like vanilla.
- **After a stall:** a catch-up burst is capped at 2 ticks, for Grim's Timer check.

**Sprint and sneak are state.**

- Sprint starts and stops by vanilla's rules: forward input, food > 6, a wall in the way, item use, water. The sprint
  key only asks for it.
- Sneak goes out as `entity_action` below 1.21.6, which is where a 1.21.4 server reads it.
- `entity_action` ids are looked up by meaning for each version (`lib/entity_action.js`). On stock mineflayer, sprint
  on 1.21.6+ is sent as "start riding jump".

**Clicks like a player (`bot.vanilla`).**

- **Clicking a block:** `bot.activateBlock` and `bot.openContainer` without an explicit face stand still, look at a
  visible point and wait for the rotation to reach the server. They then ray-cast from the eyes and click the face and
  point the crosshair hits, from within 3 blocks.
- **Containers:** opens are spaced 1.5 s apart, because 9b9t silently ignores faster ones. A window that arrives too
  late is closed.
- **Offhand:** `bot.vanilla.swapHands()`, `offhandFromHotbar()` and `toHotbar()` move items the way a player does.
  `bot.vanilla.ensureOffhandTotem()` puts a totem there (from the hotbar, else from the inventory) and
  `bot.on('totemUsed')` tells when one popped.
- **Reading containers:** `bot.containerItems(item)` lists what a shulker box item holds (slot, name, count), from its
  `container` component on 1.20.5+ and its NBT before. `bot.vanilla.scanContainers(radius, options)` opens every chest,
  barrel, shulker box, hopper, dispenser, dropper, crafter and ender chest around the bot (a double chest once), one at a
  time through `openContainer`, and returns what each holds, shulker contents included.
- **Digging, attacking and placing aim first.**
  - `bot.dig` looks at the block and lets the rotation settle, then digs the face the crosshair hits. It swings every
    tick, sends FINISH on the tick the block breaks, and waits vanilla's 5 ticks before the next block.
  - `attack`, `useOn` and `activateEntity` aim at the hitbox and check the reach (3.0) and the ray when they write.
  - Placing re-checks the ray at write time. They reject with `err.code` set to `too-far`, `no-sight`, `gone` or
    `moved` rather than send a click no player could make.
- **Window clicks and closes** wait until no movement key is held (Grim flags inventory clicks while moving). They
  reject after 40 ticks if a key stays held, so release the keys first (`bot.clearControlStates()`), as
  mineflayer-pathfinder does when it stops.

**Connection defaults for 9b9t.**

- Packets protodef can't decode (ViaBackwards) are skipped instead of dropping the bot.
- The keep-alive check is 60 s, and there is no socket idle timeout after login.
- A login that completes after `bot.end()` is killed before it reaches the server.

**Staying connected (`mineflayer.createPersistentBot`, `lib/connection.js`).** A bot that has to live on a server for days
and come back when it drops, without getting its IP throttled. 9b9t sits behind TCPShield, which after ~20 logins an hour
starts dropping connections with `read ETIMEDOUT` and lets new logins hang, and Xbox answers 429 to Microsoft logins
closer than ~15 s. So:

- reconnects back off from 10 s to 5 min, with jitter, and the kick decides: a ban, an invalid session or a `bot.end()` of
  yours stops it, "already connected" and server restarts wait 5 min, a full server or a queue retries;
- every login goes through a budget of 6 an hour per bot and 20 an hour per host for the whole process (kept in a file
  store, so a crash loop that restarts the process cannot spend them again) and, for Microsoft accounts, a single scheduler for the whole process that keeps logins 15 s apart;
- a login that never spawns within 3 min is dropped, and three such hangs in a row stop it (the IP is probably
  throttled) for an hour, then it tries once;
- the watchdog (`watchdog` option, on in `createBot` too) ends a connection that went silent for 90 s, which a dead TCP
  connection never reports by itself;
- a `transfer` packet is followed without spending a login;
- `pb.on('bot')` gives every new bot to your plugins before it connects, `pb.run(async bot => …)` rejects with
  `'disconnected'` if the bot ends mid-task, and `stop()` cancels a pending retry or a sign-in still in progress.

See [examples/persistent.js](examples/persistent.js) and `createPersistentBot` in [docs/api.md](docs/api.md).

**mineflayer-pathfinder without the snap.** `require('9bflayer/pathfinder').loadPathfinder()` loads your installed
mineflayer-pathfinder with a `fullStop()` that releases the keys instead of teleporting the bot onto the block centre.

**Minecraft 26.2 and 26.3.** Data from minecraft-data's unmerged 26.2 and 26.3 work, registered at load time
(`lib/mcdata/`); a version is skipped as soon as minecraft-data ships it. 26.3 changed more than the data: byte-array
light masks, a stepped entity-move encoding, `teleport_confirm` carrying the position, and one more block-dig status
(see [the 26.3 notes](docs/9bflayer/research/v26_3.md)). Nothing of 26.3 has run against a real server yet.

**Fixed along the way:**

- server attributes never reached the physics on 1.21+, because minecraft-data's key table is stale;
- 1.21.9+ knockback was divided by 8000 twice;
- soul sand never slowed on 1.15–1.21;
- `bed.wake()` sent stop-sprinting on 1.21.6+.

## Options

| `createBot` option | Default | |
|---|---|---|
| `skipUndecodablePackets` | `true` | skip packets protodef can't decode instead of disconnecting |
| `checkTimeoutInterval` | `60000` | keep-alive timeout (mineflayer: 30 s) |
| `watchdog` | `{ enabled: true, silenceMs: 90000 }` | end a connection that receives nothing for `silenceMs` after login |
| `socketTimeoutAfterLogin` | `true` | turn off the socket idle timeout once logged in |
| `hideErrors` | `true` | don't dump undecodable packets to the console |
| `maxCatchupTicks` | `2` | ticks replayed after an event-loop stall |
| `vanilla.interact` | `{ reach: 3, settleTicks: 2, containerSpacingMs: 1500, openTimeoutMs: 8000, clickGapMs: 150 }` | `bot.vanilla` click settings |

`bot.physics.yawSpeed` / `pitchSpeed` (rad/s) bring back eased turning when given a finite value.

## Live test bench

`bench/` runs scenarios (login, idle, look, walk, sprint, jump, sneak, stairs, water, containers, inventory, dig,
place, pathfinder, reconnect, soak) against a real server and reports what worked and what Grim refused: setbacks with
the bot's last ticks before each, kicks, grimLint violations on the outgoing stream, and a packet trace of every
failing window. It is how the three targets are tested: a vanilla server, Paper with Grim, and 9b9t.

```bash
node bench/run.js --host localhost --port 25565 --version 1.21.4 --auth offline --username BenchBot
node bench/report.js run-a.json run-b.json   # diff two runs
```

The bench reads the library's own hooks where they exist (`"teleport"`, `"tick"`, `"playerLoaded"`, `"actionRejected"`,
`bot.kickReason`, `bot._input.stats`) and falls back to raw packets for an older build.

The bot never chats unless `--commands` is given. See [docs/9bflayer/bench.md](docs/9bflayer/bench.md).

## Development

```bash
npm install
npx standard                                   # lint
npx mocha --exit test/physicsVanillaTest.js test/internalTest.js test/vanillaUnitTest.js -g "9bflayer|1.21.4v|26.1v|26.2v|26.3v"
```

The tests run offline against minecraft-protocol's server. `lib/tools/grimLint.js` replays Grim's packet-order rules over
everything a test bot sends, and `test/physicsVanillaTest.js` checks the engine against vanilla numbers.

Nothing here has a local Grim to run against. Live testing happens on 9b9t through EBS Lab, and every finding goes
into [docs/9bflayer/](docs/9bflayer/), together with the Grim audits the changes came from.

MIT, like mineflayer.
