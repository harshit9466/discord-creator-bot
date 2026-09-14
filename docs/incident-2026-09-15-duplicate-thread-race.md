# Incident — approving a creator created two threads, not one

**Date:** 2026-09-15. **Status:** Fixed, verified by reproducing the exact race, redeployed.

## What happened

Applied to be a creator, got approved — and got two identical "Sparkle ✨" threads
under `creator-spaces`, 576ms apart. The DB's `thread_id` pointed to whichever one's
`setThreadId` call happened to finish last; the other was a fully orphaned Discord
thread with its own copy of the welcome message.

## Root cause — self-inflicted, by the previous fix

Earlier today, `handleModDecision`'s approve branch was changed to call
`creatorSpace.ensureCreatorThread()` directly (defense in depth, so thread creation
didn't depend solely on the `guildMemberUpdate` gateway roundtrip). But
`member.roles.add()` in that same handler *also* triggers `guildMemberUpdate`, which
independently calls `ensureCreatorThread()` again. That gave two concurrent callers
— and `ensureCreatorThread()`'s own logic was check-then-act, not atomic:

```js
if (creator.thread_id) { ... return existing ... }
// no thread yet -> create one
```

Both concurrent calls saw `thread_id` as `null` (neither had set it yet) and both
created a real Discord thread. This is the exact same class of bug as
`findOrCreateCreator`'s race from earlier today — but `onConflict().ignore()` can't
fix it here, because creating a Discord thread is an external API side effect, not
a database row a unique constraint can dedupe.

## Fix

Added an in-process, per-member in-flight lock (`Map<string, Promise>` keyed by
`` `${guildId}:${memberId}` ``): a second concurrent call for the same member now
awaits the first call's promise instead of starting its own provisioning flow.
Verified directly — not assumed — by firing two real concurrent calls at a fresh
fake member and confirming exactly one Discord thread got created, both callers
received the identical thread reference, and the "Creator thread provisioned" log
line printed exactly once.

This only guards a single process. It does not protect against the *separate*
class of problem from earlier today (two actual bot processes both connected with
the same token) — that needs the operational discipline already adopted
(verify the process list, not just task-stop status), not a code-level lock.

## Cleanup

- Confirmed the orphaned thread (`1549188786003378246`) held only two bot-authored
  messages (the duplicate welcome), no real user content, before deleting it.
- The surviving thread (`1549188788419567688`) is correctly referenced by the
  creator's `thread_id` and unaffected.

## Takeaway

`ensureCreatorThread()`'s doc comment already claimed "idempotent, safe to call from
multiple places" — that claim was true for its *logic* but not under real
concurrency, because idempotency and concurrency-safety are different properties.
A function can produce the same *intended* result every time it's called (idempotent)
while still doing real, duplicated work if two calls overlap in time (not
concurrency-safe). Anything that creates an external resource (a thread, a role, a
webhook — not just a DB row) needs an explicit concurrency guard, not just an
"insert if missing" check, if it can plausibly be called from more than one place
for the same entity.
