const { randomBytes, randomUUID } = require('node:crypto');
const express = require('express');
const db = require('./db');
const { audit, hashPassword, hashToken, verifyPassword } = require('./auth');
const { sendAccountLink, smtpConfiguration } = require('./mailer');

const router = express.Router();
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
const SESSION_COOKIE = 'gsquad_user_session';

function userPayload(user) {
  return {
    id: user.id,
    accountId: user.account_id,
    name: user.display_name,
    email: user.email,
    emailVerified: Boolean(user.email_verified),
    status: user.status,
    currency: user.currency,
    botEnabled: Boolean(user.bot_enabled),
    configuredStakeMinor: user.configured_stake_minor,
    maxDailyLossMinor: user.max_daily_loss_minor ?? null,
    dailyProfitTargetMinor: user.daily_profit_target_minor ?? null,
  };
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_DURATION_MS,
  };
}

function clearSessionCookie(response) {
  const { maxAge, ...options } = cookieOptions();
  response.clearCookie(SESSION_COOKIE, options);
}

function setSession(response, userId) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
  db.prepare('DELETE FROM user_sessions WHERE expires_at <= ?').run(new Date().toISOString());
  db.prepare('INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(hashToken(token), userId, expiresAt);
  response.cookie(SESSION_COOKIE, token, cookieOptions());
}

function requireUser(request, response, next) {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token || token.length > 100) {
    return response.status(401).json({ error: 'Authentication required.' });
  }

  const user = db.prepare(`
    SELECT users.id, users.account_id, users.display_name, users.email, users.status,
      users.currency, users.bot_enabled, users.configured_stake_minor, users.email_verified,
      users.max_daily_loss_minor, users.daily_profit_target_minor
    FROM user_sessions
    JOIN users ON users.id = user_sessions.user_id
    WHERE user_sessions.token_hash = ? AND user_sessions.expires_at > ?
  `).get(hashToken(token), new Date().toISOString());

  if (!user || user.status !== 'active' || !user.email_verified) {
    db.prepare('DELETE FROM user_sessions WHERE token_hash = ?').run(hashToken(token));
    clearSessionCookie(response);
    return response.status(user ? 403 : 401).json({
      error: !user
        ? 'Session expired. Please sign in again.'
        : user.status !== 'active'
          ? 'This account is unavailable.'
          : 'Verify your email address before signing in.',
    });
  }

  db.prepare('UPDATE users SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
  request.user = user;
  request.userSessionHash = hashToken(token);
  return next();
}

