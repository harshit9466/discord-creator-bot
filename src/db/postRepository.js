const { db } = require('./connection');

// extra_media_urls is stored as a JSON-stringified array — this parses it back
// on every read so callers always get a real array (post.extraMediaUrls), never
// a raw string they'd each have to remember to JSON.parse themselves.
function parsePost(row) {
  if (!row) return row;
  return { ...row, extraMediaUrls: row.extra_media_urls ? JSON.parse(row.extra_media_urls) : [] };
}

// .returning('id') is required, not optional, on Postgres: a plain .insert() with
// no .returning() returns the raw driver result object there (not an array), so
// `const [id] = await db(...).insert(...)` throws "not iterable" — only worked
// during earlier SQLite testing because sqlite3's dialect returns [insertId] by
// default. Verified .returning('id') gives the identical [{id}] shape on both.
async function createPost({ creatorId, guildId, mediaUrl, extraMediaUrls, contentType, requestsOpen, caption }) {
  const [{ id }] = await db('posts').insert({
    creator_id: creatorId,
    guild_id: guildId,
    media_url: mediaUrl,
    extra_media_urls: extraMediaUrls?.length ? JSON.stringify(extraMediaUrls) : null,
    content_type: contentType,
    requests_open: requestsOpen,
    caption: caption || null,
  }).returning('id');
  return getPost(id);
}

async function setFeedMessageId(postId, messageId) {
  return db('posts').where({ id: postId }).update({ feed_message_id: messageId });
}

async function updateCaption(postId, caption) {
  return db('posts').where({ id: postId }).update({ caption: caption || null });
}

async function deletePost(postId) {
  return db('posts').where({ id: postId }).delete();
}

async function getPost(postId) {
  const row = await db('posts').where({ id: postId }).first();
  return parsePost(row);
}

async function listRecentByCreator(creatorId, limit = 5) {
  const rows = await db('posts').where({ creator_id: creatorId }).orderBy('posted_at', 'desc').limit(limit);
  return rows.map(parsePost);
}

async function getLastPostDate(creatorId) {
  const row = await db('posts').where({ creator_id: creatorId }).orderBy('posted_at', 'desc').first();
  return row?.posted_at || null;
}

// index 0 = most recent — backs the paginated profile viewer, since
// creator-spaces threads stay creator-only and members need some other way to
// actually see a creator's post history, not just a date-stamped text list.
async function getPostAtIndex(creatorId, index) {
  const row = await db('posts').where({ creator_id: creatorId }).orderBy('posted_at', 'desc').offset(index).limit(1).first();
  return parsePost(row);
}

async function countByCreator(creatorId) {
  const [{ count }] = await db('posts').where({ creator_id: creatorId }).count('* as count');
  return Number(count);
}

module.exports = {
  createPost, setFeedMessageId, updateCaption, deletePost, getPost, listRecentByCreator,
  getLastPostDate, getPostAtIndex, countByCreator,
};
