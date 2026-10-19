const { randomUUID } = require('node:crypto');
const db = require('../server/db');
const { hashPassword } = require('../server/auth');

async function createAdmin() {
  const username = process.env.ADMIN_USERNAME?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;

  if (!username || !/^[a-z0-9._-]{3,64}$/.test(username)) {
    throw new Error('Set ADMIN_USERNAME to 3-64 letters, numbers, dots, underscores, or hyphens.');
  }
  if (!password || password.length < 14 || password.length > 1024) {
    throw new Error('Set ADMIN_PASSWORD to a password between 14 and 1024 characters.');
  }

  const passwordHash = await hashPassword(password);
  const adminId = randomUUID();
  db.prepare(`
    INSERT INTO admin_users (id, username, password_hash, role)
    VALUES (?, ?, ?, 'super_admin')
  `).run(adminId, username, passwordHash);
  console.log(`Created super admin "${username}". Keep the password in a secrets manager.`);
}

createAdmin()
  .catch((error) => {
    console.error('Could not create admin:', error.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
