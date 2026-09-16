# Roadmap

## Phase 1 — done, smoke-tested

- Persistent, pinned home menu (`/setup-creator-hub`, mods only)
- Button-guided post flow: type/requests dropdowns → caption modal → DM for media → publish
- Feed: formatted card, per-post like button, auto-created comment thread
- Basic profile view (status, bio, requests-open, last 5 posts)
- Encryption module ported, not yet wired to any field
- Zero privileged intents (superseded by Phase 1.5 — see `intents-and-compliance.md`)

## Phase 1.5 — in progress (this session)

- Add `GuildMembers` + `MessageContent` intents (see `intents-and-compliance.md` for
  why both became necessary)
- `creators.thread_id`, `creators.default_content_type` columns
- Role-grant listener (`guildMemberUpdate`) → auto-provisions a creator's personal
  thread under `CREATOR_SPACES_CHANNEL_ID` the moment they receive the Creator role
- Native-posting listener (`messageCreate`) → detects a post dropped directly into a
  creator's thread, mirrors it into the Feed, reacts ✅ for confirmation
- Button flow extended to dual-publish: thread *and* Feed, not Feed alone

## Phase 2 — done, smoke-tested (including a verified encryption round-trip)

- **Apply to be a Creator**, eligibility-gated: `ELIGIBILITY_MIN_POSTS` /
  `ELIGIBILITY_MIN_TENURE_DAYS` / `ELIGIBILITY_TRACKED_CHANNEL_IDS` env vars (tunable
  by restart, not yet a live mod command); transparent "what's missing" checklist for
  members who don't yet qualify; content-comfort + frequency-commitment pickers +
  policy-agreement toggle; mod review card with Approve/Deny. Approving assigns the
  Creator role, which — via the existing `guildMemberUpdate` listener — automatically
  provisions their thread. No separate wiring needed for that; it just falls out of
  Phase 1.5's design.
- **Boundaries + consent-gated requests**: creators set boundaries via My Settings
  (plaintext — shown to every requester, not secret). Every request flow shows those
  boundaries before the requester can type anything. Request text is encrypted with
  the same AES-256-GCM module `discord-verify-bot` uses; verified directly against
  the raw DB row that the stored value contains no plaintext, and that decryption
  round-trips exactly.
- **🚩 Report** button on every request DM, plus a native "Report Message" context-menu
  command for anything else. Reports surface a pattern (multiple distinct reporters
  against the same person) rather than looking like isolated one-offs. Mod actions:
  Warn, Restrict Requests (scoped — blocks the request flow only, not general server
  access), Escalate (deliberately stops there — kicks/bans stay a manual moderator
  decision), Dismiss.

## Phase 3 — done, smoke-tested against real Postgres

- **On a Break** — self-service via My Settings, one-click duration buttons (1 week /
  2 weeks / 1 month / not sure — deliberately no free-text date parsing). Content
  stays visible with a badge, requests stay open at the flag level (creator's
  `requests_open` is untouched; the request flow doesn't currently special-case
  `ON_BREAK` — worth revisiting if that turns out to matter in practice). Hourly
  scheduled job (`ready.js`) DMs a check-in once `break_return_at` passes —
  `I'm back!` reactivates immediately, `Need more time` re-asks for a duration.
