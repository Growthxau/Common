const { randomUUID } = require('node:crypto');
const db = require('./database');
const { hashPassword } = require('./auth');

async function bootstrapAdmin() {
  await db.ready;
  if (Number((await db.prepare('SELECT COUNT(*) AS count FROM admin_users').get()).count) > 0) {
    return false;
  }

  const username = process.env.ADMIN_USERNAME?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !/^[a-z0-9._-]{3,64}$/.test(username)) {
    throw new Error('Set ADMIN_USERNAME to 3-64 letters, numbers, dots, underscores, or hyphens to initialize the first admin.');
  }
  if (!password || password.length < 14 || password.length > 1024) {
    throw new Error('Set ADMIN_PASSWORD to a password between 14 and 1024 characters to initialize the first admin.');
  }

  const passwordHash = await hashPassword(password);
  await db.prepare(`
    INSERT INTO admin_users (id, username, password_hash, role)
    SELECT ?, ?, ?, 'super_admin'
    WHERE NOT EXISTS (SELECT 1 FROM admin_users)
    ON CONFLICT(username) DO NOTHING
  `).run(randomUUID(), username, passwordHash);

  const adminCount = Number((await db.prepare('SELECT COUNT(*) AS count FROM admin_users').get()).count);
  if (adminCount === 0) {
    throw new Error('The first admin account could not be initialized.');
  }
  return true;
}

module.exports = { bootstrapAdmin };
