// One-off recovery for the 2026-09-15 findOrCreateCreator race (see docs/): a
// creator row exists with thread_id null because ensureCreatorThread crashed
// mid-provision. Safe to run — ensureCreatorThread is idempotent.
// Usage: node src/scripts/fixMissingThread.js <discordUserId>
require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const config = require('../config');
const creatorSpace = require('../services/creatorSpace');
const logger = require('../utils/logger');

const discordUserId = process.argv[2];
if (!discordUserId) {
  console.error('Usage: node src/scripts/fixMissingThread.js <discordUserId>');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});

client.once('clientReady', async () => {
  try {
    const guild = await client.guilds.fetch(config.guildId);
    const member = await guild.members.fetch(discordUserId);
    const { thread } = await creatorSpace.ensureCreatorThread(guild, member);
    logger.info(`Thread ready for ${member.displayName}: ${thread.id}`);
  } catch (err) {
    logger.error('Failed:', { error: err.message });
  } finally {
    client.destroy();
    process.exit(0);
  }
});

client.login(process.env.DISCORD_TOKEN);
