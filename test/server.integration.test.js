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
const replacementDerivPat = 'replacement-test-credential-482';
const secretsKey = Buffer.alloc(32, 7).toString('base64');

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

async function startSmtpServer(messages) {
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.write('220 localhost ESMTP\r\n');
    let buffer = '';
    let message = '';
    let readingMessage = false;
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (readingMessage) {
          if (line === '.') {
            messages.push(message);
            message = '';
            readingMessage = false;
            socket.write('250 Message accepted\r\n');
          } else {
            message += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
          }
          continue;
        }
        const command = line.split(' ', 1)[0].toUpperCase();
        if (command === 'EHLO' || command === 'HELO') socket.write('250-localhost\r\n250 PIPELINING\r\n');
        else if (command === 'DATA') {
          readingMessage = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (command === 'QUIT') {
          socket.write('221 Bye\r\n');
          socket.end();
        } else socket.write('250 OK\r\n');
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

function linkFromEmail(message, key) {
  const decoded = message
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  const link = decoded.match(new RegExp(`https?:[^\\s<>]+[?&]${key}=([^&\\s<>"]+)`))?.[0];
  assert.ok(link, `${key} link should be sent`);
  return new URL(link);
}

function tokenFromEmail(message, key) {
  return linkFromEmail(message, key).searchParams.get(key);
}

test('admin login, employee access, configuration, protected APIs, and logout work end to end', async (context) => {
  let child;
  const sentEmails = [];
  const smtp = await startSmtpServer(sentEmails);
  context.after(async () => {
    await stopProcess(child);
    await new Promise((resolve, reject) => smtp.close((error) => error ? reject(error) : resolve()));
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  const port = await unusedPort();
  const smtpPort = smtp.address().port;
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
    GSQUAD_SECRETS_KEY: secretsKey,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtpPort),
    SMTP_SECURE: 'false',
    SMTP_FROM: 'G-Squad <no-reply@example.invalid>',
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
  const publicSettings = await fetch(`${origin}/api/app-settings`);
  assert.equal(publicSettings.status, 200);
  assert.deepEqual((await publicSettings.json()).settings, { organizationName: 'G-Squad', appLogo: '' });

  const page = await fetch(`${origin}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /G-Squad/);
  const adminPage = await fetch(`${origin}/admin`);
  assert.equal(adminPage.status, 200);
  assert.match(await adminPage.text(), /G-Squad/);

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

  const saveDerivCredentials = await fetch(`${origin}/api/admin/deriv-credentials`, {
    method: 'PUT',
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ derivCredentials: { appId: '123456', pat: replacementDerivPat } }),
  });
  assert.equal(saveDerivCredentials.status, 200);
  const derivStatus = await saveDerivCredentials.json();
  assert.equal(derivStatus.derivAppId, '123456');
  assert.equal(derivStatus.derivPatConfigured, true);
  assert.equal(derivStatus.derivConnected, false);
  assert.equal(JSON.stringify(derivStatus).includes(replacementDerivPat), false);
  const storedSecret = spawnSync(process.execPath, ['-e', `
    const Database = require('better-sqlite3');
    const db = new Database(process.env.GSQUAD_DB_PATH, { readonly: true });
    process.stdout.write(db.prepare("SELECT value_json FROM app_settings WHERE key = 'derivPatEncrypted'").get().value_json);
    db.close();
  `], { cwd: root, env, encoding: 'utf8' });
  assert.equal(storedSecret.status, 0, storedSecret.stderr);
  assert.equal(storedSecret.stdout.includes(replacementDerivPat), false);
  assert.match(storedSecret.stdout, /^"v1:/);

  const saveSettings = await fetch(`${origin}/api/admin/settings`, {
    method: 'PUT',
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: {
      organizationName: 'G-Squad Operations',
      supportEmail: 'help@example.com',
      defaultCurrency: 'EUR',
      timezone: 'Europe/London',
      appLogo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/xD8AAAAASUVORK5CYII=',
    } }),
  });
  assert.equal(saveSettings.status, 200);
  const savedSettings = (await saveSettings.json()).settings;
  assert.equal(savedSettings.defaultCurrency, 'EUR');
  assert.equal(savedSettings.appLogo, 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/xD8AAAAASUVORK5CYII=');
  const malformedSettings = await fetch(`${origin}/api/admin/settings`, {
    method: 'PUT',
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    body: '{"settings":',
  });
  assert.equal(malformedSettings.status, 400);
  const malformedSettingsBody = await malformedSettings.json();
  assert.match(malformedSettingsBody.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(malformedSettings.headers.get('x-request-id'), malformedSettingsBody.requestId);
  const updatedPublicSettings = await fetch(`${origin}/api/app-settings`);
  assert.deepEqual((await updatedPublicSettings.json()).settings, {
    organizationName: 'G-Squad Operations',
    appLogo: savedSettings.appLogo,
  });

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
  const employeeLogoUpdate = await fetch(`${origin}/api/admin/settings`, {
    method: 'PUT',
    headers: { Cookie: employeeCookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: {
      organizationName: 'Unauthorized change',
      supportEmail: '',
      defaultCurrency: 'USD',
      timezone: 'UTC',
      appLogo: '',
    } }),
  });
  assert.equal(employeeLogoUpdate.status, 403);
  const employeeDirectory = await fetch(`${origin}/api/admin/employees`, { headers: { Cookie: employeeCookie } });
  assert.equal(employeeDirectory.status, 403);
  const employeeMemberCreation = await fetch(`${origin}/api/admin/members`, {
    method: 'POST',
    headers: { Cookie: employeeCookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Unauthorized Member', email: 'unauthorized@example.com' }),
  });
  assert.equal(employeeMemberCreation.status, 403);
  const employeeTransactionReview = await fetch(`${origin}/api/admin/transactions/bulk-review`, {
    method: 'POST',
    headers: { Cookie: employeeCookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'approved', items: [{ type: 'deposits', id: 'bulk-deposit-1' }] }),
  });
  assert.equal(employeeTransactionReview.status, 403);
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
  const employeeDerivCredentials = await fetch(`${origin}/api/admin/deriv-credentials`, {
    method: 'PUT',
    headers: { Cookie: employeeCookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ derivCredentials: { appId: '123456', pat: replacementDerivPat } }),
  });
  assert.equal(employeeDerivCredentials.status, 403);
  const persistedSettings = await fetch(`${origin}/api/admin/settings`, { headers: { Cookie: cookie } });
  assert.equal((await persistedSettings.json()).settings.organizationName, 'G-Squad Operations');

  const usersResponse = await fetch(`${origin}/api/admin/users`, { headers: { Cookie: cookie } });
  const usersBody = await usersResponse.json();
  assert.equal(usersBody.records.length, 0);

  const userRegister = await fetch(`${origin}/api/user/register`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Portal Member',
      email: 'portal-member@example.com',
      password: 'portal-member-strong-password-482!',
      confirmPassword: 'portal-member-strong-password-482!',
      termsAccepted: true,
    }),
  });
  assert.equal(userRegister.status, 202);
  const registeredBody = await userRegister.json();
  assert.equal(registeredBody.verificationRequired, true);
  assert.match(registeredBody.message, /verification/i);
  const verificationLink = linkFromEmail(sentEmails.at(-1), 'verify');
  assert.equal(verificationLink.pathname, '/');
  const verifyToken = verificationLink.searchParams.get('verify');

  const duplicateRegister = await fetch(`${origin}/api/user/register`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Portal Member',
      email: 'PORTAL-MEMBER@example.com',
      password: 'portal-member-strong-password-482!',
      confirmPassword: 'portal-member-strong-password-482!',
      termsAccepted: true,
    }),
  });
  assert.equal(duplicateRegister.status, 409);

  const unverifiedLogin = await fetch(`${origin}/api/user/login`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'portal-member@example.com', password: 'portal-member-strong-password-482!' }),
  });
  assert.equal(unverifiedLogin.status, 403);
  const verifyResponse = await fetch(`${origin}/api/user/verify-email`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: verifyToken }),
  });
  assert.equal(verifyResponse.status, 200);
  assert.equal((await verifyResponse.json()).verified, true);
  const replayedVerify = await fetch(`${origin}/api/user/verify-email`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: verifyToken }),
  });
  assert.equal(replayedVerify.status, 400);

  const signedIn = await fetch(`${origin}/api/user/login`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'portal-member@example.com', password: 'portal-member-strong-password-482!' }),
  });
  assert.equal(signedIn.status, 200);
  const loginResult = await signedIn.json();
  assert.match(loginResult.user.accountId, /^GSQ-[A-Z0-9]{6}$/);
  assert.equal(loginResult.user.emailVerified, true);
  assert.equal(loginResult.tradingEnabled, false);
  assert.equal(loginResult.paymentsEnabled, false);
  const userCookie = signedIn.headers.getSetCookie()[0].split(';')[0];
  assert.match(userCookie, /^gsquad_user_session=/);

  const unauthorizedUserDashboard = await fetch(`${origin}/api/user/dashboard`);
  assert.equal(unauthorizedUserDashboard.status, 401);
  const userDashboardResponse = await fetch(`${origin}/api/user/dashboard`, { headers: { Cookie: userCookie } });
  assert.equal(userDashboardResponse.status, 200);
  const userDashboard = await userDashboardResponse.json();
  assert.equal(userDashboard.user.email, 'portal-member@example.com');
  assert.equal(userDashboard.user.walletBalanceMinor, 0);
  assert.deepEqual(userDashboard.ledger, []);
  assert.equal(userDashboard.tradingEnabled, false);
  assert.equal(JSON.stringify(userDashboard).includes(derivPat), false);

  const rejectedPreference = await fetch(`${origin}/api/user/risk-settings`, {
    method: 'PUT',
    headers: { Cookie: userCookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ configuredStakeMinor: 100, maxDailyLossMinor: null, dailyProfitTargetMinor: null }),
  });
  assert.equal(rejectedPreference.status, 400);

  const userSaveRiskSettings = await fetch(`${origin}/api/user/risk-settings`, {
    method: 'PUT',
    headers: { Cookie: userCookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ configuredStakeMinor: 0, maxDailyLossMinor: 5000, dailyProfitTargetMinor: 10000 }),
  });
  assert.equal(userSaveRiskSettings.status, 200);
  assert.equal((await userSaveRiskSettings.json()).tradingEnabled, false);
  const preferenceDashboard = await fetch(`${origin}/api/user/dashboard`, { headers: { Cookie: userCookie } });
  const preferenceData = await preferenceDashboard.json();
  assert.equal(preferenceData.user.botEnabled, false);
  assert.equal(preferenceData.user.configuredStakeMinor, 0);
  assert.equal(preferenceData.user.maxDailyLossMinor, 5000);
  assert.equal(preferenceData.user.walletBalanceMinor, 0);

  const startBot = await fetch(`${origin}/api/user/bot/start`, {
    method: 'POST',
    headers: { Cookie: userCookie, Origin: origin, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(startBot.status, 200);
  assert.deepEqual(await startBot.json(), {
    botEnabled: true,
    tradingEnabled: false,
    message: 'Your participation preference is on. This does not place trades.',
  });
  const optedInDashboard = await fetch(`${origin}/api/user/dashboard`, { headers: { Cookie: userCookie } });
  assert.equal((await optedInDashboard.json()).user.botEnabled, true);
  const optedInAdminUsers = await fetch(`${origin}/api/admin/users`, { headers: { Cookie: cookie } });
  const optedInMember = (await optedInAdminUsers.json()).records.find((record) => record.email === 'portal-member@example.com');
  assert.equal(optedInMember.botEnabled, 1);
  const optedInOverview = await fetch(`${origin}/api/admin/overview`, { headers: { Cookie: cookie } });
  assert.equal((await optedInOverview.json()).metrics.activeBots, 1);
  const saveProfile = await fetch(`${origin}/api/user/profile`, {
    method: 'PUT',
    headers: { Cookie: userCookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Portal Member Updated',
      notificationPreferences: { account: true, wallet: false, security: true },
    }),
  });
  assert.equal(saveProfile.status, 200);
  const passwordChange = await fetch(`${origin}/api/user/password/change`, {
    method: 'POST',
    headers: { Cookie: userCookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      currentPassword: 'portal-member-strong-password-482!',
      newPassword: 'portal-member-updated-password-598!',
      confirmPassword: 'portal-member-updated-password-598!',
    }),
  });
  assert.equal(passwordChange.status, 200);
  const revokedUserSession = await fetch(`${origin}/api/user/dashboard`, {
    headers: { Cookie: userCookie },
  });
  assert.equal(revokedUserSession.status, 200);

  const userSupport = await fetch(`${origin}/api/user/support`, {
    method: 'POST',
    headers: { Cookie: userCookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject: 'Account question', message: 'Please help me understand my account.' }),
  });
  assert.equal(userSupport.status, 201);
  const supportRequest = await userSupport.json();
  assert.equal(supportRequest.request.status, 'open');
  const supportDashboard = await fetch(`${origin}/api/user/dashboard`, { headers: { Cookie: userCookie } });
  assert.equal((await supportDashboard.json()).support.length, 1);

  const secondMemberRegister = await fetch(`${origin}/api/user/register`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Second Member',
      email: 'second-member@example.com',
      password: 'second-member-strong-password-592!',
      confirmPassword: 'second-member-strong-password-592!',
      termsAccepted: true,
    }),
  });
  assert.equal(secondMemberRegister.status, 202);
  const secondVerifyToken = tokenFromEmail(sentEmails.at(-1), 'verify');
  const secondVerify = await fetch(`${origin}/api/user/verify-email`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: secondVerifyToken }),
  });
  assert.equal(secondVerify.status, 200);
  const secondMemberLogin = await fetch(`${origin}/api/user/login`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'second-member@example.com', password: 'second-member-strong-password-592!' }),
  });
  assert.equal(secondMemberLogin.status, 200);
  const secondMemberCookie = secondMemberLogin.headers.getSetCookie()[0].split(';')[0];
  const secondMemberDashboard = await fetch(`${origin}/api/user/dashboard`, {
    headers: { Cookie: secondMemberCookie },
  });
  const secondMemberData = await secondMemberDashboard.json();
  assert.equal(secondMemberData.user.email, 'second-member@example.com');
  assert.deepEqual(secondMemberData.support, []);

  const createAdminMember = await fetch(`${origin}/api/admin/members`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Admin Created Member', email: 'admin-created@example.com' }),
  });
  assert.equal(createAdminMember.status, 201);
  const adminMember = (await createAdminMember.json()).member;
  assert.match(adminMember.accountId, /^GSQ-[A-Z0-9]{6}$/);
  const adminMemberVerifyToken = tokenFromEmail(sentEmails.at(-1), 'verify');
  const adminMemberVerify = await fetch(`${origin}/api/user/verify-email`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.10' },
    body: JSON.stringify({ token: adminMemberVerifyToken }),
  });
  assert.equal(adminMemberVerify.status, 200);

  const adminMemberLookup = await fetch(
    `${origin}/api/admin/users/lookup?q=${encodeURIComponent(adminMember.accountId)}`,
    { headers: { Cookie: cookie } },
  );
  assert.equal(adminMemberLookup.status, 200);
  const adminMemberRecord = (await adminMemberLookup.json()).user;
  assert.equal(adminMemberRecord.email, 'admin-created@example.com');
  const missingMemberLookup = await fetch(
    `${origin}/api/admin/users/lookup?q=${encodeURIComponent('missing-member@example.com')}`,
    { headers: { Cookie: cookie } },
  );
  assert.equal((await missingMemberLookup.json()).user, null);

  const setAdminMemberPassword = await fetch(`${origin}/api/admin/users/${adminMember.id}/password`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'admin-created-member-password-938!' }),
  });
  assert.equal(setAdminMemberPassword.status, 200);
  const adminMemberLogin = await fetch(`${origin}/api/user/login`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.13' },
    body: JSON.stringify({ email: 'admin-created@example.com', password: 'admin-created-member-password-938!' }),
  });
  assert.equal(adminMemberLogin.status, 200);
  const adminMemberCookie = adminMemberLogin.headers.getSetCookie()[0].split(';')[0];
  const memberDetailsResponse = await fetch(`${origin}/api/admin/users/${adminMember.id}`, {
    headers: { Cookie: cookie },
  });
  assert.equal(memberDetailsResponse.status, 200);
  assert.equal((await memberDetailsResponse.json()).user.id, adminMember.id);

  const editAdminMember = await fetch(`${origin}/api/admin/users/${adminMember.id}`, {
    method: 'PATCH',
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Updated Admin Member',
      email: 'admin-created@example.com',
      status: 'active',
    }),
  });
  assert.equal(editAdminMember.status, 200);
  const deactivateAdminMember = await fetch(`${origin}/api/admin/users/${adminMember.id}`, {
    method: 'DELETE',
    headers: { Cookie: cookie, Origin: origin },
  });
  assert.equal(deactivateAdminMember.status, 200);
  const deactivatedMemberSession = await fetch(`${origin}/api/user/me`, { headers: { Cookie: adminMemberCookie } });
  assert.equal(deactivatedMemberSession.status, 401);
  const deactivatedLookup = await fetch(
    `${origin}/api/admin/users/lookup?q=${encodeURIComponent('admin-created@example.com')}`,
    { headers: { Cookie: cookie } },
  );
  assert.equal((await deactivatedLookup.json()).user.status, 'suspended');
  const seededTransactions = spawnSync(process.execPath, ['-e', `
    const Database = require('better-sqlite3');
    const db = new Database(process.env.GSQUAD_DB_PATH);
    db.prepare("INSERT INTO deposits (id, user_id, amount_minor, currency, idempotency_key) VALUES ('bulk-deposit-1', ?, 5000, 'USD', 'bulk-deposit-key-1')").run(process.env.TEST_MEMBER_ID);
    db.prepare("INSERT INTO withdrawals (id, user_id, amount_minor, currency, idempotency_key) VALUES ('bulk-withdrawal-1', ?, 2000, 'USD', 'bulk-withdrawal-key-1')").run(process.env.TEST_MEMBER_ID);
    db.close();
  `], { cwd: root, env: { ...env, TEST_MEMBER_ID: loginResult.user.id }, encoding: 'utf8' });
  assert.equal(seededTransactions.status, 0, seededTransactions.stderr);
  const bulkReview = await fetch(`${origin}/api/admin/transactions/bulk-review`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: 'approved',
      items: [
        { type: 'deposits', id: 'bulk-deposit-1' },
        { type: 'withdrawals', id: 'bulk-withdrawal-1' },
      ],
    }),
  });
  assert.equal(bulkReview.status, 200);
  assert.deepEqual(await bulkReview.json(), { reviewed: 2, status: 'approved', walletBalancesChanged: false });
  const replayBulkReview = await fetch(`${origin}/api/admin/transactions/bulk-review`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: 'approved',
      items: [{ type: 'deposits', id: 'bulk-deposit-1' }],
    }),
  });
  assert.equal(replayBulkReview.status, 409);
  const reviewedDeposit = (await (await fetch(`${origin}/api/admin/deposits`, { headers: { Cookie: cookie } })).json())
    .records.find((record) => record.id === 'bulk-deposit-1');
  assert.equal(reviewedDeposit.status, 'approved');
  const walletAfterReview = await fetch(`${origin}/api/user/dashboard`, { headers: { Cookie: userCookie } });
  assert.equal((await walletAfterReview.json()).user.walletBalanceMinor, 0);

  const userLogin = await fetch(`${origin}/api/user/login`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'portal-member@example.com', password: 'portal-member-updated-password-598!' }),
  });
  assert.equal(userLogin.status, 200);
  assert.equal((await userLogin.json()).user.accountId, loginResult.user.accountId);
  const persistedPreference = await fetch(`${origin}/api/user/dashboard`, {
    headers: { Cookie: userLogin.headers.getSetCookie()[0].split(';')[0] },
  });
  assert.equal((await persistedPreference.json()).user.botEnabled, true);
  const stopBot = await fetch(`${origin}/api/user/bot/stop`, {
    method: 'POST',
    headers: { Cookie: userCookie, Origin: origin, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(stopBot.status, 200);
  assert.equal((await stopBot.json()).botEnabled, false);
  const optedOutDashboard = await fetch(`${origin}/api/user/dashboard`, { headers: { Cookie: userCookie } });
  assert.equal((await optedOutDashboard.json()).user.botEnabled, false);

  const passwordResetRequest = await fetch(`${origin}/api/user/password/forgot`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'portal-member@example.com' }),
  });
  assert.equal(passwordResetRequest.status, 200);
  const resetLink = linkFromEmail(sentEmails.at(-1), 'reset');
  assert.equal(resetLink.pathname, '/');
  const resetToken = resetLink.searchParams.get('reset');
  const resetPassword = await fetch(`${origin}/api/user/password/reset`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: resetToken,
      password: 'portal-member-reset-password-746!',
      confirmPassword: 'portal-member-reset-password-746!',
    }),
  });
  assert.equal(resetPassword.status, 200);
  const afterPasswordReset = await fetch(`${origin}/api/user/me`, { headers: { Cookie: userCookie } });
  assert.equal(afterPasswordReset.status, 401);
  const afterResetLogin = await fetch(`${origin}/api/user/login`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.12' },
    body: JSON.stringify({ email: 'portal-member@example.com', password: 'portal-member-reset-password-746!' }),
  });
  assert.equal(afterResetLogin.status, 200);
  const resetUserCookie = afterResetLogin.headers.getSetCookie()[0].split(';')[0];
  const userLogout = await fetch(`${origin}/api/user/logout`, {
    method: 'POST',
    headers: { Cookie: resetUserCookie, Origin: origin },
  });
  assert.equal(userLogout.status, 204);
  const afterUserLogout = await fetch(`${origin}/api/user/me`, { headers: { Cookie: resetUserCookie } });
  assert.equal(afterUserLogout.status, 401);

  const logoutResponse = await fetch(`${origin}/api/auth/logout`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: origin },
  });
  assert.equal(logoutResponse.status, 204);
  const afterLogout = await fetch(`${origin}/api/auth/me`, { headers: { Cookie: cookie } });
  assert.equal(afterLogout.status, 401);

  await stopProcess(child);
  child = null;
  child = spawn(process.execPath, ['server/index.js', '--production'], {
    cwd: root,
    env: { ...env, NODE_ENV: 'production' },
    stdio: 'ignore',
  });
  const productionHealth = await waitForHealth(origin);
  assert.ok(productionHealth, 'production server should start');
  assert.equal(productionHealth.status, 200);
  const productionLogin = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'integration-admin', password: adminPassword }),
  });
  assert.equal(productionLogin.status, 200);
  const productionCookie = productionLogin.headers.getSetCookie()[0].split(';')[0];
  const persistedDerivCredentials = await fetch(`${origin}/api/admin/settings`, { headers: { Cookie: productionCookie } });
  const persistedDerivStatus = await persistedDerivCredentials.json();
  assert.equal(persistedDerivStatus.derivAppId, '123456');
  assert.ok(persistedDerivStatus.settings.appLogo);
  assert.equal(JSON.stringify(persistedDerivStatus).includes(replacementDerivPat), false);

  const productionPage = await fetch(`${origin}/`);
  assert.equal(productionPage.status, 200);
  const html = await productionPage.text();
  const assetPath = html.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(assetPath, 'production HTML should reference the application bundle');
  const jsAsset = await fetch(new URL(assetPath, origin));
  assert.equal(jsAsset.status, 200);
  assert.match(jsAsset.headers.get('content-type'), /javascript/);
  assert.match(productionPage.headers.get('content-security-policy'), /upgrade-insecure-requests/);
  const memberPortalPage = await fetch(`${origin}/`);
  assert.equal(memberPortalPage.status, 200);
  assert.match(await memberPortalPage.text(), /G-Squad/);
  const productionAdminPage = await fetch(`${origin}/admin`);
  assert.equal(productionAdminPage.status, 200);
  assert.match(await productionAdminPage.text(), /G-Squad/);
  const productionPublicSettings = await fetch(`${origin}/api/app-settings`);
  assert.equal((await productionPublicSettings.json()).settings.appLogo, persistedDerivStatus.settings.appLogo);
});
