const { ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const creatorRepo = require('../db/creatorRepository');
const postRepo = require('../db/postRepository');
const { buildPostCard, buildGalleryEmbeds, collectVideoFiles } = require('../utils/postCard');
const logger = require('../utils/logger');

// Optional feature: CREATOR_FORUM_CHANNEL_ID isn't in production yet (the channel
// has to be created manually in Discord as type Forum first, same as every other
// channel this bot references by ID — it doesn't create its own channels). Every
// entry point below no-ops silently until that env var is set, so deploying this
// code doesn't require the channel to exist yet.
const STATUS_LABELS = { ACTIVE: '🟢 Active', ON_BREAK: '🟡 On a Break', STEPPED_DOWN: '📦 Archived', SUSPENDED: '🚫 Suspended' };

const TAG_DEFS = [
  { name: 'Active', emoji: '🟢' },
  { name: 'On Break', emoji: '🟡' },
  { name: 'Archived', emoji: '📦' },
  { name: 'Suspended', emoji: '🚫' },
  { name: 'SFW', emoji: '📸' },
  { name: 'NSFW', emoji: '🔞' },
];

function computeTagNames(creator) {
  const statusTag = { ACTIVE: 'Active', ON_BREAK: 'On Break', STEPPED_DOWN: 'Archived', SUSPENDED: 'Suspended' }[creator.status] || 'Active';
  return [statusTag, creator.default_content_type === 'NSFW' ? 'NSFW' : 'SFW'];
}

function tagIdsFor(availableTags, creator) {
  const names = computeTagNames(creator);
  return availableTags.filter((t) => names.includes(t.name)).map((t) => t.id);
}

// Creates any of TAG_DEFS missing from the channel — idempotent, same "seed once,
// mod/Discord-editable after" spirit as guild_settings, except tags live on the
// Discord channel itself rather than in our DB.
async function ensureTags(channel) {
  const existingNames = new Set(channel.availableTags.map((t) => t.name));
  const missing = TAG_DEFS.filter((t) => !existingNames.has(t.name));
  if (missing.length === 0) return channel.availableTags;

  const nextTags = [
    ...channel.availableTags.map((t) => ({ id: t.id, name: t.name, emoji: t.emoji })),
    ...missing.map((t) => ({ name: t.name, emoji: { id: null, name: t.emoji } })),
  ];
  const updated = await channel.setAvailableTags(nextTags);
  return updated.availableTags;
}

// Just the profile summary — every actual post gets mirrored as its own message
// in this same thread (mirrorPost below), so the thread's own message history IS
// the "all their media and text in one place" gallery. No "latest post" link
// needed here anymore; scrolling the thread shows everything, oldest to newest,
// and members can reply right there to talk to the creator.
async function buildStarterPayload(guild, creator, member = null) {
  const resolvedMember = member || await guild.members.fetch(creator.discord_user_id).catch(() => null);

  const embed = new EmbedBuilder()
    .setAuthor({ name: resolvedMember?.displayName || `Creator #${creator.id}`, iconURL: resolvedMember?.displayAvatarURL() })
    .addFields(
      { name: 'Status', value: STATUS_LABELS[creator.status] || creator.status, inline: true },
      { name: 'Content', value: creator.default_content_type, inline: true },
      { name: 'Requests', value: creator.requests_open ? 'Open' : 'Closed', inline: true },
    )
    .setColor(0xE91E8C)
    .setFooter({ text: 'Every post they make shows up below — reply here to chat with them.' });
  if (creator.bio) embed.setDescription(creator.bio);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`profile_${creator.id}`).setLabel('Profile').setEmoji('👤').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

// Per-member in-flight lock, same reasoning as creatorSpace.ensureCreatorThread —
// this is legitimately called from two places for one approval (handleModDecision
// directly, and the guildMemberUpdate role-grant listener), and a Discord thread
// create is an external side effect a DB upsert alone can't deduplicate.
const inFlight = new Map();

// `member` is optional — pass it when the caller already fetched it (applyFlow.js,
// guildMemberUpdate.js both do, right before calling this) to skip a second,
// redundant Discord API round-trip for the same data.
async function ensureForumPost(guild, creator, member = null) {
  if (!config.creatorForumChannelId) return null;
  const key = `${guild.id}:${creator.discord_user_id}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const promise = provisionForumPost(guild, creator, member).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

async function provisionForumPost(guild, creator, member) {
  const channel = await guild.channels.fetch(config.creatorForumChannelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildForum) {
    logger.error('CREATOR_FORUM_CHANNEL_ID is not set to a real Forum channel — skipping directory post');
    return null;
  }

  if (creator.forum_post_id) {
    const existing = await guild.channels.fetch(creator.forum_post_id).catch(() => null);
    if (existing) {
      // Same reused-but-archived gap as creator-spaces threads (see
      // docs/incident-2026-09-16-archived-reapproval.md) — a reactivated creator's
      // old forum post can still be locked/archived from when they stepped down.
      if (existing.archived) await existing.setArchived(false).catch(() => {});
      if (existing.locked) await existing.setLocked(false).catch(() => {});
      return existing;
    }
  }

  const resolvedMember = member || await guild.members.fetch(creator.discord_user_id).catch(() => null);
  const [availableTags, { embeds, components }] = await Promise.all([
    ensureTags(channel),
    buildStarterPayload(guild, creator, resolvedMember),
  ]);

  const post = await channel.threads.create({
    name: (resolvedMember?.displayName || `Creator #${creator.id}`).slice(0, 90),
    message: { embeds, components },
    appliedTags: tagIdsFor(availableTags, creator),
    reason: 'Creator directory post provisioned',
  });

  await creatorRepo.setForumPostId(creator.id, post.id);
  logger.info(`Creator forum post provisioned for ${creator.discord_user_id} in guild ${guild.id}`);
  return post;
}

