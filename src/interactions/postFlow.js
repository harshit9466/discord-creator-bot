const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const config = require('../config');
const creatorRepo = require('../db/creatorRepository');
const postRepo = require('../db/postRepository');
const feedCard = require('./feedCard');
const creatorSpace = require('../services/creatorSpace');
const logger = require('../utils/logger');

// Short-lived wizard state only — lost on restart is an acceptable tradeoff
// for a multi-step flow that takes under a few minutes to complete.
const drafts = new Map(); // userId -> { contentType, requestsOpen, caption? }

function typeSelect(current) {
  return new StringSelectMenuBuilder()
    .setCustomId('postflow_type')
    .setPlaceholder(`Content type: ${current}`)
    .addOptions(
      { label: 'SFW', value: 'SFW', default: current === 'SFW' },
      { label: 'NSFW', value: 'NSFW', default: current === 'NSFW' },
    );
}

function requestsSelect(current) {
  return new StringSelectMenuBuilder()
    .setCustomId('postflow_requests')
    .setPlaceholder(`Requests: ${current ? 'Open' : 'Closed'}`)
    .addOptions(
      { label: 'Requests Open', value: 'OPEN', default: current === true },
      { label: 'Requests Closed', value: 'CLOSED', default: current === false },
    );
}

function stepOneComponents(draft) {
  return [
    new ActionRowBuilder().addComponents(typeSelect(draft.contentType)),
    new ActionRowBuilder().addComponents(requestsSelect(draft.requestsOpen)),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('postflow_next').setLabel('Next →').setStyle(ButtonStyle.Primary),
    ),
  ];
}

async function start(interaction) {
  if (!interaction.member.roles.cache.has(config.creatorRoleId)) {
    return interaction.reply({ content: 'Only creators can post here — apply for the role first!', ephemeral: true });
  }
  const draft = { contentType: 'SFW', requestsOpen: true };
  drafts.set(interaction.user.id, draft);
  await interaction.reply({
    content: 'Set the details for this post, then hit Next.',
    components: stepOneComponents(draft),
    ephemeral: true,
  });
}

async function setType(interaction) {
  const draft = drafts.get(interaction.user.id);
  if (!draft) return interaction.reply({ content: 'Session expired — click Post Content again.', ephemeral: true });
  draft.contentType = interaction.values[0];
  await interaction.update({ components: stepOneComponents(draft) });
}

async function setRequests(interaction) {
  const draft = drafts.get(interaction.user.id);
  if (!draft) return interaction.reply({ content: 'Session expired — click Post Content again.', ephemeral: true });
  draft.requestsOpen = interaction.values[0] === 'OPEN';
  await interaction.update({ components: stepOneComponents(draft) });
}

async function handleNext(interaction) {
  const draft = drafts.get(interaction.user.id);
  if (!draft) return interaction.reply({ content: 'Session expired — click Post Content again.', ephemeral: true });

  const modal = new ModalBuilder().setCustomId('postflow_caption_modal').setTitle('Caption');
  const captionInput = new TextInputBuilder()
    .setCustomId('caption')
    .setLabel('Caption (optional)')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(300)
    .setRequired(false);
  modal.addComponents(new ActionRowBuilder().addComponents(captionInput));
  await interaction.showModal(modal);
}

// Discord modals can't hold a file picker or a dropdown — text inputs only.
// So the media step happens right after, over DM, regardless of anything else
// this bot does or doesn't have permission to read.
async function handleCaptionSubmit(interaction) {
  const draft = drafts.get(interaction.user.id);
  if (!draft) return interaction.reply({ content: 'Session expired — click Post Content again.', ephemeral: true });
  draft.caption = interaction.fields.getTextInputValue('caption');

  await interaction.reply({ content: '📩 Check your DMs — send me the photo or video for this post.', ephemeral: true });

  let dmChannel;
  try {
    dmChannel = await interaction.user.createDM();
    await dmChannel.send('Send the photo or video for your post here (just attach it and hit send). You have 5 minutes.');
  } catch (err) {
    logger.warn(`Could not DM ${interaction.user.id} for post flow: ${err.message}`);
    return interaction.followUp({ content: "I can't DM you — check your privacy settings allow DMs from server members, then try again.", ephemeral: true });
  }

  // awaitMessages() lives on the channel itself, not on channel.messages (that's
  // MessageManager — .fetch()/.cache, no collector methods). Calling it on
  // dmChannel.messages threw "not a function" synchronously, before .catch(() =>
  // null) could even attach — so it wasn't swallowed, it crashed the whole
  // function right after the DM was sent, leaving no collector listening when the
  // attachment arrived. Confirmed against the installed discord.js source, not
  // assumed, before fixing.
  const collected = await dmChannel
    .awaitMessages({ filter: (m) => m.author.id === interaction.user.id && m.attachments.size > 0, max: 1, time: 5 * 60 * 1000 })
    .catch(() => null);

  if (!collected || collected.size === 0) {
    drafts.delete(interaction.user.id);
    return dmChannel.send('Timed out waiting for an attachment — click Post Content again to retry.');
  }

  const attachment = collected.first().attachments.first();
  const creator = await creatorRepo.findOrCreateCreator(interaction.user.id, interaction.guildId);
  const post = await postRepo.createPost({
    creatorId: creator.id,
    guildId: interaction.guildId,
    mediaUrl: attachment.url,
    contentType: draft.contentType,
    requestsOpen: draft.requestsOpen,
    caption: draft.caption,
  });

  const { thread } = await creatorSpace.ensureCreatorThread(interaction.guild, interaction.member);
  await thread.send({ content: draft.caption || undefined, files: [attachment.url] }).catch((err) => {
    logger.warn(`Could not mirror post into creator thread for ${interaction.user.id}: ${err.message}`);
  });

  await feedCard.publishPost(interaction.guild, {
    creatorTag: interaction.member.displayName,
    avatarUrl: interaction.user.displayAvatarURL(),
    post,
  });

  drafts.delete(interaction.user.id);
  await dmChannel.send('Posted! ✅ Check your space and the feed.');
}

module.exports = { start, setType, setRequests, handleNext, handleCaptionSubmit };
