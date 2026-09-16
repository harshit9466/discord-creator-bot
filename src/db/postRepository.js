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
  if (!mediaUrl && !caption) throw new Error('createPost requires at least one of mediaUrl or caption');
  const [{ id }] = await db('posts').insert({
    creator_id: creatorId,
    guild_id: guildId,
    media_url: mediaUrl || null,
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

async function setForumMirrorMessageId(postId, messageId) {
  return db('posts').where({ id: postId }).update({ forum_mirror_message_id: messageId });
}

async function updateCaption(postId, caption) {
  return db('posts').where({ id: postId }).update({ caption: caption || null });
}

async function deletePost(postId) {
  return db('posts').where({ id: postId }).delete();
}

// Removes exactly one media item (by URL) from a post, not the whole post —
// creators used to only be able to delete an entire multi-photo post to get rid
// of one bad shot. If the removed item was the primary media_url, the first extra
// gets promoted to take its place (never leaves the post pointing at a URL it no
// longer has). If that was the ONLY media item left and there's no caption either,
// the post is deleted outright — text_url/caption both empty isn't a valid post,
// same rule createPost enforces going in. Returns the updated post, or null if it
// was deleted.
async function removeMediaItem(postId, url) {
  const post = await getPost(postId);
  if (!post) return null;

  let mediaUrl = post.media_url;
  let extras = post.extraMediaUrls;

  if (post.media_url === url) {
    [mediaUrl, ...extras] = [extras[0] || null, ...extras.slice(1)];
  } else {
    extras = extras.filter((u) => u !== url);
  }

  if (!mediaUrl && !post.caption) {
    await deletePost(postId);
    return null;
  }

  await db('posts').where({ id: postId }).update({
    media_url: mediaUrl,
    extra_media_urls: extras.length ? JSON.stringify(extras) : null,
  });
  return getPost(postId);
}

async function getPost(postId) {
  const row = await db('posts').where({ id: postId }).first();
  return parsePost(row);
}

// One query instead of getPost() + a separate creators lookup — postControls.js's
// handlers need both the post AND the owning creator's discord_user_id (for the
// ownership check) before their very first interaction response, and every extra
// sequential await there is extra risk of blowing Discord's 3-second ack window.
async function getPostWithOwner(postId) {
  const row = await db('posts')
    .join('creators', 'posts.creator_id', 'creators.id')
    .where('posts.id', postId)
    .select('posts.*', 'creators.discord_user_id as owner_discord_user_id')
    .first();
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
  createPost, setFeedMessageId, setForumMirrorMessageId, updateCaption, deletePost, removeMediaItem,
  getPost, getPostWithOwner, listRecentByCreator, getLastPostDate, getPostAtIndex, countByCreator,
};