function issueToken(userId, action) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM user_action_tokens WHERE expires_at <= ?').run(new Date().toISOString());
  db.prepare(`
    INSERT INTO user_action_tokens (token_hash, user_id, action, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(hashToken(token), userId, action, expiresAt);
  return token;
}

function createAccountId() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return `GSQ-${Array.from(randomBytes(6), (byte) => alphabet[byte % alphabet.length]).join('')}`;
}

async function register(request, response) {
  const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
  const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
  const password = typeof request.body?.password === 'string' ? request.body.password : '';
  const confirmPassword = typeof request.body?.confirmPassword === 'string' ? request.body.confirmPassword : '';
  if (name.length < 2 || name.length > 80
      || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      || password.length < 14 || password.length > 1024
      || password !== confirmPassword || request.body?.termsAccepted !== true) {
    return response.status(400).json({
      error: 'Enter a valid name and email, confirm a password of at least 14 characters, and accept the terms.',
    });
  }
  if (!smtpConfiguration()) {
    return response.status(503).json({ error: 'Account registration is temporarily unavailable because email verification is not configured.' });
  }

  const id = randomUUID();
  let accountId;
  const currency = 'USD';
  const passwordHash = await hashPassword(password);
  const verificationToken = randomBytes(32).toString('base64url');
  const verificationExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    accountId = createAccountId();
    try {
      db.transaction(() => {
        db.prepare(`
          INSERT INTO users (id, account_id, display_name, email, password_hash, currency, email_verified)
          VALUES (?, ?, ?, ?, ?, ?, 0)
        `).run(id, accountId, name, email, passwordHash, currency);
        db.prepare('INSERT INTO wallets (id, user_id, currency, balance_minor) VALUES (?, ?, ?, 0)')
          .run(randomUUID(), id, currency);
        db.prepare(`
          INSERT INTO user_action_tokens (token_hash, user_id, action, expires_at)
          VALUES (?, ?, 'verify_email', ?)
        `).run(hashToken(verificationToken), id, verificationExpiresAt);
        audit({
          action: 'user.registered',
          targetType: 'user',
          targetId: id,
          details: { accountId },
          request,
        });
      })();
      break;
    } catch (error) {
      if (error.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw error;
      if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
        return response.status(409).json({ error: 'An account with that email already exists.' });
      }
      if (attempt === 2) throw error;
    }
  }

  try {
    await sendAccountLink({ request, email, name, token: verificationToken, type: 'verify_email' });
  } catch (error) {
    console.error('Could not send user verification email:', error.message);
    return response.status(503).json({
      error: 'Your account was created, but the verification email could not be sent. Request another verification email after checking your address.',
      nextStep: 'resend_verification',
    });
  }
  return response.status(202).json({
    verificationRequired: true,
    message: 'Check your email for a verification link before signing in.',
  });
}

async function login(request, response) {
  const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
  const password = typeof request.body?.password === 'string' ? request.body.password : '';
  if (email.length > 254 || password.length > 1024) {
    return response.status(400).json({ error: 'Invalid email or password.' });
  }

  const user = db.prepare(`
    SELECT id, account_id, display_name, email, status, currency, bot_enabled,
      configured_stake_minor, password_hash, email_verified, max_daily_loss_minor,
      daily_profit_target_minor
    FROM users WHERE email = ?
  `).get(email);
  const passwordMatches = await verifyPassword(password, user?.password_hash);
  if (!user || !passwordMatches || user.status !== 'active') {
    audit({
      action: 'user.login_failed',
      targetType: 'user',
      details: { email: email.slice(0, 254) },
      request,
    });
    return response.status(401).json({ error: 'Invalid email or password.' });
  }
  if (!user.email_verified) {
    return response.status(403).json({ error: 'Verify your email address before signing in.' });
  }

  db.prepare('UPDATE users SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
  setSession(response, user.id);
  audit({ action: 'user.login_success', targetType: 'user', targetId: user.id, request });
  return response.json({ user: userPayload(user), tradingEnabled: false, paymentsEnabled: false });
}

function verifyEmail(request, response) {
  const token = typeof request.body?.token === 'string' ? request.body.token : '';
  if (token.length < 40 || token.length > 100) {
    return response.status(400).json({ error: 'The verification link is invalid or expired.' });
  }
  const userId = db.transaction(() => {
    const tokenRecord = db.prepare(`
      SELECT user_id FROM user_action_tokens
      WHERE token_hash = ? AND action = 'verify_email' AND expires_at > ?
    `).get(hashToken(token), new Date().toISOString());
    if (!tokenRecord) return null;
    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(tokenRecord.user_id);
    db.prepare("DELETE FROM user_action_tokens WHERE user_id = ? AND action = 'verify_email'").run(tokenRecord.user_id);
    audit({ action: 'user.email_verified', targetType: 'user', targetId: tokenRecord.user_id, request });
    return tokenRecord.user_id;
  })();
  if (!userId) return response.status(400).json({ error: 'The verification link is invalid or expired.' });
  return response.json({ verified: true, message: 'Email verified. You can now sign in.' });
}

async function resendVerification(request, response) {
  const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return response.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (!smtpConfiguration()) return response.status(503).json({ error: 'Email delivery is not configured.' });
  const user = db.prepare(`
    SELECT id, display_name, email FROM users
    WHERE email = ? AND email_verified = 0 AND status = 'active'
  `).get(email);
  if (user) {
    db.prepare("DELETE FROM user_action_tokens WHERE user_id = ? AND action = 'verify_email'").run(user.id);
    const token = issueToken(user.id, 'verify_email');
    await sendAccountLink({ request, email: user.email, name: user.display_name, token, type: 'verify_email' });
  }
  return response.json({ message: 'If the account needs verification, a link has been sent.' });
}

async function requestPasswordReset(request, response) {
  const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return response.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (!smtpConfiguration()) return response.status(503).json({ error: 'Email delivery is not configured.' });
  const user = db.prepare(`
    SELECT id, display_name, email FROM users
    WHERE email = ? AND email_verified = 1 AND status = 'active'
  `).get(email);
  if (user) {
    db.prepare("DELETE FROM user_action_tokens WHERE user_id = ? AND action = 'password_reset'").run(user.id);
    const token = issueToken(user.id, 'password_reset');
    await sendAccountLink({ request, email: user.email, name: user.display_name, token, type: 'password_reset' });
  }
  return response.json({ message: 'If a verified account exists for this email, a reset link has been sent.' });
}

async function resetPassword(request, response) {
  const token = typeof request.body?.token === 'string' ? request.body.token : '';
  const password = typeof request.body?.password === 'string' ? request.body.password : '';
  const confirmPassword = typeof request.body?.confirmPassword === 'string' ? request.body.confirmPassword : '';
  if (token.length < 40 || token.length > 100
      || password.length < 14 || password.length > 1024 || password !== confirmPassword) {
    return response.status(400).json({ error: 'Use the valid reset link and enter matching passwords of at least 14 characters.' });
  }
  const passwordHash = await hashPassword(password);
  const userId = db.transaction(() => {
    const tokenRecord = db.prepare(`
      SELECT user_id FROM user_action_tokens
      WHERE token_hash = ? AND action = 'password_reset' AND expires_at > ?
    `).get(hashToken(token), new Date().toISOString());
    if (!tokenRecord) return null;
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, tokenRecord.user_id);
    db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(tokenRecord.user_id);
    db.prepare('DELETE FROM user_action_tokens WHERE user_id = ?').run(tokenRecord.user_id);
    audit({ action: 'user.password_reset', targetType: 'user', targetId: tokenRecord.user_id, request });
    return tokenRecord.user_id;
  })();
  if (!userId) return response.status(400).json({ error: 'The password reset link is invalid or expired.' });
  return response.json({ reset: true, message: 'Password updated. Sign in with your new password.' });
}

function logout(request, response) {
  const token = request.cookies?.[SESSION_COOKIE];
  if (token && token.length <= 100) {
    db.prepare('DELETE FROM user_sessions WHERE token_hash = ?').run(hashToken(token));
  }
  if (request.user) {
    audit({ action: 'user.logout', targetType: 'user', targetId: request.user.id, request });
  }
  clearSessionCookie(response);
  return response.status(204).end();
}

router.get('/dashboard', (request, response) => {
  const user = db.prepare(`
    SELECT users.id, users.account_id, users.display_name, users.email, users.status,
      users.currency, users.bot_enabled, users.configured_stake_minor, users.created_at,
      users.email_verified, users.max_daily_loss_minor, users.daily_profit_target_minor,
      users.notification_preferences_json,
      wallets.balance_minor
    FROM users
    JOIN wallets ON wallets.user_id = users.id
    WHERE users.id = ?
  `).get(request.user.id);
  if (!user) return response.status(404).json({ error: 'Account wallet not found.' });

  const ledgerRows = db.prepare(`
    SELECT id, entry_type AS entryType, direction, amount_minor AS amountMinor,
      balance_after_minor AS balanceAfterMinor, currency, reference_type AS referenceType,
      created_at AS createdAt
    FROM wallet_ledger WHERE user_id = ?
    ORDER BY created_at DESC, id DESC LIMIT 101
  `).all(user.id);
  const ledgerHasMore = ledgerRows.length > 100;
  if (ledgerHasMore) ledgerRows.pop();
  const ledger = ledgerRows;
  const ledgerNextCursor = ledgerHasMore
    ? Buffer.from(JSON.stringify({ createdAt: ledger.at(-1).createdAt, id: ledger.at(-1).id })).toString('base64url')
    : null;
  const deposits = db.prepare(`
    SELECT id, amount_minor AS amountMinor, currency, status, created_at AS createdAt
    FROM deposits WHERE user_id = ? ORDER BY created_at DESC LIMIT 100
  `).all(user.id);
  const withdrawals = db.prepare(`
    SELECT id, amount_minor AS amountMinor, currency, status, created_at AS createdAt
    FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 100
  `).all(user.id);
  const support = db.prepare(`
    SELECT id, subject, message, status, response, created_at AS createdAt,
      updated_at AS updatedAt
    FROM support_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 20
  `).all(user.id);
  const walletTotals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN entry_type = 'deposit' AND direction = 'credit' THEN amount_minor ELSE 0 END), 0) AS depositsMinor,
      COALESCE(SUM(CASE WHEN entry_type = 'withdrawal' AND direction = 'debit' THEN amount_minor ELSE 0 END), 0) AS withdrawalsMinor
    FROM wallet_ledger WHERE user_id = ?
  `).get(user.id);
  const realizedProfitLossMinor = db.prepare(`
    SELECT COALESCE(SUM(round_participants.allocated_result_minor), 0) AS total
    FROM round_participants
    JOIN trading_rounds ON trading_rounds.id = round_participants.round_id
    JOIN trades ON trades.round_id = trading_rounds.id
    WHERE round_participants.user_id = ? AND trades.mode = 'live'
      AND trades.status = 'confirmed' AND trades.confirmed_by_deriv = 1
  `).get(user.id).total;
  const dailyProfitLossMinor = db.prepare(`
    SELECT COALESCE(SUM(round_participants.allocated_result_minor), 0) AS total
    FROM round_participants
    JOIN trading_rounds ON trading_rounds.id = round_participants.round_id
    JOIN trades ON trades.round_id = trading_rounds.id
    WHERE round_participants.user_id = ? AND trades.mode = 'live'
      AND trades.status = 'confirmed' AND trades.confirmed_by_deriv = 1
      AND trading_rounds.settled_at >= date('now')
  `).get(user.id).total;
  const notificationPreferences = JSON.parse(user.notification_preferences_json);
  const notifications = db.prepare(`
    SELECT id, category, title, message, read_at AS readAt, created_at AS createdAt
    FROM user_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50
  `).all(user.id).filter((notification) => notificationPreferences[notification.category] !== false);
  const openCommittedMinor = db.prepare(`
    SELECT COALESCE(SUM(round_participants.stake_minor), 0) AS total
    FROM round_participants
    JOIN trading_rounds ON trading_rounds.id = round_participants.round_id
    WHERE round_participants.user_id = ? AND trading_rounds.mode = 'live'
      AND trading_rounds.status IN ('frozen', 'approved', 'executing', 'settling')
  `).get(user.id).total;
  const tradingActivity = db.prepare(`
    SELECT trading_rounds.id AS roundId, round_participants.stake_minor AS contributedStakeMinor,
      round_participants.allocated_result_minor AS allocatedProfitLossMinor,
      trading_rounds.status AS roundStatus, trading_rounds.settled_at AS settledAt,
      trades.contract_id AS contractId, trades.status AS tradeStatus,
      trades.confirmed_by_deriv AS confirmedByDeriv, trades.currency,
      trades.executed_at AS executedAt, settlements.status AS settlementStatus,
      wallet_ledger.id AS ledgerReference
    FROM round_participants
    JOIN trading_rounds ON trading_rounds.id = round_participants.round_id
    LEFT JOIN trades ON trades.round_id = trading_rounds.id
    LEFT JOIN settlements ON settlements.round_id = trading_rounds.id
    LEFT JOIN wallet_ledger
      ON wallet_ledger.reference_type = 'settlement'
      AND wallet_ledger.reference_id = settlements.id
      AND wallet_ledger.user_id = round_participants.user_id
    WHERE round_participants.user_id = ? AND trading_rounds.mode = 'live'
    ORDER BY trading_rounds.created_at DESC LIMIT 500
  `).all(user.id);

  return response.json({
    user: {
      ...userPayload(user),
      createdAt: user.created_at,
      walletBalanceMinor: user.balance_minor,
      notificationPreferences,
      emailVerified: Boolean(user.email_verified),
    },
    ledger,
    ledgerNextCursor,
    deposits,
    withdrawals,
    support,
    notifications,
    tradingActivity,
    walletTotals,
    committedStakeMinor: openCommittedMinor,
    reservedFundsMinor: 0,
    realizedProfitLossMinor,
    dailyProfitLossMinor,
    riskLimitReached: (user.max_daily_loss_minor !== null && dailyProfitLossMinor <= -user.max_daily_loss_minor)
      || (user.daily_profit_target_minor !== null && dailyProfitLossMinor >= user.daily_profit_target_minor),
    tradingEnabled: false,
    paymentsEnabled: false,
    marketStatus: 'unavailable',
  });
});

