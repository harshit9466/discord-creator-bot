const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const creatorRepo = require('../db/creatorRepository');
const postRepo = require('../db/postRepository');

const STATUS_ORDER = { ACTIVE: 0, ON_BREAK: 1, STEPPED_DOWN: 2 };
const STATUS_LABEL = { ACTIVE: '🟢', ON_BREAK: '🟡', STEPPED_DOWN: '📦' };

// Not paginated — at this community's scale (dozens of creators, not hundreds) a
// single embed comfortably fits within Discord's field/description limits, and it's
// far simpler and less error-prone than building pagination for a size problem that
// doesn't exist yet. Revisit if the roster ever approaches ~40-50 creators.
async function postRoster(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const creators = await creatorRepo.listByGuild(interaction.guildId);
  creators.sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9));

  const lines = await Promise.all(creators.map(async (creator) => {
    const member = await interaction.guild.members.fetch(creator.discord_user_id).catch(() => null);
    const name = member?.displayName || `<@${creator.discord_user_id}>`;
    const icon = STATUS_LABEL[creator.status] || '❔';

    if (creator.status === 'ON_BREAK') {
      const returns = creator.break_return_at ? new Date(creator.break_return_at).toLocaleDateString() : 'no date set';
      return `${icon} **${name}** — on break, checks in ${returns}`;
    }
    if (creator.status === 'STEPPED_DOWN') {
      return `${icon} **${name}** — archived`;
    }

    const lastPost = await postRepo.getLastPostDate(creator.id);
    if (!lastPost) return `${icon} **${name}** — no posts yet`;
    const daysSince = Math.floor((Date.now() - new Date(lastPost).getTime()) / (1000 * 60 * 60 * 24));
    const flag = daysSince >= config.inactivityFlagDays ? ' ⚠️ inactive' : '';
    return `${icon} **${name}** — last post ${daysSince}d ago${flag}`;
  }));

  const embed = new EmbedBuilder()
    .setTitle('📋 Creator Roster')
    .setDescription(lines.join('\n') || '_No creators yet._')
    .setFooter({ text: `${creators.length} total · ⚠️ = no post in ${config.inactivityFlagDays}+ days` })
    .setColor(0xE91E8C);

  await interaction.editReply({ embeds: [embed] });
}

module.exports = { postRoster };
