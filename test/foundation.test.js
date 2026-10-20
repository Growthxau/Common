const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'gsquad-test-'));
process.env.GSQUAD_DB_PATH = path.join(temporaryDirectory, 'test.sqlite');

const db = require('../server/db');
const { hashPassword, verifyPassword } = require('../server/auth');
const { getPublicOrigin } = require('../server/origin');
const { detectDeviceType, isMobileOnlyDevice } = require('../src/device');

test.after(() => {
  db.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('device detection classifies mobile, tablet, and desktop correctly', () => {
  assert.equal(detectDeviceType({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', maxTouchPoints: 5, innerWidth: 390 }), 'mobile');
  assert.equal(detectDeviceType({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0, innerWidth: 1440 }), 'desktop');
  assert.equal(detectDeviceType({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', maxTouchPoints: 2, innerWidth: 1024 }), 'tablet');
  assert.equal(detectDeviceType({ userAgent: 'Mozilla/5.0 (Android 14; Tablet)', maxTouchPoints: 5, innerWidth: 600 }), 'tablet');
  assert.equal(detectDeviceType({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5, innerWidth: 600 }), 'tablet');
  assert.equal(isMobileOnlyDevice({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0, innerWidth: 1440 }), false);
  assert.equal(isMobileOnlyDevice({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', maxTouchPoints: 5, innerWidth: 390 }), true);
});

test('public origin uses Vercel production URL without requiring APP_ORIGIN', () => {
  const previous = {
    appOrigin: process.env.APP_ORIGIN,
    productionUrl: process.env.VERCEL_PROJECT_PRODUCTION_URL,
    vercelUrl: process.env.VERCEL_URL,
    nodeEnv: process.env.NODE_ENV,
  };
  process.env.APP_ORIGIN = '';
  process.env.VERCEL_PROJECT_PRODUCTION_URL = 'g-squad.example.vercel.app';
  process.env.VERCEL_URL = 'g-squad-preview.example.vercel.app';
  process.env.NODE_ENV = 'production';

  try {
    assert.equal(getPublicOrigin({ protocol: 'http', get: () => 'internal-host' }), 'https://g-squad.example.vercel.app');
  } finally {
    if (previous.appOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = previous.appOrigin;
    if (previous.productionUrl === undefined) delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    else process.env.VERCEL_PROJECT_PRODUCTION_URL = previous.productionUrl;
    if (previous.vercelUrl === undefined) delete process.env.VERCEL_URL;
    else process.env.VERCEL_URL = previous.vercelUrl;
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.nodeEnv;
  }
});

test('admin passwords are salted and verified without storing the raw value', async () => {
  const password = 'test-only-strong-password-934!';
  const passwordHash = await hashPassword(password);

  assert.notEqual(passwordHash, password);
  assert.equal(await verifyPassword(password, passwordHash), true);
  assert.equal(await verifyPassword('wrong-password', passwordHash), false);
});

test('wallet ledger entries are idempotent and immutable', () => {
  const userId = 'test-user-ledger';
  db.prepare(`
    INSERT INTO users (id, account_id, display_name, email)
    VALUES (?, ?, ?, ?)
  `).run(userId, 'TEST-LEDGER', 'Test Ledger User', 'ledger@example.invalid');
  db.prepare('INSERT INTO wallets (id, user_id, currency, balance_minor) VALUES (?, ?, ?, ?)')
    .run('test-wallet-ledger', userId, 'USD', 1000);
  db.prepare(`
    INSERT INTO wallet_ledger (
      id, user_id, entry_type, direction, amount_minor, currency, balance_after_minor,
      reference_type, reference_id, idempotency_key
    ) VALUES (?, ?, 'adjustment', 'credit', 1000, 'USD', 1000, 'test', 'opening', 'test:opening')
  `).run('test-ledger-entry', userId);

  assert.throws(() => db.prepare(`
    INSERT INTO wallet_ledger (
      id, user_id, entry_type, direction, amount_minor, currency, balance_after_minor,
      reference_type, reference_id, idempotency_key
    ) VALUES (?, ?, 'adjustment', 'credit', 1000, 'USD', 2000, 'test', 'duplicate', 'test:opening')
  `).run('test-ledger-entry-duplicate', userId), /UNIQUE constraint failed/);
  assert.throws(() => db.prepare('UPDATE wallet_ledger SET amount_minor = 1 WHERE id = ?').run('test-ledger-entry'), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM wallet_ledger WHERE id = ?').run('test-ledger-entry'), /immutable/);
});

test('deposit references and live in-flight rounds reject duplicates', () => {
  const userId = 'test-user-idempotency';
  db.prepare(`
    INSERT INTO users (id, account_id, display_name, email)
    VALUES (?, ?, ?, ?)
  `).run(userId, 'TEST-IDEMPOTENCY', 'Test Payment User', 'payment@example.invalid');
  db.prepare(`
    INSERT INTO deposits (id, user_id, amount_minor, currency, payment_reference, idempotency_key)
    VALUES (?, ?, 1000, 'USD', 'provider-ref-1', 'deposit-key-1')
  `).run('test-deposit-1', userId);
  assert.throws(() => db.prepare(`
    INSERT INTO deposits (id, user_id, amount_minor, currency, payment_reference, idempotency_key)
    VALUES (?, ?, 1000, 'USD', 'provider-ref-1', 'deposit-key-2')
  `).run('test-deposit-2', userId), /UNIQUE constraint failed/);

  db.prepare(`
    INSERT INTO trading_signals (id, market, direction, status, source)
    VALUES ('signal-1', 'test-market', 'up', 'approved', 'test')
  `).run();
  db.prepare(`
    INSERT INTO trading_signals (id, market, direction, status, source)
    VALUES ('signal-2', 'test-market', 'down', 'approved', 'test')
  `).run();
  db.prepare(`
    INSERT INTO trading_rounds (id, signal_id, mode, status, currency)
    VALUES ('round-1', 'signal-1', 'live', 'collecting', 'USD')
  `).run();
  db.prepare(`
    INSERT INTO round_participants (round_id, user_id, stake_minor)
    VALUES ('round-1', ?, 500)
  `).run(userId);
  db.prepare(`
    UPDATE trading_rounds SET status = 'frozen', frozen_at = CURRENT_TIMESTAMP WHERE id = 'round-1'
  `).run();
  assert.throws(() => db.prepare(`
    UPDATE round_participants SET stake_minor = 250 WHERE round_id = 'round-1'
  `).run(), /Frozen participant stakes cannot be changed/);
  assert.throws(() => db.prepare(`
    INSERT INTO round_participants (round_id, user_id, stake_minor)
    VALUES ('round-1', 'test-user-ledger', 250)
  `).run(), /cannot be added after a round is frozen/);
  assert.throws(() => db.prepare(`
    DELETE FROM round_participants WHERE round_id = 'round-1'
  `).run(), /Frozen participants cannot be removed/);
  assert.throws(() => db.prepare(`
    UPDATE trading_rounds SET frozen_at = NULL WHERE id = 'round-1'
  `).run(), /Frozen round values cannot be changed/);
  assert.throws(() => db.prepare(`
    UPDATE trading_rounds SET combined_stake_minor = 1 WHERE id = 'round-1'
  `).run(), /Frozen round values cannot be changed/);
  assert.throws(() => db.prepare(`
    INSERT INTO trading_rounds (id, signal_id, mode, status, currency)
    VALUES ('round-2', 'signal-2', 'live', 'collecting', 'USD')
  `).run(), /UNIQUE constraint failed/);
});
