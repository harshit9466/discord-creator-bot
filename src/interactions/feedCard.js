const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const postRepo = require('../db/postRepository');
const config = require('../config');
const { isImageUrl } = require('../utils/media');

function getCardColor(post) {
  return post.content_type === 'NSFW' ? 0xE0245E : 0x43B581;
}

function buildFeedCard({ creatorTag, avatarUrl, post }) {
  const embed = new EmbedBuilder()
    .setAuthor({ name: creatorTag, iconURL: avatarUrl })
    .setColor(getCardColor(post))
    .setFooter({ text: `${post.content_type} · Requests ${post.requests_open ? 'Open' : 'Closed'}` });

  if (isImageUrl(post.media_url)) embed.setImage(post.media_url);
  if (post.caption) embed.setDescription(post.caption);
  return embed;
}

// Extra images become their own bare embeds (Discord caps a message at 10 embeds
// total, so main + up to 9 more) — the standard way bots show a gallery from one
// message with several images. Videos can't be embedded at all, so collectVideoFiles
// below attaches them as raw files instead, which Discord renders as playable
// attachments alongside the embeds.
function buildGalleryEmbeds(post) {
  const extraImages = (post.extraMediaUrls || []).filter(isImageUrl).slice(0, 9);
  return extraImages.map((url) => new EmbedBuilder().setColor(getCardColor(post)).setImage(url));
}

function collectVideoFiles(post) {
  const all = [post.media_url, ...(post.extraMediaUrls || [])];
  return all.filter((url) => !isImageUrl(url));
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
    embeds: [buildFeedCard({ creatorTag, avatarUrl, post }), ...buildGalleryEmbeds(post)],
    files: collectVideoFiles(post),
    components: buildFeedComponents(post),
  });
  await postRepo.setFeedMessageId(post.id, message.id);
  await message.react('❤️').catch(() => {});
  await message.startThread({ name: `Comments — ${creatorTag}`, autoArchiveDuration: 1440 }).catch(() => {});
  return message;
}

// Re-renders the Feed message in place after a caption edit — same embeds/gallery
// logic as publishPost, just editing instead of sending, and never touching the
// existing reactions/thread/components.
async function refreshFeedMessage(guild, post, creatorTag, avatarUrl) {
  const channel = await guild.channels.fetch(config.feedChannelId);
  const message = await channel.messages.fetch(post.feed_message_id);
  await message.edit({ embeds: [buildFeedCard({ creatorTag, avatarUrl, post }), ...buildGalleryEmbeds(post)] });
  return message;
}

module.exports = {
  buildFeedCard, buildGalleryEmbeds, collectVideoFiles, buildFeedComponents, publishPost, refreshFeedMessage,
};
