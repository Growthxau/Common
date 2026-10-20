const express = require('express');
const { randomBytes, randomUUID } = require('node:crypto');
const db = require('./database');
const { audit, hashPassword, hashToken } = require('./auth');
const { encryptSecret } = require('./secrets');
const { createAccountId } = require('./user');
const { sendAccountLink, smtpConfiguration } = require('./mailer');

const router = express.Router();
const elevatedResources = new Set(['members', 'transactions', 'employees', 'connection', 'settings', 'deriv-credentials', 'risk-settings', 'rounds', 'ledger']);
const validPermissions = new Set([
  'users.read',
  'users.manage',
  'users.export',
  'transactions.read',
  'transactions.review',
  'audit.read',
  'employees.manage',
  'settings.manage',
  'support.manage',
  'alerts.manage',
]);

const defaultSettings = {
  organizationName: 'G-Squad',
  supportEmail: '',
  defaultCurrency: 'USD',
  timezone: 'UTC',
  appLogo: '',
  memberRegistrationEnabled: true,
  notificationCategories: { account: true, wallet: true, security: true },
};

const configurableSettings = new Set(Object.keys(defaultSettings));
const MAX_LOGO_BYTES = 1024 * 1024;

router.use((request, response, next) => {
  const resource = request.path.split('/').filter(Boolean)[0];
  if (request.admin.role === 'super_admin') return next();

  let permission;
  if (resource === 'users') {
    permission = request.path.endsWith('/export')
      ? 'users.export'
      : ['PATCH', 'DELETE'].includes(request.method)
        || (request.method === 'POST' && request.path.endsWith('/password'))
        || (request.method === 'POST' && request.path.endsWith('/recovery'))
        ? 'users.manage'
        : request.method === 'GET'
          ? 'users.read'
          : 'users.manage';
  } else if (resource === 'members') {
    permission = 'users.manage';
  } else if (resource === 'deposits' || resource === 'withdrawals') {
    permission = request.method === 'GET' ? 'transactions.read' : 'transactions.review';
  } else if (resource === 'transactions') {
    permission = request.method === 'POST' ? 'transactions.review' : 'transactions.read';
  } else if (resource === 'audit') {
    permission = 'audit.read';
  } else if (resource === 'employees') {
    permission = request.method === 'GET' ? 'employees.manage' : 'employees.manage';
  } else if (resource === 'settings') {
    permission = request.method === 'GET' ? 'settings.manage' : 'settings.manage';
  } else if (resource === 'risk-settings') {
    permission = 'settings.manage';
  } else if (resource === 'support') {
    permission = request.method === 'GET' ? 'support.manage' : 'support.manage';
  } else if (resource === 'notifications') {
    permission = request.method === 'GET' ? 'alerts.manage' : 'alerts.manage';
  }

  const permissions = request.admin.permissions || [];
  const hasPermission = permission === 'users.read'
    ? permissions.includes('users.read') || permissions.includes('users.manage') || permissions.includes('users.export')
    : permission === 'transactions.read'
      ? permissions.includes('transactions.read') || permissions.includes('transactions.review')
      : permissions.includes(permission);
  if (permission && hasPermission) return next();
  if (!permission && !elevatedResources.has(resource)) return next();
  if (request.admin.role !== 'super_admin') {
    return response.status(403).json({ error: 'This resource requires super-admin permission.' });
  }
  return next();
});

async function notifyMember(userId, category, title, message) {
  const categoriesSetting = await db.prepare("SELECT value_json FROM app_settings WHERE key = 'notificationCategories'").get();
  const categories = categoriesSetting ? parseJson(categoriesSetting.value_json, {}) : { account: true, wallet: true, security: true };
  if (categories[category] === false) return;
  await db.prepare(`
    INSERT INTO user_notifications (id, user_id, category, title, message)
    VALUES (?, ?, ?, ?, ?)
  `).run(randomUUID(), userId, category, title, message);
}

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

async function count(sql) {
  return Number((await db.prepare(sql).get()).count);
}

async function balancesByCurrency(sql) {
  return (await db.prepare(sql).all()).map((row) => ({
    currency: row.currency,
    amountMinor: Number(row.total),
  }));
}

async function readSettings() {
  const settings = { ...defaultSettings };
  for (const row of await db.prepare('SELECT key, value_json FROM app_settings').all()) {
    if (configurableSettings.has(row.key)) settings[row.key] = JSON.parse(row.value_json);
  }
  return settings;
}

