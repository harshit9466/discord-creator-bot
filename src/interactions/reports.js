const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder,
} = require('discord.js');
const config = require('../config');
const requestRepo = require('../db/requestRepository');
const reportRepo = require('../db/conductReportRepository');
const restrictedRepo = require('../db/restrictedMemberRepository');
const logger = require('../utils/logger');

async function startFromRequest(interaction) {
  const requestId = Number(interaction.customId.split('_')[1]);
  const modal = new ModalBuilder().setCustomId(`reqreportmodal_${requestId}`).setTitle('Report this request');
  const input = new TextInputBuilder()
    .setCustomId('reason')
    .setLabel('What happened? (optional)')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(500);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

// Modal submission — decrypt + write + post to the mod channel, defer first.
async function handleRequestReportModal(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const requestId = Number(interaction.customId.split('_')[1]);
  const reason = interaction.fields.getTextInputValue('reason');
  const request = await requestRepo.getRequest(requestId);
  if (!request) return interaction.editReply({ content: 'Request not found.' });

  const report = await reportRepo.createReport({
    reportedDiscordId: request.requester_discord_id,
    reporterDiscordId: interaction.user.id,
    guildId: request.guild_id,
    requestId,
    reason,
  });

  await postReportCard(interaction.client, report, request.text);
  await interaction.editReply({ content: 'Report sent to the mod team. Thank you.' });
}

// Native "Report Message" context-menu command — works on any message, not just
// requests. This is its own interaction with the same 3-second clock, defer first.
async function startFromMessage(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const target = interaction.targetMessage;
  const report = await reportRepo.createReport({
    reportedDiscordId: target.author.id,
    reporterDiscordId: interaction.user.id,
    guildId: interaction.guildId,
    context: target.content?.slice(0, 1000) || '_(no text content)_',
  });
  await postReportCard(interaction.client, report, null);
  await interaction.editReply({ content: 'Report sent to the mod team. Thank you.' });
}

async function postReportCard(client, report, contextText) {
  const { totalReports, distinctReporters } = await reportRepo.countReportsAgainst(report.reported_discord_id, report.guild_id);
  const guild = await client.guilds.fetch(report.guild_id);
  const channel = await guild.channels.fetch(config.modReviewChannelId);

  const embed = new EmbedBuilder()
    .setTitle('🚩 Conduct Report')
    .addFields(
      { name: 'Reported', value: `<@${report.reported_discord_id}>`, inline: true },
      { name: 'Reporter', value: `<@${report.reporter_discord_id}>`, inline: true },
      {
        name: 'History',
        value: distinctReporters > 1
          ? `⚠️ ${totalReports} reports from ${distinctReporters} different people`
          : `${totalReports} report(s) total`,
      },
    )
    .setColor(0xE0245E);
  if (contextText) embed.addFields({ name: 'Context', value: contextText.slice(0, 1000) });
  if (report.context) embed.addFields({ name: 'Reported message', value: report.context.slice(0, 1000) });
  if (report.reason) embed.addFields({ name: 'Reason given', value: report.reason.slice(0, 500) });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`modrep_warn_${report.id}`).setLabel('Warn').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`modrep_restrict_${report.id}`).setLabel('Restrict Requests').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`modrep_escalate_${report.id}`).setLabel('Escalate').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`modrep_dismiss_${report.id}`).setLabel('Dismiss').setStyle(ButtonStyle.Secondary),
  );

  const message = await channel.send({ embeds: [embed], components: [row] });
  await reportRepo.setModMessageId(report.id, message.id);
}

// Warn/Restrict/Dismiss are handled here directly. Escalate deliberately stops at
// marking the report — kicks/bans stay a manual, human moderator decision, never
// automated by this bot. Button interaction — deferUpdate() first, same reasoning
// as applyFlow.handleModDecision.
async function handleModAction(interaction) {
  await interaction.deferUpdate();

  const [, action, reportIdStr] = interaction.customId.split('_');
  const reportId = Number(reportIdStr);
  const report = await reportRepo.getReport(reportId);
  if (!report) return interaction.followUp({ content: 'Report not found.', ephemeral: true });

  const statusMap = { warn: 'WARNED', restrict: 'RESTRICTED', escalate: 'ESCALATED', dismiss: 'DISMISSED' };
  const status = statusMap[action];
  await reportRepo.updateStatus(reportId, status, interaction.user.id);

  if (action === 'restrict') {
    await restrictedRepo.restrict(report.reported_discord_id, report.guild_id, interaction.user.id);
  }

  if (action === 'warn' || action === 'restrict') {
    try {
      const user = await interaction.client.users.fetch(report.reported_discord_id);
      const dm = await user.createDM();
      const msg = action === 'warn'
        ? "A moderator reviewed a report about your recent conduct and issued a warning. Please review the server's request guidelines."
        : 'A moderator has restricted your ability to send requests to creators, following a conduct report. Contact a mod if you believe this is a mistake.';
      await dm.send(msg);
    } catch (err) {
      logger.warn(`Could not DM ${report.reported_discord_id} about mod action: ${err.message}`);
    }
  }

  await interaction.editReply({
    content: `Marked **${status}** by ${interaction.user.tag}.`,
    embeds: interaction.message.embeds,
    components: [],
  });
}

module.exports = { startFromRequest, handleRequestReportModal, startFromMessage, handleModAction };
