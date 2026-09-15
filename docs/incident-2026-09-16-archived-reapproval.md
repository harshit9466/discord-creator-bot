# Incident — re-approving an archived creator left them stuck without a working thread

**Date:** 2026-09-16 (bug happened 2026-09-15, reported and fixed same day; re-verified
live 2026-09-16 after a second report). **Status:** Fixed, redeployed, and re-confirmed
against live Discord/DB state.

## What happened

A creator ("Malini", discord id `657588797415882763`) was archived (Step Down >
Archive), then later re-applied and was approved again. The user reported: *"one of
the user was archived by me and now they applied again but their thread was not
prepared."*

## Root cause

Two separate bugs compounded:

1. `applyFlow.handleModDecision()`'s approve branch never reset `creators.status`.
   A creator archived via Step Down has `status = 'STEPPED_DOWN'`; re-approving them
   gave the role back but left `status` at `STEPPED_DOWN` forever — the system still
   considered them archived even though, from the Discord side, they looked like an
   active creator again.
2. `creatorSpace.ensureCreatorThread()` reused the creator's existing `thread_id` if
   one was already set, but never checked whether that thread was archived. An
   archived creator's thread gets archived on the way out (Step Down > Archive), so
   the reused thread came back exactly as archived as it was left — invisible to the
   creator in their channel list even though the bot considered the thread
   "provisioned."

Neither path threw an error or logged anything wrong; both silently did the wrong
thing, which is why it wasn't caught until a real re-approval was reported.

## Fix

1. `handleModDecision`'s approve branch now calls `creatorRepo.reactivate(creator.id)`
   after provisioning — the same status-reset `statusFlow.reactivate` and
   `modPanel.liftSuspension` already use, so a re-approval clears **any** prior
   status (`STEPPED_DOWN`, `ON_BREAK`, `SUSPENDED`), not just the archived case.
2. `ensureCreatorThread()` now checks `existing.archived` on a reused thread and
   calls `existing.setArchived(false)` before returning it, so a reused thread is
   actually usable again instead of just technically existing.

## Recovery

Malini's live data was repaired directly (status reset, thread unarchived) after the
first report on 2026-09-15.

## Re-verification (2026-09-16)

A second, similarly-worded report came in the next day. Rather than assume the
existing fix already covered it, this was re-investigated live: checked Malini's
current role membership, thread archived-state, and message history directly against
Discord/DB, plus the 4 other creators approved since the fix shipped. All confirmed
genuinely fixed — no regression, no second bug. Reported back to the user with that
evidence rather than a bare "should be fixed."

## Takeaway

"Re-approving" isn't just re-granting a role — it has to reset every piece of state a
prior archive/suspend/break touched (`status`, and anything a reused resource like a
thread was left in), or the creator ends up in a state the UI has no name for: looks
active, behaves archived. Worth auditing whether any other "resume" path
(`statusFlow.reactivate`, `modPanel.liftSuspension`) has a similar reused-resource gap
this one did.
