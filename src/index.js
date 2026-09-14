require('dotenv').config();

const { Client, GatewayIntentBits, Partials } = require('discord.js');
const fs = require('fs');
const path = require('path');
const logger = require('./utils/logger');

if (!process.env.DISCORD_TOKEN) { logger.error('DISCORD_TOKEN is missing in .env.'); process.exit(1); }
if (!process.env.CLIENT_ID) { logger.error('CLIENT_ID is missing in .env.'); process.exit(1); }
if (!process.env.DATABASE_URL) { logger.error('DATABASE_URL is missing in .env.'); process.exit(1); }
try {
  require('./utils/crypto');
  require('./config');
} catch (err) {
  logger.error(err.message);
  process.exit(1);
}

// Privileged intents: GuildMembers (detects the Creator role being granted, to
// auto-provision a personal thread) and MessageContent (reads attachments on
// posts dropped natively into a creator's thread, so they don't need the bot
// at all to post). Both must be toggled on in the Developer Portal — see SETUP.md.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
});

// Each event handler owns its own try/catch, but this wrapper is a backstop: if any
// handler's returned promise rejects for a reason its own try/catch didn't cover, a
// bare `client.on(event, (...args) => event.execute(...))` would let that surface as
// an unhandled rejection instead of staying scoped to one event. That's what actually
// crashed the whole bot on 2026-09-15 over a single expired interaction token — see
// interactionCreate.js and docs/roadmap.md.
function runHandler(event, args) {
  Promise.resolve(event.execute(...args, client)).catch((err) => {
    logger.error(`Unhandled error in ${event.name} handler:`, { error: err.message });
  });
}

const eventsPath = path.join(__dirname, 'events');
for (const file of fs.readdirSync(eventsPath).filter((f) => f.endsWith('.js'))) {
  const event = require(path.join(eventsPath, file));
  if (event.once) client.once(event.name, (...args) => runHandler(event, args));
  else client.on(event.name, (...args) => runHandler(event, args));
  logger.debug(`Event handler loaded: ${event.name}`);
}

const { initDb } = require('./db/connection');

(async () => {
  try {
    await initDb();
  } catch (err) {
    logger.error('Database initialization failed — bot cannot start:', { error: err.message });
    process.exit(1);
  }

  logger.info('Connecting to Discord...');
  client.login(process.env.DISCORD_TOKEN).catch((err) => {
    logger.error('Login failed. Check your DISCORD_TOKEN in .env:', { error: err.message });
    process.exit(1);
  });
})();

function shutdown(signal) {
  logger.info(`Received ${signal} — shutting down gracefully...`);
  client.destroy();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise Rejection:', { reason: reason?.message || reason });
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception (bot will restart):', err);
  process.exit(1);
});
