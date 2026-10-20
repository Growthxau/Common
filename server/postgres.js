const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { Pool, types } = require('pg');

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the Neon database.');

types.setTypeParser(20, (value) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError('PostgreSQL integer value exceeds the supported safe-integer range.');
  }
  return parsed;
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true },
  max: Number(process.env.PG_POOL_MAX) || 5,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
  allowExitOnIdle: true,
});
const transactionContext = new AsyncLocalStorage();
const POSTGRES_TIMESTAMP = `TO_CHAR(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const source = fs.readFileSync(path.join(__dirname, 'db.js'), 'utf8');
const schemaBlocks = [...source.matchAll(/db\.exec\(`([\s\S]*?)`\);/g)]
  .map((match) => match[1])
  .filter((block) => block.includes('CREATE TABLE IF NOT EXISTS'));

function postgresSchema(sql) {
  return sql
    .replace(/CREATE TRIGGER IF NOT EXISTS[\s\S]*?END;\s*/g, '')
    .replace(/\s+COLLATE NOCASE/g, '')
    .replace(/\bINTEGER\b/g, 'BIGINT')
    .replace(/DEFAULT CURRENT_TIMESTAMP/g, `DEFAULT (${POSTGRES_TIMESTAMP})`);
}

async function initialize() {
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query("SELECT pg_advisory_xact_lock(hashtext('g-squad-schema-init'))");
    for (const block of schemaBlocks) {
      const statements = postgresSchema(block).split(';').map((statement) => statement.trim()).filter(Boolean);
      for (const statement of statements) await client.query(statement);
    }
    for (const [column, definition] of [
      ['password_hash', 'TEXT'],
      ['max_daily_loss_minor', 'BIGINT CHECK (max_daily_loss_minor IS NULL OR max_daily_loss_minor >= 0)'],
      ['daily_profit_target_minor', 'BIGINT CHECK (daily_profit_target_minor IS NULL OR daily_profit_target_minor >= 0)'],
      ['email_verified', 'BIGINT NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1))'],
      ['notification_preferences_json', `TEXT NOT NULL DEFAULT '{"account":true,"wallet":true,"security":true}'`],
    ]) {
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
    }
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS admin_users_username_lower_unique ON admin_users (LOWER(username))');
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique ON users (LOWER(email))');
    await client.query(`
      CREATE OR REPLACE FUNCTION reject_immutable_change() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION '%', TG_ARGV[0];
      END;
      $$ LANGUAGE plpgsql
    `);
    for (const [table, operation, trigger, message] of [
      ['wallet_ledger', 'UPDATE', 'wallet_ledger_no_update', 'Wallet ledger entries are immutable'],
      ['wallet_ledger', 'DELETE', 'wallet_ledger_no_delete', 'Wallet ledger entries are immutable'],
      ['audit_logs', 'UPDATE', 'audit_logs_no_update', 'Audit log entries are immutable'],
      ['audit_logs', 'DELETE', 'audit_logs_no_delete', 'Audit log entries are immutable'],
    ]) {
      await client.query(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`);
      await client.query(`CREATE TRIGGER ${trigger} BEFORE ${operation} ON ${table}
        FOR EACH ROW EXECUTE FUNCTION reject_immutable_change('${message}')`);
    }
    await client.query(`
      CREATE OR REPLACE FUNCTION protect_frozen_round_values() RETURNS trigger AS $$
      BEGIN
        IF OLD.frozen_at IS NOT NULL AND (
          NEW.signal_id IS DISTINCT FROM OLD.signal_id OR
          NEW.combined_stake_minor IS DISTINCT FROM OLD.combined_stake_minor OR
          NEW.currency IS DISTINCT FROM OLD.currency OR
          NEW.frozen_at IS DISTINCT FROM OLD.frozen_at
        ) THEN
          RAISE EXCEPTION 'Frozen round values cannot be changed';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query('DROP TRIGGER IF EXISTS trading_rounds_frozen_values_immutable ON trading_rounds');
    await client.query(`CREATE TRIGGER trading_rounds_frozen_values_immutable
      BEFORE UPDATE OF signal_id, combined_stake_minor, currency, frozen_at ON trading_rounds
      FOR EACH ROW EXECUTE FUNCTION protect_frozen_round_values()`);
    await client.query(`
      CREATE OR REPLACE FUNCTION protect_frozen_participant() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          RAISE EXCEPTION 'Frozen participant stakes cannot be changed';
        END IF;
        IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM trading_rounds WHERE id = NEW.round_id AND frozen_at IS NOT NULL) THEN
          RAISE EXCEPTION 'Participants cannot be added after a round is frozen';
        END IF;
        IF TG_OP = 'DELETE' AND EXISTS (SELECT 1 FROM trading_rounds WHERE id = OLD.round_id AND frozen_at IS NOT NULL) THEN
          RAISE EXCEPTION 'Frozen participants cannot be removed';
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      const trigger = `round_participants_${operation.toLowerCase()}_guard`;
      await client.query(`DROP TRIGGER IF EXISTS ${trigger} ON round_participants`);
      await client.query(`CREATE TRIGGER ${trigger} BEFORE ${operation} ON round_participants
        FOR EACH ROW EXECUTE FUNCTION protect_frozen_participant()`);
    }
    await client.query('COMMIT');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const ready = initialize();

function bindParameters(sql, parameters) {
  let index = 0;
  const query = sql
    .replace(/\?/g, () => `$${++index}`)
    .replace(/date\('now'\)/gi, 'CURRENT_DATE::text')
    .replace(/\bCURRENT_TIMESTAMP\b/g, POSTGRES_TIMESTAMP);
  return { text: query, values: parameters.map((value) => value === undefined ? null : value) };
}

async function execute(sql, parameters) {
  await ready;
  const client = transactionContext.getStore() || pool;
  return client.query(bindParameters(sql, parameters));
}

module.exports = {
  ready,
  prepare(sql) {
    return {
      all: async (...parameters) => (await execute(sql, parameters)).rows,
      get: async (...parameters) => (await execute(sql, parameters)).rows[0],
      run: async (...parameters) => {
        const result = await execute(sql, parameters);
        return { changes: result.rowCount, rowCount: result.rowCount, rows: result.rows };
      },
    };
  },
  transaction(callback) {
    return async (...parameters) => {
      await ready;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await transactionContext.run(client, () => callback(...parameters));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };
  },
  async close() {
    await pool.end();
  },
};