async function readDerivCredentialStatus() {
  const appId = await db.prepare("SELECT value_json FROM app_settings WHERE key = 'derivAppId'").get();
  const pat = await db.prepare("SELECT value_json FROM app_settings WHERE key = 'derivPatEncrypted'").get();
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
  if (value.memberRegistrationEnabled !== undefined && typeof value.memberRegistrationEnabled !== 'boolean') return false;
  if (value.notificationCategories !== undefined
      && (!value.notificationCategories || typeof value.notificationCategories !== 'object'
        || Array.isArray(value.notificationCategories)
        || ['account', 'wallet', 'security'].some((category) => typeof value.notificationCategories[category] !== 'boolean'))) return false;
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

router.get('/overview', async (request, response) => {
  const metrics = {
    totalUsers: await count('SELECT COUNT(*) AS count FROM users WHERE is_demo = 0'),
    activeBots: await count("SELECT COUNT(*) AS count FROM users WHERE is_demo = 0 AND status = 'active' AND bot_enabled = 1"),
    adminDerivBalanceMinor: null,
    walletLiabilitiesByCurrency: await balancesByCurrency(`
      SELECT wallets.currency, SUM(wallets.balance_minor) AS total
      FROM wallets
      JOIN users ON users.id = wallets.user_id
      WHERE users.is_demo = 0
      GROUP BY wallets.currency ORDER BY wallets.currency
    `),
    dailyProfitLossByCurrency: await balancesByCurrency(`
      SELECT currency, SUM(profit_loss_minor) AS total
      FROM trades
      WHERE mode = 'live' AND status = 'confirmed' AND confirmed_by_deriv = 1
        AND executed_at >= date('now')
      GROUP BY currency ORDER BY currency
    `),
    verifiedTradesToday: await count(`
      SELECT COUNT(*) AS count FROM trades
      WHERE mode = 'live' AND status = 'confirmed' AND confirmed_by_deriv = 1
        AND executed_at >= date('now')
    `),
    combinedStakeByCurrency: await balancesByCurrency(`
      SELECT currency, SUM(combined_stake_minor) AS total
      FROM trading_rounds
      WHERE mode = 'live' AND status IN ('frozen', 'approved', 'executing', 'settling')
      GROUP BY currency ORDER BY currency
    `),
    pendingDeposits: await count(`
      SELECT COUNT(*) AS count FROM deposits
      JOIN users ON users.id = deposits.user_id
      WHERE deposits.status = 'pending' AND users.is_demo = 0
    `),
    pendingWithdrawals: await count(`
      SELECT COUNT(*) AS count FROM withdrawals
      JOIN users ON users.id = withdrawals.user_id
      WHERE withdrawals.status = 'pending' AND users.is_demo = 0
    `),
    derivConfigured: Boolean((await readDerivCredentialStatus()).derivConfigured),
    derivConnected: false,
    tradingEnabled: false,
  };
  return response.json({ metrics });
});

router.get('/settings', async (request, response) => {
  const riskSettings = await db.prepare(`
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
    settings: await readSettings(),
    riskSettings,
    tradingEnabled: false,
    ...await readDerivCredentialStatus(),
    derivConnected: false,
  });
});

router.put('/settings', async (request, response) => {
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
    appLogo: settings.appLogo === undefined ? (await readSettings()).appLogo : settings.appLogo,
    memberRegistrationEnabled: settings.memberRegistrationEnabled ?? (await readSettings()).memberRegistrationEnabled,
    notificationCategories: settings.notificationCategories || (await readSettings()).notificationCategories,
  };
  const saveSettings = db.transaction(async () => {
    for (const key of configurableSettings) {
      await saveSetting.run(key, JSON.stringify(normalizedSettings[key]), request.admin.id);
    }
    await audit({
      adminId: request.admin.id,
      action: 'settings.updated',
      targetType: 'application_settings',
      details: { keys: [...configurableSettings] },
      request,
    });
  });
  await saveSettings();
  return response.json({ settings: await readSettings() });
});

router.put('/deriv-credentials', async (request, response) => {
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
    await db.transaction(async () => {
      await saveCredential.run('derivAppId', JSON.stringify(credentials.appId.trim()), request.admin.id);
      if (encryptedPat) await saveCredential.run('derivPatEncrypted', JSON.stringify(encryptedPat), request.admin.id);
      await audit({
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

  const status = await readDerivCredentialStatus();
  if (!status.derivAppIdConfigured || (encryptedPat && !status.derivPatConfigured)) {
    return response.status(500).json({ error: 'Deriv credentials were not persisted.' });
  }
  return response.json({ ...status, derivConnected: false });
});

router.put('/risk-settings', async (request, response) => {
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
  await db.transaction(async () => {
    await saveRiskSettings.run(
      settings.maxDailyLossMinor,
      settings.dailyProfitTargetMinor,
      settings.maxCombinedStakeMinor,
      settings.maxExposureMinor,
      settings.emergencyStopEnabled,
      request.admin.id,
    );
    await audit({
      adminId: request.admin.id,
      action: 'risk_settings.updated',
      targetType: 'risk_settings',
      details: { emergencyStopEnabled: settings.emergencyStopEnabled },
      request,
    });

    router.patch('/support/:requestId', async (request, response) => {
      const status = request.body?.status;
      const responseText = typeof request.body?.response === 'string' ? request.body.response.trim() : '';
      const assignedAdminId = request.body?.assignedAdminId ?? null;
      if (!['open', 'in_progress', 'resolved'].includes(status)
          || responseText.length > 2000
          || (assignedAdminId !== null && (typeof assignedAdminId !== 'string'
            || !await db.prepare('SELECT id FROM admin_users WHERE id = ?').get(assignedAdminId)))) {
        return response.status(400).json({ error: 'Support update is invalid.' });
      }
      const supportRequest = await db.prepare(`
        SELECT id, user_id AS userId FROM support_requests WHERE id = ?
      `).get(request.params.requestId);
      if (!supportRequest) return response.status(404).json({ error: 'Support request not found.' });
      await db.transaction(async () => {
        await db.prepare(`
          UPDATE support_requests SET status = ?, response = ?, assigned_admin_id = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(status, responseText || null, assignedAdminId, supportRequest.id);
        await audit({
          adminId: request.admin.id,
          action: 'support_request.updated',
          targetType: 'support_request',
          targetId: supportRequest.id,
          details: { status, assignedAdminId },
          request,
        });
        if (responseText) {
          await notifyMember(supportRequest.userId, 'account', 'Support request updated', `An administrator responded to your support request: ${responseText}`);
        }
      })();
      return response.json({ updated: true });
    });

    router.post('/notifications/:notificationId/acknowledge', async (request, response) => {
      const result = await db.prepare(`
        UPDATE notifications SET acknowledged_at = CURRENT_TIMESTAMP
        WHERE id = ? AND acknowledged_at IS NULL
      `).run(request.params.notificationId);
      if (!result.changes && !await db.prepare('SELECT id FROM notifications WHERE id = ?').get(request.params.notificationId)) {
        return response.status(404).json({ error: 'Alert not found.' });
      }
      await audit({
        adminId: request.admin.id,
        action: 'alert.acknowledged',
        targetType: 'notification',
        targetId: request.params.notificationId,
        request,
      });
      return response.json({ acknowledged: true });
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
  const permissions = request.body?.permissions;
  if (!/^[a-z0-9._-]{3,64}$/.test(username)
      || password.length < 14 || password.length > 1024
      || !['admin', 'super_admin'].includes(role)
      || (permissions !== undefined && (!Array.isArray(permissions)
        || permissions.some((permission) => !validPermissions.has(permission))))) {
    return response.status(400).json({ error: 'Enter a valid username, a password of at least 14 characters, and an available role.' });
  }
  if (request.admin.role !== 'super_admin' && (role !== 'admin'
      || (permissions || []).some((permission) => !(request.admin.permissions || []).includes(permission)))) {
    return response.status(403).json({ error: 'You may only create scoped admins with permissions you already hold.' });
  }

  const id = randomUUID();
  const passwordHash = await hashPassword(password);
  const assignedPermissions = role === 'admin' ? [...new Set(permissions || [])] : [];
  try {
    await db.transaction(async () => {
      await db.prepare(`
        INSERT INTO admin_users (id, username, password_hash, role, permissions_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, username, passwordHash, role, JSON.stringify(assignedPermissions));
      await audit({
        adminId: request.admin.id,
        action: 'employee.created',
        targetType: 'admin_user',
        targetId: id,
        details: { username, role, permissions: assignedPermissions },
        request,
      });
    })();
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.code === '23505') {
      return response.status(409).json({ error: 'An employee with that username already exists.' });
    }
    throw error;
  }
  return response.status(201).json({ employee: { id, username, role, permissions: assignedPermissions } });
});

router.patch('/employees/:employeeId/permissions', async (request, response) => {
  const permissions = request.body?.permissions;
  if (!Array.isArray(permissions) || permissions.some((permission) => !validPermissions.has(permission))) {
    return response.status(400).json({ error: 'Select valid staff permissions.' });
  }
  const employee = await db.prepare('SELECT id, role, username FROM admin_users WHERE id = ?')
    .get(request.params.employeeId);
  if (!employee) return response.status(404).json({ error: 'Employee not found.' });
  if (employee.role === 'super_admin') {
    return response.status(400).json({ error: 'Super-admin permissions cannot be customized.' });
  }
  const assignedPermissions = [...new Set(permissions)];
  if (request.admin.role !== 'super_admin'
      && assignedPermissions.some((permission) => !(request.admin.permissions || []).includes(permission))) {
    return response.status(403).json({ error: 'You may only assign permissions you already hold.' });
  }
  await db.transaction(async () => {
    await db.prepare('UPDATE admin_users SET permissions_json = ? WHERE id = ?')
      .run(JSON.stringify(assignedPermissions), employee.id);
    await audit({
      adminId: request.admin.id,
      action: 'employee.permissions_updated',
      targetType: 'admin_user',
      targetId: employee.id,
      details: { username: employee.username, permissions: assignedPermissions },
      request,
    });
  })();
  return response.json({ permissions: assignedPermissions });
});

router.post('/members', async (request, response) => {
  const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
  const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
  if (name.length < 2 || name.length > 80
      || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return response.status(400).json({ error: 'Enter a valid member name and email address.' });
  }
  if (!smtpConfiguration()) {
    return response.status(503).json({ error: 'Member creation is unavailable because email verification is not configured.' });
  }

  const id = randomUUID();
  const verificationToken = randomBytes(32).toString('base64url');
  const verificationExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  let accountId;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    accountId = createAccountId();
    try {
      await db.transaction(async () => {
        await db.prepare(`
          INSERT INTO users (id, account_id, display_name, email, currency, email_verified)
          VALUES (?, ?, ?, ?, 'USD', 0)
        `).run(id, accountId, name, email);
        await db.prepare('INSERT INTO wallets (id, user_id, currency, balance_minor) VALUES (?, ?, ?, 0)')
          .run(randomUUID(), id, 'USD');
        await db.prepare(`
          INSERT INTO user_action_tokens (token_hash, user_id, action, expires_at)
          VALUES (?, ?, 'verify_email', ?)
        `).run(hashToken(verificationToken), id, verificationExpiresAt);
        await audit({
          adminId: request.admin.id,
          action: 'member.created',
          targetType: 'user',
          targetId: id,
          details: { accountId, email },
          request,
        });
      })();
      break;
    } catch (error) {
      if (error.code !== 'SQLITE_CONSTRAINT_UNIQUE' && error.code !== '23505') throw error;
      if (await db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
        return response.status(409).json({ error: 'A member with that email already exists.' });
      }
      if (attempt === 2) throw error;
    }
  }

  try {
    await sendAccountLink({ request, email, name, token: verificationToken, type: 'verify_email' });
  } catch (error) {
    console.error('Could not send admin-created member verification email:', error.message);
    return response.status(503).json({
      error: 'The member account was created, but the verification email could not be sent. Resend verification from the member sign-in page.',
      nextStep: 'resend_verification',
    });
  }
  return response.status(201).json({ member: { id, accountId, name, email, status: 'active' } });
});

router.get('/users/lookup', async (request, response) => {
  const query = typeof request.query.q === 'string' ? request.query.q.trim() : '';
  if (query.length < 3 || query.length > 254) {
    return response.status(400).json({ error: 'Enter an account ID or email address.' });
  }
  const user = await db.prepare(`
    SELECT users.id, users.account_id AS accountId, users.display_name AS name,
      users.email, users.email_verified AS emailVerified, users.status,
      users.bot_enabled AS botEnabled, users.configured_stake_minor AS configuredStakeMinor,
      users.currency, users.created_at AS createdAt, users.last_seen_at AS lastSeenAt,
      wallets.balance_minor AS walletBalanceMinor
    FROM users LEFT JOIN wallets ON wallets.user_id = users.id
    WHERE users.is_demo = 0 AND (LOWER(users.account_id) = LOWER(?) OR LOWER(users.email) = LOWER(?))
  `).get(query, query);
  return response.json({ user: user || null });
});

router.patch('/users/:userId', async (request, response) => {
  const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
  const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
  const status = request.body?.status;
  if (name.length < 2 || name.length > 80
      || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      || !['active', 'suspended'].includes(status)) {
    return response.status(400).json({ error: 'Member name, email, or account status is invalid.' });
  }
  const user = await db.prepare('SELECT id, email FROM users WHERE id = ? AND is_demo = 0').get(request.params.userId);
  if (!user) return response.status(404).json({ error: 'Member not found.' });
  try {
    await db.transaction(async () => {
      await db.prepare(`
        UPDATE users SET display_name = ?, email = ?, status = ?,
          email_verified = CASE WHEN email = ? THEN email_verified ELSE 0 END,
          bot_enabled = CASE WHEN ? = 'active' THEN bot_enabled ELSE 0 END
        WHERE id = ?
      `).run(name, email, status, email, status, user.id);
      if (status !== 'active' || email !== user.email) {
        await db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(user.id);
      }
      if (status !== 'active' || email !== user.email) {
        await db.prepare('DELETE FROM user_action_tokens WHERE user_id = ?').run(user.id);
      }
      await notifyMember(
        user.id,
        status !== 'active' ? 'security' : 'account',
        status !== 'active' ? 'Account suspended' : 'Account information changed',
        status !== 'active'
          ? 'An administrator suspended your account. Contact support if you believe this was a mistake.'
          : email !== user.email
            ? 'Your account email was changed. Verify the new email address before signing in.'
            : 'An administrator updated your account information.',
      );
      await audit({
        adminId: request.admin.id,
        action: 'member.updated',
        targetType: 'user',
        targetId: user.id,
        details: { name, email, status },
        request,
      });
    })();
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.code === '23505') {
      return response.status(409).json({ error: 'A member with that email already exists.' });
    }
    throw error;
  }
  return response.json({ updated: true });
});

router.post('/users/:userId/recovery', async (request, response) => {
  const action = request.body?.action;
  if (!['resend_verification', 'send_password_reset', 'reactivate'].includes(action)) {
    return response.status(400).json({ error: 'Choose a valid account recovery action.' });
  }
  const user = await db.prepare(`
    SELECT id, display_name AS name, email, status, email_verified AS emailVerified
    FROM users WHERE id = ? AND is_demo = 0
  `).get(request.params.userId);
  if (!user) return response.status(404).json({ error: 'Member not found.' });
  if (action === 'resend_verification' && user.emailVerified) {
    return response.status(400).json({ error: 'This member email is already verified.' });
  }
  if (action === 'send_password_reset' && (!user.emailVerified || user.status !== 'active')) {
    return response.status(400).json({ error: 'Password reset email requires an active account with a verified email.' });
  }
  if ((action !== 'reactivate' || !user.emailVerified) && !smtpConfiguration()) {
    return response.status(503).json({ error: 'Email delivery is not configured.' });
  }

  const verification = action === 'resend_verification'
    || (action === 'reactivate' && !user.emailVerified);
  const tokenAction = verification ? 'verify_email' : 'password_reset';
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await db.transaction(async () => {
    if (action === 'reactivate') {
      await db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(user.id);
    }
    if (verification || action === 'send_password_reset') {
      await db.prepare('DELETE FROM user_action_tokens WHERE user_id = ? AND action = ?')
        .run(user.id, tokenAction);
      await db.prepare(`
        INSERT INTO user_action_tokens (token_hash, user_id, action, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(hashToken(token), user.id, tokenAction, expiresAt);
    }
    await notifyMember(
      user.id,
      'security',
      action === 'reactivate' ? 'Account reactivated' : 'Account recovery requested',
      action === 'reactivate'
        ? 'An administrator reactivated your account.'
        : 'An administrator requested an account recovery email for you.',
    );
    await audit({
      adminId: request.admin.id,
      action: `member.${action}`,
      targetType: 'user',
      targetId: user.id,
      details: { email: user.email },
      request,
    });
  })();

  if (action === 'reactivate' && user.emailVerified) {
    return response.json({ updated: true, message: 'Member account reactivated.' });
  }
  try {
    await sendAccountLink({
      request,
      email: user.email,
      name: user.name,
      token,
      type: tokenAction,
    });
  } catch (error) {
    console.error('Could not send admin-requested member recovery email:', error.message);
    return response.status(503).json({
      error: 'The recovery action was recorded, but the email could not be sent. Try again after checking SMTP configuration.',
    });
  }
  return response.json({
    updated: action === 'reactivate',
    message: verification ? 'Verification email sent.' : 'Password reset email sent.',
  });
});

router.post('/users/:userId/password', async (request, response) => {
  const password = typeof request.body?.password === 'string' ? request.body.password : '';
  if (password.length < 14 || password.length > 1024) {
    return response.status(400).json({ error: 'Use a password between 14 and 1024 characters.' });
  }
  const user = await db.prepare('SELECT id FROM users WHERE id = ? AND is_demo = 0').get(request.params.userId);
  if (!user) return response.status(404).json({ error: 'Member not found.' });
  const passwordHash = await hashPassword(password);
  await db.transaction(async () => {
    await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, user.id);
    await db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(user.id);
    await db.prepare('DELETE FROM user_action_tokens WHERE user_id = ?').run(user.id);
    await notifyMember(user.id, 'security', 'Password changed', 'An administrator set a new password for your account. All previous sessions were signed out.');
    await audit({
      adminId: request.admin.id,
      action: 'member.password_reset_by_admin',
      targetType: 'user',
      targetId: user.id,
      request,
    });
  })();
  return response.json({ updated: true });
});

router.delete('/users/:userId', async (request, response) => {
  const user = await db.prepare('SELECT id FROM users WHERE id = ? AND is_demo = 0').get(request.params.userId);
  if (!user) return response.status(404).json({ error: 'Member not found.' });
  await db.transaction(async () => {
    await db.prepare("UPDATE users SET status = 'suspended', bot_enabled = 0 WHERE id = ?").run(user.id);
    await db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(user.id);
    await db.prepare('DELETE FROM user_action_tokens WHERE user_id = ?').run(user.id);
    await audit({
      adminId: request.admin.id,
      action: 'member.deactivated',
      targetType: 'user',
      targetId: user.id,
      request,
    });
  })();
  return response.json({ deactivated: true });
});

async function readMemberDetails(userId) {
  const user = await db.prepare(`
    SELECT users.id, users.account_id AS accountId, users.display_name AS name,
      users.email, users.email_verified AS emailVerified, users.status,
      users.bot_enabled AS botEnabled, users.configured_stake_minor AS configuredStakeMinor,
      users.currency, users.created_at AS createdAt, users.last_seen_at AS lastSeenAt,
      wallets.balance_minor AS walletBalanceMinor
    FROM users LEFT JOIN wallets ON wallets.user_id = users.id
    WHERE users.id = ? AND users.is_demo = 0
  `).get(userId);
  if (!user) return null;
  const [deposits, withdrawals, ledger, trades, support, activity] = await Promise.all([
    db.prepare(`SELECT id, amount_minor AS amountMinor, currency, status, payment_reference AS paymentReference,
      review_note AS reviewNote, reviewed_at AS reviewedAt, created_at AS createdAt
      FROM deposits WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`).all(user.id),
    db.prepare(`SELECT id, amount_minor AS amountMinor, currency, status, payment_reference AS paymentReference,
      review_note AS reviewNote, reviewed_at AS reviewedAt, created_at AS createdAt
      FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`).all(user.id),
    db.prepare(`SELECT id, entry_type AS entryType, direction, amount_minor AS amountMinor, currency,
      balance_after_minor AS balanceAfterMinor, reference_type AS referenceType, reference_id AS referenceId,
      created_at AS createdAt FROM wallet_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`).all(user.id),
    db.prepare(`SELECT trades.id, trades.contract_id AS contractId, trades.status, trades.actual_stake_minor AS actualStakeMinor,
      trades.payout_minor AS payoutMinor, trades.profit_loss_minor AS profitLossMinor, trades.currency,
      trades.executed_at AS executedAt FROM trades JOIN round_participants
      ON round_participants.round_id = trades.round_id WHERE round_participants.user_id = ?
      ORDER BY trades.created_at DESC LIMIT 100`).all(user.id),
    db.prepare(`SELECT id, subject, message, status, response, created_at AS createdAt, updated_at AS updatedAt
      FROM support_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`).all(user.id),
    db.prepare(`SELECT audit_logs.action, audit_logs.details_json AS details,
      admin_users.username AS admin, audit_logs.created_at AS createdAt
      FROM audit_logs LEFT JOIN admin_users ON admin_users.id = audit_logs.admin_id
      WHERE audit_logs.target_type = 'user' AND audit_logs.target_id = ?
      ORDER BY audit_logs.created_at DESC LIMIT 100`).all(user.id),
  ]);
  return {
    user,
    activity: {
      deposits,
      withdrawals,
      ledger,
      trades,
      support,
      audit: activity.map((entry) => ({ ...entry, details: parseJson(entry.details) })),
    },
  };
}

router.get('/users/:userId/export', async (request, response) => {
  const details = await readMemberDetails(request.params.userId);
  if (!details) return response.status(404).json({ error: 'Member not found.' });
  await audit({
    adminId: request.admin.id,
    action: 'member.data_exported',
    targetType: 'user',
    targetId: details.user.id,
    request,
  });
  response.set('Content-Disposition', `attachment; filename="member-${details.user.accountId}.json"`);
  response.set('Cache-Control', 'no-store');
  return response.json(details);
});

router.get('/users/:userId', async (request, response) => {
  const details = await readMemberDetails(request.params.userId);
  if (!details) return response.status(404).json({ error: 'Member not found.' });
  return response.json(details);
});

router.post('/transactions/bulk-review', async (request, response) => {
  const items = request.body?.items;
  const status = request.body?.status;
  const note = typeof request.body?.note === 'string' ? request.body.note.trim() : '';
  if (!Array.isArray(items) || items.length < 1 || items.length > 100
      || !['approved', 'rejected'].includes(status)
      || note.length > 500 || (status === 'rejected' && note.length < 3)
      || items.some((item) => !item || !['deposits', 'withdrawals'].includes(item.type)
        || typeof item.id !== 'string' || item.id.length > 100)
      || new Set(items.map((item) => `${item.type}:${item.id}`)).size !== items.length) {
    return response.status(400).json({
      error: 'Select between 1 and 100 unique pending transactions; rejected records require a reason of at least 3 characters.',
    });
  }

  await db.transaction(async () => {
    const affectedUsers = new Set();
    for (const item of items) {
      const record = await db.prepare(`SELECT id, user_id AS userId FROM ${item.type} WHERE id = ? AND status = 'pending'`).get(item.id);
      if (!record) {
        const error = new Error('Every selected transaction must still be pending.');
        error.status = 409;
        throw error;
      }
      affectedUsers.add(record.userId);
    }
    for (const item of items) {
      const result = await db.prepare(`
        UPDATE ${item.type} SET status = ?, reviewed_by_admin_id = ?, reviewed_at = CURRENT_TIMESTAMP,
          review_note = ?
        WHERE id = ? AND status = 'pending'
      `).run(status, request.admin.id, note || null, item.id);
      if (result.changes !== 1) {
        const error = new Error('A selected transaction changed during review. Refresh and try again.');
        error.status = 409;
        throw error;
      }
    }
    for (const userId of affectedUsers) {
      await notifyMember(
        userId,
        'wallet',
        `Transaction ${status}`,
        status === 'rejected'
          ? `An administrator reviewed a transaction and rejected it. Reason: ${note}`
          : 'An administrator reviewed a transaction and marked it approved. This does not indicate a wallet credit or payout.',
      );
    }
    await audit({
      adminId: request.admin.id,
      action: 'transactions.bulk_reviewed',
      targetType: 'transactions',
      details: { status, note: note || null, items },
      request,
    });
  })();
  return response.json({ reviewed: items.length, status, note: note || null, walletBalancesChanged: false });
});

router.get('/rounds/:roundId/participants', async (request, response) => {
  const round = await db.prepare(`
    SELECT trading_rounds.id, trading_rounds.status, trading_rounds.currency,
      trading_rounds.combined_stake_minor AS combinedStakeMinor,
      trading_rounds.frozen_at AS frozenAt, trading_rounds.settled_at AS settledAt,
      settlements.status AS settlementStatus
    FROM trading_rounds
    LEFT JOIN settlements ON settlements.round_id = trading_rounds.id
    WHERE trading_rounds.id = ? AND trading_rounds.mode = 'live'
  `).get(request.params.roundId);
  if (!round) return response.status(404).json({ error: 'Trading round not found.' });

  const participants = await db.prepare(`
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
    ORDER BY users.created_at DESC
  `,
  deposits: `
    SELECT deposits.id, users.account_id AS accountId, users.display_name AS userName,
      deposits.amount_minor AS amountMinor, deposits.currency, deposits.status,
      deposits.payment_reference AS paymentReference, deposits.review_note AS reviewNote,
      admin_users.username AS reviewedBy, deposits.reviewed_at AS reviewedAt,
      deposits.created_at AS createdAt
    FROM deposits JOIN users ON users.id = deposits.user_id
    LEFT JOIN admin_users ON admin_users.id = deposits.reviewed_by_admin_id
    WHERE users.is_demo = 0
    ORDER BY deposits.created_at DESC
  `,
  withdrawals: `
    SELECT withdrawals.id, users.account_id AS accountId, users.display_name AS userName,
      withdrawals.amount_minor AS amountMinor, withdrawals.currency, withdrawals.status,
      withdrawals.payment_reference AS paymentReference, withdrawals.review_note AS reviewNote,
      admin_users.username AS reviewedBy, withdrawals.reviewed_at AS reviewedAt,
      withdrawals.created_at AS createdAt
    FROM withdrawals JOIN users ON users.id = withdrawals.user_id
    LEFT JOIN admin_users ON admin_users.id = withdrawals.reviewed_by_admin_id
    WHERE users.is_demo = 0
    ORDER BY withdrawals.created_at DESC
  `,
  signals: `
    SELECT id, market, direction, status, source, approved_at AS approvedAt, created_at AS createdAt
    FROM trading_signals
    WHERE NOT EXISTS (
      SELECT 1 FROM trading_rounds
      WHERE trading_rounds.signal_id = trading_signals.id AND trading_rounds.mode = 'demo'
    )
    ORDER BY created_at DESC
  `,
  trades: `
    SELECT trades.id, trades.round_id AS roundId, trades.mode, trades.contract_id AS contractId,
      trades.status, trades.actual_stake_minor AS actualStakeMinor,
      trades.payout_minor AS payoutMinor, trades.profit_loss_minor AS profitLossMinor,
      trades.currency, trades.confirmed_by_deriv AS confirmedByDeriv, trades.executed_at AS executedAt
    FROM trades WHERE trades.mode = 'live' ORDER BY trades.created_at DESC
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
    GROUP BY trading_rounds.id ORDER BY trading_rounds.created_at DESC
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
    ORDER BY wallet_ledger.created_at DESC
  `,
  notifications: `
    SELECT id, severity, category, title, message, acknowledged_at AS acknowledgedAt, created_at AS createdAt
    FROM notifications ORDER BY created_at DESC
  `,
  support: `
    SELECT support_requests.id, users.account_id AS accountId, users.display_name AS userName,
      support_requests.subject, support_requests.message, support_requests.status,
      support_requests.response, support_requests.assigned_admin_id AS assignedAdminId,
      assigned_admin.username AS assignedAdmin, support_requests.created_at AS createdAt,
      support_requests.updated_at AS updatedAt
    FROM support_requests JOIN users ON users.id = support_requests.user_id
    LEFT JOIN admin_users AS assigned_admin ON assigned_admin.id = support_requests.assigned_admin_id
    WHERE users.is_demo = 0
    ORDER BY support_requests.created_at DESC
  `,
  audit: `
    SELECT audit_logs.id, admin_users.username AS admin, audit_logs.action,
      audit_logs.target_type AS targetType, audit_logs.target_id AS targetId,
      audit_logs.details_json AS details, audit_logs.ip_address AS ipAddress,
      audit_logs.created_at AS createdAt
    FROM audit_logs LEFT JOIN admin_users ON admin_users.id = audit_logs.admin_id
    ORDER BY audit_logs.created_at DESC
  `,
  employees: `
    SELECT id, username, role, permissions_json AS permissionsJson,
      created_at AS createdAt, last_login_at AS lastLoginAt
    FROM admin_users ORDER BY created_at DESC
  `,
};

const searchableFields = {
  users: ['accountId', 'name', 'email'],
  deposits: ['accountId', 'userName', 'paymentReference', 'id'],
  withdrawals: ['accountId', 'userName', 'paymentReference', 'id'],
  signals: ['market', 'direction', 'source'],
  trades: ['contractId', 'status'],
  rounds: ['id', 'status'],
  ledger: ['accountId', 'userName', 'referenceId', 'entryType'],
  notifications: ['severity', 'category', 'title'],
  support: ['accountId', 'userName', 'subject', 'status'],
  audit: ['admin', 'action', 'targetType', 'targetId'],
  employees: ['username', 'role'],
};

router.get('/:resource', async (request, response) => {
  const query = listQueries[request.params.resource];
  if (!query) return response.status(404).json({ error: 'Admin resource not found.' });
  const page = Number(request.query.page || 1);
  const pageSize = Number(request.query.pageSize || 25);
  const search = typeof request.query.q === 'string' ? request.query.q.trim() : '';
  const status = typeof request.query.status === 'string' ? request.query.status.trim() : '';
  if (!Number.isInteger(page) || page < 1 || page > 100_000
      || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100
      || search.length > 100 || status.length > 40) {
    return response.status(400).json({ error: 'List filters or pagination values are invalid.' });
  }

  const conditions = [];
  const parameters = [];
  if (status) {
    if (!['users', 'deposits', 'withdrawals', 'trades', 'rounds', 'support'].includes(request.params.resource)) {
      return response.status(400).json({ error: 'Status filtering is unavailable for this list.' });
    }
    conditions.push('status = ?');
    parameters.push(status);
  }
  if (search) {
    const fields = searchableFields[request.params.resource] || [];
    conditions.push(`(${fields.map((field) => `LOWER(CAST(${field} AS TEXT)) LIKE ?`).join(' OR ')})`);
    parameters.push(...fields.map(() => `%${search.toLowerCase()}%`));
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const base = `SELECT * FROM (${query}) AS admin_resource${where}`;
  const total = Number((await db.prepare(`SELECT COUNT(*) AS count FROM (${base}) AS filtered_resource`)
    .get(...parameters)).count);
  const pageCount = Math.ceil(total / pageSize);
  const selectedPage = Math.min(page, Math.max(1, pageCount));
  const records = await db.prepare(`${base} ORDER BY createdAt DESC LIMIT ? OFFSET ?`)
    .all(...parameters, pageSize, (selectedPage - 1) * pageSize);
  if (request.params.resource === 'employees') {
    for (const record of records) record.permissions = parseJson(record.permissionsJson, []);
    for (const record of records) delete record.permissionsJson;
  }
  return response.json({
    records,
    pagination: { page: selectedPage, pageSize, total, pageCount },
  });
});

module.exports = router;
