# 9bFlayer notes

Running notes for making 9bFlayer indistinguishable from a vanilla client to Grim.

## Research (2026-10-08)

Audits of Grim's source (GrimAnticheat/Grim at f5bbe9c, 2026-10-07) against this fork. Most of each one is now
implemented, and the open items are listed below. Line numbers and paths refer to the state the audits were written
against.

- [packet-checks.md](research/packet-checks.md): every Grim check class, what it enforces, and whether the bot can trip
  it. Section 3 is the vanilla in-tick packet order that `input_queue.js` implements.
- [physics-ground.md](research/physics-ground.md): walking, jumping, collision, step-up, float vs double and the
  position-packet rules, against Grim's prediction engine.
- [physics-special.md](research/physics-special.md): item use, fluids, climbing, effects and attributes, knockback, and
  26.x movement.
- [v26_2.md](research/v26_2.md): the 26.1 to 26.2 protocol diff and how `lib/mcdata/` adds 26.2.
- [v26_3.md](research/v26_3.md): the same for 26.3 (protocol 777): where its data came from, what the wire changes touch.

## Verified live

On 9b9t, through EBS Lab's patch switches on mineflayer 4.27, so before this fork existed (evidence in EBS Lab's
`engine/patches/GRIM.md`):

- `player_input`, exact rotation, keep-ground, the float hitbox and the pathfinder without the snap: walking, jumping
  and stairs with 0 setbacks;
- clicks on the face and point the crosshair hits, opens spaced 1.5 s apart: 7 of 7 containers.

Nothing of this fork itself has run against a live Grim yet.

## Open

- The last step down off the platform (GRIM.md, finding 12): intermittent setbacks on the edge tick. 5,500 simulated
  runs show no physics difference, so the likely cause is tick or key timing, which the in-tick order rewrite changed.
  Retest on 9b9t.
- Not modelled: riptide and 26.2 geysers.
- The swimming and sprint flags the server sends in entity metadata are not adopted: the bot trusts its own simulation of
  both, so a server that forces one (a plugin, a potion) is not followed.
- The `can_sprint` of `use_effects` (1.21.11, an item that lets you sprint while it is used) isn't read: the bot stops
  its sprint for every item in use.
- From 1.21.5 vanilla applies the effects of every block a move passes through (cobweb, honey, bubble columns...), not just
  the ones at its end. The engine reads them where the move ends, so a long move (a fast fall, knockback) can differ.
- Landing doesn't cancel creative flight: vanilla clears the flag on touching the ground, the bot keeps `abilities.flying`
  until the server's abilities packet changes it.
- The sneak edge back-off follows Grim's shifted box. Vanilla 1.20.5+ may use `canFallAtLeast`, which differs only
  against a wall at an edge.
- Digging sends FINISH `ceil(1 / progress per tick)` ticks after START. Vanilla may add progress in the START tick
  too, which would make it one tick sooner. The later timing never beats Grim's FastBreak prediction; check it live.
- Two aimed actions at different targets at the same time are refused (the second look wins), not raced.
- The reach attribute keys on 1.20.5 to 1.21.1 are guessed (minecraft-data is stale there). The fallback is 4.5 for
  blocks and 3.0 for entities.
- **26.3 has never met a real server.** The data is minecraft-data's unmerged PR #1301 (the `pc_26_3` branch is a copy of
  26.1). Open: whether a server accepts the `teleport_confirm` with the position and rotation we write (and whether the real
  26.3 client sends nothing after it, as the fork now assumes from Grim), what the new
  serverbound `punch` packet is for (no fields; the fork keeps swinging with `arm_animation`), and the inherited
  particle/sound/biome/attribute data ([v26_3.md](research/v26_3.md)).
- The window type ids are prismarine-windows' list (the 1.20.3 menu registry). The join packets carry no menu registry to
  check it against, so a menu inserted into the registry after 1.21.4 would shift the names of the ones behind it. Nothing
  in minecraft-data or the 26.2/26.3 data says one was. `openContainer` only accepts windows named like a container.
- `bot.vanilla.scanContainers` does not walk: pass `approach` (the pathfinder) or it reports containers out of reach as
  `too-far`. It reads a double chest from the half nearer to the bot; trapped, copper and waxed copper chests count as chests.
- prismarine-chunk reads light nibbles as longs (upstream PR #340), so single light values can sit in the wrong place
  within an 8-byte group.
