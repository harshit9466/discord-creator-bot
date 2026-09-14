// One-off recovery: posts the mod review card for an application whose DB write
// succeeded but whose card never got posted (see the duplicate-process incident,
// docs/roadmap.md, 2026-09-15). Usage: node src/scripts/postMissingModCard.js <applicationId>
require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const config = require('../config');
const applicationRepo = require('../db/applicationRepository');
const applyFlow = require('../interactions/applyFlow');
const logger = require('../utils/logger');

const applicationId = Number(process.argv[2]);
if (!applicationId) {
  console.error('Usage: node src/scripts/postMissingModCard.js <applicationId>');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async () => {
  try {
    const application = await applicationRepo.getApplication(applicationId);
    if (!application) throw new Error(`No application with id ${applicationId}`);
    if (application.mod_message_id) throw new Error(`Application ${applicationId} already has a mod card (message ${application.mod_message_id}) — not re-posting`);

    const guild = await client.guilds.fetch(config.guildId);
    await applyFlow.postModCard(guild, application);
    logger.info(`Mod card posted for application ${applicationId}.`);
  } catch (err) {
    logger.error('Failed to post mod card:', { error: err.message });
  } finally {
    client.destroy();
    process.exit(0);
  }
});

client.login(process.env.DISCORD_TOKEN);
