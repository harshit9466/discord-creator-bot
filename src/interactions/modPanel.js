const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle,
} = require('discord.js');
const config = require('../config');
const creatorRepo = require('../db/creatorRepository');
const suspensionRepo = require('../db/creatorSuspensionRepository');
const postRepo = require('../db/postRepository');
const reportRepo = require('../db/conductReportRepository');
const requestRepo = require('../db/requestRepository');
const modRoster = require('./modRoster');
const modSettings = require('./modSettings');
const forumDirectory = require('../services/forumDirectory');
const logger = require('../utils/logger');

const STATUS_LABELS = { ACTIVE: '🟢 Active', ON_BREAK: '🟡 On a Break', STEPPED_DOWN: '📦 Archived', SUSPENDED: '🚫 Suspended' };

function buildPanel() {
  const embed = new EmbedBuilder()
    .setTitle('🛡️ Mod Panel')
    .setDescription('Everything creator-program moderation lives here — no need to remember slash commands.')
    .setColor(0xE91E8C);
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('modpanel_roster').setLabel('Creator Roster').setEmoji('📋').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('modpanel_settings').setLabel('Program Settings').setEmoji('⚙️').setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('modpanel_manage').setLabel('Manage a Creator').setEmoji('🔨').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('modpanel_escalated').setLabel('Escalated Reports').setEmoji('🚨').setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row1, row2] };
}

// Posts to whichever channel the command was run in, not a fixed config channel
// like homeMenu.postHomeMenu does — that one has to be HOME_CHANNEL_ID because
// other messages link back to it, but the mod panel has no such constraint, and
// mod-review already carries a constant stream of individual application/report
// cards, so hardcoding it there (the original version of this function) would
// bury the pinned panel under that traffic. Letting mods choose — mod-review,
// a dedicated mod-tools channel, wherever — is just more useful.
//
// Same edit-in-place pattern as homeMenu.postHomeMenu — re-running this in the
// same channel after a future change refreshes the pinned panel there instead of
// leaving a duplicate pinned message behind. Running it in a *different* channel
// intentionally posts a fresh one — moving the panel is a deliberate act, not a
// refresh, so it shouldn't silently edit whatever's pinned elsewhere.
async function postPanel(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const channel = interaction.channel;

  const { items } = await channel.messages.fetchPins();
  const existing = items.find((i) => i.message.author.id === interaction.client.user.id && i.message.embeds[0]?.title === '🛡️ Mod Panel')?.message;
  if (existing) {
    await existing.edit(buildPanel());
    return interaction.editReply({ content: `Mod panel refreshed in <#${channel.id}>.` });
  }

  const message = await channel.send(buildPanel());
  await message.pin().catch(() => {});
  await interaction.editReply({ content: `Mod panel posted in <#${channel.id}>.` });
}

// Routed straight through to the existing standalone handlers — the panel is a
// discoverable front door, not a reimplementation.
async function routeRoster(interaction) {
  return modRoster.postRoster(interaction);
}
async function routeSettings(interaction) {
  return modSettings.postPanel(interaction);
}

async function startManage(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const all = await creatorRepo.listByGuild(interaction.guildId);
  if (all.length === 0) return interaction.editReply({ content: 'No creators yet.' });

  const withNames = await Promise.all(all.map(async (creator) => {
    const member = await interaction.guild.members.fetch(creator.discord_user_id).catch(() => null);
    return { creator, name: member?.displayName || `Creator #${creator.id}` };
  }));

  // Select menus cap at 25 — same simplification as modRoster.js / creatorDirectory.js.
  const options = withNames.slice(0, 25).map(({ creator, name }) => ({
    label: name.slice(0, 100),
    description: (STATUS_LABELS[creator.status] || creator.status).slice(0, 100),
    value: `${creator.id}`,
  }));

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('modpanel_select_creator').setPlaceholder('Pick a creator to manage...').addOptions(options),
  );
  await interaction.editReply({ content: 'Who do you want to manage?', components: [row] });
}