router.get('/ledger', (request, response) => {
  const cursor = typeof request.query.cursor === 'string' ? request.query.cursor : '';
  let boundary = null;
  if (cursor) {
    try {
      boundary = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
      return response.status(400).json({ error: 'The ledger cursor is invalid.' });
    }
    if (!boundary || typeof boundary.createdAt !== 'string'
        || typeof boundary.id !== 'string' || boundary.id.length > 100) {
      return response.status(400).json({ error: 'The ledger cursor is invalid.' });
    }
  }
  const rows = db.prepare(`
    SELECT id, entry_type AS entryType, direction, amount_minor AS amountMinor,
      balance_after_minor AS balanceAfterMinor, currency, reference_type AS referenceType,
      created_at AS createdAt
    FROM wallet_ledger
    WHERE user_id = ?
      AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
    ORDER BY created_at DESC, id DESC LIMIT 101
  `).all(request.user.id, boundary?.createdAt ?? null, boundary?.createdAt ?? null,
    boundary?.createdAt ?? null, boundary?.id ?? null);
  const hasMore = rows.length > 100;
  if (hasMore) rows.pop();
  const nextCursor = hasMore
    ? Buffer.from(JSON.stringify({ createdAt: rows.at(-1).createdAt, id: rows.at(-1).id })).toString('base64url')
    : null;
  return response.json({ records: rows, nextCursor });
});

