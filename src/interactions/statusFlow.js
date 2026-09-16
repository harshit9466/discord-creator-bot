const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const creatorRepo = require('../db/creatorRepository');
const forumDirectory = require('../services/forumDirectory');
const logger = require('../utils/logger');

const DURATIONS = {
  '1w': { label: '1 week', ms: 7 * 24 * 60 * 60 * 1000 },
  '2w': { label: '2 weeks', ms: 14 * 24 * 60 * 60 * 1000 },
  '1m': { label: '1 month', ms: 30 * 24 * 60 * 60 * 1000 },
  none: { label: 'Not sure yet', ms: null },
};

function durationButtons(customIdPrefix) {
  return new ActionRowBuilder().addComponents(
    ...Object.entries(DURATIONS).map(([code, { label }]) => new ButtonBuilder()
      .setCustomId(`${customIdPrefix}_${code}`)
      .setLabel(label)
      .setStyle(ButtonStyle.Secondary)),
  );
}

// --- Take a Break ---

async function startBreak(interaction) {
  await interaction.reply({
    content: 'How long do you need?',
    components: [durationButtons('break_dur')],
    ephemeral: true,
  });
}

async function setBreakDuration(interaction) {
  await interaction.deferUpdate();
  const code = interaction.customId.split('_')[2];
  const { ms, label } = DURATIONS[code];
  const returnAt = ms ? new Date(Date.now() + ms) : null;

  const creator = await creatorRepo.getCreatorByDiscordId(interaction.user.id, interaction.guildId);
  if (!creator) return interaction.editReply({ content: 'No creator profile found.', components: [] });
  await creatorRepo.setOnBreak(creator.id, returnAt);
  await forumDirectory.syncForumPost(interaction.guild, creator.id).catch((err) => logger.warn(`Forum sync failed: ${err.message}`));

  await interaction.editReply({
    content: returnAt
      ? `🟡 You're on a break — I'll check in with you in ${label}. Requests are paused, your content stays visible.`
      : "🟡 You're on a break, no return date set — I'll check in with you occasionally. Requests are paused, your content stays visible.",
    components: [],
  });
}

// --- Step Down ---

