// One-time (or re-runnable) backfill: scans the full message history of every
// ELIGIBILITY_TRACKED_CHANNEL_IDS channel and sets accurate tracked_post_count
// baselines, so eligibility isn't blind to activity that predates the bot.
// Safe to re-run — each run recomputes exact totals from a fresh scan (setPostCount,
// not increment), so it can't double-count. Run standalone: node src/scripts/backfillActivity.js
require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const config = require('../config');
const memberActivityRepo = require('../db/memberActivityRepository');
const logger = require('../utils/logger');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel, Partials.Message],
});

client.once('clientReady', async () => {
  try {
    const guild = await client.guilds.fetch(config.guildId);
    const counts = new Map(); // userId -> count

    for (const channelId of config.eligibilityTrackedChannelIds) {
      const channel = await guild.channels.fetch(channelId);
      logger.info(`Scanning #${channel.name}...`);
      let before;
      let scanned = 0;

      for (;;) {
        const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        if (batch.size === 0) break;
        for (const msg of batch.values()) {
          if (msg.author.bot) continue;
          counts.set(msg.author.id, (counts.get(msg.author.id) || 0) + 1);
        }
        scanned += batch.size;
        before = batch.last().id;
        if (batch.size < 100) break;
      }
      logger.info(`#${channel.name}: scanned ${scanned} messages`);
    }

    logger.info(`Writing baseline counts for ${counts.size} members...`);
    for (const [userId, count] of counts) {
      await memberActivityRepo.setPostCount(userId, config.guildId, count);
    }

    logger.info('Backfill complete.');
  } catch (err) {
    logger.error('Backfill failed:', { error: err.message });
  } finally {
    client.destroy();
    process.exit(0);
  }
});

client.login(process.env.DISCORD_TOKEN);
