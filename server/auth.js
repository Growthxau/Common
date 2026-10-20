const { createHash, createHmac, randomBytes, randomUUID, scrypt, scryptSync, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const db = require('./database');
const { decryptSecret, encryptSecret } = require('./secrets');

const scryptAsync = promisify(scrypt);
const SESSION_COOKIE = 'gsquad_session';
const ADMIN_LOCKOUT_FAILURES = 5;
const ADMIN_LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_LOCKOUT_DURATION_MS = 15 * 60 * 1000;
const DUMMY_SALT = Buffer.alloc(16, 7);
const DUMMY_HASH = scryptSync('not-a-real-password', DUMMY_SALT, 64);
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function adminSessionDurationMs() {
  const configuredMinutes = Number(process.env.ADMIN_SESSION_DURATION_MINUTES || 60);
  if (!Number.isInteger(configuredMinutes) || configuredMinutes < 15 || configuredMinutes > 720) {
    throw new Error('ADMIN_SESSION_DURATION_MINUTES must be an integer between 15 and 720.');
  }
  return configuredMinutes * 60 * 1000;
}

function parsePermissions(value) {
  try {
    const permissions = JSON.parse(value || '[]');
    return Array.isArray(permissions) && permissions.every((item) => typeof item === 'string')
      ? permissions
      : [];
  } catch {
    return [];
  }
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `${salt.toString('base64url')}.${key.toString('base64url')}`;
}

async function verifyPassword(password, storedHash) {
  const [saltText, keyText] = (storedHash || '').split('.');
  const salt = saltText ? Buffer.from(saltText, 'base64url') : DUMMY_SALT;
  const expectedKey = keyText ? Buffer.from(keyText, 'base64url') : DUMMY_HASH;
  const actualKey = await scryptAsync(password, salt, expectedKey.length || 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return Boolean(keyText) && actualKey.length === expectedKey.length && timingSafeEqual(actualKey, expectedKey);
}

function encodeBase32(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(value) {
  let bits = 0;
  let buffer = 0;
  const output = [];
  for (const character of value.toUpperCase().replace(/=+$/, '')) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new Error('Invalid authenticator secret.');
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function totp(secret, time = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 30_000)));
  const digest = createHmac('sha1', decodeBase32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const number = ((digest[offset] & 127) << 24)
    | ((digest[offset + 1] & 255) << 16)
    | ((digest[offset + 2] & 255) << 8)
    | (digest[offset + 3] & 255);
  return String(number % 1_000_000).padStart(6, '0');
}

function validTotp(secret, candidate) {
  if (typeof candidate !== 'string' || !/^\d{6}$/.test(candidate)) return false;
  const supplied = Buffer.from(candidate);
  for (const offset of [-30_000, 0, 30_000]) {
    const expected = Buffer.from(totp(secret, Date.now() + offset));
    if (timingSafeEqual(supplied, expected)) return true;
  }
  return false;
}

async function verifyMfaCode(adminId, code) {
  const record = await db.prepare('SELECT secret_encrypted FROM admin_mfa WHERE admin_id = ?').get(adminId);
  if (!record) return false;
  if (typeof code === 'string' && /^\d{6}$/.test(code)) {
    return validTotp(decryptSecret(record.secret_encrypted), code);
  }
  if (typeof code !== 'string' || code.length < 8 || code.length > 100) return false;
  const recovery = await db.prepare(`
    SELECT token_hash FROM admin_mfa_recovery_codes
    WHERE admin_id = ? AND token_hash = ? AND used_at IS NULL
  `).get(adminId, hashToken(code));
  if (!recovery) return false;
  const used = await db.prepare(`
    UPDATE admin_mfa_recovery_codes SET used_at = CURRENT_TIMESTAMP
    WHERE admin_id = ? AND token_hash = ? AND used_at IS NULL
  `).run(adminId, recovery.token_hash);
  return used.changes === 1;
}

async function audit({ adminId = null, action, targetType = null, targetId = null, details = {}, request }) {
  await db.prepare(`
    INSERT INTO audit_logs (id, admin_id, action, target_type, target_id, details_json, ip_address)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    adminId,
    action,
    targetType,
    targetId,
    JSON.stringify(details),
    request?.ip || null,
  );
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: adminSessionDurationMs(),
  };
}

function clearSessionCookie(response) {
  const { maxAge, ...options } = cookieOptions();
  response.clearCookie(SESSION_COOKIE, options);
}

async function establishSession(admin, request, response) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + adminSessionDurationMs()).toISOString();
  await db.prepare('DELETE FROM admin_login_attempts WHERE username = ?').run(admin.username);
  await db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(new Date().toISOString());
  await db.prepare('INSERT INTO admin_sessions (token_hash, admin_id, expires_at, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)')
    .run(hashToken(token), admin.id, expiresAt, request.ip || null, request.get('user-agent')?.slice(0, 200) || null);
  await db.prepare('UPDATE admin_users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(admin.id);
  await audit({ adminId: admin.id, action: 'admin.login_success', request });
  response.cookie(SESSION_COOKIE, token, cookieOptions());
  return response.json({
    user: {
      id: admin.id,
      username: admin.username,
      role: admin.role,
      permissions: parsePermissions(admin.permissions_json),
      mfaEnabled: Boolean(await db.prepare('SELECT admin_id FROM admin_mfa WHERE admin_id = ?').get(admin.id)),
    },
  });
}

async function login(request, response) {
  const username = typeof request.body?.username === 'string'
    ? request.body.username.trim().toLowerCase()
    : '';
  const password = typeof request.body?.password === 'string' ? request.body.password : '';
  if (username.length > 100 || password.length > 1024) {
    return response.status(400).json({ error: 'Invalid username or password.' });
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const attempt = await db.prepare('SELECT failure_count, window_started_at, locked_until FROM admin_login_attempts WHERE username = ?')
    .get(username);
  if (attempt?.locked_until && attempt.locked_until > nowIso) {
    await audit({ action: 'admin.login_blocked', targetType: 'admin_user', details: { username }, request });
    return response.status(429).json({ error: 'Sign-in is temporarily locked after repeated failed attempts. Try again in 15 minutes.' });
  }

  const admin = await db.prepare('SELECT id, username, password_hash, role, permissions_json FROM admin_users WHERE username = ?')
    .get(username);
  const passwordMatches = await verifyPassword(password, admin?.password_hash);
  if (!admin || !passwordMatches) {
    const windowStart = attempt?.window_started_at
      && new Date(attempt.window_started_at).getTime() > now.getTime() - ADMIN_LOCKOUT_WINDOW_MS
      ? attempt.window_started_at
      : nowIso;
    const failures = windowStart === attempt?.window_started_at ? Number(attempt.failure_count) + 1 : 1;
    const lockedUntil = failures >= ADMIN_LOCKOUT_FAILURES
      ? new Date(now.getTime() + ADMIN_LOCKOUT_DURATION_MS).toISOString()
      : null;
    await db.prepare(`
      INSERT INTO admin_login_attempts (username, failure_count, window_started_at, locked_until)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET
        failure_count = excluded.failure_count,
        window_started_at = excluded.window_started_at,
        locked_until = excluded.locked_until
    `).run(username, failures, windowStart, lockedUntil);
    await audit({
      action: 'admin.login_failed',
      targetType: 'admin_user',
      details: { username: username.slice(0, 100) },
      request,
    });
    if (failures === ADMIN_LOCKOUT_FAILURES) {
      await db.prepare(`
        INSERT INTO notifications (id, severity, category, title, message)
        VALUES (?, 'warning', 'security', 'Repeated admin sign-in failures',
          'An admin username reached the failed sign-in threshold and was temporarily locked.')
      `).run(randomUUID());
    }
    return response.status(401).json({ error: 'Invalid username or password.' });
  }
  const mfa = await db.prepare('SELECT admin_id FROM admin_mfa WHERE admin_id = ?').get(admin.id);
  if (mfa) {
    const challenge = randomBytes(32).toString('base64url');
    await db.prepare(`
      INSERT INTO admin_login_challenges (token_hash, admin_id, expires_at)
      VALUES (?, ?, ?)
    `).run(hashToken(challenge), admin.id, new Date(Date.now() + 5 * 60 * 1000).toISOString());
    return response.json({ mfaRequired: true, challenge });
  }
  return establishSession(admin, request, response);
}

async function verifyLoginMfa(request, response) {
  const challenge = typeof request.body?.challenge === 'string' ? request.body.challenge : '';
  const code = typeof request.body?.code === 'string' ? request.body.code.trim() : '';
  if (challenge.length > 100 || code.length > 100) return response.status(400).json({ error: 'Authenticator code is invalid.' });
  const challengeHash = hashToken(challenge);
  const record = await db.prepare(`
    SELECT admin_login_challenges.admin_id AS adminId, admin_login_challenges.attempt_count AS attemptCount,
      admin_users.username, admin_users.role, admin_users.permissions_json AS permissionsJson
    FROM admin_login_challenges JOIN admin_users ON admin_users.id = admin_login_challenges.admin_id
    WHERE admin_login_challenges.token_hash = ? AND admin_login_challenges.expires_at > ?
  `).get(challengeHash, new Date().toISOString());
  if (!record) return response.status(401).json({ error: 'Sign-in challenge expired. Please sign in again.' });
  if (Number(record.attemptCount) >= 5) {
    await db.prepare('DELETE FROM admin_login_challenges WHERE token_hash = ?').run(challengeHash);
    return response.status(429).json({ error: 'Too many authenticator attempts. Please sign in again.' });
  }
  const accepted = await verifyMfaCode(record.adminId, code);
  if (!accepted) {
    const updated = await db.prepare(`
      UPDATE admin_login_challenges SET attempt_count = attempt_count + 1
      WHERE token_hash = ? AND attempt_count < 5
    `).run(challengeHash);
    if (!updated.changes || Number(record.attemptCount) + 1 >= 5) {
      await db.prepare('DELETE FROM admin_login_challenges WHERE token_hash = ?').run(challengeHash);
    }
    await audit({ adminId: record.adminId, action: 'admin.mfa_failed', request });
    if (Number(record.attemptCount) + 1 === 5) {
      await db.prepare(`
        INSERT INTO notifications (id, severity, category, title, message)
        VALUES (?, 'warning', 'security', 'Repeated authenticator failures',
          'An admin sign-in challenge reached the maximum failed authenticator attempts.')
      `).run(randomUUID());
    }
    return response.status(401).json({ error: 'Authenticator code is invalid.' });
  }
  await db.prepare('DELETE FROM admin_login_challenges WHERE token_hash = ?').run(challengeHash);
  return establishSession({
    id: record.adminId,
    username: record.username,
    role: record.role,
    permissions_json: record.permissionsJson,
  }, request, response);
}

async function setupMfa(request, response) {
  if (!process.env.GSQUAD_SECRETS_KEY) {
    return response.status(503).json({ error: 'Encrypted secret storage is not configured on the server.' });
  }
  if (await db.prepare('SELECT admin_id FROM admin_mfa WHERE admin_id = ?').get(request.admin.id)) {
    return response.status(409).json({ error: 'Multi-factor authentication is already enabled.' });
  }
  const secret = encodeBase32(randomBytes(20));
  return response.json({
    secret,
    otpauthUrl: `otpauth://totp/G-Squad:${encodeURIComponent(request.admin.username)}?secret=${secret}&issuer=G-Squad&algorithm=SHA1&digits=6&period=30`,
  });
}

async function enableMfa(request, response) {
  const secret = typeof request.body?.secret === 'string' ? request.body.secret : '';
  const code = typeof request.body?.code === 'string' ? request.body.code.trim() : '';
  if (!/^[A-Z2-7]{32}$/.test(secret) || !validTotp(secret, code)) {
    return response.status(400).json({ error: 'The authenticator code could not be verified.' });
  }
  const recoveryCodes = Array.from({ length: 10 }, () => randomBytes(9).toString('base64url'));
  await db.transaction(async () => {
    await db.prepare('INSERT INTO admin_mfa (admin_id, secret_encrypted) VALUES (?, ?)')
      .run(request.admin.id, encryptSecret(secret));
    for (const recoveryCode of recoveryCodes) {
      await db.prepare('INSERT INTO admin_mfa_recovery_codes (admin_id, token_hash) VALUES (?, ?)')
        .run(request.admin.id, hashToken(recoveryCode));
    }
    await audit({
      adminId: request.admin.id,
      action: 'admin.mfa_enabled',
      targetType: 'admin_user',
      targetId: request.admin.id,
      request,
    });
  })();
  return response.json({ enabled: true, recoveryCodes });
}

async function disableMfa(request, response) {
  const code = typeof request.body?.code === 'string' ? request.body.code.trim() : '';
  if (!await verifyMfaCode(request.admin.id, code)) {
    return response.status(401).json({ error: 'Authenticator or unused recovery code is required to disable MFA.' });
  }
  await db.transaction(async () => {
    await db.prepare('DELETE FROM admin_mfa WHERE admin_id = ?').run(request.admin.id);
    await db.prepare('DELETE FROM admin_login_challenges WHERE admin_id = ?').run(request.admin.id);
    await audit({
      adminId: request.admin.id,
      action: 'admin.mfa_disabled',
      targetType: 'admin_user',
      targetId: request.admin.id,
      request,
    });
  })();
  return response.json({ enabled: false });
}

async function requireAdmin(request, response, next) {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token || token.length > 100) {
    return response.status(401).json({ error: 'Authentication required.' });
  }

  const session = await db.prepare(`
    SELECT admin_users.id, admin_users.username, admin_users.role, admin_users.permissions_json,
      CASE WHEN admin_mfa.admin_id IS NULL THEN 0 ELSE 1 END AS mfaEnabled
    FROM admin_sessions
    JOIN admin_users ON admin_users.id = admin_sessions.admin_id
    LEFT JOIN admin_mfa ON admin_mfa.admin_id = admin_users.id
    WHERE admin_sessions.token_hash = ? AND admin_sessions.expires_at > ?
  `).get(hashToken(token), new Date().toISOString());

  if (!session) {
    await db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hashToken(token));
    clearSessionCookie(response);
    return response.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
  session.permissions = parsePermissions(session.permissions_json);
  delete session.permissions_json;
  session.sessionId = hashToken(token);
  request.admin = session;
  return next();
}