async function startStepDown(interaction) {
  await interaction.reply({
    content: 'Before you go — what should happen to your posts?',
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('stepdown_archive').setLabel('Archive').setEmoji('📦').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('stepdown_delete_confirm').setLabel('Delete').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('stepdown_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    )],
    ephemeral: true,
  });
}

async function cancelStepDown(interaction) {
  await interaction.update({ content: 'Cancelled — nothing changed.', components: [] });
}

async function archiveStepDown(interaction) {
  await interaction.deferUpdate();
  const creator = await creatorRepo.getCreatorByDiscordId(interaction.user.id, interaction.guildId);
  if (!creator) return interaction.editReply({ content: 'No creator profile found.', components: [] });

  await creatorRepo.stepDown(creator.id, 'ARCHIVE');
  await interaction.member.roles.remove(config.creatorRoleId).catch((err) => logger.error(`Role removal failed: ${err.message}`));
  if (creator.thread_id) {
    const thread = await interaction.guild.channels.fetch(creator.thread_id).catch(() => null);
    await thread?.setArchived(true).catch(() => {});
  }
  await forumDirectory.syncForumPost(interaction.guild, creator.id).catch((err) => logger.warn(`Forum sync failed: ${err.message}`));

  await interaction.editReply({
    content: '📦 Archived. Everything is kept — reactivate anytime from My Settings and it all comes back.',
    components: [],
  });
}

// Second confirmation — delete is irreversible, this deserves an extra click.
async function confirmDelete(interaction) {
  await interaction.update({
    content: "⚠️ This permanently deletes all your posts and can't be undone. Are you sure?",
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('stepdown_delete_final').setLabel('Yes, delete everything').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('stepdown_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    )],
  });
}

async function deleteStepDown(interaction) {
  await interaction.deferUpdate();
  const creator = await creatorRepo.getCreatorByDiscordId(interaction.user.id, interaction.guildId);
  if (!creator) return interaction.editReply({ content: 'No creator profile found.', components: [] });

  await interaction.member.roles.remove(config.creatorRoleId).catch((err) => logger.error(`Role removal failed: ${err.message}`));
  if (creator.thread_id) {
    const thread = await interaction.guild.channels.fetch(creator.thread_id).catch(() => null);
    await thread?.delete().catch(() => {});
  }
  await forumDirectory.deleteForumPost(interaction.guild, creator).catch((err) => logger.warn(`Forum post delete failed: ${err.message}`));
  await creatorRepo.deleteCreator(creator.id); // cascades: posts, likes, requests all go with it

  await interaction.editReply({
    content: "🗑️ Done — everything's been deleted. If you come back later, it's a fresh start.",
    components: [],
  });
}

// --- Reactivate (from either On a Break or archived Step Down) ---

async function reactivate(interaction) {
  await interaction.deferUpdate();
  const creator = await creatorRepo.getCreatorByDiscordId(interaction.user.id, interaction.guildId);
  if (!creator) return interaction.editReply({ content: 'No creator profile found.', components: [] });

  const wasArchived = creator.status === 'STEPPED_DOWN';
  await creatorRepo.reactivate(creator.id);

  if (wasArchived) {
    await interaction.member.roles.add(config.creatorRoleId).catch((err) => logger.error(`Role add failed: ${err.message}`));
    if (creator.thread_id) {
      const thread = await interaction.guild.channels.fetch(creator.thread_id).catch(() => null);
      await thread?.setArchived(false).catch(() => {});
    }
  }
  await forumDirectory.syncForumPost(interaction.guild, creator.id).catch((err) => logger.warn(`Forum sync failed: ${err.message}`));

  await interaction.editReply({ content: "🟢 Welcome back! You're active again.", components: [] });
}

// --- Break check-in (DM, no interaction.guild available — creatorId is embedded
// in the customId instead of relying on guild context) ---

async function sendBreakCheckin(client, creator) {
  try {
    const user = await client.users.fetch(creator.discord_user_id);
    const dm = await user.createDM();
    await dm.send({
      content: '👋 Your break was set to end today. How are you feeling?',
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`checkin_back_${creator.id}`).setLabel("I'm back!").setEmoji('✅').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`checkin_more_${creator.id}`).setLabel('Need more time').setEmoji('⏳').setStyle(ButtonStyle.Secondary),
      )],
    });
  } catch (err) {
    logger.warn(`Could not send break check-in to ${creator.discord_user_id}: ${err.message}`);
  }
  await creatorRepo.clearBreakReturn(creator.id);
}

async function handleCheckinBack(interaction) {
  await interaction.deferUpdate();
  const creatorId = Number(interaction.customId.split('_')[2]);
  await creatorRepo.reactivate(creatorId);
  // DM context — interaction.guild is null here, unlike every other handler in
  // this file, so the guild has to be fetched explicitly for the forum sync.
  const guild = await interaction.client.guilds.fetch(config.guildId).catch(() => null);
  if (guild) await forumDirectory.syncForumPost(guild, creatorId).catch((err) => logger.warn(`Forum sync failed: ${err.message}`));
  await interaction.editReply({ content: "🟢 Welcome back! You're active again.", components: [] });
}

async function handleCheckinMore(interaction) {
  await interaction.update({
    content: 'No rush — how much more time?',
    components: [durationButtons(`checkindur_${interaction.customId.split('_')[2]}`)],
  });
}

async function handleCheckinMoreDuration(interaction) {
  await interaction.deferUpdate();
  const parts = interaction.customId.split('_'); // checkindur_<creatorId>_<code>
  const creatorId = Number(parts[1]);
  const code = parts[2];
  const { ms, label } = DURATIONS[code];
  const returnAt = ms ? new Date(Date.now() + ms) : null;

  await creatorRepo.setOnBreak(creatorId, returnAt);
  await interaction.editReply({
    content: returnAt ? `🟡 No worries — I'll check in again in ${label}.` : "🟡 No worries — I'll check in again in a few weeks.",
    components: [],
  });
}

module.exports = {
  startBreak, setBreakDuration, startStepDown, cancelStepDown, archiveStepDown, confirmDelete,
  deleteStepDown, reactivate, sendBreakCheckin, handleCheckinBack, handleCheckinMore, handleCheckinMoreDuration,
};
