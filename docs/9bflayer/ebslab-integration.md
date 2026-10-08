# Bringing 9bFlayer into EBS Lab (later)

Plan: 9bFlayer stays its own project for now. Next it goes into EBS Lab, where it is tested on 9b9t, and only after
that into EBS. A trial integration was built on 2026-10-08 and passed EBS Lab's sandbox smoke test (24/24) on both
libraries. It was not kept. These are the notes to redo it.

- **Per-bot choice:** `SessionConfig.library: 'mineflayer' | '9bflayer'`, defaulting to `mineflayer`, so old
  `sessions.json` files load unchanged. `BotSession.createBot` picks the module, and a change applies on the next
  connect. In the UI: a Library select in the New bot / Edit dialog, and the library name in the bot header.
- **Dependency:** `"9bflayer": "github:Br0xx/EldiaMineflayer#9bflayer"`.
  - Keep EBS's global `overrides` (minecraft-data 3.84.1, minecraft-protocol 1.51.0, prismarine-*…). Add a nested
    `"9bflayer": { … }` block with 9bFlayer's own versions: nested overrides win.
  - Check with `npm ls minecraft-data minecraft-protocol prismarine-chunk prismarine-block`: `mineflayer@4.27.0` must
    still resolve exactly the pins.
  - The lock records the GitHub dependency as `git+ssh`, so the machine that installs needs GitHub access.
- **Patches:** don't apply EBS Lab's vanilla-parity patches to 9bFlayer bots: tick-end, player-input,
  collision-flag, player-loaded, exact-rotation, keep-ground, float-hitbox, interaction-sequence, use-item-rotation,
  protodef-guard, long-keepalive, hide-protocol-errors and queue-socket-timeout. 9bFlayer does all of them natively,
  and `vanillaTick` on top of it sends `tick_end` twice and counts sequences twice. The late-socket guard and the chat
  lock still apply.
- **Clicks:** `vanillaInteract.ts` hands over to `bot.vanilla` when it exists. A direct `bot._client.write` bypasses
  9bFlayer's in-tick order.
  - `closeAnyWindow` and `swapHands` become async, and callers must await them.
  - 9bFlayer closes a window only once no movement key is held, so clear the keys first.
  - `setQuickBarSlot` returns a promise.
- **Pearl clicks:** use `bot.vanilla.clickBlock(block, { reach: 4.4 })`. The top-row slots are about 4 blocks up, and
  the default reach is 3.
- **The 26.2 overlay:** it used to throw when the app's hoisted packages brought an older minecraft-data. Fixed in
  9bFlayer (ae6579b), so no workaround is needed.
- **Smoke test:** run it once per library (`SMOKE_LIBRARY=mineflayer|9bflayer`). Check one `tick_end` per tick,
  `bot.vanilla` present only on 9bFlayer, and a stash scan + fetch.
