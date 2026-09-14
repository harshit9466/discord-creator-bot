const logger = require('../utils/logger');
const creatorRepo = require('../db/creatorRepository');
const statusFlow = require('../interactions/statusFlow');

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly is plenty for a return date, not a live deadline

async function runBreakCheckins(client) {
  const due = await creatorRepo.getCreatorsOnBreakPastReturn().catch((err) => {
    logger.error('Break check-in query failed:', { error: err.message });
    return [];
  });
  for (const creator of due) {
    await statusFlow.sendBreakCheckin(client, creator);
  }
  if (due.length) logger.info(`Sent ${due.length} break check-in(s).`);
}

module.exports = {
  name: 'clientReady',
  once: true,
  execute(client) {
    logger.info(`Logged in as ${client.user.tag}`);
    setInterval(() => runBreakCheckins(client), CHECK_INTERVAL_MS);
    runBreakCheckins(client).catch((err) => logger.error('Initial break check-in run failed:', { error: err.message }));
  },
};
