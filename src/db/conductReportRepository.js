const { db } = require('./connection');

// See postRepository.createPost for why .returning('id') is required on Postgres.
async function createReport({ reportedDiscordId, reporterDiscordId, guildId, requestId, context, reason }) {
  const [{ id }] = await db('conduct_reports').insert({
    reported_discord_id: reportedDiscordId,
    reporter_discord_id: reporterDiscordId,
    guild_id: guildId,
    request_id: requestId || null,
    context: context || null,
    reason: reason || null,
  }).returning('id');
  return db('conduct_reports').where({ id }).first();
}

async function getReport(id) {
  return db('conduct_reports').where({ id }).first();
}

async function setModMessageId(id, messageId) {
  return db('conduct_reports').where({ id }).update({ mod_message_id: messageId });
}

async function updateStatus(id, status, handledBy) {
  return db('conduct_reports').where({ id }).update({ status, handled_at: db.fn.now(), handled_by: handledBy });
}

// Surfaces a pattern (same person reported by multiple different creators/members)
// rather than only ever looking like isolated one-off complaints.
async function countReportsAgainst(reportedDiscordId, guildId) {
  const rows = await db('conduct_reports')
    .where({ reported_discord_id: reportedDiscordId, guild_id: guildId })
    .select('reporter_discord_id');
  const distinctReporters = new Set(rows.map((r) => r.reporter_discord_id));
  return { totalReports: rows.length, distinctReporters: distinctReporters.size };
}

// Oldest first — so the longest-unresolved escalation surfaces at the top of the
// Mod Panel's Escalated Reports list instead of getting buried by newer ones.
async function listByStatus(guildId, status, limit = 25) {
  return db('conduct_reports').where({ guild_id: guildId, status }).orderBy('created_at', 'asc').limit(limit);
}

module.exports = {
  createReport, getReport, setModMessageId, updateStatus, countReportsAgainst, listByStatus,
};
