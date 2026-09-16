const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const config = require('../config');
const creatorRepo = require('../db/creatorRepository');
const postRepo = require('../db/postRepository');
const feedCard = require('./feedCard');
const { isImageUrl } = require('../utils/media');
const forumDirectory = require('../services/forumDirectory');
const logger = require('../utils/logger');

const STATUS_LABELS = { ACTIVE: '🟢 Active', ON_BREAK: '🟡 On a Break', STEPPED_DOWN: '📦 Archived', SUSPENDED: '🚫 Suspended' };

// creator-spaces threads stay creator-only (deliberate — see docs/), so this can
// never link there. Instead it pages through the creator's real posts one at a
// time, sourced from data the profile viewer already has, with a link to each
// post's actual Feed message (which every member CAN see) rather than a text
// summary with nowhere to click.
//
// isOwner adds Edit Caption / Delete controls to the current post — safe to do
// without a separate ownership check on those buttons' handlers, because this
// whole view is only ever shown as an ephemeral reply, which nobody but the
// viewer who triggered it can even see, let alone click.
async function buildProfilePage(guild, creator, index, isOwner = false) {
  const member = await guild.members.fetch(creator.discord_user_id).catch(() => null);
  const totalPosts = await postRepo.countByCreator(creator.id);

  const embed = new EmbedBuilder()
    .setTitle(member ? member.displayName : `Creator #${creator.id}`)
    .setThumbnail(member?.displayAvatarURL() ?? null)
    .addFields(
      { name: 'Status', value: STATUS_LABELS[creator.status] || creator.status, inline: true },
      { name: 'Requests', value: creator.requests_open ? 'Open' : 'Closed', inline: true },
    )
    .setColor(0xE91E8C);
  if (creator.bio) embed.setDescription(creator.bio);

  if (totalPosts === 0) {
    embed.addFields({ name: 'Posts', value: '_No posts yet._' });
    return { embeds: [embed], components: [] };
  }

  const safeIndex = Math.min(Math.max(index, 0), totalPosts - 1);
  const post = await postRepo.getPostAtIndex(creator.id, safeIndex);

  if (post.caption) embed.addFields({ name: 'Caption', value: post.caption.slice(0, 500) });
  if (isImageUrl(post.media_url)) embed.setImage(post.media_url);
  const extraCount = post.extraMediaUrls?.length || 0;
  embed.setFooter({
    text: `Post ${safeIndex + 1} of ${totalPosts} · ${post.content_type}`
      + `${extraCount ? ` · +${extraCount} more attached` : ''} · ${new Date(post.posted_at).toLocaleDateString()}`,
  });

  const ownerSuffix = isOwner ? '1' : '0';
  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`profilepage_${creator.id}_${safeIndex - 1}_${ownerSuffix}`)
      .setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(safeIndex === 0),
    new ButtonBuilder()
      .setCustomId(`profilepage_${creator.id}_${safeIndex + 1}_${ownerSuffix}`)
      .setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(safeIndex >= totalPosts - 1),
  );
  if (post.feed_message_id) {
    navRow.addComponents(
      new ButtonBuilder()
        .setURL(`https://discord.com/channels/${guild.id}/${config.feedChannelId}/${post.feed_message_id}`)
        .setLabel('View in Feed').setStyle(ButtonStyle.Link),
    );
  }
  if (!isImageUrl(post.media_url)) {
    // Video/other media doesn't render via setImage() — the media itself is only
    // one click away via View in Feed above, so this is a courtesy, not a gap.
    embed.addFields({ name: '​', value: "_This post is a video — use 'View in Feed' to watch it._" });
  }

  const components = [navRow];
  if (isOwner) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`profedit_${post.id}_${creator.id}_${safeIndex}`).setLabel('Edit Caption').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`profdelstart_${post.id}_${creator.id}_${safeIndex}`).setLabel('Delete Post').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
    ));
  }

  return { embeds: [embed], components };
}

async function showByCreatorId(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const creatorId = Number(interaction.customId.split('_')[1]);
  const creator = await creatorRepo.getCreatorById(creatorId);
  if (!creator) return interaction.editReply({ content: 'Creator not found.' });
  const isOwner = creator.discord_user_id === interaction.user.id;
  await interaction.editReply(await buildProfilePage(interaction.guild, creator, 0, isOwner));
}

async function showOwn(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const creator = await creatorRepo.getCreatorByDiscordId(interaction.user.id, interaction.guildId);
  if (!creator) {
    return interaction.editReply({ content: "You don't have a creator profile yet — post something first, or apply for the role!" });
  }
  await interaction.editReply(await buildProfilePage(interaction.guild, creator, 0, true));
}

