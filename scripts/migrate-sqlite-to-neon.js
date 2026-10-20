const sqlite = require('../server/db');
const postgres = require('../server/postgres');

const tables = [
  'admin_users',
  'users',
  'risk_settings',
  'app_settings',
  'wallets',
  'admin_sessions',
  'user_sessions',
  'user_action_tokens',
  'user_notifications',
  'trading_signals',
  'trading_rounds',
  'round_participants',
  'trades',
  'settlements',
  'notifications',
  'support_requests',
  'wallet_ledger',
  'deposits',
  'withdrawals',
  'audit_logs',
];

function normalizeValue(value) {
  if (typeof value !== 'string') return value;
  return value.replace(
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/,
    '$1T$2Z',
  );
}

async function migrate() {
  await postgres.ready;
  const rowCounts = {};
  await postgres.transaction(async () => {
    for (const table of tables) {
      const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
      for (const row of rows) {
        const columns = Object.keys(row);
        const placeholders = columns.map(() => '?').join(', ');
        const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;
        await postgres.prepare(sql).run(...columns.map((column) => normalizeValue(row[column])));
      }
      rowCounts[table] = rows.length;
    }
  })();
  for (const [table, count] of Object.entries(rowCounts)) {
    console.log(`${table}: ${count}`);
  }
  console.log('SQLite data copied to Neon.');
}

migrate()
  .catch((error) => {
    console.error('Could not migrate SQLite data to Neon:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    sqlite.close();
    await postgres.close();
  });
