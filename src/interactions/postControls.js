const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder,
} = require('discord.js');
const config = require('../config');
const creatorRepo = require('../db/creatorRepository');
const postRepo = require('../db/postRepository');
const feedCard = require('./feedCard');
const forumDirectory = require('../services/forumDirectory');
const { isImageUrl } = require('../utils/media');
const logger = require('../utils/logger');

// Full post-management lives here, attached directly to each post as it's mirrored
// into the creator's own thread — not behind a separate Profile view anymore.
// creator-spaces threads are already creator-only (mods can see them too, and any
// other creator technically could open another creator's thread — same visibility
// note settings.js's showBoundariesModalForThreadOwner already relies on), so
// unlike introFlow's ephemeral-only wizard, these buttons live on a persistent
// message anyone with thread access could click — ownership has to be checked for
// real every time, not skipped.
function canManage(interaction, ownerDiscordId) {
  if (interaction.user.id === ownerDiscordId) return true;
  return interaction.member.roles.cache.has(config.modRoleId);
}

// Built once per post and attached wherever that post gets mirrored (the button
// flow's own thread-send, or a follow-up message after a native message-drop,
// since a creator's own message can't carry bot buttons). "Remove a Photo/Video"
// only shows up when there's more than one media item to choose between.
function manageControlsRow(post) {
  const totalMedia = (post.media_url ? 1 : 0) + (post.extraMediaUrls?.length || 0);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`postmgmt_edit_${post.id}`).setLabel('Edit Caption').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`postmgmt_delstart_${post.id}`).setLabel('Delete Post').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
  );
  if (totalMedia > 1) {
    row.addComponents(
      new ButtonBuilder().setCustomId(`postmgmt_removemedia_${post.id}`).setLabel('Remove a Photo/Video').setEmoji('🖼️').setStyle(ButtonStyle.Secondary),
    );
  }
  return [row];
}

async function refreshRenders(guild, post) {
  const creator = await creatorRepo.getCreatorById(post.creator_id);
  if (!creator) return;
  const member = await guild.members.fetch(creator.discord_user_id).catch(() => null);
  const creatorTag = member?.displayName || `Creator #${creator.id}`;
  const avatarUrl = member?.displayAvatarURL();
  if (post.feed_message_id) {
    await feedCard.refreshFeedMessage(guild, post, creatorTag, avatarUrl)
      .catch((err) => logger.warn(`Could not refresh Feed message for post ${post.id}: ${err.message}`));
  }
  await forumDirectory.refreshMirroredPost(guild, post, creatorTag, avatarUrl);
}

async function deleteRenders(guild, post) {
  if (post.feed_message_id) {
    const channel = await guild.channels.fetch(config.feedChannelId).catch(() => null);
    const message = await channel?.messages.fetch(post.feed_message_id).catch(() => null);
    // Deleting the message also removes its comment thread — Discord does this
    // automatically for threads started from a message.
    await message?.delete().catch((err) => logger.warn(`Could not delete Feed message for post ${post.id}: ${err.message}`));
  }
  await forumDirectory.deleteMirroredPost(guild, post);
}

