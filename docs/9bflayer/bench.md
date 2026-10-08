# The live test bench

`bench/` runs a fixed set of scenarios with a 9bFlayer bot against a real server and says what worked and what the
server (or Grim) refused, with evidence for every failure. It is for the three places 9bFlayer has to work:

- a vanilla server (1.21.4, 26.2, 26.3), where nothing should be refused;
- a Paper server with Grim, where Grim answers a mismatch with a setback;
- 9b9t, through a real account.

Nothing in the bench is specific to one of them, so a failing scenario on one and a passing one on another is the
finding.

## Run it

```bash
node bench/run.js --host localhost --port 25565 --version 1.21.4 --auth offline --username BenchBot
node bench/run.js --host minecraft.9b9t.org --version 1.21.4 --auth microsoft --username you@example.com \
  --scenarios login,idle,look,walk --json 9b9t-walk.json
```

`npm run bench -- <options>` is the same. The exit code is 0 when no scenario failed, 1 when one did, and 2 when the
command line was wrong. Without `--scenarios` it runs every scenario but `soak`; `--list` shows them with what each
needs from the world.

| Option | Default | |
|---|---|---|
| `--host`, `--port`, `--version` | `localhost`, 25565, detected | the server; set `--version` for ViaBackwards servers like 9b9t |
| `--auth`, `--username` | `offline`, `BenchBot` | `microsoft` prints a device code and caches the tokens in `bench/.auth` (`--profiles DIR`) |
| `--scenarios a,b,c` | all but `soak` | `all` adds `soak` |
| `--modify` | off | lets `dig` and `place` change the world |
| `--commands` | off | lets the bench send chat commands (only `inventory` can: `/give`) |
| `--radius N` | 16 | how far from the bot the scenarios look for stairs, water, containers... |
| `--duration T` | 60s | the soak length: `90`, `90s`, `5m`, `1h`. A bare number is seconds |
| `--idle T` | 10s | how long `idle` stands still |
| `--timeout T`, `--login-timeout T` | 120s, 120s | per scenario, and for a login (raise it for the 9b9t queue) |
| `--spacing T` | 15s microsoft, 2s offline | minimum time between two logins |
| `--max-containers N` | 6 | how many containers `container` opens |
| `--max-logins N` | 6 | logins per hour (all scenarios) before the soak stops with "stopped: login budget" instead of reviving after another kick; 0 = no limit |
| `--json FILE` | | also write the report there (it is always in the output folder) |
| `--out DIR` | `bench/out/<timestamp>` | traces and `report.json` |
| `--pathfinder-from DIR` | the working directory | where `pathfinder` finds mineflayer-pathfinder |
| `--absolute` | off | real coordinates in reports; otherwise positions are relative to where the bot first stood |
| `--mock` | off | run against the in-process mock server, as a check of the bench itself |
| `--verbose` | off | print every step |

**The bot never talks.** Chat, whispers and commands are blocked in the packet write path unless `--commands` is
given, and a blocked attempt fails the scenario. Do not give `--commands` on 9b9t. The bench also reads chat and
reports lines that look like anticheat alerts (`Grim`, `VL`, `failed ... (x2)`); only a line naming the bot fails a
scenario.

**Positions are relative.** A bug report should not carry the coordinates of anybody's base, so every position in the
report and the traces is relative to the block the bot first stood in. `--absolute` turns that off.

**Logins.** Every `reconnect` and every reconnect after a kick is a login. 9b9t sits behind TCPShield and starts to
refuse logins after a few dozen in an hour, so keep 9b9t runs short and leave `reconnect` out of them.

## Scenarios

Each is self-contained and adapts to the world the bot spawns in. A scenario that cannot find what it needs is
`skipped` with the reason; one that finds it and is refused fails. Every scenario fails on any setback, kick, error
or grimLint violation seen while it ran.

