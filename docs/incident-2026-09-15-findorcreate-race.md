# Incident — findOrCreateCreator race crashed thread provisioning on approval

**Date:** 2026-09-15. **Status:** Fixed, verified with a real concurrent reproduction
on Postgres and SQLite, redeployed.

## What happened

Approved a real application. The applicant got their "You're approved!" DM, but
their personal thread never got created — `creators.thread_id` stayed null.

## Root cause

`applyFlow.handleModDecision()`'s approve branch does two things close together:

1. `member.roles.add(config.creatorRoleId)` — which Discord dispatches back to the
   bot as a `guildMemberUpdate` event, correctly detected as a role-add transition,
   which calls `creatorSpace.ensureCreatorThread()` → `creatorRepo.findOrCreateCreator()`.
2. The approve handler itself then also calls `creatorRepo.findOrCreateCreator()`
   directly, to set `default_content_type`.

`findOrCreateCreator()` was check-then-insert, not atomic:

```js
const existing = await db('creators').where({...}).first();
if (existing) return existing;
await db('creators').insert({...}); // no ON CONFLICT handling
```

Both calls landed close enough together that both SELECTs saw "no row," both tried
to INSERT, and the loser hit the table's unique constraint and threw. Since that
throw happened inside `guildMemberUpdate.js`'s own try/catch, it didn't crash the
bot (the interaction-crash fix from earlier today held) — it just silently failed
*that one provisioning attempt*, logged an error, and left the row without a thread.

## Fix

1. **`findOrCreateCreator` is now a real atomic upsert**:
   `.insert({...}).onConflict(['discord_user_id', 'guild_id']).ignore()`, then
   select. The loser's insert is now a no-op instead of an error. Verified by
   actually firing two concurrent calls for the same new user with `Promise.all`
   on both real Postgres and SQLite — both succeeded, returned the same row, and
   the table ended up with exactly one row either way.
2. **`handleModDecision`'s approve branch now calls `ensureCreatorThread()`
   directly** instead of the bare repo function, so thread creation no longer
   depends solely on a gateway-event roundtrip completing after the handler
   returns. `ensureCreatorThread()` is idempotent (checks `thread_id` first), so
   having both the approve handler and the `guildMemberUpdate` listener able to
   call it is a safety property, not a re-introduced race — the underlying race was
   in the non-atomic upsert, not in having two callers.

## Recovery

The specific stuck user (creator id 31, discord id 359202240671645697) was fixed
directly with `src/scripts/fixMissingThread.js <discordUserId>`, which just calls
the now-safe `ensureCreatorThread()` — thread `1549186789149777990` created.

## Takeaway

Any "find or create" repository function that could plausibly be called from two
places for the same entity around the same time needs to be a real atomic upsert
(`onConflict().ignore()` or equivalent), not check-then-insert — even when each
individual call site looks single-threaded, the two call sites together aren't.
This is the second data-layer bug found today (`incident-2026-09-15-insert-returning-bug.md`
was the first) from code that was never exercised under real concurrent conditions
before now.
