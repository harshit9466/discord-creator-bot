const { db } = require('./connection');
const config = require('../config');

const DEFAULT_POLICY =
  "As a creator here, you agree to: post the kind of content you're comfortable with (SFW/NSFW, your call); " +
  "honor the boundaries you set — you're never obligated to fulfill any request; keep posts to what's allowed " +
  'in the tracked content channels; treat members respectfully, and expect the same in return; tell a mod if ' +
  "anything makes you uncomfortable. You can take a break or step down anytime, no explanation needed.\n\n" +
  '_(Mods: edit this anytime with /creator-settings — this is a starter default, not final wording.)_';

// In-memory cache so messageCreate.js (which runs on every message the bot can
// see) doesn't hit the DB per message just to check tracked channel IDs. Cleared
// on every write below, so a mod's change via /creator-settings takes effect
// immediately — never stale, never a hot-path query.
const cache = new Map(); // guildId -> settings row

async function getSettings(guildId) {
  // Fails clearly and immediately instead of as a Postgres NOT NULL violation on
  // guild_id — that's how a missing DM guard in messageCreate.js first surfaced
  // this, 2026-09-15.
  if (!guildId) throw new Error('getSettings() called with no guildId — check the caller has a guild context (not a DM)');
  if (cache.has(guildId)) return cache.get(guildId);

  await db('guild_settings').insert({
    guild_id: guildId,
    eligibility_min_posts: config.eligibilityMinPosts,
    eligibility_min_tenure_days: config.eligibilityMinTenureDays,
    eligibility_tracked_channel_ids: config.eligibilityTrackedChannelIds.join(','),
    creator_policy: DEFAULT_POLICY,
  }).onConflict('guild_id').ignore();

  const row = await db('guild_settings').where({ guild_id: guildId }).first();
  cache.set(guildId, row);
  return row;
}

function trackedChannelIds(settings) {
  return settings.eligibility_tracked_channel_ids.split(',').map((s) => s.trim()).filter(Boolean);
}

async function updateEligibility(guildId, { minPosts, minTenureDays, trackedChannelIds: ids }, updatedBy) {
  await getSettings(guildId); // ensure the row exists before updating
  await db('guild_settings').where({ guild_id: guildId }).update({
    eligibility_min_posts: minPosts,
    eligibility_min_tenure_days: minTenureDays,
    eligibility_tracked_channel_ids: ids.join(','),
    updated_at: db.fn.now(),
    updated_by: updatedBy,
  });
  cache.delete(guildId);
  return getSettings(guildId);
}

async function updatePolicy(guildId, policyText, updatedBy) {
  await getSettings(guildId);
  await db('guild_settings').where({ guild_id: guildId }).update({
    creator_policy: policyText,
    updated_at: db.fn.now(),
    updated_by: updatedBy,
  });
  cache.delete(guildId);
  return getSettings(guildId);
}

module.exports = { getSettings, trackedChannelIds, updateEligibility, updatePolicy };
