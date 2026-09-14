const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const creatorRepo = require('../db/creatorRepository');
const postRepo = require('../db/postRepository');

const STATUS_LABELS = { ACTIVE: '🟢 Active', ON_BREAK: '🟡 On a Break', STEPPED_DOWN: '📦 Archived' };
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp)(\?|$)/i;

// creator-spaces threads stay creator-only (deliberate — see docs/), so this can
// never link there. Instead it pages through the creator's real posts one at a
// time, sourced from data the profile viewer already has, with a link to each
// post's actual Feed message (which every member CAN see) rather than a text
// summary with nowhere to click.
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
  if (IMAGE_EXTENSIONS.test(post.media_url)) embed.setImage(post.media_url);
  embed.setFooter({ text: `Post ${safeIndex + 1} of ${totalPosts} · ${post.content_type} · ${new Date(post.posted_at).toLocaleDateString()}` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`profilepage_${creator.id}_${safeIndex - 1}`)
      .setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(safeIndex === 0),
    new ButtonBuilder()
      .setCustomId(`profilepage_${creator.id}_${safeIndex + 1}`)
      .setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(safeIndex >= totalPosts - 1),
  );
  if (post.feed_message_id) {
    row.addComponents(
      new ButtonBuilder()
        .setURL(`https://discord.com/channels/${guild.id}/${config.feedChannelId}/${post.feed_message_id}`)
        .setLabel('View in Feed').setStyle(ButtonStyle.Link),
    );
  }
  if (!IMAGE_EXTENSIONS.test(post.media_url)) {
    // Video/other media doesn't render via setImage() — the media itself is only
    // one click away via View in Feed above, so this is a courtesy, not a gap.
    embed.addFields({ name: '​', value: "_This post is a video — use 'View in Feed' to watch it._" });
  }

  return { embeds: [embed], components: [row] };
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
