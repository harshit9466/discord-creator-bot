const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const postRepo = require('../db/postRepository');
const config = require('../config');
const { buildPostCard, buildGalleryEmbeds, collectVideoFiles } = require('../utils/postCard');
const forumDirectory = require('../services/forumDirectory');
const logger = require('../utils/logger');

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
    embeds: [buildPostCard({ creatorTag, avatarUrl, post }), ...buildGalleryEmbeds(post)],
    files: collectVideoFiles(post),
    components: buildFeedComponents(post),
  });
  await postRepo.setFeedMessageId(post.id, message.id);
  await message.react('❤️').catch(() => {});
  await message.startThread({ name: `Comments — ${creatorTag}`, autoArchiveDuration: 1440 }).catch(() => {});
  await forumDirectory.syncForumPost(guild, post.creator_id).catch((err) => logger.warn(`Forum sync failed: ${err.message}`));
  await forumDirectory.mirrorPost(guild, post, creatorTag, avatarUrl).catch((err) => logger.warn(`Forum mirror failed: ${err.message}`));
  return message;
}

// Re-renders the Feed message in place after a caption edit — same embeds/gallery
// logic as publishPost, just editing instead of sending, and never touching the
// existing reactions/thread/components.
async function refreshFeedMessage(guild, post, creatorTag, avatarUrl) {
  const channel = await guild.channels.fetch(config.feedChannelId);
  const message = await channel.messages.fetch(post.feed_message_id);
  await message.edit({ embeds: [buildPostCard({ creatorTag, avatarUrl, post }), ...buildGalleryEmbeds(post)] });
  return message;
}

module.exports = { buildFeedComponents, publishPost, refreshFeedMessage };
