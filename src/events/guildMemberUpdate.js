const config = require('../config');
const creatorSpace = require('../services/creatorSpace');
const forumDirectory = require('../services/forumDirectory');
const logger = require('../utils/logger');

module.exports = {
  name: 'guildMemberUpdate',
  once: false,
  async execute(oldMember, newMember) {
    const hadRole = oldMember.roles.cache.has(config.creatorRoleId);
    const hasRole = newMember.roles.cache.has(config.creatorRoleId);
    if (hadRole || !hasRole) return; // only act on the ADD transition

    try {
      const { creator } = await creatorSpace.ensureCreatorThread(newMember.guild, newMember);
      await forumDirectory.ensureForumPost(newMember.guild, creator, newMember);
    } catch (err) {
      logger.error(`Failed to provision creator thread for ${newMember.id}:`, { error: err.message });
    }
  },
};
