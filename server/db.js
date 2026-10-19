const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const databasePath = path.resolve(process.env.GSQUAD_DB_PATH || 'data/gsquad.sqlite');
fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });

const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS admin_users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'super_admin')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    admin_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx ON admin_sessions(expires_at);

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    bot_enabled INTEGER NOT NULL DEFAULT 0 CHECK (bot_enabled IN (0, 1)),
    configured_stake_minor INTEGER NOT NULL DEFAULT 0 CHECK (configured_stake_minor >= 0),
    currency TEXT NOT NULL DEFAULT 'USD',
    is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT
  );
  CREATE INDEX IF NOT EXISTS users_status_idx ON users(status, bot_enabled);

  CREATE TABLE IF NOT EXISTS wallets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
    currency TEXT NOT NULL,
    balance_minor INTEGER NOT NULL DEFAULT 0 CHECK (balance_minor >= 0),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS wallet_ledger (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    entry_type TEXT NOT NULL CHECK (entry_type IN ('deposit', 'withdrawal', 'stake', 'profit', 'loss', 'adjustment')),
    direction TEXT NOT NULL CHECK (direction IN ('credit', 'debit')),
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    currency TEXT NOT NULL,
    balance_after_minor INTEGER NOT NULL CHECK (balance_after_minor >= 0),
    reference_type TEXT NOT NULL,
    reference_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_by_admin_id TEXT REFERENCES admin_users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS wallet_ledger_user_created_idx ON wallet_ledger(user_id, created_at);
  CREATE TRIGGER IF NOT EXISTS wallet_ledger_no_update
    BEFORE UPDATE ON wallet_ledger BEGIN
      SELECT RAISE(ABORT, 'Wallet ledger entries are immutable');
    END;
  CREATE TRIGGER IF NOT EXISTS wallet_ledger_no_delete
    BEFORE DELETE ON wallet_ledger BEGIN
      SELECT RAISE(ABORT, 'Wallet ledger entries are immutable');
    END;

  CREATE TABLE IF NOT EXISTS deposits (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    currency TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    payment_reference TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    reviewed_by_admin_id TEXT REFERENCES admin_users(id),
    reviewed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX IF NOT EXISTS deposits_payment_reference_unique
    ON deposits(payment_reference) WHERE payment_reference IS NOT NULL;

  CREATE TABLE IF NOT EXISTS withdrawals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    currency TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'paid')),
    payment_reference TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    reviewed_by_admin_id TEXT REFERENCES admin_users(id),
    reviewed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX IF NOT EXISTS withdrawals_payment_reference_unique
    ON withdrawals(payment_reference) WHERE payment_reference IS NOT NULL;

  CREATE TABLE IF NOT EXISTS trading_signals (
    id TEXT PRIMARY KEY,
    market TEXT NOT NULL,
    direction TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
    source TEXT NOT NULL,
    approved_by_admin_id TEXT REFERENCES admin_users(id),
    approved_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS trading_rounds (
    id TEXT PRIMARY KEY,
    signal_id TEXT NOT NULL UNIQUE REFERENCES trading_signals(id),
    mode TEXT NOT NULL CHECK (mode IN ('demo', 'live')),
    status TEXT NOT NULL CHECK (status IN ('collecting', 'frozen', 'approved', 'executing', 'settling', 'settled', 'rejected', 'failed')),
    combined_stake_minor INTEGER NOT NULL DEFAULT 0 CHECK (combined_stake_minor >= 0),
    currency TEXT NOT NULL,
    deriv_contract_id TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    frozen_at TEXT,
    settled_at TEXT
  );
  CREATE TRIGGER IF NOT EXISTS trading_rounds_frozen_values_immutable
    BEFORE UPDATE OF signal_id, combined_stake_minor, currency, frozen_at ON trading_rounds
    WHEN OLD.frozen_at IS NOT NULL AND (
      NEW.signal_id IS NOT OLD.signal_id OR
      NEW.combined_stake_minor IS NOT OLD.combined_stake_minor OR
      NEW.currency IS NOT OLD.currency OR
      NEW.frozen_at IS NOT OLD.frozen_at
    ) BEGIN
      SELECT RAISE(ABORT, 'Frozen round values cannot be changed');
    END;
  CREATE UNIQUE INDEX IF NOT EXISTS one_live_open_round
    ON trading_rounds(mode)
    WHERE mode = 'live' AND status IN ('collecting', 'frozen', 'approved', 'executing', 'settling');

  CREATE TABLE IF NOT EXISTS round_participants (
    round_id TEXT NOT NULL REFERENCES trading_rounds(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    stake_minor INTEGER NOT NULL CHECK (stake_minor > 0),
    allocated_result_minor INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (round_id, user_id)
  );
  CREATE TRIGGER IF NOT EXISTS round_participants_stake_frozen
    BEFORE UPDATE OF round_id, user_id, stake_minor ON round_participants BEGIN
      SELECT RAISE(ABORT, 'Frozen participant stakes cannot be changed');
    END;
  CREATE TRIGGER IF NOT EXISTS round_participants_no_late_insert
    BEFORE INSERT ON round_participants
    WHEN (SELECT frozen_at FROM trading_rounds WHERE id = NEW.round_id) IS NOT NULL BEGIN
      SELECT RAISE(ABORT, 'Participants cannot be added after a round is frozen');
    END;
  CREATE TRIGGER IF NOT EXISTS round_participants_no_frozen_delete
    BEFORE DELETE ON round_participants
    WHEN (SELECT frozen_at FROM trading_rounds WHERE id = OLD.round_id) IS NOT NULL BEGIN
      SELECT RAISE(ABORT, 'Frozen participants cannot be removed');
    END;

  CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,
    round_id TEXT NOT NULL UNIQUE REFERENCES trading_rounds(id),
    mode TEXT NOT NULL CHECK (mode IN ('demo', 'live')),
    contract_id TEXT UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected', 'failed')),
    actual_stake_minor INTEGER CHECK (actual_stake_minor IS NULL OR actual_stake_minor >= 0),
    payout_minor INTEGER CHECK (payout_minor IS NULL OR payout_minor >= 0),
    profit_loss_minor INTEGER,
    currency TEXT NOT NULL,
    confirmed_by_deriv INTEGER NOT NULL DEFAULT 0 CHECK (confirmed_by_deriv IN (0, 1)),
    executed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settlements (
    id TEXT PRIMARY KEY,
    round_id TEXT NOT NULL UNIQUE REFERENCES trading_rounds(id),
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
    actual_result_minor INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS risk_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    max_daily_loss_minor INTEGER CHECK (max_daily_loss_minor IS NULL OR max_daily_loss_minor >= 0),
    daily_profit_target_minor INTEGER CHECK (daily_profit_target_minor IS NULL OR daily_profit_target_minor >= 0),
    max_combined_stake_minor INTEGER CHECK (max_combined_stake_minor IS NULL OR max_combined_stake_minor >= 0),
    max_exposure_minor INTEGER CHECK (max_exposure_minor IS NULL OR max_exposure_minor >= 0),
    emergency_stop_enabled INTEGER NOT NULL DEFAULT 1 CHECK (emergency_stop_enabled IN (0, 1)),
    updated_by_admin_id TEXT REFERENCES admin_users(id),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    acknowledged_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS support_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    subject TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved')),
    assigned_admin_id TEXT REFERENCES admin_users(id),
    response TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    admin_id TEXT REFERENCES admin_users(id),
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    details_json TEXT NOT NULL DEFAULT '{}',
    ip_address TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at);
  CREATE TRIGGER IF NOT EXISTS audit_logs_no_update
    BEFORE UPDATE ON audit_logs BEGIN
      SELECT RAISE(ABORT, 'Audit log entries are immutable');
    END;
  CREATE TRIGGER IF NOT EXISTS audit_logs_no_delete
    BEFORE DELETE ON audit_logs BEGIN
      SELECT RAISE(ABORT, 'Audit log entries are immutable');
    END;

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_by_admin_id TEXT REFERENCES admin_users(id),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

module.exports = db;
