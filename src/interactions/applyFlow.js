const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder,
} = require('discord.js');
const config = require('../config');
const creatorRepo = require('../db/creatorRepository');
const applicationRepo = require('../db/applicationRepository');
const memberActivityRepo = require('../db/memberActivityRepository');
const guildSettingsRepo = require('../db/guildSettingsRepository');
const creatorSpace = require('../services/creatorSpace');
const logger = require('../utils/logger');

const drafts = new Map(); // userId -> { contentComfort, frequency, policyAccepted, tenureDays, postCount }

const FREQUENCY_OPTIONS = [
  { value: 'WEEKLY_1', label: 'At least 1x/week' },
  { value: 'WEEKLY_2', label: 'At least 2x/week' },
  { value: 'WEEKLY_3', label: 'At least 3x/week' },
];

function comfortSelect(current) {
  return new StringSelectMenuBuilder()
    .setCustomId('apply_comfort')
    .setPlaceholder(`Content comfort: ${current}`)
    .addOptions(
      { label: 'SFW only', value: 'SFW', default: current === 'SFW' },
      { label: 'NSFW only', value: 'NSFW', default: current === 'NSFW' },
      { label: 'Both', value: 'BOTH', default: current === 'BOTH' },
    );
}

function frequencySelect(current) {
  return new StringSelectMenuBuilder()
    .setCustomId('apply_frequency')
    .setPlaceholder(`Frequency: ${FREQUENCY_OPTIONS.find((f) => f.value === current)?.label || current}`)
    .addOptions(FREQUENCY_OPTIONS.map((f) => ({ ...f, default: f.value === current })));
}

function stepComponents(draft) {
  return [
    new ActionRowBuilder().addComponents(comfortSelect(draft.contentComfort)),
    new ActionRowBuilder().addComponents(frequencySelect(draft.frequency)),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('apply_view_policy').setLabel('View Policy').setEmoji('📄').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('apply_agree')
        .setLabel(draft.policyAccepted ? '✅ Agreed to Policy' : '☐ I Agree to the Creator Policy')
        .setStyle(draft.policyAccepted ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('apply_continue').setLabel('Continue →').setStyle(ButtonStyle.Primary),
    ),
  ];
}

// Discord requires the FIRST acknowledgment of an interaction within 3 seconds, or
// the interaction token dies and any reply fails with "Unknown interaction" (10062).
// This handler does up to 3 sequential DB round-trips before it knows what to say,
// so it defers immediately and edits the deferred reply once the checks are done —
// this is what actually broke in production on 2026-09-15, see docs/roadmap.md.
async function start(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const existingCreator = await creatorRepo.getCreatorByDiscordId(interaction.user.id, interaction.guildId);
  if (existingCreator && existingCreator.status !== 'STEPPED_DOWN') {
    return interaction.editReply({ content: "You're already a creator!" });
  }
  const pending = await applicationRepo.getPendingApplication(interaction.user.id, interaction.guildId);
  if (pending) {
    return interaction.editReply({ content: 'Your application is already under review — sit tight!' });
  }

  // Live settings, not the static config.js values — a mod can change these
  // anytime via /creator-settings without a restart, see guildSettingsRepository.js.
  const settings = await guildSettingsRepo.getSettings(interaction.guildId);
  const tenureDays = Math.floor((Date.now() - interaction.member.joinedAt.getTime()) / (1000 * 60 * 60 * 24));
  const postCount = await memberActivityRepo.getPostCount(interaction.user.id, interaction.guildId);
  const tenureOk = tenureDays >= settings.eligibility_min_tenure_days;
  const postsOk = postCount >= settings.eligibility_min_posts;

  if (!tenureOk || !postsOk) {
    const embed = new EmbedBuilder()
      .setTitle('Not quite eligible yet')
      .setDescription('Keep going — this unlocks automatically once you meet both:')
      .addFields(
        { name: 'Tenure', value: `${tenureOk ? '✅' : '❌'} ${tenureDays}/${settings.eligibility_min_tenure_days} days` },
        { name: 'Activity', value: `${postsOk ? '✅' : '❌'} ${postCount}/${settings.eligibility_min_posts} tracked posts` },
      )
      .setColor(0xFAA61A);
    return interaction.editReply({ embeds: [embed] });
  }

  drafts.set(interaction.user.id, {
    contentComfort: 'SFW', frequency: 'WEEKLY_1', policyAccepted: false, tenureDays, postCount,
  });
  await interaction.editReply({
    content: 'You qualify! Set a few details, agree to the policy, then continue.',
    components: stepComponents(drafts.get(interaction.user.id)),
  });
}

async function setComfort(interaction) {
  const draft = drafts.get(interaction.user.id);
  if (!draft) return interaction.reply({ content: 'Session expired — click Apply again.', ephemeral: true });
  draft.contentComfort = interaction.values[0];
  await interaction.update({ components: stepComponents(draft) });
}

async function setFrequency(interaction) {
  const draft = drafts.get(interaction.user.id);
  if (!draft) return interaction.reply({ content: 'Session expired — click Apply again.', ephemeral: true });
  draft.frequency = interaction.values[0];
  await interaction.update({ components: stepComponents(draft) });
}

