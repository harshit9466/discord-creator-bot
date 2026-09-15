const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder,
} = require('discord.js');
const config = require('../config');
const creatorRepo = require('../db/creatorRepository');
const logger = require('../utils/logger');

// Short-lived wizard state only, same tradeoff as postFlow.js's drafts map — lost on
// restart is fine for a flow that takes under a few minutes end to end.
const drafts = new Map(); // creatorId -> { introText }

function genericIntroText(displayName) {
  return `🎉 Please give a warm welcome to our newest creator, **${displayName}**! Drop by, say hi, and check out what they're sharing.`;
}

// The onboarding welcome message that carries this button lives in the creator's
// own thread, which (like onboard_boundaries_, see settings.js) other members can
// reach too — so every entry point here has to confirm the clicker actually owns
// the creator profile the customId points at before acting on it.
async function verifyOwner(interaction, creatorId) {
  const creator = await creatorRepo.getCreatorById(creatorId);
  if (!creator || creator.discord_user_id !== interaction.user.id) return null;
  return creator;
}

async function publishIntro(guild, creator, introText, mediaUrl) {
  const member = await guild.members.fetch(creator.discord_user_id).catch(() => null);
  const embed = new EmbedBuilder()
    .setAuthor({ name: member?.displayName || `Creator #${creator.id}`, iconURL: member?.displayAvatarURL() })
    .setTitle('🎉 New Creator!')
    .setDescription(introText)
    .setColor(0xE91E8C);
  if (mediaUrl) embed.setImage(mediaUrl);

  // @here plus the content-preference roles VerifyBot assigns — parse:['everyone']
  // is what actually makes @here notify (Discord suppresses it by default the same
  // way it suppresses @everyone), and the explicit `roles` allowlist is what makes
  // the role mentions ping rather than render as plain text.
  const rolePings = config.introPingRoleIds.map((id) => `<@&${id}>`).join(' ');
  const channel = await guild.channels.fetch(config.feedChannelId);
  await channel.send({
    content: `@here ${rolePings}`.trim(),
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`profile_${creator.id}`).setLabel('Profile').setEmoji('👤').setStyle(ButtonStyle.Secondary),
    )],
    allowedMentions: { parse: ['everyone'], roles: config.introPingRoleIds },
  });
  await creatorRepo.setIntroPosted(creator.id);
}

async function start(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const creatorId = Number(interaction.customId.split('_')[1]); // introstart_<creatorId>
  const creator = await verifyOwner(interaction, creatorId);
  if (!creator) return interaction.editReply({ content: "This isn't your space — open your own creator thread to introduce yourself." });
  if (creator.intro_posted_at) return interaction.editReply({ content: "You've already been introduced in the Feed! 🎉" });

  await interaction.editReply({
    content: 'How would you like to be introduced in the Feed?',
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`intromode_custom_${creatorId}`).setLabel('Write My Own').setEmoji('✍️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`intromode_generic_${creatorId}`).setLabel('Use the Generic Intro').setEmoji('🤖').setStyle(ButtonStyle.Secondary),
    )],
  });
}

// No defer — showModal() has to be the direct acknowledgment of the interaction,
// same constraint profile.showEditCaptionModal already works within.
async function chooseCustom(interaction) {
  const creatorIdStr = interaction.customId.split('_')[2]; // intromode_custom_<creatorId>
  const creator = await verifyOwner(interaction, Number(creatorIdStr));
  if (!creator) return interaction.reply({ content: "This isn't your space.", ephemeral: true });

  const modal = new ModalBuilder().setCustomId(`introcustommodal_${creatorIdStr}`).setTitle('Your Introduction');
  const input = new TextInputBuilder()
    .setCustomId('introtext').setLabel('Introduce yourself to the server').setStyle(TextInputStyle.Paragraph)
    .setMaxLength(500).setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

function mediaChoiceComponents(creatorId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`introaddmedia_${creatorId}`).setLabel('Yes, attach a photo').setEmoji('📎').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`introskip_${creatorId}`).setLabel('No, skip it').setStyle(ButtonStyle.Secondary),
  )];
}

