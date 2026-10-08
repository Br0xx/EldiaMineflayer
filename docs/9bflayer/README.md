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
- Swimming (pose, box, look-driven motion) isn't simulated, so the bot never sprints in water.
- Not modelled: bubble columns on 1.21.2+, the stuck multipliers of sweet berry bushes, powder snow and cobweb
  (weaving), riptide, creative flight, and 26.2 geysers.
- The sneak edge back-off follows Grim's shifted box. Vanilla 1.20.5+ may use `canFallAtLeast`, which differs only
  against a wall at an edge.
- Digging sends FINISH `ceil(1 / progress per tick)` ticks after START. Vanilla may add progress in the START tick
  too, which would make it one tick sooner. The later timing never beats Grim's FastBreak prediction; check it live.
- Two aimed actions at different targets at the same time are refused (the second look wins), not raced.
- The reach attribute keys on 1.20.5 to 1.21.1 are guessed (minecraft-data is stale there). The fallback is 4.5 for
  blocks and 3.0 for entities.
