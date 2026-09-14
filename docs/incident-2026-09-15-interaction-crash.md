# Incident — first live test crashed the bot

**Date:** 2026-09-15. **Status:** Fixed, redeployed, confirmed back online.

## What happened

First real test in Desi Sisters: clicked "Apply to be a Creator". The eligibility
check itself ran correctly (`Tenure ✅ 816/90 days`, `Activity ❌ 0/50 tracked posts`)
but the bot never replied — Discord client showed "CreatorsHub didn't respond in
time" — and the whole process crashed:

```
error: Uncaught Exception (bot will restart): Unknown interaction
{ "code": 10062, ... }
```

## Root causes (two, stacked)

1. **Interaction token expiry.** Discord requires the *first* acknowledgment of an
   interaction within 3 seconds or the token dies. `applyFlow.start()` did three
   sequential DB round-trips (`getCreatorByDiscordId`, `getPendingApplication`,
   `getPostCount`) before its first `interaction.reply()` — enough latency, on a
   cross-region connection to Neon, to blow the window.

2. **The router couldn't have caught it even if it were fast enough.**
   `interactionCreate.js` dispatched every handler as `return handler(interaction);`
   — never `await`ed. A `try { return somePromise; } catch {}` does not catch a
   later rejection of that promise; the dynamic scope has already exited by the time
   it settles. So the failed reply became a genuinely unhandled rejection, which hit
   `index.js`'s `uncaughtException` handler, which calls `process.exit(1)` — one
   expired token took down every connection in the process, not just that one
   interaction.

## Fix

**Every handler that does any `await` before its first Discord response now defers
first** (`deferReply()`/`deferUpdate()`), then uses `editReply()` once the real work
is done. This applies to `applyFlow.js`, `requestFlow.js`, `reports.js`,
`feedCard.handleLike()`, `profile.js`, and `homeMenu.postHomeMenu()`. Left alone:
handlers with no `await` before their response (`postFlow`'s select/button steps),
and `settings.start()` — it needs to `showModal()`, which cannot be deferred, but it
only does one fast lookup rather than three sequential ones.

**The router now actually awaits its dispatched handler**, wrapped in one try/catch,
so a rejection is caught, logged, and turned into an ephemeral "something went wrong"
reply (or edit, if already deferred) — scoped to that one interaction instead of the
whole process. `index.js`'s event-loader also got a matching backstop
(`runHandler()`) in case any *other* event handler's promise rejects outside its own
try/catch, for the same reason.

## Verification

- Syntax-checked all files.
- Restarted the bot: clean login, no crash (crashed at 03:12:17, fix deployed and
  confirmed logged in at 03:16:57).
- Re-tested live against the original failing path: clicking Apply again returned
  the eligibility embed successfully, no crash, no dropped interaction. Confirmed
  fixed under real conditions, not just "it didn't crash on boot."
- Separately surfaced (not a bug in this fix, a pre-existing gap): eligibility showed
  0 tracked posts despite real posting history, because `member_activity` only counts
  going forward from when the bot started listening — no backfill existed yet. Fixed
  same session with `src/scripts/backfillActivity.js`, a re-runnable historical scan;
  see `docs/data-model.md`.

## Takeaway for anything built in later phases

Any new interaction handler that does more than one `await` before its first
response needs `deferReply()`/`deferUpdate()` as the first line. Any new code
dispatched from `interactionCreate.js` or any event file needs to actually be
awaited by its caller — returning a promise without awaiting it looks identical to
awaiting it until something inside actually rejects.
