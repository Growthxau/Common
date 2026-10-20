const express = require('express');
const { randomUUID } = require('node:crypto');
const db = require('./db');
const { audit, hashPassword } = require('./auth');
const { encryptSecret } = require('./secrets');

const router = express.Router();
const elevatedResources = new Set(['users', 'employees', 'connection', 'settings', 'deriv-credentials', 'risk-settings', 'deposits', 'withdrawals', 'rounds', 'ledger', 'audit']);

const defaultSettings = {
  organizationName: 'G-Squad',
  supportEmail: '',
  defaultCurrency: 'USD',
  timezone: 'UTC',
  appLogo: '',
};

const configurableSettings = new Set(Object.keys(defaultSettings));
const MAX_LOGO_BYTES = 1024 * 1024;

router.use((request, response, next) => {
  const resource = request.path.split('/').filter(Boolean)[0];
  if (request.admin.role !== 'super_admin' && elevatedResources.has(resource)) {
    return response.status(403).json({ error: 'This resource requires super-admin permission.' });
  }
  return next();
});

function count(sql) {
  return db.prepare(sql).get().count;
}

function balancesByCurrency(sql) {
  return db.prepare(sql).all().map((row) => ({
    currency: row.currency,
    amountMinor: row.total,
  }));
}

function readSettings() {
  const settings = { ...defaultSettings };
  for (const row of db.prepare('SELECT key, value_json FROM app_settings').all()) {
    if (configurableSettings.has(row.key)) settings[row.key] = JSON.parse(row.value_json);
  }
  return settings;
}

function readDerivCredentialStatus() {
  const appId = db.prepare("SELECT value_json FROM app_settings WHERE key = 'derivAppId'").get();
  const pat = db.prepare("SELECT value_json FROM app_settings WHERE key = 'derivPatEncrypted'").get();
  const derivAppId = appId ? JSON.parse(appId.value_json) : (process.env.DERIV_APP_ID || '');
  const derivPatConfigured = Boolean(pat || process.env.DERIV_PAT);
  return {
    derivAppId,
    derivAppIdConfigured: Boolean(derivAppId),
    derivPatConfigured,
    derivConfigured: Boolean(derivAppId && derivPatConfigured),
  };
}

function validSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (typeof value.organizationName !== 'string' || !value.organizationName.trim() || value.organizationName.trim().length > 80) return false;
  if (typeof value.supportEmail !== 'string' || value.supportEmail.length > 254) return false;
  if (value.supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.supportEmail)) return false;
  if (typeof value.defaultCurrency !== 'string' || !/^[A-Za-z]{3}$/.test(value.defaultCurrency)) return false;
  try {
    new Intl.NumberFormat('en', { style: 'currency', currency: value.defaultCurrency });
  } catch {
    return false;
  }
  if (typeof value.timezone !== 'string' || value.timezone.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value.timezone });
  } catch {
    return false;
  }
  if (value.appLogo !== undefined && typeof value.appLogo !== 'string') return false;
  if (value.appLogo) {
    const match = value.appLogo.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/);
    if (!match || match[2].length > Math.ceil(MAX_LOGO_BYTES / 3) * 4) return false;
    const image = Buffer.from(match[2], 'base64');
    if (image.length > MAX_LOGO_BYTES || image.toString('base64') !== match[2]) return false;
    const validImage = match[1] === 'image/png'
      ? image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : match[1] === 'image/jpeg'
        ? image[0] === 255 && image[1] === 216 && image[2] === 255
        : image.toString('ascii', 0, 4) === 'RIFF'
          && image.toString('ascii', 8, 12) === 'WEBP';
    if (!validImage) return false;
  }
  return true;
}

