const { db } = require('./connection');

async function incrementPostCount(discordUserId, guildId) {
  const existing = await db('member_activity').where({ discord_user_id: discordUserId, guild_id: guildId }).first();
  if (existing) {
    return db('member_activity').where({ discord_user_id: discordUserId, guild_id: guildId }).increment('tracked_post_count', 1);
  }
  return db('member_activity').insert({ discord_user_id: discordUserId, guild_id: guildId, tracked_post_count: 1 });
}

async function getPostCount(discordUserId, guildId) {
  const row = await db('member_activity').where({ discord_user_id: discordUserId, guild_id: guildId }).first();
  return row?.tracked_post_count || 0;
}

// Used by the history backfill script — sets an exact value from a fresh full scan,
// rather than incrementing, so re-running the backfill is always safe and idempotent.
async function setPostCount(discordUserId, guildId, count) {
  const existing = await db('member_activity').where({ discord_user_id: discordUserId, guild_id: guildId }).first();
  if (existing) {
    return db('member_activity').where({ discord_user_id: discordUserId, guild_id: guildId }).update({ tracked_post_count: count });
  }
  return db('member_activity').insert({ discord_user_id: discordUserId, guild_id: guildId, tracked_post_count: count });
}

module.exports = { incrementPostCount, getPostCount, setPostCount };
