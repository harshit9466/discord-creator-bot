# Creator Program — Design Overview

**Status:** Phase 1 built and smoke-tested. Phase 1.5 (native posting + auto-provisioned
creator threads) in progress. See `roadmap.md` for the full phase breakdown.

## 1. The problem this replaces

16 members hold the "Pornstar" creator role, each with their own individual Discord
channel. 7 more members want the role. At 23+ individual channels, the server was
heading toward a point where members would stop browsing them — more creators would
mean more channels, not more discovered content. The goal was to flip that: more
creators should mean more discoverable content, not more sidebar clutter.

## 2. Architectures considered and why they were adapted or dropped

- **Keep doing individual channels per creator.** Rejected outright — this is exactly
  the scaling problem being solved. Doesn't fix discoverability, and the channel list
  keeps growing without bound.

- **Single shared "Creator Hub" channel, everyone posts into it.** Solves discovery,
  but a single stream with 20+ people posting into it becomes noisy in the same way
  the channel list did — just moved from the sidebar into message history. Also gives
  creators no sense of a space that's "theirs," which turned out to matter.

- **Forum channel with tags (SFW/NSFW/Requests Open/etc.), one thread per creator.**
  Discord forums cap out at 20 tags total, which doesn't comfortably scale past the
  16→23→50+ creator growth this needs to support. Threads inside a forum also don't
  give the same "this is my channel" feeling a real, named, persistently-branded space
  does.

- **Bot-curated aggregated feed only, no personal space.** Good for consistent
  presentation and discovery, but requires the bot to mediate every single post —
  high friction, and (like the Hub option) creators lose any sense of ownership over
  their own content.

- **Studio pods — small creator groups sharing one channel.** Floated as an optional
  add-on for creators who want to cross-promote each other, but not adopted as the
  core structure; nothing about it fixes discoverability for the whole roster on its
  own.

## 3. The architecture that was settled on

Two things exist side by side, kept in sync automatically:

- **The Feed** (`FEED_CHANNEL_ID`) — a single channel, bot-posted only, one
  consistently-formatted card per post, for browsing/discovery. Each card gets an
  auto-created comment thread and Like/Profile/Request buttons.

- **A personal thread per creator** (`creator-spaces` parent channel) — real,
  persistent, named after them, full message history. This is their equivalent of
  the individual channel they have today, without reintroducing sidebar clutter,
  because it's a thread rather than a top-level channel.

Both are kept in sync because **posting can happen two ways, and both converge on
the same result** (content lands in the creator's thread *and* the Feed):

1. **Native posting** — a creator just drops a photo/video with a caption directly
   into their own thread, exactly like posting in a normal channel today. Zero bot
   interaction required. The bot notices, mirrors a formatted card into the Feed,
   and reacts ✅ on their original message as confirmation.
2. **Button-guided posting** — for anyone who prefers being walked through it: click
   Post Content on the home menu → pick content type/requests via dropdowns → caption
   modal → bot asks for the media over DM → bot publishes into *both* their thread
   and the Feed.

This was a deliberate late change from the original Phase 1 design (which only had
the button flow, publishing to the Feed alone). The reasoning: forcing every post
through a bot flow is friction that doesn't exist today, and a feed-only architecture
never gave creators the ownership feeling of a channel that's genuinely theirs. See
`intents-and-compliance.md` for what this decision cost in terms of bot permissions.

## 4. Thread lifecycle

A creator's thread is provisioned **eagerly, at the moment they receive the Creator
role** — not lazily on first post. The bot listens for role changes, detects the
Creator role going from absent to present on a member, and immediately creates their
thread with a pinned welcome message. This was an explicit choice over lazy
creation-on-first-use, at the cost of needing the Guild Members intent (see
`intents-and-compliance.md`).

## 4.5 creator-spaces is creator-only, by explicit decision (2026-09-15)

Checked the live permission overwrites and found `@everyone` explicitly denied
`ViewChannel` on `creator-spaces` — only the Creator and mod roles can see it.
Asked whether to open it up (gated to whichever role VerifyBot grants post-NSFW-
verification) so members could browse creators' actual threads directly. Explicit
answer: **no — creator-spaces stays creator-only.** That's a deliberate privacy
boundary, not an oversight to fix.

This means the Feed is the *only* member-facing content surface, permanently —
nothing member-facing may ever link into a creator-spaces thread. Two things got
built on that constraint rather than around it:

- **Profile** (`profile.js`) now pages through a creator's actual posts one at a
  time (image, caption, date) with a "View in Feed" link to that post's specific
  Feed message — never the thread. Replaced a flat date-stamped text list that
  had no source of the actual content behind it.
- **Creator Directory** (`creatorDirectory.js`, "Browse Creators" on the home menu)
  — a member-facing browsable list of active creators, entirely built from data
  members already have access to (the Feed + each creator's own `creators` row),
  with a select menu into the paginated profile above.

## 5. Design principles carried through every decision here

- **Low friction beats guided flows wherever the two conflict.** A creator should
  never have to learn bot-specific syntax to do the basic job of posting content.
- **Every creator gets genuine, permanent ownership of a space** — not just an
  on-demand generated profile view — because that's what the current channel-based
  system already gives them and any replacement has to preserve that feeling.
- **Discoverability is solved by the Feed, not by making individual spaces harder to
  find** — the Feed exists so members don't have to browse 23+ spaces, not to replace
  those spaces.
- **Everything should still work with a click, not just a slash command**, for anyone
  unfamiliar with bots — the button flow exists for exactly this reason and is not
  being deprecated now that native posting exists.
