# Privileged Intents — Decision Trail

**Status:** Design decided. Both intents below must still be toggled on in the
Developer Portal (Bot tab) before the running bot will actually receive the events —
not yet done as of this writing, since the Discord application for this bot hasn't
been created yet.

## Where this started

The explicit early goal for this bot was **zero privileged intents** — specifically
so it would never need to go through the same review process `discord-verify-bot`
went through at the 10,000-user threshold (see
`../../discord-verify-bot/docs/privileged-intents-review-2026-08.md`). This was
verified against Discord's own guidance, not assumed:

- A single guild-member lookup (`guild.members.fetch(id)`) does **not** require the
  Guild Members intent — only bulk member caching and join/leave/update gateway
  events do. ([You Might Not Need a Privileged Intent — Discord Docs](https://docs.discord.com/developers/gateway/you-might-not-need-a-privileged-intent))
- Interaction payloads (slash commands, buttons, modals) already include the
  resolved guild member object — including `joinedAt` — for free, no intent needed.
- Message metadata (author, channel, timestamp) is always available regardless of
  intents; only `content`/`embeds`/`attachments`/`components` are gated behind the
  Message Content intent, and DMs are exempt from that gating entirely.

Phase 1 (home menu, button-guided post flow via DM attachment, Feed, likes, basic
profile) was built entirely on this basis: `Guilds` + `DirectMessages`, neither
privileged.

## What changed, and why

Two feature decisions, made explicitly and in this order, each added one privileged
intent:

1. **"I want both options — post in their channel thing, or have the bot do it for
   them via the UI button."** Native posting (dropping a file directly into a
   creator's own thread, no bot interaction) requires the bot to read that message's
   attachment. Reading attachments on a non-exempt guild message requires the
   **Message Content** intent. There is no way around this while still supporting
   fully native, zero-friction posting — it was evaluated and confirmed, not assumed.

2. **"At the grant of role it should happen"** (thread auto-provisioning). Detecting
   that a member's roles changed — specifically, that the Creator role was newly
   added — requires the `GUILD_MEMBER_UPDATE` gateway event, which requires the
   **Guild Members** intent. This is the same intent `discord-verify-bot` already
   uses, for the same category of reason (reacting to member/role state changes).

Both were deliberate trades: lower friction and eager thread provisioning, in
exchange for leaving the "zero privileged intents" goal behind. This is recorded
here so the reasoning isn't lost — the alternative (lazy thread creation on first
post, bot-mediated-only posting) was fully designed and explicitly rejected in favor
of these two feature decisions.

## Current intent requirements

```js
intents: [
  GatewayIntentBits.Guilds,         // not privileged
  GatewayIntentBits.GuildMembers,   // PRIVILEGED — role-grant detection for thread provisioning
  GatewayIntentBits.GuildMessages,  // not privileged — needed to receive messageCreate at all
  GatewayIntentBits.MessageContent, // PRIVILEGED — reading attachments on native posts
  GatewayIntentBits.DirectMessages, // not privileged — button flow's DM attachment step
],
```

No `GuildPresences` — nothing here needs online/offline status.

## Risk framing (carried over from the VerifyBot review)

Enabling privileged intents does **not** by itself require Discord's review process.
Per `discord-verify-bot`'s own audit trail, that review was triggered specifically by
crossing a **10,000-user threshold** while already using a privileged intent — not by
simply toggling one on. At this bot's current scale, both intents can be enabled
directly in the Developer Portal with no review step. If this bot ever grows enough
to trigger the same review, the exact procedure — including the two failure modes
that came up (missing Privacy Policy/ToS blocking the form, a stale browser auth
token causing a 401 on submit) — is already documented in
`../../discord-verify-bot/docs/privileged-intents-review-2026-08.md`.

## Outstanding

- [ ] Create the Discord application for this bot (not yet done).
- [ ] Toggle **Server Members Intent** and **Message Content Intent** on in the Bot
      tab. (Do *not* follow `discord-verify-bot`'s own "leave everything off" guidance
      verbatim — that applied to its own, different feature set.)
- [ ] Decide whether this bot shares a Privacy Policy/ToS page with `discord-verify-bot`
      or needs its own, if it ever reaches the review threshold.