async function buildManageCard(guild, creator) {
  const member = await guild.members.fetch(creator.discord_user_id).catch(() => null);
  const postCount = await postRepo.countByCreator(creator.id);
  const openSuspension = await suspensionRepo.getOpenSuspension(creator.id);
  const history = await suspensionRepo.getHistory(creator.id, 5);

  const embed = new EmbedBuilder()
    .setTitle(member?.displayName || `Creator #${creator.id}`)
    .addFields(
      { name: 'Status', value: STATUS_LABELS[creator.status] || creator.status, inline: true },
      { name: 'Posts', value: `${postCount}`, inline: true },
    )
    .setColor(0xE91E8C);

  if (openSuspension) {
    embed.addFields({
      name: '🚫 Current suspension',
      value: `${openSuspension.reason}\n— by <@${openSuspension.suspended_by}>, ${new Date(openSuspension.suspended_at).toLocaleDateString()}`,
    });
  }
  if (history.length) {
    const lines = history.map((h) => `• ${new Date(h.suspended_at).toLocaleDateString()} — ${h.reason.slice(0, 60)}${h.lifted_at ? ' _(lifted)_' : ' _(active)_'}`);
    embed.addFields({ name: 'Suspension history', value: lines.join('\n') });
  }

  const row = new ActionRowBuilder();
  if (creator.status === 'SUSPENDED') {
    row.addComponents(new ButtonBuilder().setCustomId(`modpanel_lift_${creator.id}`).setLabel('Lift Suspension').setEmoji('✅').setStyle(ButtonStyle.Success));
  } else {
    row.addComponents(new ButtonBuilder().setCustomId(`modpanel_suspend_${creator.id}`).setLabel('Suspend').setEmoji('🚫').setStyle(ButtonStyle.Danger));
  }
  if (creator.status !== 'STEPPED_DOWN') {
    row.addComponents(new ButtonBuilder().setCustomId(`modpanel_archive_${creator.id}`).setLabel('Archive').setEmoji('📦').setStyle(ButtonStyle.Secondary));
  }
  row.addComponents(new ButtonBuilder().setCustomId(`modpanel_delete_start_${creator.id}`).setLabel('Delete').setEmoji('🗑️').setStyle(ButtonStyle.Danger));

  return { content: null, embeds: [embed], components: [row] };
}

async function selectCreator(interaction) {
  await interaction.deferUpdate();
  const creator = await creatorRepo.getCreatorById(Number(interaction.values[0]));
  if (!creator) return interaction.editReply({ content: 'Creator not found.', embeds: [], components: [] });
  await interaction.editReply(await buildManageCard(interaction.guild, creator));
}

