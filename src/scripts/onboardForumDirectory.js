// One-time (or re-runnable) backfill for the member-facing Forum directory
// (forumDirectory.js). The normal path (ensureForumPost, called on approval or
// role-grant) never fires for creators who already existed before
// CREATOR_FORUM_CHANNEL_ID was set — no transition happens for them, so this finds
// every creator in the DB (any status, not just ACTIVE role-holders — the whole
// point is one post per creator, filterable by status/content-type tags) and
// provisions + syncs their post directly.
//
// Purely additive and idempotent: ensureForumPost() no-ops if forum_post_id is
// already set and the thread still exists; syncForumPost() just re-applies the
// current tags/lock state either way. Safe to re-run.
// Run standalone: node src/scripts/onboardForumDirectory.js
require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const config = require('../config');
const creatorRepo = require('../db/creatorRepository');
const forumDirectory = require('../services/forumDirectory');
const logger = require('../utils/logger');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});

client.once('clientReady', async () => {
  try {
    if (!config.creatorForumChannelId) throw new Error('CREATOR_FORUM_CHANNEL_ID is not set — nothing to backfill');

    const guild = await client.guilds.fetch(config.guildId);
    const creators = await creatorRepo.listByGuild(config.guildId);
    logger.info(`Found ${creators.length} creators to backfill into the Forum directory.`);

    let done = 0;
    for (const creator of creators) {
      const member = await guild.members.fetch(creator.discord_user_id).catch(() => null);
      await forumDirectory.ensureForumPost(guild, creator, member);
      await forumDirectory.syncForumPost(guild, creator.id);
      done += 1;
      logger.info(`Backfilled ${member?.displayName || `creator #${creator.id}`} (${done}/${creators.length})`);
    }

    logger.info(`Forum directory backfill complete: ${done} creators processed.`);
  } catch (err) {
    logger.error('Forum directory backfill failed:', { error: err.message });
  } finally {
    client.destroy();
    process.exit(0);
  }
});

client.login(process.env.DISCORD_TOKEN);