router.get('/overview', (request, response) => {
  const metrics = {
    totalUsers: count('SELECT COUNT(*) AS count FROM users WHERE is_demo = 0'),
    activeBots: count("SELECT COUNT(*) AS count FROM users WHERE is_demo = 0 AND status = 'active' AND bot_enabled = 1"),
    adminDerivBalanceMinor: null,
    walletLiabilitiesByCurrency: balancesByCurrency(`
      SELECT wallets.currency, SUM(wallets.balance_minor) AS total
      FROM wallets
      JOIN users ON users.id = wallets.user_id
      WHERE users.is_demo = 0
      GROUP BY wallets.currency ORDER BY wallets.currency
    `),
    dailyProfitLossByCurrency: balancesByCurrency(`
      SELECT currency, SUM(profit_loss_minor) AS total
      FROM trades
      WHERE mode = 'live' AND status = 'confirmed' AND confirmed_by_deriv = 1
        AND executed_at >= date('now')
      GROUP BY currency ORDER BY currency
    `),
    verifiedTradesToday: count(`
      SELECT COUNT(*) AS count FROM trades
      WHERE mode = 'live' AND status = 'confirmed' AND confirmed_by_deriv = 1
        AND executed_at >= date('now')
    `),
    combinedStakeByCurrency: balancesByCurrency(`
      SELECT currency, SUM(combined_stake_minor) AS total
      FROM trading_rounds
      WHERE mode = 'live' AND status IN ('frozen', 'approved', 'executing', 'settling')
      GROUP BY currency ORDER BY currency
    `),
    pendingDeposits: count(`
      SELECT COUNT(*) AS count FROM deposits
      JOIN users ON users.id = deposits.user_id
      WHERE deposits.status = 'pending' AND users.is_demo = 0
    `),
    pendingWithdrawals: count(`
      SELECT COUNT(*) AS count FROM withdrawals
      JOIN users ON users.id = withdrawals.user_id
      WHERE withdrawals.status = 'pending' AND users.is_demo = 0
    `),
    derivConfigured: Boolean(readDerivCredentialStatus().derivConfigured),
    derivConnected: false,
    tradingEnabled: false,
  };
  return response.json({ metrics });
});

router.get('/settings', (request, response) => {
  const riskSettings = db.prepare(`
    SELECT max_daily_loss_minor AS maxDailyLossMinor,
      daily_profit_target_minor AS dailyProfitTargetMinor,
      max_combined_stake_minor AS maxCombinedStakeMinor,
      max_exposure_minor AS maxExposureMinor,
      emergency_stop_enabled AS emergencyStopEnabled
    FROM risk_settings WHERE id = 1
  `).get() || {
    maxDailyLossMinor: null,
    dailyProfitTargetMinor: null,
    maxCombinedStakeMinor: null,
    maxExposureMinor: null,
    emergencyStopEnabled: 1,
  };
  return response.json({
    settings: readSettings(),
    riskSettings,
    tradingEnabled: false,
    ...readDerivCredentialStatus(),
    derivConnected: false,
  });
});

router.put('/settings', (request, response) => {
  const settings = request.body?.settings;
  if (!validSettings(settings)) {
    return response.status(400).json({ error: 'Application settings are invalid.' });
  }

  const saveSetting = db.prepare(`
    INSERT INTO app_settings (key, value_json, updated_by_admin_id, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_by_admin_id = excluded.updated_by_admin_id,
      updated_at = CURRENT_TIMESTAMP
  `);
  const normalizedSettings = {
    organizationName: settings.organizationName.trim(),
    supportEmail: settings.supportEmail.trim(),
    defaultCurrency: settings.defaultCurrency.toUpperCase(),
    timezone: settings.timezone.trim(),
    appLogo: settings.appLogo === undefined ? readSettings().appLogo : settings.appLogo,
  };
  const saveSettings = db.transaction(() => {
    for (const key of configurableSettings) {
      saveSetting.run(key, JSON.stringify(normalizedSettings[key]), request.admin.id);
    }
    audit({
      adminId: request.admin.id,
      action: 'settings.updated',
      targetType: 'application_settings',
      details: { keys: [...configurableSettings] },
      request,
    });
  });
  saveSettings();
  return response.json({ settings: readSettings() });
});

