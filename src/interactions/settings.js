const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const creatorRepo = require('../db/creatorRepository');
const suspensionRepo = require('../db/creatorSuspensionRepository');

// Entry point from the home menu — shows a different set of options depending on
// whether the creator is active, on a break, archived, or suspended.
//
// Deliberately does NOT gate on currently holding the Creator role: Archive,
// Step Down, and Suspend all remove it, so gating here on role membership meant
// an archived creator could never see their own Reactivate button again — a real
// bug, not just a design choice. Gating on "does a creator record exist" instead
// covers every status correctly, including this one.
async function start(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const creator = await creatorRepo.getCreatorByDiscordId(interaction.user.id, interaction.guildId);
  if (!creator) return interaction.editReply({ content: 'No creator profile found yet — post something first!' });

  if (creator.status === 'SUSPENDED') {
    const open = await suspensionRepo.getOpenSuspension(creator.id);
    return interaction.editReply({
      content:
        "🚫 You're currently suspended and can't manage your creator settings.\n\n" +
        `**Reason:** ${open?.reason || '_not recorded_'}\n\n` +
        'A mod needs to lift this before anything changes — reach out if you have questions.',
    });
  }

  const row = new ActionRowBuilder();
  if (creator.status === 'STEPPED_DOWN' && creator.step_down_mode === 'ARCHIVE') {
    row.addComponents(
      new ButtonBuilder().setCustomId('settings_reactivate').setLabel('Reactivate').setEmoji('🔄').setStyle(ButtonStyle.Success),
    );
    return interaction.editReply({
      content: "You're currently archived. You can reactivate anytime — everything's still there.",
      components: [row],
    });
  }

  row.addComponents(
    new ButtonBuilder().setCustomId('settings_boundaries_btn').setLabel('Boundaries').setEmoji('📝').setStyle(ButtonStyle.Secondary),
  );
  if (creator.status === 'ON_BREAK') {
    row.addComponents(
      new ButtonBuilder().setCustomId('settings_reactivate').setLabel("I'm Back").setEmoji('✅').setStyle(ButtonStyle.Success),
    );
  } else {
    row.addComponents(
      new ButtonBuilder().setCustomId('settings_break_btn').setLabel('Take a Break').setEmoji('🟡').setStyle(ButtonStyle.Secondary),
    );
  }
  row.addComponents(
    new ButtonBuilder().setCustomId('settings_stepdown_btn').setLabel('Step Down').setEmoji('🔴').setStyle(ButtonStyle.Danger),
  );

  await interaction.editReply({
    content: `Current status: **${creator.status.replace('_', ' ')}**`,
    components: [row],
  });
}

async function showBoundariesModal(interaction) {
  const creator = await creatorRepo.getCreatorByDiscordId(interaction.user.id, interaction.guildId);
  const modal = new ModalBuilder().setCustomId('settings_boundaries_modal').setTitle('Your Boundaries');
  const input = new TextInputBuilder()
    .setCustomId('boundaries')
    .setLabel('What are you okay with? Not okay with?')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(500)
    .setRequired(false)
    .setValue(creator?.boundaries || '');
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

async function handleBoundariesSubmit(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const creator = await creatorRepo.findOrCreateCreator(interaction.user.id, interaction.guildId);
  const boundaries = interaction.fields.getTextInputValue('boundaries');
  await creatorRepo.updateBoundaries(creator.id, boundaries);
  await interaction.editReply({ content: 'Boundaries saved — shown to anyone who sends you a request.' });
}

// The onboarding welcome message posted in a creator's thread includes a Boundaries
// button — but that thread is visible to other members too, not just the creator,
// so unlike settings_boundaries_btn (only ever reached via the creator's own My
// Settings) this one must verify the clicker actually owns the thread before
// reusing the same modal, or it would silently edit the WRONG person's boundaries.
async function showBoundariesModalForThreadOwner(interaction) {
  const creatorId = Number(interaction.customId.split('_')[2]); // onboard_boundaries_<creatorId>
  const creator = await creatorRepo.getCreatorById(creatorId);
  if (!creator || creator.discord_user_id !== interaction.user.id) {
    return interaction.reply({ content: "This isn't your space — open My Settings from the home menu to edit your own boundaries.", ephemeral: true });
  }
  return showBoundariesModal(interaction);
}

module.exports = {
  start, showBoundariesModal, handleBoundariesSubmit, showBoundariesModalForThreadOwner,
};