async function showSuspendModal(interaction) {
  const creatorId = interaction.customId.split('_')[2];
  const modal = new ModalBuilder().setCustomId(`modpanel_suspendmodal_${creatorId}`).setTitle('Suspend Creator');
  const input = new TextInputBuilder()
    .setCustomId('reason').setLabel('Reason (kept on file for next time)')
    .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

async function handleSuspendSubmit(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const creatorId = Number(interaction.customId.split('_')[2]);
  const reason = interaction.fields.getTextInputValue('reason');
  const creator = await creatorRepo.getCreatorById(creatorId);
  if (!creator) return interaction.editReply({ content: 'Creator not found.' });

  await creatorRepo.suspend(creatorId);
  await suspensionRepo.createSuspension(creatorId, creator.guild_id, reason, interaction.user.id);

  const member = await interaction.guild.members.fetch(creator.discord_user_id).catch(() => null);
  await member?.roles.remove(config.creatorRoleId).catch((err) => logger.error(`Role removal failed: ${err.message}`));
  if (creator.thread_id) {
    const thread = await interaction.guild.channels.fetch(creator.thread_id).catch(() => null);
    await thread?.setArchived(true).catch(() => {});
  }
  await forumDirectory.syncForumPost(interaction.guild, creatorId).catch((err) => logger.warn(`Forum sync failed: ${err.message}`));
  try {
    const user = await interaction.client.users.fetch(creator.discord_user_id);
    await user.send(`🚫 You've been suspended as a creator.\n**Reason:** ${reason}\n\nA mod needs to lift this before you can be reactivated.`);
  } catch (err) { logger.warn(`Could not DM suspended creator: ${err.message}`); }

  const updated = await creatorRepo.getCreatorById(creatorId);
  await interaction.editReply(await buildManageCard(interaction.guild, updated));
}

async function liftSuspension(interaction) {
  await interaction.deferUpdate();
  const creatorId = Number(interaction.customId.split('_')[2]);
  const creator = await creatorRepo.getCreatorById(creatorId);
  if (!creator) return interaction.editReply({ content: 'Creator not found.', embeds: [], components: [] });

  const open = await suspensionRepo.getOpenSuspension(creatorId);
  if (open) await suspensionRepo.liftSuspension(open.id, interaction.user.id);
  await creatorRepo.reactivate(creatorId);

  const member = await interaction.guild.members.fetch(creator.discord_user_id).catch(() => null);
  await member?.roles.add(config.creatorRoleId).catch((err) => logger.error(`Role add failed: ${err.message}`));
  if (creator.thread_id) {
    const thread = await interaction.guild.channels.fetch(creator.thread_id).catch(() => null);
    await thread?.setArchived(false).catch(() => {});
  }
  await forumDirectory.syncForumPost(interaction.guild, creatorId).catch((err) => logger.warn(`Forum sync failed: ${err.message}`));
  try {
    const user = await interaction.client.users.fetch(creator.discord_user_id);
    await user.send("✅ Your suspension has been lifted — you're an active creator again.");
  } catch (err) { logger.warn(`Could not DM unsuspended creator: ${err.message}`); }

  const updated = await creatorRepo.getCreatorById(creatorId);
  await interaction.editReply(await buildManageCard(interaction.guild, updated));
}

async function archiveCreator(interaction) {
  await interaction.deferUpdate();
  const creatorId = Number(interaction.customId.split('_')[2]);
  const creator = await creatorRepo.getCreatorById(creatorId);
  if (!creator) return interaction.editReply({ content: 'Creator not found.', embeds: [], components: [] });

  await creatorRepo.stepDown(creatorId, 'ARCHIVE');
  const member = await interaction.guild.members.fetch(creator.discord_user_id).catch(() => null);
  await member?.roles.remove(config.creatorRoleId).catch((err) => logger.error(`Role removal failed: ${err.message}`));
  if (creator.thread_id) {
    const thread = await interaction.guild.channels.fetch(creator.thread_id).catch(() => null);
    await thread?.setArchived(true).catch(() => {});
  }
  await forumDirectory.syncForumPost(interaction.guild, creatorId).catch((err) => logger.warn(`Forum sync failed: ${err.message}`));
  try {
    const user = await interaction.client.users.fetch(creator.discord_user_id);
    await user.send('📦 A mod archived your creator profile. Everything is kept — you can reactivate anytime from My Settings.');
  } catch (err) { logger.warn(`Could not DM archived creator: ${err.message}`); }

  const updated = await creatorRepo.getCreatorById(creatorId);
  await interaction.editReply(await buildManageCard(interaction.guild, updated));
}

// Delete is irreversible — same second-confirmation pattern as the creator's own
// self-service Step Down > Delete in statusFlow.js.
async function startDelete(interaction) {
  const creatorId = interaction.customId.split('_')[3];
  await interaction.update({
    content: "⚠️ This permanently deletes this creator's posts and can't be undone. Are you sure?",
    embeds: [],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`modpanel_delete_final_${creatorId}`).setLabel('Yes, delete everything').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`modpanel_delete_cancel_${creatorId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    )],
  });
}

async function cancelDelete(interaction) {
  await interaction.deferUpdate();
  const creatorId = Number(interaction.customId.split('_')[3]);
  const creator = await creatorRepo.getCreatorById(creatorId);
  if (!creator) return interaction.editReply({ content: 'Creator not found.', embeds: [], components: [] });
  await interaction.editReply(await buildManageCard(interaction.guild, creator));
}

async function deleteFinal(interaction) {
  await interaction.deferUpdate();
  const creatorId = Number(interaction.customId.split('_')[3]);
  const creator = await creatorRepo.getCreatorById(creatorId);
  if (!creator) return interaction.editReply({ content: 'Creator not found.', embeds: [], components: [] });

  const member = await interaction.guild.members.fetch(creator.discord_user_id).catch(() => null);
  await member?.roles.remove(config.creatorRoleId).catch((err) => logger.error(`Role removal failed: ${err.message}`));
  if (creator.thread_id) {
    const thread = await interaction.guild.channels.fetch(creator.thread_id).catch(() => null);
    await thread?.delete().catch(() => {});
  }
  await forumDirectory.deleteForumPost(interaction.guild, creator).catch((err) => logger.warn(`Forum post delete failed: ${err.message}`));
  try {
    const user = await interaction.client.users.fetch(creator.discord_user_id);
    await user.send('🗑️ A mod removed your creator profile and content.');
  } catch (err) { logger.warn(`Could not DM deleted creator: ${err.message}`); }

  await creatorRepo.deleteCreator(creatorId); // cascades posts/requests/suspensions

  await interaction.editReply({ content: `${member?.displayName || 'Creator'} removed — their content is gone.`, embeds: [], components: [] });
}

// Escalate previously had no follow-through: clicking it on a report card just set
// status='ESCALATED' and nothing else ever surfaced it again. This is that missing
// piece — a live, always-current list of unresolved escalations, oldest first, so
// nothing quietly gets forgotten. Falls back to a raw Discord username if the
// reported member already left/was removed from the server (a real possibility —
// escalation often means a mod kicked or banned them outside the bot).
async function resolveDisplayName(guild, discordUserId) {
  const member = await guild.members.fetch(discordUserId).catch(() => null);
  if (member) return member.displayName;
  const user = await guild.client.users.fetch(discordUserId).catch(() => null);
  return user?.tag || `User ${discordUserId}`;
}

async function startEscalated(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const escalated = await reportRepo.listByStatus(interaction.guildId, 'ESCALATED');
  if (escalated.length === 0) {
    return interaction.editReply({ content: '✅ No escalated reports right now.' });
  }

  const withNames = await Promise.all(escalated.map(async (report) => ({
    report,
    name: await resolveDisplayName(interaction.guild, report.reported_discord_id),
  })));

  const embed = new EmbedBuilder()
    .setTitle('🚨 Escalated Reports')
    .setDescription(withNames.map(({ report, name }) => `• **${name}** — escalated ${new Date(report.created_at).toLocaleDateString()}`).join('\n'))
    .setFooter({ text: 'Oldest first. Pick one below to see full details and mark it resolved.' })
    .setColor(0xE0245E);

  // Select menus cap at 25 — same simplification as elsewhere in this file.
  const options = withNames.slice(0, 25).map(({ report, name }) => ({
    label: `${name} — ${new Date(report.created_at).toLocaleDateString()}`.slice(0, 100),
    value: `${report.id}`,
  }));
  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('modpanel_select_escalated').setPlaceholder('View a report...').addOptions(options),
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}

async function buildEscalatedDetail(guild, report) {
  const reportedName = await resolveDisplayName(guild, report.reported_discord_id);
  const embed = new EmbedBuilder()
    .setTitle(`🚨 Report on ${reportedName}`)
    .addFields(
      { name: 'Reported', value: `<@${report.reported_discord_id}>`, inline: true },
      { name: 'Reporter', value: `<@${report.reporter_discord_id}>`, inline: true },
      { name: 'Escalated', value: new Date(report.created_at).toLocaleString() },
    )
    .setColor(0xE0245E);

  // Requests are encrypted at rest everywhere else — decrypted here specifically
  // because a mod resolving an escalation needs to see what was actually sent,
  // same reasoning as reports.postReportCard.
  if (report.request_id) {
    const request = await requestRepo.getRequest(report.request_id);
    if (request) embed.addFields({ name: 'Original request', value: request.text.slice(0, 1000) });
  }
  if (report.context) embed.addFields({ name: 'Reported message', value: report.context.slice(0, 1000) });
  if (report.reason) embed.addFields({ name: 'Reason given', value: report.reason.slice(0, 500) });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`modpanel_resolve_${report.id}`).setLabel('Mark Resolved').setEmoji('✅').setStyle(ButtonStyle.Success),
  );
  return { embeds: [embed], components: [row] };
}

async function selectEscalated(interaction) {
  await interaction.deferUpdate();
  const report = await reportRepo.getReport(Number(interaction.values[0]));
  if (!report) return interaction.editReply({ content: 'Report not found.', embeds: [], components: [] });
  await interaction.editReply(await buildEscalatedDetail(interaction.guild, report));
}

// Deliberately no DM here — by the time something reaches Resolved, the mod has
// already handled it manually outside the bot (kick/ban/timeout), which is the
// entire point of Escalate over Warn/Restrict. This just closes the loop so it
// stops showing up in the list above.
async function resolveEscalated(interaction) {
  await interaction.deferUpdate();
  const reportId = Number(interaction.customId.split('_')[2]);
  await reportRepo.updateStatus(reportId, 'RESOLVED', interaction.user.id);
  await interaction.editReply({ content: '✅ Marked resolved.', embeds: [], components: [] });
}

module.exports = {
  postPanel, routeRoster, routeSettings, startManage, selectCreator, showSuspendModal, handleSuspendSubmit,
  liftSuspension, archiveCreator, startDelete, cancelDelete, deleteFinal,
  startEscalated, selectEscalated, resolveEscalated,
};
