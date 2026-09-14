# Incident — button-flow image step never actually listened for the attachment

**Date:** 2026-09-15. **Status:** Fixed, redeployed. Two unrelated bugs, both real.

## Bug 1 — wrong discord.js API, present since Phase 1

`postFlow.handleCaptionSubmit()` called:

```js
await dmChannel.messages.awaitMessages({ ... })
```

`awaitMessages()` is a method on the **channel itself** (`TextBasedChannel`), not
on `channel.messages` (`MessageManager`, which only has `.fetch()`/`.cache`).
Confirmed directly against the installed `discord.js` source before fixing, not
assumed. Calling a non-existent method throws a `TypeError` **synchronously** —
before the chained `.catch(() => null)` could even attach to a promise — so it
wasn't swallowed the way a real await-time rejection would have been. It crashed
`handleCaptionSubmit` immediately after the DM was successfully sent, which:

1. Made the router's error handler `editReply()` the "📩 Check your DMs" message
   into "Something went wrong — please try again," in the same message (matches
   the reported symptom exactly).
2. Meant the attachment collector never actually got created — so when the
   attachment was sent to the DM afterward, nothing was listening. Silence, not
   an error, which is why "nothing happened after it."

This is exactly the class of bug the 2026-09-15 router fix (awaiting handlers,
catching real errors) was built to surface cleanly instead of crashing the whole
bot — and it worked as intended here: one interaction failed visibly, the process
stayed up. It just took someone actually completing this specific flow for the
underlying API mistake to surface at all.

**Fix:** `dmChannel.awaitMessages({ ... })` — direct channel call.

## Bug 2 — unrelated, found in the same log dive: DMs crashed the settings lookup

`messageCreate.js` (added earlier today for the mod-configurable eligibility
settings) called `guildSettingsRepo.getSettings(message.guildId)` unconditionally,
for every message the bot receives — including DMs, where `message.guildId` is
`null`. That crashed with a Postgres NOT NULL violation trying to seed a
`guild_settings` row with `guild_id: null`. Caught by `index.js`'s `runHandler`
backstop (so it didn't take the bot down), but fired on every DM the bot ever
received — including, incidentally, the exact attachment message from Bug 1's
test, though that message going unprocessed was Bug 1's fault, not this one's.

**Fix:** early `if (!message.guildId) return;` — everything in this handler
(tracked-channel counting, native-thread posting) is guild-scoped anyway,
so DMs have nothing to do there. Also added a defensive guard directly inside
`getSettings()` that throws a clear, immediately-diagnosable error on a missing
`guildId`, instead of surfacing as a confusing database constraint violation —
so any future caller mistake in the same shape fails fast and readably.

## Takeaway

Both bugs were only found because a real end-to-end flow was actually completed
for the first time — the button-guided post flow's image step, in this case. That
pattern has now repeated enough times today (insert-returning, findOrCreate race,
duplicate-thread race, this) that it's worth stating plainly: smoke tests that
exercise a function in isolation are not the same as exercising the full flow a
real user takes, and this project's early smoke tests were mostly the former.
