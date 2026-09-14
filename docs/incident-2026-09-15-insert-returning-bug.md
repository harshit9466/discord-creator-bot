# Incident — every INSERT-then-fetch repository function was broken on Postgres

**Date:** 2026-09-15. **Status:** Fixed, verified against real Postgres, redeployed.

## What happened

While smoke-testing the new Phase 3 status functions (`setOnBreak`,
`getCreatorsOnBreakPastReturn`, `stepDown`, `deleteCreator` — see `roadmap.md`),
`postRepository.createPost()` threw `TypeError: (intermediate value) is not
iterable` against the real Neon Postgres connection.

## Root cause

Four repository functions all used the same pattern:

```js
const [id] = await db('posts').insert({ ... });
```

This relied on Knex returning `[insertId]` from a plain `.insert()` with no
`.returning()`. That's true for **sqlite3** (confirmed by direct test) — which is
exactly why every earlier smoke test in this project passed: `postRepository`,
`requestRepository`, `applicationRepository`, and `conductReportRepository` were
all validated against SQLite, never against real Postgres, because Phase 1's
initial Postgres verification only exercised `creatorRepository.findOrCreateCreator`
(deliberately written differently — insert, then re-query by unique columns instead
of relying on the insert's return value).

On **Postgres**, a plain `.insert()` with no `.returning()` returns the raw
`pg` driver result object (`{ command, rowCount, rows: [], ... }`) — not an array.
Destructuring `const [id] = thatObject` throws immediately.

**Practical impact:** every write path through these four functions was broken in
production this entire session — creating a post, sending a request, submitting an
application (once someone was actually eligible), and filing a conduct report all
would have failed the moment anyone actually exercised them. This went undetected
specifically because nobody had yet completed one of those flows end-to-end against
the live database before this Phase 3 testing pass surfaced it.

## Fix

Added `.returning('id')` to all four inserts, destructuring `[{ id }]` instead of
`[id]`. Verified directly (not assumed) that `.returning('id')` produces the
identical `[{ id: N }]` shape on both Postgres and SQLite, so the DB-portability
goal from `data-model.md` still holds — this makes the pattern *more* consistent
across engines, not less.

## Verification

Ran a single script creating a real post, request (encrypted, decrypted, and
round-trip-checked), application, and conduct report directly against the live
Neon database, then cleaned up the test rows. All four succeeded. Bot restarted
clean afterward.

## Takeaway

`creatorRepository.js` already used the safer "insert, then re-query by known
columns" pattern — that was a deliberate choice at the time to sidestep exactly this
class of RETURNING-portability question, but the same care wasn't carried over when
the other four repositories were written later in the same session. Any new
repository function that needs the ID of a just-inserted row must use
`.insert({...}).returning('id')` and destructure `[{ id }]` — never bare
`.insert({...})` destructured as an array.
