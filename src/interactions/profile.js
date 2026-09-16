const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const creatorRepo = require('../db/creatorRepository');
const postRepo = require('../db/postRepository');
const { isImageUrl } = require('../utils/media');

const STATUS_LABELS = { ACTIVE: '🟢 Active', ON_BREAK: '🟡 On a Break', STEPPED_DOWN: '📦 Archived', SUSPENDED: '🚫 Suspended' };

// Read-only — editing/deleting your own posts happens in your creator-space
// thread now (postControls.js), attached directly to each post as it's made, not
// behind this view. creator-spaces threads stay creator-only (deliberate — see
// docs/), so this is still how members see a creator's post history: paginated,
// one post at a time, linking out to each post's actual Feed message.
async function buildProfilePage(guild, creator, index) {
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

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`profilepage_${creator.id}_${safeIndex - 1}`)
      .setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(safeIndex === 0),
    new ButtonBuilder()
      .setCustomId(`profilepage_${creator.id}_${safeIndex + 1}`)
      .setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(safeIndex >= totalPosts - 1),
  );
  if (post.feed_message_id) {
    navRow.addComponents(
      new ButtonBuilder()
        .setURL(`https://discord.com/channels/${guild.id}/${config.feedChannelId}/${post.feed_message_id}`)
        .setLabel('View in Feed').setStyle(ButtonStyle.Link),
    );
  }
  if (post.media_url && !isImageUrl(post.media_url)) {
    // Video/other media doesn't render via setImage() — the media itself is only
    // one click away via View in Feed above, so this is a courtesy, not a gap.
    embed.addFields({ name: '​', value: "_This post is a video — use 'View in Feed' to watch it._" });
  }

  return { embeds: [embed], components: [navRow] };
}

async function showByCreatorId(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const creatorId = Number(interaction.customId.split('_')[1]);
  const creator = await creatorRepo.getCreatorById(creatorId);
  if (!creator) return interaction.editReply({ content: 'Creator not found.' });
  await interaction.editReply(await buildProfilePage(interaction.guild, creator, 0));
}

async function showOwn(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const creator = await creatorRepo.getCreatorByDiscordId(interaction.user.id, interaction.guildId);
  if (!creator) {
    return interaction.editReply({ content: "You don't have a creator profile yet — post something first, or apply for the role!" });
  }
  await interaction.editReply(await buildProfilePage(interaction.guild, creator, 0));
}

async function changePage(interaction) {
  await interaction.deferUpdate();
  const [, creatorIdStr, indexStr] = interaction.customId.split('_');
  const creator = await creatorRepo.getCreatorById(Number(creatorIdStr));
  if (!creator) return interaction.editReply({ content: 'Creator not found.', embeds: [], components: [] });
  await interaction.editReply(await buildProfilePage(interaction.guild, creator, Number(indexStr)));
}

module.exports = { showByCreatorId, showOwn, changePage, buildProfilePage };
