const { db } = require('./connection');

async function getPendingApplication(discordUserId, guildId) {
  return db('applications').where({ discord_user_id: discordUserId, guild_id: guildId, status: 'PENDING' }).first();
}

// See postRepository.createPost for why .returning('id') is required on Postgres.
async function createApplication(data) {
  const [{ id }] = await db('applications').insert({
    discord_user_id: data.discordUserId,
    guild_id: data.guildId,
    content_comfort: data.contentComfort,
    committed_frequency: data.committedFrequency,
    reasoning: data.reasoning,
    policy_accepted: data.policyAccepted,
    eligible_post_count: data.eligiblePostCount,
    eligible_tenure_days: data.eligibleTenureDays,
  }).returning('id');
  return db('applications').where({ id }).first();
}

async function setModMessageId(id, messageId) {
  return db('applications').where({ id }).update({ mod_message_id: messageId });
}

async function getApplication(id) {
  return db('applications').where({ id }).first();
}

async function decide(id, status, decidedBy) {
  return db('applications').where({ id }).update({ status, decided_at: db.fn.now(), decided_by: decidedBy });
}

module.exports = { getPendingApplication, createApplication, setModMessageId, getApplication, decide };
