const { db } = require('./connection');
const crypto = require('../utils/crypto');

// See postRepository.createPost for why .returning('id') is required on Postgres.
async function createRequest({ creatorId, postId, requesterDiscordId, guildId, text }) {
  const enc = crypto.encryptJsonField(text);
  const [{ id }] = await db('requests').insert({
    creator_id: creatorId,
    post_id: postId || null,
    requester_discord_id: requesterDiscordId,
    guild_id: guildId,
    request_text_enc: JSON.stringify(enc),
  }).returning('id');
  return getRequest(id);
}

async function getRequest(id) {
  const row = await db('requests').where({ id }).first();
  if (!row) return null;
  return { ...row, text: crypto.decryptJsonField(JSON.parse(row.request_text_enc)) };
}

module.exports = { createRequest, getRequest };