// Called after any state change (new post, break/archive/suspend/reactivate) —
// always recomputes fully from the current DB row rather than taking a "what
// changed" argument, so every call site is the same one line regardless of which
// specific field changed.
async function syncForumPost(guild, creatorId) {
  if (!config.creatorForumChannelId) return;
  const creator = await creatorRepo.getCreatorById(creatorId);
  if (!creator?.forum_post_id) return;

  const post = await guild.channels.fetch(creator.forum_post_id).catch(() => null);
  const channel = await guild.channels.fetch(config.creatorForumChannelId).catch(() => null);
  if (!post || !channel) return;

  const availableTags = channel.availableTags.length ? channel.availableTags : await ensureTags(channel);
  const { embeds, components } = await buildStarterPayload(guild, creator);
  const starter = await post.fetchStarterMessage().catch(() => null);
  await starter?.edit({ embeds, components }).catch((err) => logger.warn(`Could not edit forum post for creator ${creatorId}: ${err.message}`));
  await post.setAppliedTags(tagIdsFor(availableTags, creator)).catch(() => {});

  const shouldBeClosed = creator.status === 'STEPPED_DOWN' || creator.status === 'SUSPENDED';
  if (shouldBeClosed) {
    if (!post.locked) await post.setLocked(true).catch(() => {});
    if (!post.archived) await post.setArchived(true).catch(() => {});
  } else {
    if (post.archived) await post.setArchived(false).catch(() => {});
    if (post.locked) await post.setLocked(false).catch(() => {});
  }
}

// Mirrors one post's actual content (embeds + files, same rendering as the Feed
// card) into the creator's own forum thread, right after it's published — this is
// what turns that thread into a real "everything this creator has shared, in
// order, in one place" gallery instead of just a status summary, and since it's a
// normal Discord thread, members can reply right there to actually talk to them.
async function mirrorPost(guild, post, creatorTag, avatarUrl) {
  if (!config.creatorForumChannelId) return;
  const creator = await creatorRepo.getCreatorById(post.creator_id);
  if (!creator?.forum_post_id) return;

  const thread = await guild.channels.fetch(creator.forum_post_id).catch(() => null);
  if (!thread) return;
  const wasArchived = thread.archived;
  if (wasArchived) await thread.setArchived(false).catch(() => {});

  const message = await thread.send({
    embeds: [buildPostCard({ creatorTag, avatarUrl, post }), ...buildGalleryEmbeds(post)],
    files: collectVideoFiles(post),
  });
  await postRepo.setForumMirrorMessageId(post.id, message.id);

  if (wasArchived) await thread.setArchived(true).catch(() => {});
}

// Re-renders a post's mirrored copy in place after a caption edit or a single
// media item being removed — same "edit, don't resend" pattern as
// feedCard.refreshFeedMessage, just targeting the forum thread's copy instead.
async function refreshMirroredPost(guild, post, creatorTag, avatarUrl) {
  if (!config.creatorForumChannelId || !post?.forum_mirror_message_id) return;
  const creator = await creatorRepo.getCreatorById(post.creator_id);
  if (!creator?.forum_post_id) return;
  const thread = await guild.channels.fetch(creator.forum_post_id).catch(() => null);
  if (!thread) return;
  const message = await thread.messages.fetch(post.forum_mirror_message_id).catch(() => null);
  await message?.edit({ embeds: [buildPostCard({ creatorTag, avatarUrl, post }), ...buildGalleryEmbeds(post)] })
    .catch((err) => logger.warn(`Could not refresh forum mirror for post ${post.id}: ${err.message}`));
}

// Cleans up a post's mirrored copy when the post itself gets deleted (or loses its
// last media item down to nothing — see postRepository.removeMediaItem) — takes
// the already-fetched post row, same reasoning as deleteForumPost below.
async function deleteMirroredPost(guild, post) {
  if (!config.creatorForumChannelId || !post?.forum_mirror_message_id) return;
  const creator = await creatorRepo.getCreatorById(post.creator_id);
  if (!creator?.forum_post_id) return;
  const thread = await guild.channels.fetch(creator.forum_post_id).catch(() => null);
  if (!thread) return;
  const message = await thread.messages.fetch(post.forum_mirror_message_id).catch(() => null);
  await message?.delete().catch((err) => logger.warn(`Could not delete forum mirror for post ${post.id}: ${err.message}`));
}

// Takes the already-fetched creator row, not a creatorId — this always runs right
// before creatorRepo.deleteCreator(), so the row won't exist to re-fetch by then.
async function deleteForumPost(guild, creator) {
  if (!config.creatorForumChannelId || !creator?.forum_post_id) return;
  const post = await guild.channels.fetch(creator.forum_post_id).catch(() => null);
  await post?.delete().catch((err) => logger.warn(`Could not delete forum post for creator ${creator.id}: ${err.message}`));
}

module.exports = { ensureForumPost, syncForumPost, mirrorPost, refreshMirroredPost, deleteMirroredPost, deleteForumPost };