router.put('/risk-settings', (request, response) => {
  const { configuredStakeMinor, maxDailyLossMinor, dailyProfitTargetMinor } = request.body || {};
  const optionalLimits = [maxDailyLossMinor, dailyProfitTargetMinor];
  if (!Number.isSafeInteger(configuredStakeMinor) || configuredStakeMinor < 0
      || optionalLimits.some((value) => value !== null
        && (!Number.isSafeInteger(value) || value <= 0))) {
    return response.status(400).json({ error: 'Enter a non-negative stake and positive daily limits, or leave a limit empty.' });
  }
  const wallet = db.prepare('SELECT balance_minor FROM wallets WHERE user_id = ?').get(request.user.id);
  if (!wallet) return response.status(404).json({ error: 'Account wallet not found.' });
  if (configuredStakeMinor > wallet.balance_minor) {
    return response.status(400).json({ error: 'The configured stake cannot exceed your available wallet balance.' });
  }

  db.transaction(() => {
    db.prepare(`
      UPDATE users
      SET configured_stake_minor = ?, max_daily_loss_minor = ?, daily_profit_target_minor = ?
      WHERE id = ?
    `).run(configuredStakeMinor, maxDailyLossMinor, dailyProfitTargetMinor, request.user.id);
    audit({
      action: 'user.risk_settings_updated',
      targetType: 'user',
      targetId: request.user.id,
      details: { configuredStakeMinor, maxDailyLossMinor, dailyProfitTargetMinor },
      request,
    });
  })();
  return response.json({
    configuredStakeMinor,
    maxDailyLossMinor,
    dailyProfitTargetMinor,
    tradingEnabled: false,
  });
});

