// One-time (or re-runnable) repair for creator threads whose pinned welcome
// message is stale. The welcome message's content/buttons have changed several
// times as features were added (boundaries button, then the intro button) — a
// thread created under an older version never picks up the update on its own,
// since nothing re-sends a pinned message just because its source template
// changed. Confirmed directly: the 25 creators bulk-onboarded on 2026-09-15 all
// still had the very first, button-less welcome text.
//
// Edits the existing pinned message in place (finds it by author === this bot)
// rather than deleting/recreating the thread — preserves all real thread history,
// touches nothing else. Safe to re-run: editing to identical content is a no-op.
// Run standalone: node src/scripts/refreshWelcomeMessages.js
require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const config = require('../config');
const creatorRepo = require('../db/creatorRepository');
const creatorSpace = require('../services/creatorSpace');
const logger = require('../utils/logger');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});

client.once('clientReady', async () => {
  try {
    const guild = await client.guilds.fetch(config.guildId);
    const creators = await creatorRepo.listByGuild(config.guildId);
    logger.info(`Checking ${creators.length} creators' pinned welcome messages.`);

    let refreshed = 0;
    let skipped = 0;
    for (const creator of creators) {
      if (!creator.thread_id) { skipped += 1; continue; }
      const thread = await guild.channels.fetch(creator.thread_id).catch(() => null);
      if (!thread) { skipped += 1; continue; }

      const member = await guild.members.fetch(creator.discord_user_id).catch(() => null);
      if (!member) { skipped += 1; continue; }

      const { items } = await thread.messages.fetchPins().catch(() => ({ items: [] }));
      const pinned = items.find((i) => i.message.author.id === client.user.id)?.message;
      const fresh = creatorSpace.buildWelcomeMessage(creator, member);

      if (pinned) {
        await pinned.edit(fresh);
      } else {
        // No pinned welcome at all (shouldn't normally happen, but handle it
        // rather than leaving the thread with nothing) — send and pin a fresh one.
        const sent = await thread.send(fresh);
        await sent.pin().catch(() => {});
      }
      refreshed += 1;
      logger.info(`Refreshed welcome message for ${member.displayName} (${refreshed}/${creators.length})`);
    }

    logger.info(`Done: ${refreshed} refreshed, ${skipped} skipped (no thread/member).`);
  } catch (err) {
    logger.error('Welcome message refresh failed:', { error: err.message });
  } finally {
    client.destroy();
    process.exit(0);
  }
});

client.login(process.env.DISCORD_TOKEN);
