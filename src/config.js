function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

module.exports = {
  guildId: required('GUILD_ID'),
  homeChannelId: required('HOME_CHANNEL_ID'),
  feedChannelId: required('FEED_CHANNEL_ID'),
  creatorSpacesChannelId: required('CREATOR_SPACES_CHANNEL_ID'),
  modReviewChannelId: required('MOD_REVIEW_CHANNEL_ID'),
  // Optional — the member-facing creator directory (forumDirectory.js) only works
  // once this points at a real Discord Forum channel, created manually the same
  // way every other channel here is (this bot never creates its own channels).
  // Left unset, every forumDirectory call is a silent no-op — nothing else changes.
  creatorForumChannelId: process.env.CREATOR_FORUM_CHANNEL_ID || null,
  creatorRoleId: required('CREATOR_ROLE_ID'),
  modRoleId: required('MOD_ROLE_ID'),

  // Tunable eligibility thresholds — safe to change anytime, just restart the bot
  eligibilityMinPosts: Number(process.env.ELIGIBILITY_MIN_POSTS || 50),
  eligibilityMinTenureDays: Number(process.env.ELIGIBILITY_MIN_TENURE_DAYS || 90),
  eligibilityTrackedChannelIds: (process.env.ELIGIBILITY_TRACKED_CHANNEL_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean),

  // Mod roster flags an ACTIVE creator who hasn't posted in this many days
  inactivityFlagDays: Number(process.env.INACTIVITY_FLAG_DAYS || 21),

  // Content-preference roles VerifyBot assigns post-verification — pinged when a
  // new creator introduces themselves in the Feed, alongside @here.
  introPingRoleIds: [
    process.env.INITIATE_ROLE_ID,
    process.env.NSFW_ONLY_ROLE_ID,
    process.env.ANYTIME_ROLE_ID,
  ].filter(Boolean),
};
