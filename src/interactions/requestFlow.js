const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder,
} = require('discord.js');
const postRepo = require('../db/postRepository');
const creatorRepo = require('../db/creatorRepository');
const requestRepo = require('../db/requestRepository');
const restrictedRepo = require('../db/restrictedMemberRepository');
const logger = require('../utils/logger');

// Step 1: show the creator's boundaries before the requester can type anything.
// Several sequential DB/API calls happen before we know what to say, so defer
// first — see applyFlow.js's start() for why this matters.
async function start(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const postId = Number(interaction.customId.split('_')[1]);

  if (await restrictedRepo.isRestricted(interaction.user.id, interaction.guildId)) {
    return interaction.editReply({ content: "You've been restricted from sending requests. Contact a mod if you think this is a mistake." });
  }

  const post = await postRepo.getPost(postId);
  if (!post) return interaction.editReply({ content: 'Post not found.' });
  const creator = await creatorRepo.getCreatorById(post.creator_id);
  if (!creator) return interaction.editReply({ content: 'Creator not found.' });

  if (creator.discord_user_id === interaction.user.id) {
    return interaction.editReply({ content: "You can't send yourself a request." });
  }
  if (!post.requests_open || !creator.requests_open) {
    return interaction.editReply({ content: 'Requests are closed for this creator right now.' });
  }

  const member = await interaction.guild.members.fetch(creator.discord_user_id).catch(() => null);
  const embed = new EmbedBuilder()
    .setTitle(`Before you request from ${member?.displayName || 'this creator'}`)
    .setDescription(creator.boundaries || '_No boundaries listed yet — be respectful and ask first._')
    .setColor(0xE91E8C);

  await interaction.editReply({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`reqcontinue_${postId}`).setLabel('I understand, continue →').setStyle(ButtonStyle.Primary),
    )],
  });
}

async function showModal(interaction) {
  const postId = Number(interaction.customId.split('_')[1]);
  const modal = new ModalBuilder().setCustomId(`reqmodal_${postId}`).setTitle('Send a Request');
  const input = new TextInputBuilder()
    .setCustomId('text')
    .setLabel('Your request')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(500)
    .setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

// Modal submission — encrypting + writing the request, then DMing the creator,
// easily exceeds 3 seconds. Defer first.
async function handleModalSubmit(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const postId = Number(interaction.customId.split('_')[1]);
  const text = interaction.fields.getTextInputValue('text');

  const post = await postRepo.getPost(postId);
  if (!post) return interaction.editReply({ content: 'Post not found.' });
  const creator = await creatorRepo.getCreatorById(post.creator_id);

  const request = await requestRepo.createRequest({
    creatorId: creator.id,
    postId,
    requesterDiscordId: interaction.user.id,
    guildId: interaction.guildId,
    text,
  });

  try {
    const creatorUser = await interaction.client.users.fetch(creator.discord_user_id);
    const dm = await creatorUser.createDM();
    await dm.send({
      content: `📨 New request from **${interaction.user.tag}**:\n> ${text}`,
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`reqreport_${request.id}`).setLabel('Report').setEmoji('🚩').setStyle(ButtonStyle.Danger),
      )],
    });
  } catch (err) {
    logger.warn(`Could not DM creator ${creator.discord_user_id} with new request: ${err.message}`);
  }

  await interaction.editReply({ content: 'Sent! 💌' });
}

module.exports = { start, showModal, handleModalSubmit };
