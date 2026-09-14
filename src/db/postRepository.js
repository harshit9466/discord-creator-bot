const { db } = require('./connection');

// .returning('id') is required, not optional, on Postgres: a plain .insert() with
// no .returning() returns the raw driver result object there (not an array), so
// `const [id] = await db(...).insert(...)` throws "not iterable" — only worked
// during earlier SQLite testing because sqlite3's dialect returns [insertId] by
// default. Verified .returning('id') gives the identical [{id}] shape on both.
async function createPost({ creatorId, guildId, mediaUrl, contentType, requestsOpen, caption }) {
  const [{ id }] = await db('posts').insert({
    creator_id: creatorId,
    guild_id: guildId,
    media_url: mediaUrl,
    content_type: contentType,
    requests_open: requestsOpen,
    caption: caption || null,
  }).returning('id');
  return db('posts').where({ id }).first();
}

async function setFeedMessageId(postId, messageId) {
  return db('posts').where({ id: postId }).update({ feed_message_id: messageId });
}

async function getPost(postId) {
  return db('posts').where({ id: postId }).first();
}

async function listRecentByCreator(creatorId, limit = 5) {
  return db('posts').where({ creator_id: creatorId }).orderBy('posted_at', 'desc').limit(limit);
}

async function getLastPostDate(creatorId) {
  const row = await db('posts').where({ creator_id: creatorId }).orderBy('posted_at', 'desc').first();
  return row?.posted_at || null;
}

// index 0 = most recent — backs the paginated profile viewer, since
// creator-spaces threads stay creator-only and members need some other way to
// actually see a creator's post history, not just a date-stamped text list.
async function getPostAtIndex(creatorId, index) {
  return db('posts').where({ creator_id: creatorId }).orderBy('posted_at', 'desc').offset(index).limit(1).first();
}

async function countByCreator(creatorId) {
  const [{ count }] = await db('posts').where({ creator_id: creatorId }).count('* as count');
  return Number(count);
}

async function toggleLike(postId, discordUserId) {
  const existing = await db('post_likes').where({ post_id: postId, discord_user_id: discordUserId }).first();
  if (existing) {
    await db('post_likes').where({ post_id: postId, discord_user_id: discordUserId }).delete();
    await db('posts').where({ id: postId }).decrement('like_count', 1);
    return { liked: false };
  }
  await db('post_likes').insert({ post_id: postId, discord_user_id: discordUserId });
  await db('posts').where({ id: postId }).increment('like_count', 1);
  return { liked: true };
}

module.exports = {
  createPost, setFeedMessageId, getPost, listRecentByCreator, getLastPostDate, toggleLike,
  getPostAtIndex, countByCreator,
};
