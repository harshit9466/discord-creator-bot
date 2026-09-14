# Creator Bot — Setup (Phase 1 + 1.5 + 2)

Gives you: a persistent home-menu message, a personal thread per creator (created
the moment they get the Creator role), two ways to post — drop a file directly in
that thread, or use the guided button flow — both landing in the creator's thread
*and* the public feed, per-post likes, a basic profile view, eligibility-gated
applications (with mod approve/deny), boundaries-first consent-gated requests
(encrypted), and a conduct-report system (Warn/Restrict/Escalate/Dismiss). The
break/step-down self-service flows and the mod roster/inactivity panel are the only
things still not built — the DB schema already has room for them. See
`docs/roadmap.md` for the full picture and `docs/intents-and-compliance.md` for why
this needs two privileged intents.

## 1. Create the Discord application

1. https://discord.com/developers/applications → New Application → name it (e.g. "Creator Bot").
2. **Bot** tab → Reset Token → copy it into `.env` as `DISCORD_TOKEN`.
3. On the same tab, toggle **Server Members Intent** and **Message Content Intent**
   ON. Leave **Presence Intent** off — nothing here needs it. See
   `docs/intents-and-compliance.md` for exactly why the first two are needed and why
   this is lower-risk than it might sound.
4. **General Information** tab → copy the Application ID into `.env` as `CLIENT_ID`.
5. **OAuth2 → URL Generator** → scopes: `bot`, `applications.commands`.
   Bot permissions: Send Messages, Embed Links, Attach Files, Create Public
   Threads, Read Message History, Manage Messages (for pinning the home menu).
   Open the generated URL, invite it to your server.

## 2. Set up the database

Any Postgres works (Railway, Neon, local Docker). Set `DATABASE_URL` in `.env`.
`DB_CLIENT` defaults to `pg`. To switch engines later: change `DB_CLIENT` to
`mysql2` or `sqlite3`, `npm install` the matching driver package, update
`DATABASE_URL` — no code changes.

## 3. Fill in `.env`

Copy `.env.example` to `.env` and fill in:
- `GUILD_ID` — your server's ID (right-click server icon → Copy Server ID; enable Developer Mode first).
- `HOME_CHANNEL_ID` — channel where the persistent menu should live.
- `FEED_CHANNEL_ID` — channel where published posts appear.
- `CREATOR_SPACES_CHANNEL_ID` — parent text channel under which each creator's
  personal thread gets created (e.g. `🎥│creator-spaces`). Create this channel first.
- `CREATOR_ROLE_ID` — the Pornstar/Creator role ID.
- `MOD_ROLE_ID` — your mod role ID (not yet enforced beyond the slash command's built-in `ManageGuild` permission check, but wire it up now).
- `MOD_REVIEW_CHANNEL_ID` — private mod-only channel where applications and conduct reports land.
- `ELIGIBILITY_MIN_POSTS`, `ELIGIBILITY_MIN_TENURE_DAYS`, `ELIGIBILITY_TRACKED_CHANNEL_IDS`
  — Apply-to-be-a-Creator thresholds. Tracked channel IDs are comma-separated; leave
  blank and nothing counts toward eligibility (everyone stays ineligible until set).
- `ENCRYPTION_KEY` — generate with:
  ```
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
  Back this up in a password manager immediately — it's not recoverable if lost.

## 4. Install, register commands, run

```bash
npm install
npm run deploy-commands
npm start
```

Then, in Discord, run `/setup-creator-hub` once (mods only) in any channel —
it posts and pins the home menu in `HOME_CHANNEL_ID`.

## What's next (not built yet)

See `docs/roadmap.md` for the full breakdown — Phase 3: break/step-down self-service
status changes, mod roster + inactivity flags.