async function changePage(interaction) {
  await interaction.deferUpdate();
  const [, creatorIdStr, indexStr, ownerStr] = interaction.customId.split('_');
  const creator = await creatorRepo.getCreatorById(Number(creatorIdStr));
  if (!creator) return interaction.editReply({ content: 'Creator not found.', embeds: [], components: [] });
  await interaction.editReply(await buildProfilePage(interaction.guild, creator, Number(indexStr), ownerStr === '1'));
}

async function showEditCaptionModal(interaction) {
  const [, postIdStr, creatorIdStr, indexStr] = interaction.customId.split('_');
  const post = await postRepo.getPost(Number(postIdStr));
  const modal = new ModalBuilder().setCustomId(`profeditmodal_${postIdStr}_${creatorIdStr}_${indexStr}`).setTitle('Edit Caption');
  const input = new TextInputBuilder()
    .setCustomId('caption').setLabel('Caption').setStyle(TextInputStyle.Paragraph)
    .setMaxLength(500).setRequired(false).setValue(post?.caption || '');
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

async function handleEditCaptionSubmit(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const [, postIdStr, creatorIdStr, indexStr] = interaction.customId.split('_');
  const postId = Number(postIdStr);
  const caption = interaction.fields.getTextInputValue('caption');

  const post = await postRepo.getPost(postId);
  if (!post) return interaction.editReply({ content: 'Post not found.' });

  await postRepo.updateCaption(postId, caption);

  if (post.feed_message_id) {
    // Reachable only via the owner's own (isOwner-gated) profile view, so
    // interaction.user is guaranteed to be the post's creator here.
    const updatedPost = await postRepo.getPost(postId);
    await feedCard.refreshFeedMessage(interaction.guild, updatedPost, interaction.member.displayName, interaction.user.displayAvatarURL())
      .catch((err) => logger.warn(`Could not refresh Feed message for edited post ${postId}: ${err.message}`));
  }

  const creator = await creatorRepo.getCreatorById(Number(creatorIdStr));
  await interaction.editReply({ content: 'Caption updated.', ...(await buildProfilePage(interaction.guild, creator, Number(indexStr), true)) });
}

// Same second-confirmation pattern used everywhere else irreversible deletion
// happens in this bot (Step Down > Delete, Mod Panel > Delete Creator).
async function startDeletePost(interaction) {
  const [, postIdStr, creatorIdStr, indexStr] = interaction.customId.split('_');
  await interaction.update({
    content: "⚠️ This permanently deletes this post from the Feed and can't be undone. Are you sure?",
    embeds: [],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`profdelfinal_${postIdStr}_${creatorIdStr}_${indexStr}`).setLabel('Yes, delete it').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`profdelcancel_${creatorIdStr}_${indexStr}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    )],
  });
}

async function cancelDeletePost(interaction) {
  await interaction.deferUpdate();
  const [, creatorIdStr, indexStr] = interaction.customId.split('_');
  const creator = await creatorRepo.getCreatorById(Number(creatorIdStr));
  if (!creator) return interaction.editReply({ content: 'Creator not found.', embeds: [], components: [] });
  await interaction.editReply(await buildProfilePage(interaction.guild, creator, Number(indexStr), true));
}

async function deletePostFinal(interaction) {
  await interaction.deferUpdate();
  const [, postIdStr, creatorIdStr, indexStr] = interaction.customId.split('_');
  const post = await postRepo.getPost(Number(postIdStr));

  if (post?.feed_message_id) {
    const channel = await interaction.guild.channels.fetch(config.feedChannelId).catch(() => null);
    const message = await channel?.messages.fetch(post.feed_message_id).catch(() => null);
    // Deleting the message also removes its comment thread — Discord does this
    // automatically for threads started from a message.
    await message?.delete().catch((err) => logger.warn(`Could not delete Feed message for post ${postIdStr}: ${err.message}`));
  }
  await postRepo.deletePost(Number(postIdStr));
  await forumDirectory.syncForumPost(interaction.guild, Number(creatorIdStr)).catch((err) => logger.warn(`Forum sync failed: ${err.message}`));

  const creator = await creatorRepo.getCreatorById(Number(creatorIdStr));
  if (!creator) return interaction.editReply({ content: 'Post deleted.', embeds: [], components: [] });
  await interaction.editReply({ content: 'Post deleted.', ...(await buildProfilePage(interaction.guild, creator, Math.max(0, Number(indexStr) - 1), true)) });
}

module.exports = {
  showByCreatorId, showOwn, changePage, buildProfilePage,
  showEditCaptionModal, handleEditCaptionSubmit, startDeletePost, cancelDeletePost, deletePostFinal,
};
