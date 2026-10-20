const path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { rateLimit } = require('express-rate-limit');
const db = require('./database');
const adminRouter = require('./admin');
const {
  adminSessionDurationMs,
  audit,
  disableMfa,
  enableMfa,
  listAdminSessions,
  login,
  logout,
  requireAdmin,
  revokeAdminSession,
  setupMfa,
  verifyLoginMfa,
} = require('./auth');
const { bootstrapAdmin } = require('./admin-bootstrap');
const userModule = require('./user');
const { getRequestOrigin } = require('./origin');

const app = express();
const port = Number(process.env.PORT) || 3000;
const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';
let applicationReady;

function ensureApplicationReady() {
  if (!applicationReady) {
    applicationReady = bootstrapAdmin().catch((error) => {
      console.error('Could not initialize administrator:', error.message);
      throw error;
    });
  }
  return applicationReady;
}

if (production) process.env.NODE_ENV = 'production';

app.use((request, response, next) => {
  const requestId = randomUUID();
  response.locals.requestId = requestId;
  response.set('X-Request-Id', requestId);
  next();
});
app.use((request, response, next) => {
  ensureApplicationReady().then(() => next(), next);
});

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY || (production ? false : 'loopback'));
app.use(helmet({
  strictTransportSecurity: production,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: production ? ["'self'"] : ["'self'", "'unsafe-inline'"],
      upgradeInsecureRequests: production ? [] : null,
    },
  },
}));
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
}));

function requireSameOrigin(request, response, next) {
  const origin = request.get('origin');
  const expectedOrigin = getRequestOrigin(request);
  try {
    if (origin && new URL(origin).origin === new URL(expectedOrigin).origin) return next();
  } catch {
    return response.status(403).json({ error: 'Request origin was rejected.' });
  }
  return response.status(403).json({ error: 'Request origin was rejected.' });
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please try again later.' },
});

const userLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please try again later.' },
});

const userRegistrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many account creation attempts. Please try again later.' },
});

const userRecoveryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many account recovery attempts. Please try again later.' },
});

function requireSameOriginForChanges(request, response, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return next();
  return requireSameOrigin(request, response, next);
}

app.use('/api/auth/login', loginLimiter, requireSameOriginForChanges);
app.use('/api/auth/logout', requireSameOriginForChanges);
app.use('/api/auth/mfa', requireSameOriginForChanges);
app.use('/api/auth/sessions', requireSameOriginForChanges);
app.use('/api/admin', requireSameOriginForChanges);
app.use('/api/user', requireSameOriginForChanges);
app.use(express.json({ limit: '2mb', strict: true }));
app.use(cookieParser());

app.get('/api/health', async (request, response) => {
  await ensureApplicationReady();
  return response.json({
  status: 'ok',
  tradingEnabled: false,
  paymentsEnabled: false,
  });
});
app.get('/api/app-settings', async (request, response, next) => {
  try {
    const rows = await db.prepare(`
      SELECT key, value_json FROM app_settings
      WHERE key IN ('organizationName', 'appLogo')
    `).all();
    const settings = { organizationName: 'G-Squad', appLogo: '' };
    for (const row of rows) settings[row.key] = JSON.parse(row.value_json);
    const registration = await db.prepare("SELECT value_json FROM app_settings WHERE key = 'memberRegistrationEnabled'").get();
    return response.json({ settings, registrationEnabled: registration ? JSON.parse(registration.value_json) : true });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/auth/login', login);
app.post('/api/auth/mfa/verify', loginLimiter, verifyLoginMfa);
app.post('/api/auth/mfa/setup', requireAdmin, setupMfa);
app.post('/api/auth/mfa/enable', requireAdmin, enableMfa);
app.post('/api/auth/mfa/disable', requireAdmin, disableMfa);
app.get('/api/auth/sessions', requireAdmin, listAdminSessions);
app.delete('/api/auth/sessions/:sessionId', requireAdmin, revokeAdminSession);
app.get('/api/auth/me', requireAdmin, (request, response) => {
  response.json({
    user: {
      id: request.admin.id,
      username: request.admin.username,
      role: request.admin.role,
      permissions: request.admin.permissions,
      mfaEnabled: Boolean(request.admin.mfaEnabled),
      sessionDurationMinutes: adminSessionDurationMs() / 60_000,
    },
    tradingEnabled: false,
    paymentsEnabled: false,
  });
});
app.post('/api/auth/logout', logout);
app.post('/api/user/register', userRegistrationLimiter, userModule.register);
app.post('/api/user/login', userLoginLimiter, userModule.login);
app.post('/api/user/verify-email', userRecoveryLimiter, userModule.verifyEmail);
app.post('/api/user/resend-verification', userRecoveryLimiter, userModule.resendVerification);
app.post('/api/user/password/forgot', userRecoveryLimiter, userModule.requestPasswordReset);
app.post('/api/user/password/reset', userRecoveryLimiter, userModule.resetPassword);
app.get('/api/user/me', userModule.requireUser, (request, response) => {
  response.json({ user: {
    id: request.user.id,
    accountId: request.user.account_id,
    name: request.user.display_name,
    email: request.user.email,
    emailVerified: Boolean(request.user.email_verified),
    currency: request.user.currency,
  } });
});
app.post('/api/user/logout', userModule.requireUser, userModule.logout);
app.use('/api/user', userModule.requireUser, userModule.router);
app.use('/api/admin', requireAdmin, adminRouter);
app.use('/api', (request, response) => response.status(404).json({ error: 'API route not found.' }));

app.use((error, request, response, next) => {
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500
    ? error.status
    : 500;
  console.error('Request failed:', {
    requestId: response.locals.requestId,
    method: request.method,
    path: request.path,
    type: error.type || error.name,
    code: error.code,
    status,
  });
  if (response.headersSent) return next(error);
  return response.status(status).json({
    error: status === 500 ? 'The request could not be completed.' : 'Invalid request.',
    requestId: response.locals.requestId,
  });
});

async function start() {
  let vite;
  if (production) {
    const buildDirectory = path.resolve('public');
    app.use(express.static(buildDirectory, { index: false, fallthrough: true }));
    app.use(express.static(path.join(buildDirectory, 'site'), { index: false, fallthrough: true }));
    app.get(/.*/, (request, response, next) => {
      response.sendFile(path.join(buildDirectory, 'site', 'index.html'), (error) => {
        if (error) next(error);
      });
    });
  } else {
    const { createServer } = await import('vite');
    vite = await createServer({
      appType: 'spa',
      server: { middlewareMode: true },
    });
    app.use(vite.middlewares);
  }

  await db.ready;
  await db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(new Date().toISOString());
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`G-Squad is running at http://localhost:${port}`);
    console.log('Live trading and payment processing are disabled.');
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    Promise.resolve(vite?.close())
      .catch((error) => console.error('Could not close Vite cleanly:', error))
      .finally(() => {
        server.close(() => void db.close());
        server.closeAllConnections();
      });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Could not start G-Squad:', error);
    process.exitCode = 1;
  });
}

module.exports = app;
