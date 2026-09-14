// One-time (or re-runnable) bulk onboarding for members who already held the
// Creator role before this bot existed. The normal path (guildMemberUpdate
// detecting the role being newly granted) never fires for them, since no
// transition ever happens — they already have it. This finds everyone currently
// holding CREATOR_ROLE_ID and provisions their thread + DB row directly.
//
// Purely additive: ensureCreatorThread() is idempotent, and this never touches
// existing individual channels or their content — that migration/retirement
// decision is deliberately left to a human, not automated here.
// Run standalone: node src/scripts/onboardExistingCreators.js
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
    const role = await guild.roles.fetch(config.creatorRoleId);
    if (!role) throw new Error('Creator role not found — check CREATOR_ROLE_ID');

    // role.members reads from the member cache, which needs an explicit bulk
    // fetch first (this is exactly the kind of bulk member request the Guild
    // Members privileged intent exists for).
    await guild.members.fetch();

    const members = [...role.members.values()];
    logger.info(`Found ${members.length} existing members with the Creator role.`);

    let onboarded = 0;
    for (const member of members) {
      const { creator } = await creatorSpace.ensureCreatorThread(guild, member);
      if (!creator.approved_at) await creatorRepo.markApproved(creator.id);
      onboarded += 1;
      logger.info(`Onboarded ${member.displayName} (${onboarded}/${members.length})`);
    }

    logger.info(`Onboarding complete: ${onboarded} creators provisioned.`);
  } catch (err) {
    logger.error('Onboarding failed:', { error: err.message });
  } finally {
    client.destroy();
    process.exit(0);
  }
});

client.login(process.env.DISCORD_TOKEN);
