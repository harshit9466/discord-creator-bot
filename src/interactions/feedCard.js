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
    new ButtonBuilder().setCustomId(`profile_${post.creator_id}`).setLabel('Profile').setEmoji('👤').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`reqstart_${post.id}`).setLabel('Request').setEmoji('📨').setStyle(ButtonStyle.Secondary),
  )];
}

// Appreciation is a real Discord reaction, not a custom button — a button has no
// way to show who clicked it (no hover tooltip, no reactor list; that's a native
// reaction feature Discord's client renders itself, not something bot components
// can replicate). Adding the seed reaction here means the count and the "who
// reacted" list are both free — Discord already builds both, correctly, for any
// message with a reaction on it.
async function publishPost(guild, { creatorTag, avatarUrl, post }) {
  const channel = await guild.channels.fetch(config.feedChannelId);
  const message = await channel.send({
    embeds: [buildFeedCard({ creatorTag, avatarUrl, post })],
    components: buildFeedComponents(post),
  });
  await postRepo.setFeedMessageId(post.id, message.id);
  await message.react('❤️').catch(() => {});
  await message.startThread({ name: `Comments — ${creatorTag}`, autoArchiveDuration: 1440 }).catch(() => {});
  return message;
}

module.exports = { buildFeedCard, buildFeedComponents, publishPost };