async function chooseGeneric(interaction) {
  await interaction.deferUpdate();
  const creatorIdStr = interaction.customId.split('_')[2]; // intromode_generic_<creatorId>
  const creatorId = Number(creatorIdStr);
  const creator = await verifyOwner(interaction, creatorId);
  if (!creator) return interaction.editReply({ content: "This isn't your space.", components: [] });

  const member = await interaction.guild.members.fetch(creator.discord_user_id).catch(() => null);
  drafts.set(creatorId, { introText: genericIntroText(member?.displayName || 'this creator') });
  await interaction.editReply({ content: 'Want to attach a photo to your intro post?', components: mediaChoiceComponents(creatorId) });
}

async function handleCustomModalSubmit(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const creatorId = Number(interaction.customId.split('_')[1]); // introcustommodal_<creatorId>
  const creator = await verifyOwner(interaction, creatorId);
  if (!creator) return interaction.editReply({ content: "This isn't your space." });

  drafts.set(creatorId, { introText: interaction.fields.getTextInputValue('introtext') });
  await interaction.editReply({ content: 'Want to attach a photo to your intro post?', components: mediaChoiceComponents(creatorId) });
}

async function finalizeNoMedia(interaction) {
  await interaction.deferUpdate();
  const creatorId = Number(interaction.customId.split('_')[1]); // introskip_<creatorId>
  const creator = await verifyOwner(interaction, creatorId);
  if (!creator) return interaction.editReply({ content: "This isn't your space.", components: [] });
  const draft = drafts.get(creatorId);
  if (!draft) return interaction.editReply({ content: 'Session expired — click Introduce Me in the Feed again.', components: [] });

  await publishIntro(interaction.guild, creator, draft.introText, null);
  drafts.delete(creatorId);
  await interaction.editReply({ content: 'Posted your introduction in the Feed! 🎉', components: [] });
}

// Discord modals can't hold a file picker (same constraint postFlow.js's media step
// works within) — so, same as there, media collection happens over DM regardless of
// anything else this bot does or doesn't have permission to read.
async function startMediaCollection(interaction) {
  await interaction.deferUpdate();
  const creatorId = Number(interaction.customId.split('_')[1]); // introaddmedia_<creatorId>
  const creator = await verifyOwner(interaction, creatorId);
  if (!creator) return interaction.editReply({ content: "This isn't your space.", components: [] });
  const draft = drafts.get(creatorId);
  if (!draft) return interaction.editReply({ content: 'Session expired — click Introduce Me in the Feed again.', components: [] });

  await interaction.editReply({ content: '📩 Check your DMs — send me a photo for your Feed introduction.', components: [] });

  let dmChannel;
  try {
    dmChannel = await interaction.user.createDM();
    await dmChannel.send("Send a photo for your Feed introduction here — you have 5 minutes. If you don't, I'll just post without one.");
  } catch (err) {
    logger.warn(`Could not DM ${interaction.user.id} for intro media: ${err.message}`);
    await publishIntro(interaction.guild, creator, draft.introText, null);
    drafts.delete(creatorId);
    return interaction.followUp({
      content: "I can't DM you — check your privacy settings allow DMs from server members. Posted your introduction without a photo instead. 🎉",
      ephemeral: true,
    });
  }

  const collected = await dmChannel
    .awaitMessages({ filter: (m) => m.author.id === interaction.user.id && m.attachments.size > 0, max: 1, time: 5 * 60 * 1000 })
    .catch(() => null);

  const mediaUrl = collected?.first()?.attachments.first()?.url || null;
  await publishIntro(interaction.guild, creator, draft.introText, mediaUrl);
  drafts.delete(creatorId);
  await dmChannel
    .send(mediaUrl ? 'Posted your introduction in the Feed! 🎉' : "Didn't get a photo in time — posted your introduction without one. 🎉")
    .catch(() => {});
}

module.exports = {
  start, chooseCustom, chooseGeneric, handleCustomModalSubmit, finalizeNoMedia, startMediaCollection,
};
