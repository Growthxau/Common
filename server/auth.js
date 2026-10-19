const { createHash, randomBytes, randomUUID, scrypt, scryptSync, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const db = require('./db');

const scryptAsync = promisify(scrypt);
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
const SESSION_COOKIE = 'gsquad_session';
const DUMMY_SALT = Buffer.alloc(16, 7);
const DUMMY_HASH = scryptSync('not-a-real-password', DUMMY_SALT, 64);

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

function audit({ adminId = null, action, targetType = null, targetId = null, details = {}, request }) {
  db.prepare(`
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
    maxAge: SESSION_DURATION_MS,
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

  const admin = db.prepare('SELECT id, username, password_hash, role FROM admin_users WHERE username = ?')
    .get(username);
  const passwordMatches = await verifyPassword(password, admin?.password_hash);
  if (!admin || !passwordMatches) {
    audit({
      action: 'admin.login_failed',
      targetType: 'admin_user',
      details: { username: username.slice(0, 100) },
      request,
    });
    return response.status(401).json({ error: 'Invalid username or password.' });
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
  db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(new Date().toISOString());
  db.prepare('INSERT INTO admin_sessions (token_hash, admin_id, expires_at) VALUES (?, ?, ?)')
    .run(hashToken(token), admin.id, expiresAt);
  db.prepare('UPDATE admin_users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(admin.id);
  audit({ adminId: admin.id, action: 'admin.login_success', request });

  response.cookie(SESSION_COOKIE, token, cookieOptions());
  return response.json({ user: { id: admin.id, username: admin.username, role: admin.role } });
}

function requireAdmin(request, response, next) {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token || token.length > 100) {
    return response.status(401).json({ error: 'Authentication required.' });
  }

  const session = db.prepare(`
    SELECT admin_users.id, admin_users.username, admin_users.role
    FROM admin_sessions
    JOIN admin_users ON admin_users.id = admin_sessions.admin_id
    WHERE admin_sessions.token_hash = ? AND admin_sessions.expires_at > ?
  `).get(hashToken(token), new Date().toISOString());

  if (!session) {
    db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hashToken(token));
    clearSessionCookie(response);
    return response.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
  request.admin = session;
  return next();
}

function logout(request, response) {
  const token = request.cookies?.[SESSION_COOKIE];
  if (token && token.length <= 100) {
    db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hashToken(token));
  }
  if (request.admin) audit({ adminId: request.admin.id, action: 'admin.logout', request });
  clearSessionCookie(response);
  return response.status(204).end();
}

module.exports = { audit, hashPassword, login, logout, requireAdmin, verifyPassword };
