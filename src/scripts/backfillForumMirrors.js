// One-time (or re-runnable) backfill: mirrors every existing post into its
// creator's Forum directory thread. mirrorPost only ever runs going forward (from
// feedCard.publishPost) — posts made before the Forum directory feature existed
// (or before a given creator's forum post was provisioned) never got mirrored, so
// their thread's "gallery" would be missing everything from before today. Skips
// any post that already has a forum_mirror_message_id, so it's safe to re-run.
// Run standalone: node src/scripts/backfillForumMirrors.js
require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { db } = require('../db/connection');
const postRepo = require('../db/postRepository');
const creatorRepo = require('../db/creatorRepository');
const forumDirectory = require('../services/forumDirectory');
const config = require('../config');
const logger = require('../utils/logger');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});

client.once('clientReady', async () => {
  try {
    if (!config.creatorForumChannelId) throw new Error('CREATOR_FORUM_CHANNEL_ID is not set — nothing to backfill');

    const guild = await client.guilds.fetch(config.guildId);
    const rows = await db('posts').whereNull('forum_mirror_message_id').orderBy('posted_at', 'asc').select('id');
    logger.info(`Found ${rows.length} posts without a forum mirror yet.`);

    let done = 0;
    let skipped = 0;
    for (const { id } of rows) {
      const post = await postRepo.getPost(id);
      const creator = await creatorRepo.getCreatorById(post.creator_id);
      if (!creator?.forum_post_id) { skipped += 1; continue; } // creator has no forum post to mirror into

      const member = await guild.members.fetch(creator.discord_user_id).catch(() => null);
      await forumDirectory.mirrorPost(guild, post, member?.displayName || `Creator #${creator.id}`, member?.displayAvatarURL());
      done += 1;
      logger.info(`Mirrored post ${post.id} (${done + skipped}/${rows.length})`);
    }

    logger.info(`Done: ${done} mirrored, ${skipped} skipped (creator has no forum post).`);
  } catch (err) {
    logger.error('Forum mirror backfill failed:', { error: err.message });
  } finally {
    client.destroy();
    process.exit(0);
  }
});

client.login(process.env.DISCORD_TOKEN);
