const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');

function buildHomeMenu() {
  const embed = new EmbedBuilder()
    .setTitle('🎬 Creator Program')
    .setDescription('Everything creator-related lives here — post content, check your profile, or apply for the role.')
    .setColor(0xE91E8C);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('home_post').setLabel('Post Content').setEmoji('📸').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('home_profile').setLabel('My Profile').setEmoji('👤').setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('home_apply').setLabel('Apply to be a Creator').setEmoji('🎯').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('home_settings').setLabel('My Settings').setEmoji('⚙️').setStyle(ButtonStyle.Secondary),
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('home_directory').setLabel('Browse Creators').setEmoji('🔍').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row1, row2, row3] };
}

// Edits the existing pinned menu if one exists, rather than always posting a new
// one — otherwise re-running this after any future menu change (like adding the
// Browse Creators button) would leave a duplicate pinned message behind.
async function postHomeMenu(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const channel = await interaction.guild.channels.fetch(config.homeChannelId);

  const { items } = await channel.messages.fetchPins(); // fetchPinned() is deprecated; shape differs — {items: [{message}], hasMore}
  const existing = items.find((i) => i.message.author.id === interaction.client.user.id)?.message;
  if (existing) {
    await existing.edit(buildHomeMenu());
    return interaction.editReply({ content: `Home menu refreshed in <#${config.homeChannelId}>.` });
  }

  const message = await channel.send(buildHomeMenu());
  await message.pin().catch(() => {});
  await interaction.editReply({ content: `Home menu posted in <#${config.homeChannelId}>.` });
}

module.exports = { buildHomeMenu, postHomeMenu };
