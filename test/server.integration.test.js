const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'gsquad-server-test-'));
const databasePath = path.join(temporaryDirectory, 'test.sqlite');
const adminPassword = 'integration-test-password-8492!';
const derivPat = 'never-return-this-test-credential';

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  let timeout;
  const exited = await Promise.race([
    once(child, 'exit').then(() => true),
    new Promise((resolve) => { timeout = setTimeout(() => resolve(false), 5000); }),
  ]);
  clearTimeout(timeout);
  if (!exited) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

async function waitForHealth(origin) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await fetch(`${origin}/api/health`);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  return null;
}

test('admin login, employee access, configuration, protected APIs, and logout work end to end', async (context) => {
  let child;
  context.after(async () => {
    await stopProcess(child);
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    GSQUAD_DB_PATH: databasePath,
    PORT: String(port),
    APP_ORIGIN: '',
    ADMIN_USERNAME: 'integration-admin',
    ADMIN_PASSWORD: adminPassword,
    DERIV_PAT: derivPat,
    DERIV_APP_ID: 'test-app-id',
    NODE_ENV: 'development',
  };
  const adminResult = spawnSync(process.execPath, ['scripts/create-admin.js'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  assert.equal(adminResult.status, 0, adminResult.stderr);

  child = spawn(process.execPath, ['server/index.js'], { cwd: root, env, stdio: 'ignore' });

  const health = await waitForHealth(origin);
  assert.ok(health, 'server should start');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok', tradingEnabled: false, paymentsEnabled: false });

  const page = await fetch(`${origin}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /G-Squad/);

  const unauthorized = await fetch(`${origin}/api/admin/overview`);
  assert.equal(unauthorized.status, 401);

  const rejectedOrigin = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.invalid' },
    body: JSON.stringify({ username: 'integration-admin', password: adminPassword }),
  });
  assert.equal(rejectedOrigin.status, 403);

  const loginResponse = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'integration-admin', password: adminPassword }),
  });
  assert.equal(loginResponse.status, 200);
  const loginBody = await loginResponse.json();
  assert.equal(loginBody.user.username, 'integration-admin');
  assert.equal(JSON.stringify(loginBody).includes(adminPassword), false);
  const cookie = loginResponse.headers.getSetCookie()[0].split(';')[0];
  assert.match(cookie, /^gsquad_session=/);

  const forwardedHttpsLogin = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: `https://127.0.0.1:${port}`,
      'X-Forwarded-Proto': 'https',
    },
    body: JSON.stringify({ username: 'integration-admin', password: adminPassword }),
  });
  assert.equal(forwardedHttpsLogin.status, 200);

  const identity = await fetch(`${origin}/api/auth/me`, { headers: { Cookie: cookie } });
  assert.equal(identity.status, 200);
  assert.equal((await identity.json()).user.role, 'super_admin');

  const overviewResponse = await fetch(`${origin}/api/admin/overview`, { headers: { Cookie: cookie } });
  assert.equal(overviewResponse.status, 200);
  const overviewBody = await overviewResponse.json();
  assert.equal(overviewBody.metrics.totalUsers, 0);
  assert.equal(overviewBody.metrics.tradingEnabled, false);

  const settingsResponse = await fetch(`${origin}/api/admin/settings`, { headers: { Cookie: cookie } });
  const settingsBody = await settingsResponse.json();
  assert.equal(settingsBody.settings.organizationName, 'G-Squad');
  assert.equal(settingsBody.riskSettings.emergencyStopEnabled, 1);
  assert.equal(settingsBody.derivPatConfigured, true);
  assert.equal(settingsBody.derivAppIdConfigured, true);
  assert.equal(JSON.stringify(settingsBody).includes(derivPat), false);

  const saveSettings = await fetch(`${origin}/api/admin/settings`, {
    method: 'PUT',
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: {
      organizationName: 'G-Squad Operations',
      supportEmail: 'help@example.com',
      defaultCurrency: 'EUR',
      timezone: 'Europe/London',
    } }),
  });
  assert.equal(saveSettings.status, 200);
  assert.equal((await saveSettings.json()).settings.defaultCurrency, 'EUR');

  const saveRiskSettings = await fetch(`${origin}/api/admin/risk-settings`, {
    method: 'PUT',
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ riskSettings: {
      maxDailyLossMinor: 50000,
      dailyProfitTargetMinor: null,
      maxCombinedStakeMinor: 10000,
      maxExposureMinor: null,
      emergencyStopEnabled: 1,
    } }),
  });
  assert.equal(saveRiskSettings.status, 200);
  assert.equal((await saveRiskSettings.json()).riskSettings.maxDailyLossMinor, 50000);

  const createEmployee = await fetch(`${origin}/api/admin/employees`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'operations-staff', password: 'strong-employee-password-482!', role: 'admin' }),
  });
  assert.equal(createEmployee.status, 201);
  assert.equal((await createEmployee.json()).employee.role, 'admin');
  const employeeLogin = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'operations-staff', password: 'strong-employee-password-482!' }),
  });
  assert.equal(employeeLogin.status, 200);
  const employeeCookie = employeeLogin.headers.getSetCookie()[0].split(';')[0];
  const employeeSettings = await fetch(`${origin}/api/admin/settings`, { headers: { Cookie: employeeCookie } });
  assert.equal(employeeSettings.status, 403);
  const employeeDirectory = await fetch(`${origin}/api/admin/employees`, { headers: { Cookie: employeeCookie } });
  assert.equal(employeeDirectory.status, 403);
  const employeeRiskSettings = await fetch(`${origin}/api/admin/risk-settings`, {
    method: 'PUT',
    headers: { Cookie: employeeCookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ riskSettings: {
      maxDailyLossMinor: 1,
      dailyProfitTargetMinor: null,
      maxCombinedStakeMinor: null,
      maxExposureMinor: null,
      emergencyStopEnabled: 1,
    } }),
  });
  assert.equal(employeeRiskSettings.status, 403);
  const persistedSettings = await fetch(`${origin}/api/admin/settings`, { headers: { Cookie: cookie } });
  assert.equal((await persistedSettings.json()).settings.organizationName, 'G-Squad Operations');

  const usersResponse = await fetch(`${origin}/api/admin/users`, { headers: { Cookie: cookie } });
  const usersBody = await usersResponse.json();
  assert.equal(usersBody.records.length, 0);

  const logoutResponse = await fetch(`${origin}/api/auth/logout`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: origin },
  });
  assert.equal(logoutResponse.status, 204);
  const afterLogout = await fetch(`${origin}/api/auth/me`, { headers: { Cookie: cookie } });
  assert.equal(afterLogout.status, 401);

  await stopProcess(child);
  child = null;
  const buildResult = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(buildResult.status, 0, buildResult.stderr);

  child = spawn(process.execPath, ['server/index.js', '--production'], {
    cwd: root,
    env: { ...env, NODE_ENV: 'production' },
    stdio: 'ignore',
  });
  const productionHealth = await waitForHealth(origin);
  assert.ok(productionHealth, 'production server should start');
  assert.equal(productionHealth.status, 200);

  const productionPage = await fetch(`${origin}/`);
  assert.equal(productionPage.status, 200);
  const html = await productionPage.text();
  const assetPath = html.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(assetPath, 'production HTML should reference the application bundle');
  const jsAsset = await fetch(new URL(assetPath, origin));
  assert.equal(jsAsset.status, 200);
  assert.match(jsAsset.headers.get('content-type'), /javascript/);
  assert.match(productionPage.headers.get('content-security-policy'), /upgrade-insecure-requests/);
});