// No defer — showModal() has to be the direct, immediate acknowledgment (same
// constraint chooseCustom and profile's old edit modal worked within). Uses
// getPostWithOwner specifically to keep this to exactly one DB round-trip before
// showModal, not two — see docs/incident-2026-09-16-* pattern for why that matters.
async function showEditModal(interaction) {
  const postId = Number(interaction.customId.split('_')[2]); // postmgmt_edit_<postId>
  const post = await postRepo.getPostWithOwner(postId);
  if (!post) return interaction.reply({ content: 'Post not found.', ephemeral: true });
  if (!canManage(interaction, post.owner_discord_user_id)) {
    return interaction.reply({ content: "You can't manage this post.", ephemeral: true });
  }

  const modal = new ModalBuilder().setCustomId(`postmgmt_editmodal_${postId}`).setTitle('Edit Caption');
  const input = new TextInputBuilder()
    .setCustomId('caption').setLabel('Caption').setStyle(TextInputStyle.Paragraph)
    .setMaxLength(1000).setRequired(!post.media_url).setValue(post.caption || '');
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

async function handleEditModalSubmit(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const postId = Number(interaction.customId.split('_')[2]); // postmgmt_editmodal_<postId>
  const post = await postRepo.getPostWithOwner(postId);
  if (!post) return interaction.editReply({ content: 'Post not found.' });
  if (!canManage(interaction, post.owner_discord_user_id)) {
    return interaction.editReply({ content: "You can't manage this post." });
  }

  const caption = interaction.fields.getTextInputValue('caption');
  if (!post.media_url && !caption) {
    return interaction.editReply({ content: "A text post can't have an empty caption — delete it instead if you want it gone." });
  }
  await postRepo.updateCaption(postId, caption);
  const updated = await postRepo.getPost(postId);
  await refreshRenders(interaction.guild, updated);
  await interaction.editReply({ content: 'Caption updated.' });
}

// Same second-confirmation pattern used everywhere else irreversible deletion
// happens in this bot (Step Down > Delete, Mod Panel > Delete Creator).
async function startDelete(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const postId = Number(interaction.customId.split('_')[2]); // postmgmt_delstart_<postId>
  const post = await postRepo.getPostWithOwner(postId);
  if (!post) return interaction.editReply({ content: 'Post not found.' });
  if (!canManage(interaction, post.owner_discord_user_id)) {
    return interaction.editReply({ content: "You can't manage this post." });
  }

  await interaction.editReply({
    content: "⚠️ This permanently deletes this post from the Feed and directory and can't be undone. Are you sure?",
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`postmgmt_delfinal_${postId}`).setLabel('Yes, delete it').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`postmgmt_delcancel_${postId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    )],
  });
}

async function cancelDelete(interaction) {
  await interaction.update({ content: 'Cancelled — nothing changed.', components: [] });
}

async function deleteFinal(interaction) {
  await interaction.deferUpdate();
  const postId = Number(interaction.customId.split('_')[2]); // postmgmt_delfinal_<postId>
  const post = await postRepo.getPostWithOwner(postId);
  if (!post) return interaction.editReply({ content: 'Post not found — may already be deleted.', components: [] });
  if (!canManage(interaction, post.owner_discord_user_id)) {
    return interaction.editReply({ content: "You can't manage this post.", components: [] });
  }

  await deleteRenders(interaction.guild, post);
  await postRepo.deletePost(postId);
  await interaction.editReply({ content: 'Post deleted.', components: [] });
}

async function startRemoveMedia(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const postId = Number(interaction.customId.split('_')[2]); // postmgmt_removemedia_<postId>
  const post = await postRepo.getPostWithOwner(postId);
  if (!post) return interaction.editReply({ content: 'Post not found.' });
  if (!canManage(interaction, post.owner_discord_user_id)) {
    return interaction.editReply({ content: "You can't manage this post." });
  }

  const combined = [post.media_url, ...post.extraMediaUrls].filter(Boolean);
  const options = combined.map((url, i) => ({
    label: `${isImageUrl(url) ? '🖼️ Photo' : '🎬 Video'} ${i + 1}`.slice(0, 100),
    value: `${i}`,
  }));
  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`postmgmt_removemediaselect_${postId}`).setPlaceholder('Which one?').addOptions(options),
  );
  await interaction.editReply({ content: 'Pick which photo/video to remove — the rest of the post stays:', components: [row] });
}

async function handleRemoveMediaSelect(interaction) {
  await interaction.deferUpdate();
  const postId = Number(interaction.customId.split('_')[2]); // postmgmt_removemediaselect_<postId>
  const post = await postRepo.getPostWithOwner(postId);
  if (!post) return interaction.editReply({ content: 'Post not found.', components: [] });
  if (!canManage(interaction, post.owner_discord_user_id)) {
    return interaction.editReply({ content: "You can't manage this post.", components: [] });
  }

  const combined = [post.media_url, ...post.extraMediaUrls].filter(Boolean);
  const url = combined[Number(interaction.values[0])];
  if (!url) return interaction.editReply({ content: 'That item no longer exists.', components: [] });

  const updated = await postRepo.removeMediaItem(postId, url);
  if (!updated) {
    // That was the last media item and there's no caption either — the whole
    // post is gone, same cleanup as a full delete.
    await deleteRenders(interaction.guild, post);
    return interaction.editReply({ content: 'Removed — that was the only content left, so the post was deleted entirely.', components: [] });
  }

  await refreshRenders(interaction.guild, updated);
  await interaction.editReply({ content: 'Removed.', components: [] });
}

module.exports = {
  manageControlsRow, showEditModal, handleEditModalSubmit, startDelete, cancelDelete, deleteFinal,
  startRemoveMedia, handleRemoveMediaSelect,
};
