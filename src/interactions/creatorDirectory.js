const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const creatorRepo = require('../db/creatorRepository');
const profile = require('./profile');

// Member-facing browse-all-creators surface. creator-spaces threads stay
// creator-only by design (see docs/), so this — built entirely from Feed-visible
// data — is the only real discovery path members have beyond scrolling the Feed
// chronologically.
async function postDirectory(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const all = await creatorRepo.listByGuild(interaction.guildId);
  const active = all.filter((c) => c.status === 'ACTIVE');

  if (active.length === 0) {
    return interaction.editReply({ content: 'No active creators right now — check back soon!' });
  }

  const withNames = await Promise.all(active.map(async (creator) => {
    const member = await interaction.guild.members.fetch(creator.discord_user_id).catch(() => null);
    return { creator, name: member?.displayName || `Creator #${creator.id}` };
  }));

  const lines = withNames.map(({ creator, name }) => {
    const requests = creator.requests_open ? 'Requests Open' : 'Requests Closed';
    return `• **${name}** — ${creator.default_content_type} · ${requests}`;
  });

  const embed = new EmbedBuilder()
    .setTitle('🔍 Creator Directory')
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Pick a name below to view their profile and recent posts' })
    .setColor(0xE91E8C);

  // Select menus cap at 25 options — fine at this community's current size
  // (matches the same simplification already made in modRoster.js), revisit with
  // real pagination if the active roster grows past 25.
  const options = withNames.slice(0, 25).map(({ creator, name }) => ({
    label: name.slice(0, 100),
    value: `${creator.id}`,
  }));

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('directory_select').setPlaceholder('View a creator\'s profile...').addOptions(options),
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}

async function handleSelect(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const creator = await creatorRepo.getCreatorById(Number(interaction.values[0]));
  if (!creator) return interaction.editReply({ content: 'Creator not found.' });
  await interaction.editReply(await profile.buildProfilePage(interaction.guild, creator, 0));
}

module.exports = { postDirectory, handleSelect };