- **Step Down** — self-service, Archive (role removed, thread archived not deleted,
  one-click Reactivate restores role + thread + all data) or Delete (role removed,
  thread deleted, creator row deleted — cascades posts/likes/requests via FK — with
  a mandatory second confirmation click since it's irreversible).
- **Mod roster** (`/creator-roster`, mod-only) — single embed, not paginated
  (deliberate simplification at this community's scale — see `modRoster.js`),
  showing every creator's status and, for active ones, days since last post with a
  ⚠️ flag past `INACTIVITY_FLAG_DAYS`.
- Not built: round-robin featured-creator spotlight (deliberately not vote-based —
  see chat history for the popularity-contest reasoning). No blocker, just not
  requested yet.

## Onboarding existing creators (one-time, run once this session)

Pre-existing Creator role holders never trigger the `guildMemberUpdate` role-grant
listener (no transition happens for a role they already have), so they'd have no
thread or DB row without a separate step. `src/scripts/onboardExistingCreators.js`
finds everyone currently holding the role and provisions each one exactly like a
fresh approval would (idempotent, safe to re-run). Deliberately does **not** touch
existing individual channels or migrate their content — that's a human decision, not
something to automate silently. Run 2026-09-15: 25 creators onboarded, 0 errors.

## Phase 4 — creator content control, in progress

- **Multi-media posting** — native message-drop, the guided post flow's DM step, and
  the Feed itself previously only ever kept the first attachment of a multi-file
  message; every extra photo/video was silently dropped. Posts now store every
  attachment (`posts.extra_media_urls`); the Feed renders extra images as gallery
  embeds (main card + up to 9 more — Discord's 10-embed-per-message cap) and any
  video/non-image file as a raw attachment instead (videos can't be embedded).
  Smoke-tested against real Postgres: create/read/single-vs-multi-attachment all
  round-trip correctly, including the `hasColumn`/`alterTable` migration needed
  because `posts` already existed in production before this column did.
- **Creator control over their own posts** — Profile, when viewed by the post's own
  creator (ephemeral, so no separate ownership check needed on the buttons
  themselves), now shows Edit Caption and Delete Post. Edit updates the DB and
  refreshes the live Feed message in place; Delete removes the Feed message (which
  auto-deletes its comment thread) and the DB row, with the same second-confirmation
  pattern used everywhere else in this bot for irreversible actions.
- **Archived-creator reapplication** re-investigated and re-confirmed fixed — see
  `incident-2026-09-16-archived-reapproval.md`. The underlying fix (reset status +
  unarchive a reused thread on re-approval) shipped 2026-09-15; this session
  live-checked role membership, thread archived-state, and message history for the
  reporting case again before telling the user it holds.
- **Feed introduction for new creators** — the onboarding welcome message (in the
  creator's own thread) now has an "Introduce Me in the Feed" button alongside Set
  My Boundaries. Walks through: write your own intro (modal) or use a generic one,
  then optionally attach a photo over DM (same "modals can't hold a file picker,
  DM for media" pattern as the post flow) — see `src/interactions/introFlow.js`.
  Posts to the Feed pinging `@here` plus the three content-preference roles
  (`config.introPingRoleIds`: Initiate/NSFW Only/Anytime), with a Profile button.
  Guarded by `creators.intro_posted_at` so it can't fire twice for the same
  creator. Only wired into the welcome message going forward — deliberately not
  retrofitted onto creators who onboarded before this shipped, same restraint as
  `onboardExistingCreators.js` not touching pre-existing content.
- **Member-facing creator directory**, via a Discord Forum channel
  (`CREATOR_FORUM_CHANNEL_ID`, optional/inert until configured) — see Phase 5 below,
  this landed the same session after more design thought as requested.

## Phase 5 — post ownership redesign, forum-as-gallery, text posts

Direct feedback after Phase 4 shipped: the Forum directory had become a place for
creators to *edit* their posts instead of a place for *members* to browse a
creator's content and talk to them, post editing required an extra click through
Profile that added friction, and deleting one bad photo out of a multi-photo post
deleted the whole post. Three changes:

- **Post management moved into the creator's own thread**, attached directly to
  each post as it's made (`src/interactions/postControls.js`) — Edit Caption /
  Delete Post / Remove a Photo-Video, right there, no detour through Profile.
  Profile (`profile.js`) is read-only again, member-facing only. For a native
  message-drop (the creator's own message, which can't carry bot buttons), the
  controls arrive as a bot follow-up reply instead.
- **`postRepository.removeMediaItem(postId, url)`** removes exactly one media
  item — promoting the next one to `media_url` if the primary was the one
  removed, or quietly turning the post text-only if a caption remains and no
  media is left, or deleting the post outright only if truly nothing is left.
  No more "delete the whole post to get rid of one photo."
- **Text-only posts** — `posts.media_url` is now nullable. The guided post flow
  asks Photo/Video vs Text Only right after Next; Text Only skips the DM-for-media
  step entirely since there's nothing to collect. Native message-drop stays
  media-required (an attachment is still the only unambiguous "this is meant to be
  a post, not just chat in my thread" signal).
- **The Forum directory now mirrors actual content**, not just a status card —
  `forumDirectory.mirrorPost` sends every new post into the creator's own forum
  thread as it's made (`src/utils/postCard.js` holds the shared embed-building
  logic so `feedCard.js` and `forumDirectory.js` don't require each other in a
  cycle). Scrolling a creator's forum thread now shows everything they've shared,
  oldest to newest, and since it's a normal Discord thread members can reply right
  there to actually talk to them — the starter message stays a lightweight status
  card. `refreshMirroredPost`/`deleteMirroredPost` keep that copy in sync with
  edits/removals/deletes. The intro announcement also got its own comment thread,
  matching every other post (it was missing one).
- `src/scripts/backfillForumMirrors.js` mirrored the handful of posts that existed
  before this shipped. Run 2026-09-16: 7 mirrored, 0 skipped, 0 failed.

## Incidents this session

Two production bugs surfaced and fixed during real testing — see
`incident-2026-09-15-interaction-crash.md` (interaction-token expiry + a router that
couldn't catch async errors) and `incident-2026-09-15-insert-returning-bug.md` (every
INSERT-then-fetch repository function was silently broken on Postgres, only ever
tested against SQLite). Both are worth reading before extending this further — they
describe two different classes of "worked in every test, broke on first real use."

A third issue was operational, not a code bug: after an interim bot restart, the
background task wrapper was stopped but the underlying `node src/index.js` process
it spawned kept running, orphaned — leaving two live connections on the same bot
token both racing to answer every interaction ("Unknown interaction" /
"already acknowledged" errors on a real Apply test). Confirmed via
`Get-CimInstance Win32_Process` (two PIDs running `src/index.js`) and fixed by
killing the stale one directly. Worth checking process list, not just the task
wrapper's exit status, after any future restart during dev.