router.put('/deriv-credentials', (request, response) => {
  const credentials = request.body?.derivCredentials;
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)
      || typeof credentials.appId !== 'string' || !/^\d{1,20}$/.test(credentials.appId.trim())
      || typeof credentials.pat !== 'string' || credentials.pat.length > 512
      || (credentials.pat && !/^[A-Za-z0-9_-]{8,512}$/.test(credentials.pat))) {
    return response.status(400).json({ error: 'Deriv credentials are invalid.' });
  }
  if (credentials.pat && !process.env.GSQUAD_SECRETS_KEY) {
    return response.status(503).json({ error: 'Encrypted secret storage is not configured on the server.' });
  }

  let encryptedPat;
  try {
    if (credentials.pat) encryptedPat = encryptSecret(credentials.pat);
  } catch {
    return response.status(503).json({ error: 'Encrypted secret storage is not configured correctly.' });
  }

  const saveCredential = db.prepare(`
    INSERT INTO app_settings (key, value_json, updated_by_admin_id, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_by_admin_id = excluded.updated_by_admin_id,
      updated_at = CURRENT_TIMESTAMP
  `);
  try {
    db.transaction(() => {
      saveCredential.run('derivAppId', JSON.stringify(credentials.appId.trim()), request.admin.id);
      if (encryptedPat) saveCredential.run('derivPatEncrypted', JSON.stringify(encryptedPat), request.admin.id);
      audit({
        adminId: request.admin.id,
        action: 'deriv_credentials.updated',
        targetType: 'integration_credentials',
        details: { appIdChanged: true, patReplaced: Boolean(encryptedPat) },
        request,
      });
    })();
  } catch {
    return response.status(500).json({ error: 'Deriv credentials could not be saved.' });
  }

  const status = readDerivCredentialStatus();
  if (!status.derivAppIdConfigured || (encryptedPat && !status.derivPatConfigured)) {
    return response.status(500).json({ error: 'Deriv credentials were not persisted.' });
  }
  return response.json({ ...status, derivConnected: false });
});

router.put('/risk-settings', (request, response) => {
  const settings = request.body?.riskSettings;
  const numberFields = ['maxDailyLossMinor', 'dailyProfitTargetMinor', 'maxCombinedStakeMinor', 'maxExposureMinor'];
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)
      || numberFields.some((field) => settings[field] !== null
        && (!Number.isSafeInteger(settings[field]) || settings[field] < 0))
      || ![0, 1].includes(settings.emergencyStopEnabled)) {
    return response.status(400).json({ error: 'Risk settings are invalid.' });
  }
  const saveRiskSettings = db.prepare(`
    INSERT INTO risk_settings (
      id, max_daily_loss_minor, daily_profit_target_minor, max_combined_stake_minor,
      max_exposure_minor, emergency_stop_enabled, updated_by_admin_id, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      max_daily_loss_minor = excluded.max_daily_loss_minor,
      daily_profit_target_minor = excluded.daily_profit_target_minor,
      max_combined_stake_minor = excluded.max_combined_stake_minor,
      max_exposure_minor = excluded.max_exposure_minor,
      emergency_stop_enabled = excluded.emergency_stop_enabled,
      updated_by_admin_id = excluded.updated_by_admin_id,
      updated_at = CURRENT_TIMESTAMP
  `);
  db.transaction(() => {
    saveRiskSettings.run(
      settings.maxDailyLossMinor,
      settings.dailyProfitTargetMinor,
      settings.maxCombinedStakeMinor,
      settings.maxExposureMinor,
      settings.emergencyStopEnabled,
      request.admin.id,
    );
    audit({
      adminId: request.admin.id,
      action: 'risk_settings.updated',
      targetType: 'risk_settings',
      details: { emergencyStopEnabled: settings.emergencyStopEnabled },
      request,
    });
  })();
  return response.json({ riskSettings: settings });
});