router.post('/bot/start', (request, response) => {
  db.transaction(() => {
    db.prepare('UPDATE users SET bot_enabled = 1 WHERE id = ?').run(request.user.id);
    audit({
      action: 'user.bot_opted_in',
      targetType: 'user',
      targetId: request.user.id,
      details: { configuredStakeMinor: request.user.configured_stake_minor },
      request,
    });
  })();
  return response.json({
    botEnabled: true,
    tradingEnabled: false,
    message: 'Your participation preference is on. This does not place trades.',
  });
});

router.post('/bot/stop', (request, response) => {
  db.transaction(() => {
    db.prepare('UPDATE users SET bot_enabled = 0 WHERE id = ?').run(request.user.id);
    audit({ action: 'user.bot_opted_out', targetType: 'user', targetId: request.user.id, request });
  })();
  return response.json({ botEnabled: false, tradingEnabled: false, message: 'Your participation preference is off.' });
});

router.get('/activity', (request, response) => {
  const records = db.prepare(`
    SELECT trading_rounds.id AS roundId, round_participants.stake_minor AS contributedStakeMinor,
      round_participants.allocated_result_minor AS allocatedProfitLossMinor,
      trading_rounds.status AS roundStatus, trading_rounds.settled_at AS settledAt,
      trades.contract_id AS contractId, trades.status AS tradeStatus,
      trades.confirmed_by_deriv AS confirmedByDeriv, trades.currency,
      trades.executed_at AS executedAt, settlements.status AS settlementStatus,
      wallet_ledger.id AS ledgerReference
    FROM round_participants
    JOIN trading_rounds ON trading_rounds.id = round_participants.round_id
    LEFT JOIN trades ON trades.round_id = trading_rounds.id
    LEFT JOIN settlements ON settlements.round_id = trading_rounds.id
    LEFT JOIN wallet_ledger
      ON wallet_ledger.reference_type = 'settlement'
      AND wallet_ledger.reference_id = settlements.id
      AND wallet_ledger.user_id = round_participants.user_id
    WHERE round_participants.user_id = ? AND trading_rounds.mode = 'live'
    ORDER BY trading_rounds.created_at DESC LIMIT 500
  `).all(request.user.id);
  return response.json({ records });
});

