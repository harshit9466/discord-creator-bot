const { db } = require('./connection');

async function isRestricted(discordUserId, guildId) {
  const row = await db('restricted_members').where({ discord_user_id: discordUserId, guild_id: guildId }).first();
  return !!row;
}

async function restrict(discordUserId, guildId, restrictedBy) {
  const existing = await db('restricted_members').where({ discord_user_id: discordUserId, guild_id: guildId }).first();
  if (existing) return existing;
  await db('restricted_members').insert({ discord_user_id: discordUserId, guild_id: guildId, restricted_by: restrictedBy });
  return db('restricted_members').where({ discord_user_id: discordUserId, guild_id: guildId }).first();
}

module.exports = { isRestricted, restrict };