router.post('/employees', async (request, response) => {
  const username = typeof request.body?.username === 'string'
    ? request.body.username.trim().toLowerCase()
    : '';
  const password = typeof request.body?.password === 'string' ? request.body.password : '';
  const role = request.body?.role;
  if (!/^[a-z0-9._-]{3,64}$/.test(username)
      || password.length < 14 || password.length > 1024
      || !['admin', 'super_admin'].includes(role)) {
    return response.status(400).json({ error: 'Enter a valid username, a password of at least 14 characters, and an available role.' });
  }

  const id = randomUUID();
  const passwordHash = await hashPassword(password);
  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO admin_users (id, username, password_hash, role)
        VALUES (?, ?, ?, ?)
      `).run(id, username, passwordHash, role);
      audit({
        adminId: request.admin.id,
        action: 'employee.created',
        targetType: 'admin_user',
        targetId: id,
        details: { username, role },
        request,
      });
    })();
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return response.status(409).json({ error: 'An employee with that username already exists.' });
    }
    throw error;
  }
  return response.status(201).json({ employee: { id, username, role } });
});

router.get('/rounds/:roundId/participants', (request, response) => {
  const round = db.prepare(`
    SELECT trading_rounds.id, trading_rounds.status, trading_rounds.currency,
      trading_rounds.combined_stake_minor AS combinedStakeMinor,
      trading_rounds.frozen_at AS frozenAt, trading_rounds.settled_at AS settledAt,
      settlements.status AS settlementStatus
    FROM trading_rounds
    LEFT JOIN settlements ON settlements.round_id = trading_rounds.id
    WHERE trading_rounds.id = ? AND trading_rounds.mode = 'live'
  `).get(request.params.roundId);
  if (!round) return response.status(404).json({ error: 'Trading round not found.' });

  const participants = db.prepare(`
    SELECT users.account_id AS accountId, users.display_name AS name,
      round_participants.stake_minor AS stakeMinor,
      round_participants.allocated_result_minor AS allocatedResultMinor
    FROM round_participants
    JOIN users ON users.id = round_participants.user_id
    WHERE round_participants.round_id = ?
    ORDER BY users.account_id
  `).all(request.params.roundId);
  return response.json({ round, participants });
});

const listQueries = {
  users: `
    SELECT users.id, users.account_id AS accountId, users.display_name AS name,
      users.email, users.email_verified AS emailVerified, users.status, users.bot_enabled AS botEnabled,
      users.configured_stake_minor AS configuredStakeMinor, users.currency,
      users.created_at AS createdAt,
      users.last_seen_at AS lastSeenAt, wallets.balance_minor AS walletBalanceMinor
    FROM users LEFT JOIN wallets ON wallets.user_id = users.id
    WHERE users.is_demo = 0
    ORDER BY users.created_at DESC LIMIT 500
  `,
  deposits: `
    SELECT deposits.id, users.account_id AS accountId, users.display_name AS userName,
      deposits.amount_minor AS amountMinor, deposits.currency, deposits.status,
      deposits.payment_reference AS paymentReference, deposits.created_at AS createdAt
    FROM deposits JOIN users ON users.id = deposits.user_id
    WHERE users.is_demo = 0
    ORDER BY deposits.created_at DESC LIMIT 500
  `,
  withdrawals: `
    SELECT withdrawals.id, users.account_id AS accountId, users.display_name AS userName,
      withdrawals.amount_minor AS amountMinor, withdrawals.currency, withdrawals.status,
      withdrawals.payment_reference AS paymentReference, withdrawals.created_at AS createdAt
    FROM withdrawals JOIN users ON users.id = withdrawals.user_id
    WHERE users.is_demo = 0
    ORDER BY withdrawals.created_at DESC LIMIT 500
  `,
  signals: `
    SELECT id, market, direction, status, source, approved_at AS approvedAt, created_at AS createdAt
    FROM trading_signals
    WHERE NOT EXISTS (
      SELECT 1 FROM trading_rounds
      WHERE trading_rounds.signal_id = trading_signals.id AND trading_rounds.mode = 'demo'
    )
    ORDER BY created_at DESC LIMIT 500
  `,
  trades: `
    SELECT trades.id, trades.round_id AS roundId, trades.mode, trades.contract_id AS contractId,
      trades.status, trades.actual_stake_minor AS actualStakeMinor,
      trades.payout_minor AS payoutMinor, trades.profit_loss_minor AS profitLossMinor,
      trades.currency, trades.confirmed_by_deriv AS confirmedByDeriv, trades.executed_at AS executedAt
    FROM trades WHERE trades.mode = 'live' ORDER BY trades.created_at DESC LIMIT 500
  `,
  rounds: `
    SELECT trading_rounds.id, trading_rounds.signal_id AS signalId, trading_rounds.mode,
      trading_rounds.status, trading_rounds.mode, trading_rounds.combined_stake_minor AS combinedStakeMinor,
      trading_rounds.currency, trading_rounds.deriv_contract_id AS contractId,
      COUNT(round_participants.user_id) AS participantCount,
      trading_rounds.created_at AS createdAt, trading_rounds.frozen_at AS frozenAt,
      trading_rounds.settled_at AS settledAt
    FROM trading_rounds
    LEFT JOIN round_participants ON round_participants.round_id = trading_rounds.id
    WHERE trading_rounds.mode = 'live'
    GROUP BY trading_rounds.id ORDER BY trading_rounds.created_at DESC LIMIT 500
  `,
  ledger: `
    SELECT wallet_ledger.id, users.account_id AS accountId, users.display_name AS userName,
      wallet_ledger.entry_type AS entryType, wallet_ledger.direction,
      wallet_ledger.amount_minor AS amountMinor, wallet_ledger.balance_after_minor AS balanceAfterMinor,
      wallet_ledger.currency,
      wallet_ledger.reference_type AS referenceType, wallet_ledger.reference_id AS referenceId,
      wallet_ledger.created_at AS createdAt
    FROM wallet_ledger JOIN users ON users.id = wallet_ledger.user_id
    WHERE users.is_demo = 0
    ORDER BY wallet_ledger.created_at DESC LIMIT 500
  `,
  notifications: `
    SELECT id, severity, category, title, message, acknowledged_at AS acknowledgedAt, created_at AS createdAt
    FROM notifications ORDER BY created_at DESC LIMIT 500
  `,
  support: `
    SELECT support_requests.id, users.account_id AS accountId, users.display_name AS userName,
      support_requests.subject, support_requests.message, support_requests.status,
      support_requests.response, support_requests.created_at AS createdAt,
      support_requests.updated_at AS updatedAt
    FROM support_requests JOIN users ON users.id = support_requests.user_id
    WHERE users.is_demo = 0
    ORDER BY support_requests.created_at DESC LIMIT 500
  `,
  audit: `
    SELECT audit_logs.id, admin_users.username AS admin, audit_logs.action,
      audit_logs.target_type AS targetType, audit_logs.target_id AS targetId,
      audit_logs.details_json AS details, audit_logs.ip_address AS ipAddress,
      audit_logs.created_at AS createdAt
    FROM audit_logs LEFT JOIN admin_users ON admin_users.id = audit_logs.admin_id
    ORDER BY audit_logs.created_at DESC LIMIT 500
  `,
  employees: `
    SELECT id, username, role, created_at AS createdAt, last_login_at AS lastLoginAt
    FROM admin_users ORDER BY created_at DESC LIMIT 500
  `,
};

router.get('/:resource', (request, response) => {
  const query = listQueries[request.params.resource];
  if (!query) return response.status(404).json({ error: 'Admin resource not found.' });
  return response.json({ records: db.prepare(query).all() });
});

module.exports = router;
