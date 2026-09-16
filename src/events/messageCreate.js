const config = require('../config');
const creatorRepo = require('../db/creatorRepository');
const postRepo = require('../db/postRepository');
const feedCard = require('../interactions/feedCard');
const postControls = require('../interactions/postControls');
const memberActivityRepo = require('../db/memberActivityRepository');
const guildSettingsRepo = require('../db/guildSettingsRepository');
const logger = require('../utils/logger');

module.exports = {
  name: 'messageCreate',
  once: false,
  async execute(message) {
    if (message.author.bot) return; // also guards against re-processing the button flow's own thread mirror
    // Everything below is guild-scoped (tracked-channel counting, native-thread
    // posting) — a DM has message.guildId === null, which crashed getSettings()
    // trying to insert a guild_settings row with a null primary key (caught by
    // index.js's runHandler backstop, so it didn't take the bot down, but it fired
    // on every single DM the bot received, including the post-flow's own attachment
    // step — unrelated to why that step failed, but a real bug found alongside it).
    if (!message.guildId) return;

    // getSettings() is cache-backed (see guildSettingsRepository.js) specifically
    // so this per-message check never becomes a per-message DB query.
    const settings = await guildSettingsRepo.getSettings(message.guildId);
    if (guildSettingsRepo.trackedChannelIds(settings).includes(message.channelId)) {
      memberActivityRepo.incrementPostCount(message.author.id, message.guildId).catch((err) => {
        logger.error(`Failed to increment tracked post count for ${message.author.id}:`, { error: err.message });
      });
    }

    if (!message.channel.isThread()) return;
    if (message.channel.parentId !== config.creatorSpacesChannelId) return;
    if (message.attachments.size === 0) return;

    const creator = await creatorRepo.getCreatorByThreadId(message.channel.id);
    if (!creator || creator.discord_user_id !== message.author.id) return;

    try {
      // All attachments from the message, not just the first — a creator dropping
      // 3 photos in one message used to only ever post the first one to the Feed.
      const [primary, ...rest] = [...message.attachments.values()];
      const post = await postRepo.createPost({
        creatorId: creator.id,
        guildId: message.guildId,
        mediaUrl: primary.url,
        extraMediaUrls: rest.map((a) => a.url),
        contentType: creator.default_content_type,
        requestsOpen: creator.requests_open,
        caption: message.content || null,
      });

      await feedCard.publishPost(message.guild, {
        creatorTag: message.member?.displayName || message.author.username,
        avatarUrl: message.author.displayAvatarURL(),
        post,
      });

      await message.react('✅').catch(() => {});
      // The creator's own message can't carry bot buttons, so management controls
      // (edit caption, delete, remove one photo/video) go on a follow-up reply
      // instead — same controls the button flow attaches directly to its own
      // thread-mirror message.
      await message.reply({ content: 'Manage this post:', components: postControls.manageControlsRow(post) }).catch((err) => {
        logger.warn(`Could not send post-management controls for ${message.author.id}: ${err.message}`);
      });
    } catch (err) {
      logger.error(`Native post mirror failed for ${message.author.id}:`, { error: err.message });
    }
  },
};