router.put('/profile', (request, response) => {
  const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
  const preferences = request.body?.notificationPreferences;
  const preferenceKeys = ['account', 'wallet', 'security'];
  if (name.length < 2 || name.length > 80
      || !preferences || typeof preferences !== 'object' || Array.isArray(preferences)
      || preferenceKeys.some((key) => typeof preferences[key] !== 'boolean')
      || Object.keys(preferences).some((key) => !preferenceKeys.includes(key))) {
    return response.status(400).json({ error: 'Enter a valid name and notification preferences.' });
  }
  db.transaction(() => {
    db.prepare(`
      UPDATE users SET display_name = ?, notification_preferences_json = ? WHERE id = ?
    `).run(name, JSON.stringify(preferences), request.user.id);
    audit({
      action: 'user.profile_updated',
      targetType: 'user',
      targetId: request.user.id,
      details: { notificationPreferences: preferences },
      request,
    });
  })();
  return response.json({ name, notificationPreferences: preferences });
});

router.post('/password/change', async (request, response) => {
  const currentPassword = typeof request.body?.currentPassword === 'string' ? request.body.currentPassword : '';
  const newPassword = typeof request.body?.newPassword === 'string' ? request.body.newPassword : '';
  const confirmPassword = typeof request.body?.confirmPassword === 'string' ? request.body.confirmPassword : '';
  if (newPassword.length < 14 || newPassword.length > 1024 || newPassword !== confirmPassword) {
    return response.status(400).json({ error: 'Enter matching new passwords of at least 14 characters.' });
  }
  const stored = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(request.user.id);
  if (!await verifyPassword(currentPassword, stored?.password_hash)) {
    return response.status(401).json({ error: 'Current password is incorrect.' });
  }
  const passwordHash = await hashPassword(newPassword);
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, request.user.id);
    db.prepare('DELETE FROM user_sessions WHERE user_id = ? AND token_hash != ?')
      .run(request.user.id, request.userSessionHash);
    audit({ action: 'user.password_changed', targetType: 'user', targetId: request.user.id, request });
  })();
  return response.json({ changed: true });
});

router.patch('/notifications/:notificationId/read', (request, response) => {
  const result = db.prepare(`
    UPDATE user_notifications SET read_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ? AND read_at IS NULL
  `).run(request.params.notificationId, request.user.id);
  if (!result.changes) {
    const exists = db.prepare('SELECT 1 FROM user_notifications WHERE id = ? AND user_id = ?')
      .get(request.params.notificationId, request.user.id);
    if (!exists) return response.status(404).json({ error: 'Notification not found.' });
  }
  return response.json({ read: true });
});

router.post('/support', (request, response) => {
  const subject = typeof request.body?.subject === 'string' ? request.body.subject.trim() : '';
  const message = typeof request.body?.message === 'string' ? request.body.message.trim() : '';
  if (subject.length < 3 || subject.length > 120 || message.length < 10 || message.length > 2000) {
    return response.status(400).json({
      error: 'Subject must be 3–120 characters and message must be 10–2000 characters.',
    });
  }

  const id = randomUUID();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO support_requests (id, user_id, subject, message) VALUES (?, ?, ?, ?)
    `).run(id, request.user.id, subject, message);
    audit({
      action: 'user.support_request_created',
      targetType: 'support_request',
      targetId: id,
      request,
    });
  })();
  const supportRequest = db.prepare(`
    SELECT id, subject, message, status, response, created_at AS createdAt
    FROM support_requests WHERE id = ? AND user_id = ?
  `).get(id, request.user.id);
  return response.status(201).json({ request: supportRequest });
});

module.exports = {
  login,
  logout,
  register,
  requireUser,
  requestPasswordReset,
  resendVerification,
  resetPassword,
  router,
  verifyEmail,
};
