const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const guildSettingsRepo = require('../db/guildSettingsRepository');

function buildPanel(settings) {
  const trackedMentions = guildSettingsRepo.trackedChannelIds(settings).map((id) => `<#${id}>`).join(', ') || '_none set_';
  const policyPreview = settings.creator_policy
    ? `${settings.creator_policy.slice(0, 200)}${settings.creator_policy.length > 200 ? '…' : ''}`
    : '_Not set_';

  const embed = new EmbedBuilder()
    .setTitle('⚙️ Creator Program Settings')
    .addFields(
      { name: 'Min tracked posts', value: `${settings.eligibility_min_posts}`, inline: true },
      { name: 'Min tenure', value: `${settings.eligibility_min_tenure_days} days`, inline: true },
      { name: 'Tracked channels', value: trackedMentions },
      { name: 'Policy (preview)', value: policyPreview },
    )
    .setColor(0xE91E8C);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('modsettings_edit_eligibility').setLabel('Edit Eligibility').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('modsettings_edit_policy').setLabel('Edit Policy').setEmoji('📄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('modsettings_view_policy').setLabel('View Full Policy').setEmoji('👁️').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

async function postPanel(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const settings = await guildSettingsRepo.getSettings(interaction.guildId);
  await interaction.editReply(buildPanel(settings));
}

async function viewFullPolicy(interaction) {
  const settings = await guildSettingsRepo.getSettings(interaction.guildId);
  const embed = new EmbedBuilder()
    .setTitle('📄 Creator Policy (full text)')
    .setDescription(settings.creator_policy || '_Not set_')
    .setColor(0xE91E8C);
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function showEligibilityModal(interaction) {
  const settings = await guildSettingsRepo.getSettings(interaction.guildId);
  const modal = new ModalBuilder().setCustomId('modsettings_eligibility_modal').setTitle('Edit Eligibility Rules');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('min_posts').setLabel('Minimum tracked posts')
        .setStyle(TextInputStyle.Short).setValue(`${settings.eligibility_min_posts}`).setRequired(true),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('min_tenure').setLabel('Minimum tenure (days)')
        .setStyle(TextInputStyle.Short).setValue(`${settings.eligibility_min_tenure_days}`).setRequired(true),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('channel_ids').setLabel('Tracked channel IDs (comma-separated)')
        .setStyle(TextInputStyle.Paragraph)
        .setValue(guildSettingsRepo.trackedChannelIds(settings).join(','))
        .setRequired(false),
    ),
  );
  await interaction.showModal(modal);
}

async function handleEligibilitySubmit(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const minPostsRaw = interaction.fields.getTextInputValue('min_posts').trim();
  const minTenureRaw = interaction.fields.getTextInputValue('min_tenure').trim();
  const channelIdsRaw = interaction.fields.getTextInputValue('channel_ids').trim();

  const minPosts = Number(minPostsRaw);
  const minTenureDays = Number(minTenureRaw);
  if (!Number.isInteger(minPosts) || minPosts < 0 || !Number.isInteger(minTenureDays) || minTenureDays < 0) {
    return interaction.editReply({ content: `Both values need to be whole numbers ≥ 0 — got "${minPostsRaw}" and "${minTenureRaw}".` });
  }

  const trackedChannelIds = channelIdsRaw.split(',').map((s) => s.trim()).filter(Boolean);
  const badIds = trackedChannelIds.filter((id) => !/^\d{17,20}$/.test(id));
  if (badIds.length) {
    return interaction.editReply({ content: `These don't look like valid channel IDs: ${badIds.join(', ')}` });
  }

  const settings = await guildSettingsRepo.updateEligibility(
    interaction.guildId,
    { minPosts, minTenureDays, trackedChannelIds },
    interaction.user.id,
  );
  await interaction.editReply(buildPanel(settings));
}

async function showPolicyModal(interaction) {
  const settings = await guildSettingsRepo.getSettings(interaction.guildId);
  const modal = new ModalBuilder().setCustomId('modsettings_policy_modal').setTitle('Edit Creator Policy');
  const input = new TextInputBuilder()
    .setCustomId('policy')
    .setLabel('Policy text — shown to every applicant')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(4000)
    .setRequired(true)
    .setValue(settings.creator_policy || '');
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

async function handlePolicySubmit(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const policy = interaction.fields.getTextInputValue('policy');
  const settings = await guildSettingsRepo.updatePolicy(interaction.guildId, policy, interaction.user.id);
  await interaction.editReply(buildPanel(settings));
}

module.exports = {
  postPanel, viewFullPolicy, showEligibilityModal, handleEligibilitySubmit, showPolicyModal, handlePolicySubmit,
};
