const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const creatorRepo = require('../db/creatorRepository');
const logger = require('../utils/logger');

// Per-member in-flight lock: ensureCreatorThread is legitimately called from two
// places for the same approval (handleModDecision directly, and the
// guildMemberUpdate listener the role-add triggers). Its own "check thread_id,
// then create" logic was just as non-atomic as findOrCreateCreator's old bug —
// two concurrent calls both saw thread_id as null and both created a thread,
// producing two real Discord threads for one creator (confirmed directly: two
// "Sparkle" threads 576ms apart, one silently orphaned when the second
// setThreadId overwrote the first). onConflict().ignore() can't fix this the way
// it fixed findOrCreateCreator, because creating a Discord thread is an external
// side effect, not a DB row — a second concurrent call has to wait for the first
// call's result instead of racing it. See docs/incident-2026-09-15-*.
const inFlight = new Map(); // `${guildId}:${memberId}` -> Promise<{creator, thread}>

async function ensureCreatorThread(guild, member) {
  const key = `${guild.id}:${member.id}`;
  if (inFlight.has(key)) return inFlight.get(key);

  const promise = provisionThread(guild, member).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

async function provisionThread(guild, member) {
  const creator = await creatorRepo.findOrCreateCreator(member.id, guild.id);

  if (creator.thread_id) {
    const existing = await guild.channels.fetch(creator.thread_id).catch(() => null);
    if (existing) return { creator, thread: existing };
  }

  const parent = await guild.channels.fetch(config.creatorSpacesChannelId);
  const thread = await parent.threads.create({
    name: member.displayName.slice(0, 90),
    autoArchiveDuration: 10080, // 7 days of inactivity
    reason: 'Creator space provisioned on role grant',
  });

  const welcome = await thread.send({
    content:
      `🎬 <@${member.id}>'s space — welcome, you're a creator now! 🎉\n\n` +
      "Here's everything in one place:\n\n" +
      '📸 **Posting** — two ways, whichever you like:\n' +
      '• Drop a photo/video right here with a caption, just like any normal channel — it shows up in the Feed automatically.\n' +
      `• Or click Post Content in <#${config.homeChannelId}> if you'd rather be guided step by step.\n\n` +
      '📢 **The Feed** — every post you make (either way) gets mirrored there, so people can find you without needing to know this thread exists.\n\n' +
      "📨 **Requests** — members can request specific content from you. Whatever boundaries you set are shown to them *before* they can send anything, so you never have to repeat yourself.\n\n" +
      '👤 **Profile** — anyone can check your status and recent posts from the Feed.\n\n' +
      `⚙️ **Settings** (in <#${config.homeChannelId}>) — update your boundaries anytime, take a break (your content stays up, requests pause, I'll check in when you're ready to return), or step down whenever — archive (reversible) or delete (permanent), your call.\n\n` +
      "One thing worth doing right now, so you're never caught off guard by a request:",
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`onboard_boundaries_${creator.id}`).setLabel('Set My Boundaries').setEmoji('📝').setStyle(ButtonStyle.Primary),
    )],
  });
  await welcome.pin().catch(() => {});

  await creatorRepo.setThreadId(creator.id, thread.id);
  logger.info(`Creator thread provisioned for ${member.id} in guild ${guild.id}`);

  return { creator: { ...creator, thread_id: thread.id }, thread };
}

module.exports = { ensureCreatorThread };
