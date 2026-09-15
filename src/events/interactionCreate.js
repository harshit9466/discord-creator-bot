const logger = require('../utils/logger');
const homeMenu = require('../interactions/homeMenu');
const postFlow = require('../interactions/postFlow');
const feedCard = require('../interactions/feedCard');
const profile = require('../interactions/profile');
const settings = require('../interactions/settings');
const applyFlow = require('../interactions/applyFlow');
const requestFlow = require('../interactions/requestFlow');
const reports = require('../interactions/reports');
const statusFlow = require('../interactions/statusFlow');
const modRoster = require('../interactions/modRoster');
const modSettings = require('../interactions/modSettings');
const creatorDirectory = require('../interactions/creatorDirectory');
const modPanel = require('../interactions/modPanel');

// Resolves which handler a given interaction maps to, or null if none match.
// Kept separate from execute() so there is exactly one place that awaits the
// handler — see the comment below on why that single await matters.
function resolveHandler(interaction) {
  if (interaction.isChatInputCommand() && interaction.commandName === 'setup-creator-hub') {
    return homeMenu.postHomeMenu;
  }
  if (interaction.isChatInputCommand() && interaction.commandName === 'creator-roster') {
    return modRoster.postRoster;
  }
  if (interaction.isChatInputCommand() && interaction.commandName === 'creator-settings') {
    return modSettings.postPanel;
  }
  if (interaction.isChatInputCommand() && interaction.commandName === 'setup-mod-panel') {
    return modPanel.postPanel;
  }
  if (interaction.isMessageContextMenuCommand() && interaction.commandName === 'Report Message') {
    return reports.startFromMessage;
  }

  if (interaction.isButton()) {
    const id = interaction.customId;
    if (id === 'home_post') return postFlow.start;
    if (id === 'home_profile') return profile.showOwn;
    if (id === 'home_apply') return applyFlow.start;
    if (id === 'home_settings') return settings.start;
    if (id === 'home_directory') return creatorDirectory.postDirectory;

    if (id === 'postflow_next') return postFlow.handleNext;

    if (id === 'apply_view_policy') return applyFlow.viewPolicy;
    if (id === 'apply_agree') return applyFlow.toggleAgree;
    if (id === 'apply_continue') return applyFlow.continueToModal;
    if (id.startsWith('modapp_')) return applyFlow.handleModDecision;

    if (id === 'modsettings_edit_eligibility') return modSettings.showEligibilityModal;
    if (id === 'modsettings_edit_policy') return modSettings.showPolicyModal;
    if (id === 'modsettings_view_policy') return modSettings.viewFullPolicy;

    if (id === 'modpanel_roster') return modPanel.routeRoster;
    if (id === 'modpanel_settings') return modPanel.routeSettings;
    if (id === 'modpanel_manage') return modPanel.startManage;
    if (id === 'modpanel_escalated') return modPanel.startEscalated;
    if (id.startsWith('modpanel_suspend_')) return modPanel.showSuspendModal;
    if (id.startsWith('modpanel_lift_')) return modPanel.liftSuspension;
    if (id.startsWith('modpanel_archive_')) return modPanel.archiveCreator;
    if (id.startsWith('modpanel_delete_start_')) return modPanel.startDelete;
    if (id.startsWith('modpanel_delete_final_')) return modPanel.deleteFinal;
    if (id.startsWith('modpanel_delete_cancel_')) return modPanel.cancelDelete;
    if (id.startsWith('modpanel_resolve_')) return modPanel.resolveEscalated;

    if (id.startsWith('profile_')) return profile.showByCreatorId;
    if (id.startsWith('profilepage_')) return profile.changePage;

    if (id.startsWith('reqcontinue_')) return requestFlow.showModal;
    if (id.startsWith('reqstart_')) return requestFlow.start;
    if (id.startsWith('reqreport_')) return reports.startFromRequest;
    if (id.startsWith('modrep_')) return reports.handleModAction;

    if (id === 'settings_boundaries_btn') return settings.showBoundariesModal;
    if (id.startsWith('onboard_boundaries_')) return settings.showBoundariesModalForThreadOwner;
    if (id === 'settings_break_btn') return statusFlow.startBreak;
    if (id.startsWith('break_dur_')) return statusFlow.setBreakDuration;
    if (id === 'settings_stepdown_btn') return statusFlow.startStepDown;
    if (id === 'stepdown_cancel') return statusFlow.cancelStepDown;
    if (id === 'stepdown_archive') return statusFlow.archiveStepDown;
    if (id === 'stepdown_delete_confirm') return statusFlow.confirmDelete;
    if (id === 'stepdown_delete_final') return statusFlow.deleteStepDown;
    if (id === 'settings_reactivate') return statusFlow.reactivate;
    if (id.startsWith('checkin_back_')) return statusFlow.handleCheckinBack;
    if (id.startsWith('checkin_more_')) return statusFlow.handleCheckinMore;
    if (id.startsWith('checkindur_')) return statusFlow.handleCheckinMoreDuration;
    return null;
  }

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'postflow_type') return postFlow.setType;
    if (interaction.customId === 'postflow_requests') return postFlow.setRequests;
    if (interaction.customId === 'apply_comfort') return applyFlow.setComfort;
    if (interaction.customId === 'apply_frequency') return applyFlow.setFrequency;
    if (interaction.customId === 'directory_select') return creatorDirectory.handleSelect;
    if (interaction.customId === 'modpanel_select_creator') return modPanel.selectCreator;
    if (interaction.customId === 'modpanel_select_escalated') return modPanel.selectEscalated;
    return null;
  }

  if (interaction.isModalSubmit()) {
    const id = interaction.customId;
    if (id === 'postflow_caption_modal') return postFlow.handleCaptionSubmit;
    if (id === 'settings_boundaries_modal') return settings.handleBoundariesSubmit;
    if (id === 'apply_modal') return applyFlow.handleModalSubmit;
    if (id.startsWith('reqmodal_')) return requestFlow.handleModalSubmit;
    if (id.startsWith('reqreportmodal_')) return reports.handleRequestReportModal;
    if (id === 'modsettings_eligibility_modal') return modSettings.handleEligibilitySubmit;
    if (id === 'modsettings_policy_modal') return modSettings.handlePolicySubmit;
    if (id.startsWith('modpanel_suspendmodal_')) return modPanel.handleSuspendSubmit;
    return null;
  }

  return null;
}

module.exports = {
  name: 'interactionCreate',
  once: false,
  async execute(interaction) {
    const handler = resolveHandler(interaction);
    if (!handler) return;

    try {
      // This await is load-bearing: `return handler(interaction)` without it looks
      // identical when nothing throws, but a rejection from inside handler() then
      // surfaces after this try/catch's stack has already unwound, skips the catch
      // entirely, and hits index.js's uncaughtException handler instead — which
      // calls process.exit(1). That's exactly what took the whole bot down on
      // 2026-09-15 (see docs/roadmap.md): a single expired interaction token
      // crashed every connection, not just that one reply.
      await handler(interaction);
    } catch (err) {
      logger.error('Interaction handling failed:', { error: err.message, customId: interaction.customId });
      if (!interaction.isRepliable()) return;
      const payload = { content: 'Something went wrong — please try again.', ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
  },
};
