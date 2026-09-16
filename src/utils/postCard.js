const { EmbedBuilder } = require('discord.js');
const { isImageUrl } = require('./media');

// Shared "render a post as embeds/files" logic, used by both the Feed
// (feedCard.js) and the creator directory's Forum mirror (forumDirectory.js).
// Lives here rather than in feedCard.js specifically because forumDirectory.js
// already gets required BY feedCard.js (for syncForumPost/mirrorPost) — putting
// this in feedCard.js would make that a circular require.
function getCardColor(post) {
  return post.content_type === 'NSFW' ? 0xE0245E : 0x43B581;
}

function buildPostCard({ creatorTag, avatarUrl, post }) {
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
  const all = [post.media_url, ...(post.extraMediaUrls || [])].filter(Boolean);
  return all.filter((url) => !isImageUrl(url));
}

module.exports = { getCardColor, buildPostCard, buildGalleryEmbeds, collectVideoFiles };
