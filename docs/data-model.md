# Data Model

**DB layer:** Knex, not raw `pg` (unlike `discord-verify-bot`) — specifically so the
engine is swappable via `DB_CLIENT` + `DATABASE_URL` with no code changes. Verified,
not just claimed: the full repository layer (create creator, create post, like,
list-recent) was run end-to-end against SQLite with zero code changes from the
Postgres-configured version.

**Encryption:** `src/utils/crypto.js` is a direct port of `discord-verify-bot`'s
AES-256-GCM module (same wrapper shape, same fail-fast key validation). Not yet
applied to any field — post captions are intentionally public content, not PII, the
same distinction `discord-verify-bot`'s own audit log draws when explaining which
fields it left unencrypted. Phase 2 is where this starts actually mattering: creator
boundaries/limits text and viewer request messages are the closest equivalent to
`discord-verify-bot`'s `intro` field (sensitive, user-submitted, 18+/NSFW context)
and should be encrypted the same way.

## `creators`

| Column | Purpose |
|---|---|
| `discord_user_id`, `guild_id` | identity, unique together |
| `status` | `ACTIVE` \| `ON_BREAK` \| `STEPPED_DOWN` — driven by `statusFlow.js` (Phase 3) |
| `bio` | shown on profile |
| `thread_id` | their personal space — set when the role-grant listener provisions it |
| `default_content_type` | `SFW` \| `NSFW` — used for native posts, which skip the button flow's type/requests picker |
| `requests_open` | used for both native and button-flow posts by default |
| `break_return_at`, `step_down_mode` | Phase 3 (On a Break / Step Down flows) |
| `applied_at`, `approved_at` | Phase 2 (eligibility-gated apply flow) |
| `intro_posted_at` | set once `introFlow.publishIntro` has announced this creator in the Feed — guards the onboarding "Introduce Me" button against firing twice. Same `hasColumn`/`alterTable` migration story as `posts.extra_media_urls` |

## `posts`

| Column | Purpose |
|---|---|
| `creator_id` | FK → `creators.id`, cascade delete |
| `media_url` | Discord CDN URL of the attachment |
| `content_type`, `requests_open` | per-post override of the creator's defaults (button flow only — native posts always use the creator's defaults) |
| `caption` | plaintext, not encrypted (public content) — editable by the creator via Profile > Edit Caption, which also refreshes the live Feed message in place |
| `extra_media_urls` | JSON-stringified array of any attachments beyond the first in the same post — same "plain text column, parse in JS" reasoning as `eligibility_tracked_channel_ids` below, for identical behavior across pg/mysql2/sqlite3. Parsed back into `post.extraMediaUrls` on every read by `postRepository.parsePost`. Added after `posts` already existed in production, so `connection.js` has a `hasColumn`/`alterTable` step alongside the `createTable` guard — the createTable block alone would never reach an already-existing table |
| `feed_message_id` | the Feed message this post published as — used to jump to it from Profile, and to locate/delete it (and its auto-deleted comment thread) when the creator deletes the post |
| `like_count` | legacy, no longer written to — appreciation is a native ❤️ reaction on the Feed message instead, not a custom button (see roadmap.md) |

## `post_likes`

Composite primary key `(post_id, discord_user_id)` — existence of a row *is* the
like; toggling deletes/inserts rather than using a boolean flag.

## `applications` (Phase 2)

Snapshot of eligibility at the moment of applying (`eligible_post_count`,
`eligible_tenure_days`) — deliberately captured at apply-time rather than
recomputed later, so a mod reviewing it later sees what the applicant actually
qualified with. `status`: `PENDING` → `APPROVED` \| `DENIED`.

## `requests` (Phase 2)

Viewer → creator. `request_text_enc` is a `JSON.stringify()`'d `crypto.js` wrapper —
this is the one field in the whole schema that actually needed encryption, being
the closest equivalent to `discord-verify-bot`'s `intro` field (private,
user-submitted, 18+/NSFW context). Verified via smoke test that the raw column
never contains plaintext and that decryption round-trips exactly.

## `conduct_reports` (Phase 2)

`context` is only populated for native "Report Message" reports — content that was
already publicly visible has no confidentiality reason to avoid storing. A
request-linked report instead carries `request_id` and decrypts the original text
on demand when a mod views it, rather than keeping a second plaintext copy of
something that was deliberately encrypted. `countReportsAgainst()` tracks distinct
reporters, not just report count, specifically to surface a pattern across multiple
different people rather than looking like one person's isolated complaint.

## `restricted_members` (Phase 2)

Scoped restriction: blocks a member from the request flow only (checked at the start
of `requestFlow.start()`), not general server access. Deliberately not a ban/kick —
those stay manual moderator actions, never automated by this bot.

## `member_activity` (Phase 2)

Message counts in `ELIGIBILITY_TRACKED_CHANNEL_IDS`, incremented going forward as
messages arrive live. Historical activity from before the bot existed is covered by
`src/scripts/backfillActivity.js` — a standalone, re-runnable script that scans each
tracked channel's full message history via the Discord API and sets exact baseline
counts (`setPostCount`, not increment, so re-running never double-counts). Run once
in production on 2026-09-15 against Desi Sisters: scanned ~23,500 messages across 4
channels, wrote baselines for 1,704 members. Re-run it if a new channel gets added to
`ELIGIBILITY_TRACKED_CHANNEL_IDS` and its pre-existing history should count too.

## `guild_settings`

Mod-editable rules — `eligibility_min_posts`, `eligibility_min_tenure_days`,
`eligibility_tracked_channel_ids` (comma-separated text, same reasoning as
`request_text_enc` above: a plain text column behaves identically across
pg/mysql2/sqlite3, a native array/JSON column wouldn't), and `creator_policy`
(free text, shown to every applicant and editable via `/creator-settings`).

One row per guild, seeded once from the `ELIGIBILITY_*` env vars and a sensible
starter `creator_policy` the first time anything touches it — after that the row
is the actual source of truth, and the env vars only matter for a from-scratch
deploy. Read through an in-memory cache (`guildSettingsRepository.js`) that's
invalidated on every write, specifically so `messageCreate.js` — which runs on
every message the bot can see — never turns into a per-message database query
just to check the tracked-channel list. Seeding uses the same
`onConflict().ignore()` atomic-upsert pattern as `creatorRepository.findOrCreateCreator`
(and was verified concurrency-safe the same way — two simultaneous first-access
calls for a brand-new guild both get the identical seeded row, no duplicate insert).

Added because the original policy-agreement step in the apply flow was a toggle
button with no actual policy text behind it anywhere, and eligibility thresholds
could only be changed by editing `.env` and restarting — neither was something a
mod could do from inside Discord. `/creator-settings` fixes both in one place.

## Not yet modeled (future phases)

- Follows
- Round-robin featured-creator spotlight
