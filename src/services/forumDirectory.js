const { ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const creatorRepo = require('../db/creatorRepository');
const postRepo = require('../db/postRepository');
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

async function buildStarterPayload(guild, creator, member = null) {
  const resolvedMember = member || await guild.members.fetch(creator.discord_user_id).catch(() => null);
  const [latest] = await postRepo.listRecentByCreator(creator.id, 1);

  const embed = new EmbedBuilder()
    .setAuthor({ name: resolvedMember?.displayName || `Creator #${creator.id}`, iconURL: resolvedMember?.displayAvatarURL() })
    .addFields(
      { name: 'Status', value: STATUS_LABELS[creator.status] || creator.status, inline: true },
      { name: 'Content', value: creator.default_content_type, inline: true },
      { name: 'Requests', value: creator.requests_open ? 'Open' : 'Closed', inline: true },
    )
    .setColor(0xE91E8C);
  if (creator.bio) embed.setDescription(creator.bio);
  if (latest) embed.addFields({ name: 'Latest post', value: `<t:${Math.floor(new Date(latest.posted_at).getTime() / 1000)}:R>` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`profile_${creator.id}`).setLabel('Profile').setEmoji('👤').setStyle(ButtonStyle.Secondary),
  );
  if (latest?.feed_message_id) {
    row.addComponents(
      new ButtonBuilder()
        .setURL(`https://discord.com/channels/${guild.id}/${config.feedChannelId}/${latest.feed_message_id}`)
        .setLabel('Latest Post').setStyle(ButtonStyle.Link),
    );
  }

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

// Takes the already-fetched creator row, not a creatorId — this always runs right
// before creatorRepo.deleteCreator(), so the row won't exist to re-fetch by then.
async function deleteForumPost(guild, creator) {
  if (!config.creatorForumChannelId || !creator?.forum_post_id) return;
  const post = await guild.channels.fetch(creator.forum_post_id).catch(() => null);
  await post?.delete().catch((err) => logger.warn(`Could not delete forum post for creator ${creator.id}: ${err.message}`));
}

module.exports = { ensureForumPost, syncForumPost, deleteForumPost };
