const { db } = require('./connection');

// Atomic upsert, not check-then-insert: the previous version raced when two callers
// hit it for the same user near-simultaneously (e.g. approving an application calls
// this directly, which also fires guildMemberUpdate -> ensureCreatorThread -> this
// again) — both would see "no existing row" and both try to INSERT, the loser
// crashing on the unique constraint. onConflict().ignore() makes the second insert
// a no-op instead of an error. See docs/incident-2026-09-15-findorcreate-race.md.
async function findOrCreateCreator(discordUserId, guildId) {
  await db('creators')
    .insert({ discord_user_id: discordUserId, guild_id: guildId, status: 'ACTIVE' })
    .onConflict(['discord_user_id', 'guild_id'])
    .ignore();
  return db('creators').where({ discord_user_id: discordUserId, guild_id: guildId }).first();
}

async function getCreatorById(id) {
  return db('creators').where({ id }).first();
}

async function getCreatorByDiscordId(discordUserId, guildId) {
  return db('creators').where({ discord_user_id: discordUserId, guild_id: guildId }).first();
}

async function getCreatorByThreadId(threadId) {
  return db('creators').where({ thread_id: threadId }).first();
}

async function setThreadId(creatorId, threadId) {
  return db('creators').where({ id: creatorId }).update({ thread_id: threadId });
}

async function setForumPostId(creatorId, forumPostId) {
  return db('creators').where({ id: creatorId }).update({ forum_post_id: forumPostId });
}

async function updateBoundaries(creatorId, boundaries) {
  return db('creators').where({ id: creatorId }).update({ boundaries });
}

async function setDefaultContentType(creatorId, contentType) {
  return db('creators').where({ id: creatorId }).update({ default_content_type: contentType });
}

// Used by the bulk onboarding script for pre-existing role holders who never went
// through the apply flow — marks when they became a recognized creator in this
// system, distinct from applied_at (which stays null for them, since they never
// applied).
async function markApproved(creatorId) {
  return db('creators').where({ id: creatorId }).update({ approved_at: db.fn.now() });
}

// Guards introFlow.start() against a second Feed announcement for the same
// creator — the welcome message's "Introduce Me" button has no other way to know
// it's already been used, since it isn't removed/disabled after the first click.
async function setIntroPosted(creatorId) {
  return db('creators').where({ id: creatorId }).update({ intro_posted_at: db.fn.now() });
}

async function setOnBreak(creatorId, breakReturnAt) {
  return db('creators').where({ id: creatorId }).update({ status: 'ON_BREAK', break_return_at: breakReturnAt });
}

async function clearBreakReturn(creatorId) {
  return db('creators').where({ id: creatorId }).update({ break_return_at: null });
}

async function reactivate(creatorId) {
  return db('creators').where({ id: creatorId }).update({ status: 'ACTIVE', break_return_at: null, step_down_mode: null });
}

async function stepDown(creatorId, mode) {
  return db('creators').where({ id: creatorId }).update({ status: 'STEPPED_DOWN', step_down_mode: mode });
}

// Mod-only status, distinct from Step Down/Archive: overrides whatever status the
// creator was in, and — unlike Archive — reactivate() is deliberately NOT reachable
// by the creator themselves while suspended (enforced in settings.js). Only a mod
// lifting it via the Mod Panel calls reactivate() to clear it.
async function suspend(creatorId) {
  return db('creators').where({ id: creatorId }).update({ status: 'SUSPENDED' });
}

// Posts cascade-delete via the FK (onDelete('CASCADE')) — deleting the creator row
// is the whole "Delete" step-down mode, deliberately, so there's exactly one place
// that decides what "permanently delete a creator" means.
async function deleteCreator(creatorId) {
  return db('creators').where({ id: creatorId }).delete();
}

async function listByGuild(guildId) {
  return db('creators').where({ guild_id: guildId }).orderBy('status', 'asc');
}

async function getCreatorsOnBreakPastReturn() {
  return db('creators').where({ status: 'ON_BREAK' }).whereNotNull('break_return_at').where('break_return_at', '<=', db.fn.now());
}

module.exports = {
  findOrCreateCreator, getCreatorById, getCreatorByDiscordId, getCreatorByThreadId, setThreadId, setForumPostId,
  updateBoundaries, setDefaultContentType, markApproved, setIntroPosted, setOnBreak, clearBreakReturn,
  reactivate, stepDown, suspend, deleteCreator, listByGuild, getCreatorsOnBreakPastReturn,
};