async function viewPolicy(interaction) {
  const settings = await guildSettingsRepo.getSettings(interaction.guildId);
  const embed = new EmbedBuilder()
    .setTitle('📄 Creator Policy')
    .setDescription(settings.creator_policy || '_No policy has been set yet — ask a mod to add one with /creator-settings._')
    .setColor(0xE91E8C);
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function toggleAgree(interaction) {
  const draft = drafts.get(interaction.user.id);
  if (!draft) return interaction.reply({ content: 'Session expired — click Apply again.', ephemeral: true });
  draft.policyAccepted = !draft.policyAccepted;
  await interaction.update({ components: stepComponents(draft) });
}

async function continueToModal(interaction) {
  const draft = drafts.get(interaction.user.id);
  if (!draft) return interaction.reply({ content: 'Session expired — click Apply again.', ephemeral: true });
  if (!draft.policyAccepted) {
    return interaction.reply({ content: 'Please agree to the Creator Policy first.', ephemeral: true });
  }

  const modal = new ModalBuilder().setCustomId('apply_modal').setTitle('Almost done');
  const input = new TextInputBuilder()
    .setCustomId('reasoning')
    .setLabel('Why do you want to be a creator?')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(500)
    .setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

// Modal submission is itself a fresh interaction with its own 3-second clock — the
// DB write + mod-channel post below need the same defer-first treatment as start().
async function handleModalSubmit(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const draft = drafts.get(interaction.user.id);
  if (!draft) return interaction.editReply({ content: 'Session expired — click Apply again.' });
  const reasoning = interaction.fields.getTextInputValue('reasoning');

  const application = await applicationRepo.createApplication({
    discordUserId: interaction.user.id,
    guildId: interaction.guildId,
    contentComfort: draft.contentComfort,
    committedFrequency: draft.frequency,
    reasoning,
    policyAccepted: draft.policyAccepted,
    eligiblePostCount: draft.postCount,
    eligibleTenureDays: draft.tenureDays,
  });

  await postModCard(interaction.guild, application);
  drafts.delete(interaction.user.id);
  await interaction.editReply({ content: 'Application submitted! The mod team will review it soon.' });
}

// Takes `guild` rather than `interaction` so it's reusable outside a live
// interaction — e.g. src/scripts/postMissingModCard.js, used to recover an
// application whose DB write succeeded but whose mod card never got posted
// because of the 2026-09-15 duplicate-process incident (see docs/roadmap.md).
async function postModCard(guild, application) {
  const embed = new EmbedBuilder()
    .setTitle('🎯 New Creator Application')
    .addFields(
      { name: 'Applicant', value: `<@${application.discord_user_id}>` },
      { name: 'Eligibility', value: `${application.eligible_post_count} tracked posts · ${application.eligible_tenure_days} days tenure` },
      { name: 'Content comfort', value: application.content_comfort, inline: true },
      {
        name: 'Committed frequency',
        value: FREQUENCY_OPTIONS.find((f) => f.value === application.committed_frequency)?.label || application.committed_frequency,
        inline: true,
      },
      { name: 'Why', value: application.reasoning.slice(0, 1000) },
    )
    .setColor(0x43B581);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`modapp_approve_${application.id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`modapp_deny_${application.id}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
  );

  const channel = await guild.channels.fetch(config.modReviewChannelId);
  const message = await channel.send({ embeds: [embed], components: [row] });
  await applicationRepo.setModMessageId(application.id, message.id);
}

// Button interaction — deferUpdate() acknowledges by editing the original message
// (a no-op visually until editReply below), giving the same headroom as deferReply
// does for a fresh reply.
async function handleModDecision(interaction) {
  await interaction.deferUpdate();

  const [, action, appIdStr] = interaction.customId.split('_');
  const applicationId = Number(appIdStr);
  const application = await applicationRepo.getApplication(applicationId);
  if (!application) return interaction.followUp({ content: 'Application not found.', ephemeral: true });

  if (action === 'approve') {
    await applicationRepo.decide(applicationId, 'APPROVED', interaction.user.id);
    const member = await interaction.guild.members.fetch(application.discord_user_id).catch(() => null);
    if (member) await member.roles.add(config.creatorRoleId).catch((err) => logger.error(`Role assign failed: ${err.message}`));

    // Provisioned directly here rather than left to guildMemberUpdate alone: that
    // listener does fire correctly for this role add, but relying on it exclusively
    // means thread creation depends on a gateway roundtrip completing after this
    // handler returns. Calling it from both places is safe because
    // ensureCreatorThread() now holds a per-member in-flight lock — see
    // docs/incident-2026-09-15-duplicate-thread-race.md for why that lock exists;
    // without it, this deliberate double-call would recreate that exact bug.
    const { creator } = member
      ? await creatorSpace.ensureCreatorThread(interaction.guild, member)
      : { creator: await creatorRepo.findOrCreateCreator(application.discord_user_id, application.guild_id) };
    const defaultType = application.content_comfort === 'NSFW' ? 'NSFW' : 'SFW';
    await creatorRepo.setDefaultContentType(creator.id, defaultType);

    try {
      const user = await interaction.client.users.fetch(application.discord_user_id);
      await user.send("🎉 You're approved as a creator! Check the server — your space is ready.");
    } catch (err) { logger.warn(`Could not DM approved applicant: ${err.message}`); }
  } else {
    await applicationRepo.decide(applicationId, 'DENIED', interaction.user.id);
    try {
      const user = await interaction.client.users.fetch(application.discord_user_id);
      await user.send("Thanks for applying — you weren't approved this time. Feel free to apply again later.");
    } catch (err) { logger.warn(`Could not DM denied applicant: ${err.message}`); }
  }

  await interaction.editReply({
    content: `Decision: **${action.toUpperCase()}** by ${interaction.user.tag}`,
    embeds: interaction.message.embeds,
    components: [],
  });
}

module.exports = {
  start, setComfort, setFrequency, toggleAgree, continueToModal, handleModalSubmit, handleModDecision, postModCard,
  viewPolicy,
};
