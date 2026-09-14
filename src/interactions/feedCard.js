const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const postRepo = require('../db/postRepository');
const config = require('../config');

function buildFeedCard({ creatorTag, avatarUrl, post }) {
  const embed = new EmbedBuilder()
    .setAuthor({ name: creatorTag, iconURL: avatarUrl })
    .setImage(post.media_url)
    .setColor(post.content_type === 'NSFW' ? 0xE0245E : 0x43B581)
    .setFooter({ text: `${post.content_type} · Requests ${post.requests_open ? 'Open' : 'Closed'}` });

  if (post.caption) embed.setDescription(post.caption);
  return embed;
}

function buildFeedComponents(post) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`like_${post.id}`).setLabel(`${post.like_count}`).setEmoji('❤️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`profile_${post.creator_id}`).setLabel('Profile').setEmoji('👤').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`reqstart_${post.id}`).setLabel('Request').setEmoji('📨').setStyle(ButtonStyle.Secondary),
  )];
}

async function publishPost(guild, { creatorTag, avatarUrl, post }) {
  const channel = await guild.channels.fetch(config.feedChannelId);
  const message = await channel.send({
    embeds: [buildFeedCard({ creatorTag, avatarUrl, post })],
    components: buildFeedComponents(post),
  });
  await postRepo.setFeedMessageId(post.id, message.id);
  await message.startThread({ name: `Comments — ${creatorTag}`, autoArchiveDuration: 1440 }).catch(() => {});
  return message;
}

// deferUpdate() first — two DB calls before the response risk the same
// interaction-token expiry as applyFlow.start(), just less likely to be noticed
// since it's usually fast. Better to close the gap than rely on luck.
async function handleLike(interaction) {
  await interaction.deferUpdate();
  const postId = Number(interaction.customId.split('_')[1]);
  const { liked } = await postRepo.toggleLike(postId, interaction.user.id);
  const post = await postRepo.getPost(postId);
  await interaction.editReply({ components: buildFeedComponents(post) });
  await interaction.followUp({ content: liked ? 'Appreciated! ❤️' : 'Like removed.', ephemeral: true });
}

module.exports = { buildFeedCard, buildFeedComponents, publishPost, handleLike };
