const knexFactory = require('knex');
const logger = require('../utils/logger');

// Swap DB engines by changing DB_CLIENT + DATABASE_URL — no other code changes required.
const client = process.env.DB_CLIENT || 'pg';

const db = knexFactory({
  client,
  connection: client === 'sqlite3'
    ? { filename: process.env.DATABASE_URL || './data.sqlite3' }
    : {
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_URL?.includes('.railway.internal') ? false : { rejectUnauthorized: false },
      },
  useNullAsDefault: client === 'sqlite3',
  pool: { min: 0, max: 10 },
});

async function initDb() {
  if (!(await db.schema.hasTable('creators'))) {
    await db.schema.createTable('creators', (t) => {
      t.increments('id').primary();
      t.string('discord_user_id', 20).notNullable();
      t.string('guild_id', 20).notNullable();
      // ACTIVE | ON_BREAK | STEPPED_DOWN — break/step-down flows land in a later phase,
      // the column exists now so no migration is needed when that phase ships.
      t.string('status', 20).notNullable().defaultTo('ACTIVE');
      t.text('bio');
      t.string('thread_id', 20); // personal space, created on Creator role grant
      t.string('default_content_type', 10).notNullable().defaultTo('SFW'); // used for native posts, which skip the type/requests picker
      t.boolean('requests_open').notNullable().defaultTo(true);
      // Shown to anyone requesting from this creator — deliberately plaintext,
      // since it's meant to be displayed, unlike request text below.
      t.text('boundaries');
      t.timestamp('break_return_at');
      t.string('step_down_mode', 10); // ARCHIVE | DELETE
      t.timestamp('applied_at');
      t.timestamp('approved_at');
      t.unique(['discord_user_id', 'guild_id']);
    });
  }

  if (!(await db.schema.hasTable('posts'))) {
    await db.schema.createTable('posts', (t) => {
      t.increments('id').primary();
      t.integer('creator_id').unsigned().notNullable().references('id').inTable('creators').onDelete('CASCADE');
      t.string('guild_id', 20).notNullable();
      t.string('media_url', 500).notNullable();
      t.string('content_type', 10).notNullable(); // SFW | NSFW
      t.boolean('requests_open').notNullable().defaultTo(true);
      t.text('caption');
      t.string('feed_message_id', 20);
      t.integer('like_count').unsigned().notNullable().defaultTo(0);
      t.timestamp('posted_at').notNullable().defaultTo(db.fn.now());
    });
  }

  if (!(await db.schema.hasTable('post_likes'))) {
    await db.schema.createTable('post_likes', (t) => {
      t.integer('post_id').unsigned().notNullable().references('id').inTable('posts').onDelete('CASCADE');
      t.string('discord_user_id', 20).notNullable();
      t.primary(['post_id', 'discord_user_id']);
    });
  }

  // Message counts in eligibility-tracked channels, going forward only — there is
  // no retroactive backfill from channel history.
  if (!(await db.schema.hasTable('member_activity'))) {
    await db.schema.createTable('member_activity', (t) => {
      t.string('discord_user_id', 20).notNullable();
      t.string('guild_id', 20).notNullable();
      t.integer('tracked_post_count').unsigned().notNullable().defaultTo(0);
      t.primary(['discord_user_id', 'guild_id']);
    });
  }

  if (!(await db.schema.hasTable('applications'))) {
    await db.schema.createTable('applications', (t) => {
      t.increments('id').primary();
      t.string('discord_user_id', 20).notNullable();
      t.string('guild_id', 20).notNullable();
      t.string('status', 20).notNullable().defaultTo('PENDING'); // PENDING | APPROVED | DENIED
      t.string('content_comfort', 10); // SFW | NSFW | BOTH
      t.string('committed_frequency', 20);
      t.text('reasoning');
      t.boolean('policy_accepted').notNullable().defaultTo(false);
      t.integer('eligible_post_count');
      t.integer('eligible_tenure_days');
      t.string('mod_message_id', 20);
      t.timestamp('applied_at').notNullable().defaultTo(db.fn.now());
      t.timestamp('decided_at');
      t.string('decided_by', 20);
    });
  }

  // request_text_enc holds a JSON.stringify()'d crypto wrapper ({__enc, v}) — stored
  // as plain text rather than a native JSON column so serialization behaves
  // identically across pg/mysql2/sqlite3 instead of depending on driver-specific
  // JSON handling.
  if (!(await db.schema.hasTable('requests'))) {
    await db.schema.createTable('requests', (t) => {
      t.increments('id').primary();
      t.integer('creator_id').unsigned().notNullable().references('id').inTable('creators').onDelete('CASCADE');
      t.integer('post_id').unsigned().references('id').inTable('posts').onDelete('SET NULL');
      t.string('requester_discord_id', 20).notNullable();
      t.string('guild_id', 20).notNullable();
      t.text('request_text_enc').notNullable();
      t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
    });
  }

  if (!(await db.schema.hasTable('conduct_reports'))) {
    await db.schema.createTable('conduct_reports', (t) => {
      t.increments('id').primary();
      t.string('reported_discord_id', 20).notNullable();
      t.string('reporter_discord_id', 20).notNullable();
      t.string('guild_id', 20).notNullable();
      t.integer('request_id').unsigned().references('id').inTable('requests').onDelete('SET NULL');
      // Only populated for native "Report Message" reports, whose content was
      // already publicly visible — request-linked reports decrypt via request_id
      // on demand instead of duplicating the sensitive text here in plaintext.
      t.text('context');
      t.text('reason');
      t.string('status', 20).notNullable().defaultTo('OPEN'); // OPEN | WARNED | RESTRICTED | ESCALATED | DISMISSED
      t.string('mod_message_id', 20);
      t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
      t.timestamp('handled_at');
      t.string('handled_by', 20);
    });
  }

  if (!(await db.schema.hasTable('restricted_members'))) {
    await db.schema.createTable('restricted_members', (t) => {
      t.string('discord_user_id', 20).notNullable();
      t.string('guild_id', 20).notNullable();
      t.timestamp('restricted_at').notNullable().defaultTo(db.fn.now());
      t.string('restricted_by', 20);
      t.primary(['discord_user_id', 'guild_id']);
    });
  }

  // Mod-editable rules, so changing eligibility thresholds or the creator policy
  // never requires touching .env or restarting the bot. Seeded once per guild from
  // the ELIGIBILITY_* env vars (see guildSettingsRepository.js) so the values
  // already configured there aren't lost — after that, this table is the source
  // of truth, editable via /creator-settings.
  if (!(await db.schema.hasTable('guild_settings'))) {
    await db.schema.createTable('guild_settings', (t) => {
      t.string('guild_id', 20).primary();
      t.integer('eligibility_min_posts').unsigned().notNullable();
      t.integer('eligibility_min_tenure_days').unsigned().notNullable();
      t.text('eligibility_tracked_channel_ids').notNullable().defaultTo(''); // comma-separated
      t.text('creator_policy');
      t.timestamp('updated_at').notNullable().defaultTo(db.fn.now());
      t.string('updated_by', 20);
    });
  }

  logger.info(`Database tables initialized (client: ${client})`);
}

module.exports = { db, initDb };
