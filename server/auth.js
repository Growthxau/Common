const { createHash, randomBytes, randomUUID, scrypt, scryptSync, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const db = require('./database');

const scryptAsync = promisify(scrypt);
const SESSION_COOKIE = 'gsquad_session';
const ADMIN_LOCKOUT_FAILURES = 5;
const ADMIN_LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_LOCKOUT_DURATION_MS = 15 * 60 * 1000;
const DUMMY_SALT = Buffer.alloc(16, 7);
const DUMMY_HASH = scryptSync('not-a-real-password', DUMMY_SALT, 64);

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

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + adminSessionDurationMs()).toISOString();
  await db.prepare('DELETE FROM admin_login_attempts WHERE username = ?').run(username);
  await db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(new Date().toISOString());
  await db.prepare('INSERT INTO admin_sessions (token_hash, admin_id, expires_at) VALUES (?, ?, ?)')
    .run(hashToken(token), admin.id, expiresAt);
  await db.prepare('UPDATE admin_users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(admin.id);
  await audit({ adminId: admin.id, action: 'admin.login_success', request });

  response.cookie(SESSION_COOKIE, token, cookieOptions());
  return response.json({
    user: {
      id: admin.id,
      username: admin.username,
      role: admin.role,
      permissions: parsePermissions(admin.permissions_json),
    },
  });
}

async function requireAdmin(request, response, next) {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token || token.length > 100) {
    return response.status(401).json({ error: 'Authentication required.' });
  }

  const session = await db.prepare(`
    SELECT admin_users.id, admin_users.username, admin_users.role, admin_users.permissions_json
    FROM admin_sessions
    JOIN admin_users ON admin_users.id = admin_sessions.admin_id
    WHERE admin_sessions.token_hash = ? AND admin_sessions.expires_at > ?
  `).get(hashToken(token), new Date().toISOString());

  if (!session) {
    await db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hashToken(token));
    clearSessionCookie(response);
    return response.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
  session.permissions = parsePermissions(session.permissions_json);
  delete session.permissions_json;
  request.admin = session;
  return next();
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
  requireAdmin,
  verifyPassword,
};
