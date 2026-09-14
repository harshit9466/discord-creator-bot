require('dotenv').config();
const {
  REST, Routes, SlashCommandBuilder, PermissionFlagsBits, ContextMenuCommandBuilder, ApplicationCommandType,
} = require('discord.js');
const logger = require('./utils/logger');

const commands = [
  new SlashCommandBuilder()
    .setName('setup-creator-hub')
    .setDescription('Post the creator program home menu in the configured channel (mods only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),
  new SlashCommandBuilder()
    .setName('creator-roster')
    .setDescription('View all creators, their status, and inactivity flags (mods only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),
  new SlashCommandBuilder()
    .setName('creator-settings')
    .setDescription('View or edit eligibility rules and the creator policy (mods only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),
  new ContextMenuCommandBuilder()
    .setName('Report Message')
    .setType(ApplicationCommandType.Message)
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands },
    );
    logger.info('Slash commands registered.');
  } catch (err) {
    logger.error('Command registration failed:', { error: err.message });
    process.exit(1);
  }
})();