async function listAdminSessions(request, response) {
  const sessions = await db.prepare(`
    SELECT token_hash AS id, created_at AS createdAt, expires_at AS expiresAt,
      ip_address AS ipAddress, user_agent AS userAgent
    FROM admin_sessions
    WHERE admin_id = ? AND expires_at > ?
    ORDER BY created_at DESC
  `).all(request.admin.id, new Date().toISOString());
  return response.json({
    sessions: sessions.map((session) => ({ ...session, current: session.id === request.admin.sessionId })),
  });
}

async function revokeAdminSession(request, response) {
  const sessionId = typeof request.params.sessionId === 'string' ? request.params.sessionId : '';
  if (!/^[a-f0-9]{64}$/.test(sessionId)) return response.status(400).json({ error: 'Session ID is invalid.' });
  const result = await db.prepare('DELETE FROM admin_sessions WHERE token_hash = ? AND admin_id = ?')
    .run(sessionId, request.admin.id);
  if (!result.changes) return response.status(404).json({ error: 'Session not found.' });
  await audit({
    adminId: request.admin.id,
    action: 'admin.session_revoked',
    targetType: 'admin_session',
    targetId: sessionId,
    request,
  });
  if (sessionId === request.admin.sessionId) clearSessionCookie(response);
  return response.json({ revoked: true, current: sessionId === request.admin.sessionId });
}

async function logout(request, response) {
  const token = request.cookies?.[SESSION_COOKIE];
  if (token && token.length <= 100) {
    await db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hashToken(token));
  }
  if (request.admin) await audit({ adminId: request.admin.id, action: 'admin.logout', request });
  clearSessionCookie(response);
  return response.status(204).end();
}

module.exports = {
  adminSessionDurationMs,
  audit,
  hashPassword,
  hashToken,
  login,
  logout,
  listAdminSessions,
  revokeAdminSession,
  requireAdmin,
  setupMfa,
  enableMfa,
  disableMfa,
  verifyLoginMfa,
  verifyPassword,
};