| Scenario | Needs in the world | What it checks |
|---|---|---|
| `login` | a reachable server | login, spawn, first chunk, the placement teleport answered, health, food, position and dimension readable, `player_loaded` sent (1.21.4+), `tick_end` every tick; times to each |
| `idle` | ground | stands still for `--idle`: tick rate 18 to 21.5 per second, no input packets, one movement packet every 20 ticks (exactly) |
| `look` | nothing | all four directions, straight up and down, pitch beyond the pole (must clamp to 90), yaw wrapping; pitch never beyond ±90 in a packet |
| `walk` | 4 free blocks in a row on flat ground (it walks to some if needed) | 4 to 6 blocks in each cardinal direction and back with the keys only; the first five ticks from rest on a full block against 0.098, 0.1515, 0.1807, 0.1967, 0.2054 |
| `sprint` | flat run of 4; food above 6 | sprints out and back; sprint started, top speed about 0.28 per tick |
| `jump` | 3 free blocks above the ground | five jumps in place; heights 0.42, 0.7532, 1.0013, 1.1661, 1.2492 from the position packets; lands where it started |
| `sprintjump` | flat run of 4, headroom; food above 6 | sprint-jumps out and back |
| `sneak` | flat run of 3; for the edge part, a drop of a block or more next to flat ground | sneak-walks out and back; walks towards the edge and must stop there (centre at most 0.31 past it, not falling), then backs off still sneaking |
| `stairs` | a straight run of bottom-half stairs with free space above | walks up and down without jumping |
| `step` | a full block one higher than flat ground | jumps up and walks down, three times |
| `water` | water next to walkable ground | wades in (no sprint) until 20 ticks in the water, climbs out with the jump key |
| `container` | chest, trapped chest, barrel, ender chest or shulker box in the radius, reachable on foot | walks within reach, opens each with `bot.openContainer`, reads the items and the contents of shulker boxes inside, closes, waits 1.5 s; per container open time |
| `inventory` | nothing; a totem and food make it do more | lists the inventory; totem from the hotbar to the offhand and back (`bot.vanilla`), the server must confirm both; eats standing still if food is below 20 |
| `dig` (`--modify`) | a diggable full block next to the feet with air above | digs it; START and FINISH both sent, FINISH not earlier than `ceil(digTime / 50)` ticks after START, the server breaks it; puts the drop back if it picked it up |
| `place` (`--modify`) | a plain block item in the inventory | places it on the floor next to the feet, checks the server keeps it, digs it again |
| `pathfinder` | mineflayer-pathfinder installed in the working directory or `--pathfinder-from` | `loadPathfinder()`, goes to a cell 8 blocks away and back |
| `reconnect` | a server that lets the account log in twice | ends the bot and logs in again once; spawns again |
| `soak` (named explicitly) | ground | stays online for `--duration` doing idle, look and short walks in a cycle; logs in again after a kick (up to 5 times); setbacks and kicks per minute |

## What counts as a setback

A server `position` packet that no login, respawn or scenario asked for. The teleport after login and after a respawn
is expected. Everything else is counted, with the distance from the last position the bot had, and the bot's last five
ticks (position, velocity, ground, keys, rotation) before it. Grim's setbacks look exactly like this.

Also reported, not counted: server `player_rotation` packets (`serverRotations`), tick stalls and event-loop lag
(`watchdog`, fatal only from 3 s), anticheat-looking chat lines (`alerts`).

## Reading the output

The console shows a line per scenario and a table at the end. Everything is in `bench/out/<timestamp>/`:

- `report.json`, written after every scenario (a run you interrupt still has the finished ones);
- `<scenario>-<n>-<kind>.trace.txt` for every setback, kick, lint violation and failed check.

A trace holds the last 40 outgoing and 40 incoming packets before the incident (noise like chunks and entity moves
left out), a `!!` line at the moment, and the packets of the five ticks after it. Each line starts with the tick (the
count of `tick_end` packets, or of movement packets before 1.21.2) and the time into the scenario; `>>` is sent by the
bot, `<<` received:

```text
tick   281   14.855s >> player_input  none
tick   281   14.856s >> position  xyz 8.433 0 3.333 g=1 w=0
tick   282   14.907s >> position  xyz 8.433 -0.078 3.353 g=0 w=0
tick   286   15.057s !! <<fail: the sneaking bot walked off the edge and fell>>
```

A setback trace starts with the five ticks of state before it. For a bug report, attach the trace file, the scenario's
entry from `report.json` and the server and version it ran against.

The JSON has `bench` (library version and commit, node, start and end), `target`, `options`, `summary`, and per
scenario: `status`, `reason` (skips), `reasons` (fails), `durationMs`, `ticks`, `setbacks.events`, `kicks`, `errors`,
`lint.violations`, `alerts`, `watchdog`, `failures`, `notes`, `metrics`, `perMinute` and `traces`.

### Comparing runs

```bash
node bench/report.js 9b9t-walk.json                 # print a report
node bench/report.js 1.21.4.json 26.2.json          # diff: status, setbacks, lint ids, failures, changed metrics
```

The diff marks a scenario that got worse, new lint ids and new failure messages, and exits 1 if the second run
regressed. Use it for two versions of the server and for two commits of the library.

## Testing the bench

```bash
npx mocha --exit bench/bench.test.js    # the mock server (1.21.4 and 26.2) and, if found, flying-squid
node bench/run.js --mock                # all scenarios against the mock server
node bench/smoke.js                     # the movement scenarios against flying-squid
```

`bench/mock.js` accepts every movement, serves a flat world with a step, stairs, a pool, a pit and three containers
(one holding a shulker box with items), and can inject a setback, a kick or a chat line. It has no physics and no
anticheat: it shows the bench works, not that Grim is satisfied. `bench/smoke.js` and the last mocha test use
flying-squid from `BENCH_SQUID_DIR` (a folder with `flying-squid` 1.12 in its `node_modules`; EBS Lab's
`sandbox-server/` is one). It has no anticheat either and cannot open containers.

## What the bench cannot see

- Grim's verdicts. It sees the setbacks Grim sends and the kicks, not the violation levels below them; ask the
  server operator for the Grim log of the run, matched by the tick and time in the trace.
- Timer drift against the server's clock. It measures its own tick rate.
- Entity checks (reach, hitbox, interact cursor): nothing attacks or uses entities.
- The first `player_loaded` race on servers that hold the bot in a queue: the login timeout is the only guard.
