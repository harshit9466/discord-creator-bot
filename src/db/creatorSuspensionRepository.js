const { db } = require('./connection');

// See postRepository.createPost for why .returning('id') is required on Postgres.
async function createSuspension(creatorId, guildId, reason, suspendedBy) {
  const [{ id }] = await db('creator_suspensions').insert({
    creator_id: creatorId,
    guild_id: guildId,
    reason,
    suspended_by: suspendedBy,
  }).returning('id');
  return db('creator_suspensions').where({ id }).first();
}

// The currently-active suspension, if any — a creator is "suspended" exactly
// when this returns a row.
async function getOpenSuspension(creatorId) {
  return db('creator_suspensions').where({ creator_id: creatorId }).whereNull('lifted_at').orderBy('suspended_at', 'desc').first();
}

async function getHistory(creatorId, limit = 10) {
  return db('creator_suspensions').where({ creator_id: creatorId }).orderBy('suspended_at', 'desc').limit(limit);
}

async function liftSuspension(suspensionId, liftedBy) {
  return db('creator_suspensions').where({ id: suspensionId }).update({ lifted_by: liftedBy, lifted_at: db.fn.now() });
}

module.exports = { createSuspension, getOpenSuspension, getHistory, liftSuspension };
