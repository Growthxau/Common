import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { UserPortal } from './user.jsx';
import './styles.css';

const navigation = [
  { label: 'WORKSPACE', items: [{ id: 'overview', name: 'Dashboard', icon: '▦' }, { id: 'users', name: 'User management', icon: '♙' }] },
  { label: 'TRADING', items: [{ id: 'connection', name: 'Deriv connection', icon: '⌁' }, { id: 'engine', name: 'Trading engine', icon: '◉' }, { id: 'trades', name: 'Trade history', icon: '↗' }, { id: 'profit', name: 'Profit sharing', icon: '⇄' }, { id: 'risk', name: 'Risk management', icon: '◇' }] },
  { label: 'OPERATIONS', items: [{ id: 'deposits', name: 'Deposits', icon: '↓' }, { id: 'withdrawals', name: 'Withdrawals', icon: '↑' }, { id: 'ledger', name: 'Wallet ledger', icon: '▤' }, { id: 'notifications', name: 'Notifications', icon: '♧' }, { id: 'support', name: 'Support', icon: '?' }] },
  { label: 'SYSTEM', items: [{ id: 'employees', name: 'Employee access', icon: '♙' }, { id: 'settings', name: 'Application settings', icon: '⚙' }, { id: 'security', name: 'Security & audit', icon: '▤' }] },
];

let applicationSettings = {
  organizationName: 'G-Squad',
  defaultCurrency: 'USD',
  timezone: 'UTC',
  appLogo: '',
};

const pageDetails = {
  users: { title: 'User management', subtitle: 'Review account status, wallet figures, configured stakes, and member participation preferences.', resource: 'users', columns: [['accountId', 'Account ID'], ['name', 'Name'], ['email', 'Email'], ['emailVerified', 'Email verified'], ['walletBalanceMinor', 'Wallet'], ['configuredStakeMinor', 'Configured stake'], ['botEnabled', 'Participation'], ['status', 'Account'], ['lastSeenAt', 'Last active']] },
  employees: { title: 'Employee access', subtitle: 'Provision employee administrator accounts and assign access roles.', resource: 'employees', columns: [['username', 'Username'], ['role', 'Role'], ['createdAt', 'Created'], ['lastLoginAt', 'Last sign-in']] },
  deposits: { title: 'Deposits', subtitle: 'Deposit records. Payment verification and crediting are not enabled.', resource: 'deposits', columns: [['userName', 'User'], ['accountId', 'Account ID'], ['amountMinor', 'Amount'], ['paymentReference', 'Reference'], ['status', 'Status'], ['createdAt', 'Requested']] },
  withdrawals: { title: 'Withdrawals', subtitle: 'Withdrawal records. Payout processing is not enabled.', resource: 'withdrawals', columns: [['userName', 'User'], ['accountId', 'Account ID'], ['amountMinor', 'Amount'], ['paymentReference', 'Reference'], ['status', 'Status'], ['createdAt', 'Requested']] },
  trades: { title: 'Trade history', subtitle: 'Only Deriv-confirmed execution results may be reported as real trades.', resource: 'trades', columns: [['mode', 'Mode'], ['contractId', 'Contract ID'], ['actualStakeMinor', 'Actual stake'], ['payoutMinor', 'Payout'], ['profitLossMinor', 'Profit / loss'], ['confirmedByDeriv', 'Deriv confirmed'], ['status', 'Execution'], ['executedAt', 'Timestamp']] },
  profit: { title: 'Profit sharing', subtitle: 'Frozen participants, contributions, proportional allocations, and settlement status.', resource: 'rounds', columns: [['mode', 'Mode'], ['id', 'Round'], ['participantCount', 'Participants'], ['combinedStakeMinor', 'Combined stake'], ['status', 'Settlement'], ['contractId', 'Contract ID'], ['createdAt', 'Created']] },
  ledger: { title: 'Wallet ledger', subtitle: 'An append-only record of every wallet credit, debit, and adjustment.', resource: 'ledger', columns: [['createdAt', 'Timestamp'], ['accountId', 'Account ID'], ['userName', 'User'], ['entryType', 'Entry'], ['direction', 'Direction'], ['amountMinor', 'Amount'], ['balanceAfterMinor', 'Balance after'], ['referenceId', 'Reference']] },
  notifications: { title: 'Notifications', subtitle: 'Operational alerts for connection, payment, risk, and trading events.', resource: 'notifications', columns: [['severity', 'Severity'], ['category', 'Category'], ['title', 'Alert'], ['message', 'Details'], ['createdAt', 'Created']] },
  support: { title: 'Support management', subtitle: 'Review user requests and track response status.', resource: 'support', columns: [['accountId', 'Account ID'], ['userName', 'User'], ['subject', 'Subject'], ['message', 'Request'], ['status', 'Status'], ['createdAt', 'Received']] },
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.error || 'The request could not be completed.');
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

function money(minor, currency = applicationSettings.defaultCurrency) {
  if (minor === null || minor === undefined) return '—';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

function balanceSummary(balances, emptyLabel = '—') {
  if (!balances?.length) return emptyLabel;
  return balances.map(({ amountMinor, currency }) => money(amountMinor, currency)).join(' · ');
}

function dateLabel(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: applicationSettings.timezone,
    }).format(date);
}

function SignIn({ onSignIn }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      onSignIn(result.user);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-layout">
      <section className="login-card" aria-labelledby="login-title">
        <Brand />
        <p className="eyebrow">SECURE ADMIN ACCESS</p>
        <h1 id="login-title">Welcome back</h1>
        <p className="muted">Sign in to the G-Squad administration console.</p>
        <form className="login-form" onSubmit={submit}>
          <label htmlFor="username">Admin username</label>
          <input id="username" autoComplete="username" required value={username} onChange={(event) => setUsername(event.target.value)} />
          <label htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
          {error && <p className="inline-error" role="alert">{error}</p>}
          <button className="button button-primary login-submit" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in securely'}</button>
        </form>
        <p className="login-footnote">Employee admin accounts are provisioned by a super-admin. Public registration is unavailable.</p>
        <div className="operations-note"><span className="status-dot status-dot-amber"></span> Trading and payment operations are disabled</div>
        <a className="portal-admin-link" href="/">Looking for your account? Visit the user portal</a>
      </section>
    </main>
  );
}

function SplashScreen({ logo }) {
  return (
    <main className="app-splash-screen" aria-live="polite" aria-label="Loading splash screen">
      {logo
        ? <img className="app-splash-logo app-splash-logo-image" src={logo} alt="" aria-hidden="true" />
        : <div className="app-splash-logo" aria-hidden="true">G</div>}
    </main>
  );
}

function Brand() {
  return <div className="brand">{applicationSettings.appLogo
    ? <img className="brand-image" src={applicationSettings.appLogo} alt="" />
    : <span className="brand-symbol">G</span>}<span><strong>{applicationSettings.organizationName}</strong><small>ADMIN CONSOLE</small></span></div>;
}

function Sidebar({ activePage, onNavigate, open, onClose, user }) {
  const elevatedOnly = new Set(['users', 'employees', 'settings', 'connection', 'risk', 'deposits', 'withdrawals', 'profit', 'ledger', 'security']);
  return (
    <>
      <button className={`sidebar-scrim${open ? ' is-visible' : ''}`} aria-label="Close navigation" onClick={onClose} />
      <aside className={`sidebar${open ? ' is-open' : ''}`} aria-label="Main navigation">
        <div className="sidebar-brand"><Brand /><button className="mobile-close" type="button" onClick={onClose} aria-label="Close navigation">×</button></div>
        <nav className="side-nav">
          {navigation.map((group) => {
            const items = user.role === 'super_admin' ? group.items : group.items.filter((item) => !elevatedOnly.has(item.id));
            return items.length > 0 && <div className="nav-group" key={group.label}>
              <p className="nav-group-label">{group.label}</p>
              {items.map((item) => (
                <button key={item.id} type="button" className={`nav-item${activePage === item.id ? ' is-active' : ''}`} onClick={() => onNavigate(item.id)}>
                  <span className="nav-icon" aria-hidden="true">{item.icon}</span><span>{item.name}</span>
                </button>
              ))}
            </div>;
          })}
        </nav>
        <div className="sidebar-footer">
          <div className="sidebar-user-avatar">{user.username.slice(0, 2).toUpperCase()}</div>
          <div className="sidebar-user"><strong>{user.username}</strong><span>{user.role.replace('_', ' ')}</span></div>
          <span className="online-indicator" title="Signed in" />
        </div>
      </aside>
    </>
  );
}

function Header({ user, onMenu, onLogout, activePage }) {
  const current = navigation.flatMap((group) => group.items).find((item) => item.id === activePage);
  return (
    <header className="topbar">
      <button className="menu-toggle" type="button" onClick={onMenu} aria-label="Open navigation">☰</button>
      <div className="breadcrumbs"><span>G-Squad</span><span className="breadcrumb-slash">/</span><strong>{current?.name || 'Dashboard'}</strong></div>
      <div className="header-actions">
        <span className="header-user">{user.username}</span>
        <button className="button button-subtle logout-button" type="button" onClick={onLogout}>Sign out</button>
      </div>
    </header>
  );
}

function Metric({ label, value, detail, icon, tone = 'blue' }) {
  return (
    <article className="metric-card">
      <div className={`metric-icon tone-${tone}`} aria-hidden="true">{icon}</div>
      <p className="metric-label">{label}</p>
      <p className="metric-value">{value}</p>
      <p className="metric-detail">{detail}</p>
    </article>
  );
}

function Overview({ metrics, loading, error, onRetry }) {
  if (loading) return <LoadingPanel label="Loading dashboard data…" />;
  if (error) return <ErrorPanel message={error} onRetry={onRetry} />;
  const data = metrics || {};
  return (
    <div className="page-stack">
      <div className="page-title-row">
        <div><p className="eyebrow">WORKSPACE OVERVIEW</p><h1>Dashboard</h1><p className="page-description">An overview of recorded platform activity and operational status.</p></div>
        <span className="read-only-pill">LIVE ACTIONS DISABLED</span>
      </div>
      <div className="notice notice-info"><span className="notice-icon">i</span><span><strong>Operations are restricted.</strong> This installation has no active payment processor or trading integration. Financial activity shown here is not live-verified.</span></div>
      <section className="metrics-grid" aria-label="Platform metrics">
        <Metric label="Total users" value={data.totalUsers ?? '—'} detail="Registered user accounts" icon="♙" tone="blue" />
        <Metric label="Bot opt-ins" value={data.activeBots ?? '—'} detail="Saved preference; no trades execute" icon="◉" tone="violet" />
        <Metric label="Admin Deriv balance" value={data.derivConnected ? money(data.adminDerivBalanceMinor) : 'Not connected'} detail="Verified account balance" icon="⌁" tone="cyan" />
        <Metric label="User wallet liabilities" value={balanceSummary(data.walletLiabilitiesByCurrency, '—')} detail="Live user wallets only" icon="▤" tone="green" />
        <Metric label="Daily profit / loss" value={balanceSummary(data.dailyProfitLossByCurrency)} detail={data.verifiedTradesToday ? 'Deriv-confirmed trades today' : 'No verified live trades today'} icon="↗" tone="amber" />
        <Metric label="Combined stake" value={balanceSummary(data.combinedStakeByCurrency)} detail="Active live trading rounds" icon="⇄" tone="blue" />
        <Metric label="Pending deposits" value={data.pendingDeposits ?? '—'} detail="Awaiting verification" icon="↓" tone="cyan" />
        <Metric label="Pending withdrawals" value={data.pendingWithdrawals ?? '—'} detail="Awaiting review" icon="↑" tone="violet" />
      </section>
      <section className="overview-bottom">
        <article className="surface-card connection-card">
          <div className="section-heading"><div><h2>System status</h2><p>Integrations and trading safety</p></div><span className="status-tag status-tag-warning">NOT LIVE</span></div>
          <StatusLine label="Deriv connection" value={data.derivConnected ? 'Connected' : 'Not connected'} good={data.derivConnected} />
          <StatusLine label="Trading engine" value="Stopped" />
          <StatusLine label="Live money movement" value="Disabled" />
          <StatusLine label="Live trading" value="Disabled" />
          <StatusLine label="Payment processing" value="Disabled" />
        </article>
        <article className="surface-card getting-started">
          <div className="section-heading"><div><h2>Next steps</h2><p>Complete the platform foundation in stages</p></div></div>
          <ol className="setup-list">
            <li><span className="setup-number">1</span><span><strong>Provision an admin</strong><small>Create the first admin from a secure terminal.</small></span></li>
            <li><span className="setup-number">2</span><span><strong>Review database schema</strong><small>Wallet, audit, payment, and trading records persist in SQLite.</small></span></li>
            <li><span className="setup-number">3</span><span><strong>Keep live trading off</strong><small>Deriv and payment workflows need verification before enablement.</small></span></li>
          </ol>
        </article>
      </section>
    </div>
  );
}

function StatusLine({ label, value, good = false }) {
  return <div className="status-line"><span>{label}</span><strong className={good ? 'text-good' : ''}>{value}</strong></div>;
}

function PageHeading({ title, subtitle, trailing }) {
  return <div className="page-title-row"><div><p className="eyebrow">ADMINISTRATION</p><h1>{title}</h1><p className="page-description">{subtitle}</p></div>{trailing}</div>;
}

function ConnectionPage({ data, loading, error, onRetry }) {
  if (loading) return <LoadingPanel label="Checking connection settings…" />;
  if (error) return <ErrorPanel message={error} onRetry={onRetry} />;
  const settings = data || {};
  return (
    <div className="page-stack">
      <PageHeading title="Deriv connection" subtitle="Credential readiness and verified account status. Secret values are never sent to the browser." />
      <div className="surface-card detail-card">
        <div className="section-heading"><div><h2>Backend credentials</h2><p>Manage credentials in Application settings; secrets stay server-side.</p></div><span className="status-tag status-tag-warning">{settings.derivConnected ? 'CONNECTED' : 'NOT CONNECTED'}</span></div>
        <StatusLine label="DERIV_PAT configured" value={settings.derivPatConfigured ? 'Set on server' : 'Not set'} good={settings.derivPatConfigured} />
        <StatusLine label="DERIV_APP_ID configured" value={settings.derivAppIdConfigured ? 'Set on server' : 'Not set'} good={settings.derivAppIdConfigured} />
        <StatusLine label="Verified account currency" value="Unavailable" />
        <StatusLine label="Verified Deriv balance" value="Unavailable" />
        <p className="notice notice-warning"><span className="notice-icon">!</span><span>Credentials are not exposed here. A configured PAT alone does not mean a live connection has been verified. Live trading remains disabled.</span></p>
      </div>
    </div>
  );
}

function EnginePage({ metrics, data, loading, error, onRetry }) {
  if (loading) return <LoadingPanel label="Loading trading engine status…" />;
  if (error) return <ErrorPanel message={error} onRetry={onRetry} />;
  return (
    <div className="page-stack">
      <PageHeading title="Trading engine" subtitle="Trading is hard-disabled in this foundation; no signal or order can execute." trailing={<div className="engine-actions"><button className="button button-disabled" type="button" disabled>Engine stopped</button><button className="button button-subtle" type="button" disabled>Emergency stop unavailable</button></div>} />
      <div className="notice notice-warning"><span className="notice-icon">!</span><span><strong>Live execution is not implemented.</strong> Deriv approval, verified funds, frozen round participants, risk checks, and idempotent settlement must be completed before any real trade.</span></div>
      <div className="metrics-grid engine-metrics">
        <Metric label="Engine state" value="Stopped" detail="Cannot be started in this build" icon="◉" tone="amber" />
        <Metric label="Deriv link" value={metrics?.derivConnected ? 'Connected' : 'Offline'} detail="No trading socket established" icon="⌁" tone="cyan" />
        <Metric label="Eligible users" value="0" detail="Live execution unavailable" icon="♙" tone="violet" />
        <Metric label="Combined stake" value={balanceSummary(metrics?.combinedStakeByCurrency)} detail="No active live rounds" icon="⇄" tone="blue" />
      </div>
      <section className="surface-card detail-card engine-status">
        <div className="section-heading"><div><h2>Execution readiness</h2><p>Live market data and order execution are not connected.</p></div><span className="status-tag status-tag-warning">DISABLED</span></div>
        <StatusLine label="Live market status" value="Unavailable — no market feed" />
        <StatusLine label="Approved signals" value={data?.records?.filter((signal) => signal.status === 'approved').length ?? 0} />
        <StatusLine label="Eligible live users" value="0 — trading disabled" />
        <StatusLine label="Emergency stop control" value="Not implemented; live trading is hard-disabled" />
      </section>
      <RecordPage config={{ title: 'Approved signals', subtitle: 'Signals are not yet approved or executable.', resource: 'signals', columns: [['market', 'Market'], ['direction', 'Direction'], ['status', 'Status'], ['source', 'Source'], ['approvedAt', 'Approved']] }} data={data} loading={false} error={null} onRetry={onRetry} />
    </div>
  );
}

function RiskPage({ data, loading, error, onRetry }) {
  useEffect(() => {
    if (!data?.settings) return;
    applicationSettings = { ...applicationSettings, ...data.settings };
    document.title = `${applicationSettings.organizationName} | Admin Console`;
  }, [data?.settings]);
  if (loading) return <LoadingPanel label="Loading risk limits…" />;
  if (error) return <ErrorPanel message={error} onRetry={onRetry} />;
  return (
    <div className="page-stack">
      <PageHeading title="Risk management" subtitle="Required controls for loss limits, exposure, and automatic stops." />
      <div className="notice notice-warning"><span className="notice-icon">!</span><span>Saving risk limits does not enable trading. Execution remains disabled until a verified trading integration is implemented and separately reviewed.</span></div>
      <RiskSettingsEditor initialSettings={data?.riskSettings} />
    </div>
  );
}

function RiskSettingsEditor({ initialSettings }) {
  const [risk, setRisk] = useState(initialSettings);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');

  useEffect(() => setRisk(initialSettings), [initialSettings]);
  if (!risk) return null;

  function setLimit(field, value) {
    setRisk((current) => ({ ...current, [field]: value === '' ? null : Math.round(Number(value) * 100) }));
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setFeedback('');
    setError('');
    try {
      const result = await api('/api/admin/risk-settings', {
        method: 'PUT',
        body: JSON.stringify({ riskSettings: risk }),
      });
      setRisk(result.riskSettings);
      setFeedback('Risk settings saved. Trading remains disabled.');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  const fields = [
    ['maxDailyLossMinor', 'Maximum daily loss'],
    ['dailyProfitTargetMinor', 'Daily profit target'],
    ['maxCombinedStakeMinor', 'Maximum combined stake'],
    ['maxExposureMinor', 'Maximum exposure'],
  ];
  return (
    <form className="surface-card config-form" onSubmit={submit}>
      <div className="section-heading"><div><h2>Global risk limits</h2><p>Amounts are in the configured currency, stored in minor units.</p></div><span className="status-tag status-tag-warning">TRADING DISABLED</span></div>
      <div className="form-grid">
        {fields.map(([field, label]) => (
          <label className="form-field" key={field}>
            <span>{label}</span>
            <input type="number" min="0" step="0.01" value={risk[field] == null ? '' : risk[field] / 100} onChange={(event) => setLimit(field, event.target.value)} placeholder="Not configured" />
          </label>
        ))}
        <label className="form-field form-checkbox"><input type="checkbox" checked={Boolean(risk.emergencyStopEnabled)} onChange={(event) => setRisk((current) => ({ ...current, emergencyStopEnabled: event.target.checked ? 1 : 0 }))} /><span>Emergency stop enabled</span></label>
      </div>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {feedback && <p className="form-feedback" role="status">{feedback}</p>}
      <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save risk limits'}</button></div>
    </form>
  );
}

function ApplicationSettingsPage({ data, loading, error, onRetry, onSettingsChanged }) {
  useEffect(() => {
    if (!data?.settings) return;
    applicationSettings = { ...applicationSettings, ...data.settings };
    document.title = `${applicationSettings.organizationName} | Admin Console`;
  }, [data?.settings]);
  if (loading) return <LoadingPanel label="Loading application settings…" />;
  if (error) return <ErrorPanel message={error} onRetry={onRetry} />;
  return (
    <div className="page-stack">
      <PageHeading title="Application settings" subtitle="Configure platform identity, support contact, locale, and operational defaults." />
      <ApplicationSettingsEditor settings={data?.settings} onSettingsChanged={onSettingsChanged} />
      <section className="surface-card detail-card">
        <div className="section-heading"><div><h2>Deriv credentials</h2><p>App ID is stored as configuration; the PAT is encrypted on the server and never returned.</p></div><span className="status-tag status-tag-warning">NOT CONNECTED</span></div>
        <DerivCredentialsEditor status={data} />
        <StatusLine label="Deriv credentials" value={data?.derivPatConfigured && data?.derivAppIdConfigured ? 'Configured on server; not connected' : 'Not configured'} />
        <StatusLine label="Trading execution" value="Disabled" />
        <StatusLine label="Payment processing" value="Disabled" />
        <p className="notice notice-warning"><span className="notice-icon">!</span><span>Adding credentials does not activate an integration. No trading, deposit, withdrawal, or wallet mutation workflow is implemented.</span></p>
      </section>
    </div>
  );
}

function DerivCredentialsEditor({ status }) {
  const [appId, setAppId] = useState(status?.derivAppId || '');
  const [pat, setPat] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');

  useEffect(() => setAppId(status?.derivAppId || ''), [status?.derivAppId]);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setFeedback('');
    setError('');
    try {
      const result = await api('/api/admin/deriv-credentials', {
        method: 'PUT',
        body: JSON.stringify({ derivCredentials: { appId, pat } }),
      });
      setAppId(result.derivAppId);
      setPat('');
      setFeedback('Deriv credentials saved. Connection remains unverified and trading stays disabled.');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="config-form config-form-compact" onSubmit={submit}>
      <div className="form-grid">
        <label className="form-field"><span>Deriv App ID</span><input inputMode="numeric" pattern="[0-9]{1,20}" maxLength="20" required value={appId} onChange={(event) => setAppId(event.target.value)} /></label>
        <label className="form-field"><span>Replace Deriv PAT</span><input type="password" autoComplete="new-password" maxLength="512" value={pat} onChange={(event) => setPat(event.target.value)} placeholder={status?.derivPatConfigured ? 'Leave blank to keep current PAT' : 'Enter PAT'} /></label>
      </div>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {feedback && <p className="form-feedback" role="status">{feedback}</p>}
      <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save Deriv credentials'}</button></div>
    </form>
  );
}

function ApplicationSettingsEditor({ settings, onSettingsChanged }) {
  const [values, setValues] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');

  useEffect(() => setValues(settings), [settings]);
  if (!values) return null;

  function selectLogo(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError('');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 1024 * 1024) {
      setError('Choose a PNG, JPEG, or WebP image no larger than 1 MB.');
      event.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        setError('The selected logo could not be read.');
        return;
      }
      setValues((current) => ({ ...current, appLogo: reader.result }));
    };
    reader.onerror = () => setError('The selected logo could not be read.');
    reader.readAsDataURL(file);
    event.target.value = '';
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setFeedback('');
    setError('');
    try {
      const result = await api('/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({ settings: values }),
      });
      applicationSettings = { ...applicationSettings, ...result.settings };
      document.title = `${applicationSettings.organizationName} | Admin Console`;
      setValues(result.settings);
      onSettingsChanged();
      setFeedback('Application settings saved.');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="surface-card config-form" onSubmit={submit}>
      <div className="section-heading"><div><h2>Organization</h2><p>These values configure administrative display and defaults.</p></div></div>
      <div className="form-grid">
        <label className="form-field"><span>Organization name</span><input maxLength="80" required value={values.organizationName} onChange={(event) => setValues({ ...values, organizationName: event.target.value })} /></label>
        <label className="form-field"><span>Support email</span><input type="email" maxLength="254" value={values.supportEmail} onChange={(event) => setValues({ ...values, supportEmail: event.target.value })} placeholder="support@example.com" /></label>
        <label className="form-field"><span>Default currency (ISO 4217)</span><input minLength="3" maxLength="3" pattern="[A-Za-z]{3}" required value={values.defaultCurrency} onChange={(event) => setValues({ ...values, defaultCurrency: event.target.value.toUpperCase() })} /></label>
        <label className="form-field"><span>Timezone</span><input maxLength="100" required value={values.timezone} onChange={(event) => setValues({ ...values, timezone: event.target.value })} placeholder="UTC" /></label>
      </div>
      <div className="app-logo-field">
        <label className="form-field"><span>Application logo (PNG, JPEG, or WebP; max 1 MB)</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={selectLogo} /></label>
        <div className="app-logo-preview" aria-label="Application logo preview">
          {values.appLogo ? <img src={values.appLogo} alt="Application logo preview" /> : <span>G</span>}
          {values.appLogo && <button className="button button-subtle" type="button" onClick={() => setValues({ ...values, appLogo: '' })}>Remove logo</button>}
        </div>
      </div>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {feedback && <p className="form-feedback" role="status">{feedback}</p>}
      <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save application settings'}</button></div>
    </form>
  );
}

function EmployeesPage({ data, loading, error, onRetry }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('admin');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [formError, setFormError] = useState('');

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setFeedback('');
    setFormError('');
    try {
      await api('/api/admin/employees', {
        method: 'POST',
        body: JSON.stringify({ username, password, role }),
      });
      setUsername('');
      setPassword('');
      setRole('admin');
      setFeedback('Employee account created.');
      onRetry();
    } catch (requestError) {
      setFormError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingPanel label="Loading employee accounts…" />;
  if (error) return <ErrorPanel message={error} onRetry={onRetry} />;
  return (
    <div className="page-stack">
      <PageHeading title="Employee access" subtitle="Create staff accounts with the minimum access needed for their work." />
      <div className="notice notice-info"><span className="notice-icon">i</span><span>Only super-admins can provision employees. Admin employees have read-only operational access; super-admins can manage configuration, access, and sensitive records.</span></div>
      <form className="surface-card config-form" onSubmit={submit}>
        <div className="section-heading"><div><h2>Add employee</h2><p>Set a unique username, initial password, and role.</p></div></div>
        <div className="form-grid">
          <label className="form-field"><span>Username</span><input minLength="3" maxLength="64" pattern="[A-Za-z0-9._-]+" autoComplete="off" required value={username} onChange={(event) => setUsername(event.target.value)} /></label>
          <label className="form-field"><span>Initial password (14+ characters)</span><input type="password" minLength="14" maxLength="1024" autoComplete="new-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          <label className="form-field"><span>Role</span><select value={role} onChange={(event) => setRole(event.target.value)}><option value="admin">Admin — operational read-only</option><option value="super_admin">Super-admin — full administration</option></select></label>
        </div>
        {formError && <p className="inline-error" role="alert">{formError}</p>}
        {feedback && <p className="form-feedback" role="status">{feedback}</p>}
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create employee'}</button></div>
      </form>
      <RecordPage config={pageDetails.employees} data={data} loading={false} error={null} onRetry={onRetry} />
    </div>
  );
}

function SecurityPage({ user, data, loading, error, onRetry }) {
  if (loading) return <LoadingPanel label="Loading security settings…" />;
  if (error) return <ErrorPanel message={error} onRetry={onRetry} />;
  return (
    <div className="page-stack">
      <PageHeading title="Security & audit" subtitle="Admin access and security audit visibility." />
      <div className="surface-card detail-card">
        <div className="section-heading"><div><h2>Current session</h2><p>Authenticated admin identity</p></div><span className="status-tag status-tag-good">AUTHENTICATED</span></div>
        <StatusLine label="Username" value={user.username} />
        <StatusLine label="Role" value={user.role.replace('_', ' ')} />
        <StatusLine label="Permissions" value={user.role === 'super_admin' ? 'Full administrative access; live financial actions remain disabled' : 'Read-only operational access'} />
        <StatusLine label="Session protection" value="HttpOnly · SameSite · server stored" />
        <StatusLine label="Live money movement" value="Disabled" />
      </div>
      <RecordPage config={{ title: 'Admin audit log', subtitle: 'Recorded sign-in and administrative events.', resource: 'audit', columns: [['createdAt', 'Timestamp'], ['admin', 'Admin'], ['action', 'Action'], ['targetType', 'Target'], ['ipAddress', 'IP address']] }} data={data} loading={false} error={null} onRetry={onRetry} />
    </div>
  );
}

function RecordPage({
  config,
  data,
  loading,
  error,
  onRetry,
  onSelectRound,
  selectedRound,
  roundDetails,
  roundLoading,
  roundError,
}) {
  const [filter, setFilter] = useState('');
  useEffect(() => setFilter(''), [config.resource]);
  if (loading) return <LoadingPanel label={`Loading ${config.title.toLowerCase()}…`} />;
  if (error) return <ErrorPanel message={error} onRetry={onRetry} />;
  const records = data?.records || [];
  const visibleRecords = config.resource === 'users' && filter
    ? records.filter((record) => `${record.name} ${record.email} ${record.accountId}`.toLowerCase().includes(filter.toLowerCase()))
    : records;
  return (
    <section className="surface-card table-card">
      <div className="section-heading table-heading"><div><h2>{config.title}</h2><p>{config.subtitle}</p></div>
        {config.resource === 'users' && <label className="search-box"><span aria-hidden="true">⌕</span><input type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search users" aria-label="Search users" /></label>}
      </div>
      {visibleRecords.length === 0
        ? <div className="empty-state"><span className="empty-state-icon">▤</span><strong>{records.length ? 'No matching records' : 'No records yet'}</strong><span>{records.length ? 'Try a different search.' : 'When verified data is added, it will appear here.'}</span></div>
        : <div className="table-scroll"><table className="data-table"><thead><tr>{config.columns.map(([, label]) => <th key={label} scope="col">{label}</th>)}{config.resource === 'rounds' && <th scope="col">Participants</th>}</tr></thead><tbody>
          {visibleRecords.map((record) => <tr key={record.id || `${record.accountId}-${record.createdAt}`}>
            {config.columns.map(([key, label]) => <td key={key} data-label={label}><CellValue value={record[key]} record={record} field={key} /></td>)}
            {config.resource === 'rounds' && <td data-label="Participants"><button className="table-action" type="button" onClick={() => onSelectRound(record.id)}>View frozen list</button></td>}
          </tr>)}
        </tbody></table></div>}
      {config.resource === 'rounds' && selectedRound && <section className="round-detail" aria-label="Trading round participants">
        {roundLoading
          ? <LoadingPanel label="Loading frozen participants…" />
          : roundError
            ? <ErrorPanel message={roundError} onRetry={() => onSelectRound(selectedRound.id)} />
            : <>
              <div className="section-heading"><div><h2>Frozen participants</h2><p>Round {selectedRound.id} · Combined stake {money(selectedRound.combinedStakeMinor, selectedRound.currency)} · {selectedRound.frozenAt ? 'Frozen' : 'Not frozen'}</p></div><span className={`status-tag ${statusTone(roundDetails?.round?.settlementStatus || selectedRound.status)}`}>{roundDetails?.round?.settlementStatus || selectedRound.status}</span></div>
              {!roundDetails?.participants?.length
                ? <div className="empty-state compact-empty"><strong>No participants recorded</strong><span>Participant snapshots appear here after a round is frozen.</span></div>
                : <div className="table-scroll"><table className="data-table"><thead><tr><th>Account ID</th><th>User</th><th>Frozen contribution</th><th>Allocated result</th></tr></thead><tbody>
                  {roundDetails.participants.map((participant) => <tr key={participant.accountId}>
                    <td data-label="Account ID">{participant.accountId}</td>
                    <td data-label="User">{participant.name}</td>
                    <td data-label="Frozen contribution">{money(participant.stakeMinor, selectedRound.currency)}</td>
                    <td data-label="Allocated result">{participant.allocatedResultMinor == null ? 'Not settled' : money(participant.allocatedResultMinor, selectedRound.currency)}</td>
                  </tr>)}
                </tbody></table></div>}
            </>}
      </section>}
      <div className="table-footer"><span>{visibleRecords.length} {visibleRecords.length === 1 ? 'record' : 'records'}</span><span>G-Squad · Demo foundation</span></div>
    </section>
  );
}

function CellValue({ value, record, field }) {
  if (value === null || value === undefined || value === '') return <span className="muted">—</span>;
  if (field === 'amountMinor' || field.endsWith('BalanceMinor') || field.endsWith('StakeMinor') || field === 'payoutMinor' || field === 'profitLossMinor') return money(value, record.currency || 'USD');
  if (field === 'createdAt' || field === 'approvedAt' || field === 'executedAt' || field === 'updatedAt' || field === 'lastSeenAt') return dateLabel(value);
  if (field === 'botEnabled') return <span className={`status-tag ${value ? 'status-tag-warning' : 'status-tag-neutral'}`}>{value ? 'Opted in' : 'Off'}</span>;
  if (field === 'emailVerified') return <span className={`status-tag ${value ? 'status-tag-good' : 'status-tag-warning'}`}>{value ? 'Verified' : 'Pending'}</span>;
  if (field === 'confirmedByDeriv') return <span className={`status-tag ${value ? 'status-tag-good' : 'status-tag-neutral'}`}>{value ? 'Yes' : 'No'}</span>;
  if (field === 'mode') return <span className="status-tag status-tag-neutral">{value}</span>;
  if (field === 'status' || field === 'severity' || field === 'direction') return <span className={`status-tag ${statusTone(String(value))}`}>{String(value).replaceAll('_', ' ')}</span>;
  return String(value);
}

function statusTone(value) {
  if (['active', 'approved', 'completed', 'settled', 'resolved', 'confirmed', 'credit'].includes(value.toLowerCase())) return 'status-tag-good';
  if (['pending', 'warning', 'in_progress', 'frozen'].includes(value.toLowerCase())) return 'status-tag-warning';
  if (['rejected', 'failed', 'critical', 'suspended', 'debit'].includes(value.toLowerCase())) return 'status-tag-danger';
  return 'status-tag-neutral';
}

function LoadingPanel({ label }) {
  return <div className="surface-card state-panel"><span className="spinner" aria-hidden="true" />{label}</div>;
}

function ErrorPanel({ message, onRetry }) {
  return <div className="surface-card state-panel error-panel"><span>{message}</span><button className="button button-subtle" type="button" onClick={onRetry}>Try again</button></div>;
}

function PageContent({ page, overview, pageData, pageLoading, pageError, onRetry, user, roundProps, onSettingsChanged }) {
  if (page === 'overview') return <Overview metrics={overview.data?.metrics} loading={overview.loading} error={overview.error} onRetry={onRetry} />;
  if (page === 'connection') return <ConnectionPage data={pageData} loading={pageLoading} error={pageError} onRetry={onRetry} />;
  if (page === 'risk') return <RiskPage data={pageData} loading={pageLoading} error={pageError} onRetry={onRetry} />;
  if (page === 'settings') return <ApplicationSettingsPage data={pageData} loading={pageLoading} error={pageError} onRetry={onRetry} onSettingsChanged={onSettingsChanged} />;
  if (page === 'employees') return <EmployeesPage data={pageData} loading={pageLoading} error={pageError} onRetry={onRetry} />;
  if (page === 'security') return <SecurityPage user={user} data={pageData} loading={pageLoading} error={pageError} onRetry={onRetry} />;
  if (page === 'engine') return <EnginePage metrics={overview.data?.metrics} data={pageData} loading={pageLoading || overview.loading} error={pageError || overview.error} onRetry={onRetry} />;
  return <div className="page-stack"><PageHeading title={pageDetails[page].title} subtitle={pageDetails[page].subtitle} /><RecordPage config={pageDetails[page]} data={pageData} loading={pageLoading} error={pageError} onRetry={onRetry} {...(page === 'profit' ? roundProps : {})} /></div>;
}

function Dashboard({ user, onLogout }) {
  const [activePage, setActivePage] = useState('overview');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [overview, setOverview] = useState({ loading: true, error: '' });
  const [pageData, setPageData] = useState(null);
  const [pageDataResource, setPageDataResource] = useState(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState('');
  const [selectedRound, setSelectedRound] = useState(null);
  const [roundDetails, setRoundDetails] = useState(null);
  const [roundLoading, setRoundLoading] = useState(false);
  const [roundError, setRoundError] = useState('');
  const [, setBrandingVersion] = useState(0);
  const pageRequestId = useRef(0);
  const roundRequestId = useRef(0);
  const pageResource = activePage === 'connection' || activePage === 'risk' ? 'settings'
    : activePage === 'security' ? 'audit'
      : activePage === 'settings' ? 'settings'
      : activePage === 'engine' ? 'signals'
        : pageDetails[activePage]?.resource;

  async function loadOverview() {
    setOverview((current) => ({ ...current, loading: !current.data, error: '' }));
    try {
      const data = await api('/api/admin/overview');
      setOverview({ data, loading: false, error: '' });
    } catch (error) {
      setOverview({ data: null, loading: false, error: error.message });
    }
  }

  async function loadPage() {
    if (!pageResource) return;
    const requestId = ++pageRequestId.current;
    setPageLoading(pageDataResource !== pageResource);
    setPageError('');
    try {
      const data = await api(`/api/admin/${pageResource}`);
      if (requestId === pageRequestId.current) {
        setPageData(data);
        setPageDataResource(pageResource);
      }
    } catch (error) {
      if (requestId === pageRequestId.current) setPageError(error.message);
    } finally {
      if (requestId === pageRequestId.current) setPageLoading(false);
    }
  }

  async function loadRoundParticipants(roundId) {
    const round = pageData?.records?.find((record) => record.id === roundId);
    if (!round) return;
    const requestId = ++roundRequestId.current;
    setSelectedRound(round);
    setRoundDetails(null);
    setRoundLoading(true);
    setRoundError('');
    try {
      const details = await api(`/api/admin/rounds/${encodeURIComponent(roundId)}/participants`);
      if (requestId === roundRequestId.current) setRoundDetails(details);
    } catch (error) {
      if (requestId === roundRequestId.current) setRoundError(error.message);
    } finally {
      if (requestId === roundRequestId.current) setRoundLoading(false);
    }
  }

  useEffect(() => { loadOverview(); }, []);
  useEffect(() => {
    pageRequestId.current += 1;
    roundRequestId.current += 1;
    setRoundLoading(false);
    loadPage();
  }, [activePage]);

  function retryPage() {
    if (activePage === 'overview') loadOverview();
    else if (activePage === 'engine') {
      loadOverview();
      loadPage();
    } else loadPage();
  }

  return (
    <div className="app-shell">
      <Sidebar activePage={activePage} onNavigate={(page) => { setActivePage(page); setSidebarOpen(false); setSelectedRound(null); setRoundDetails(null); setRoundLoading(false); }} open={sidebarOpen} onClose={() => setSidebarOpen(false)} user={user} />
      <div className="main-column">
        <Header user={user} activePage={activePage} onMenu={() => setSidebarOpen(true)} onLogout={onLogout} />
        <main className="main-content">
          <PageContent
            page={activePage}
            overview={overview}
            pageData={pageData}
            pageLoading={pageLoading}
            pageError={pageError}
            onRetry={retryPage}
            user={user}
            onSettingsChanged={() => setBrandingVersion((version) => version + 1)}
            roundProps={{
              onSelectRound: loadRoundParticipants,
              selectedRound,
              roundDetails,
              roundLoading,
              roundError,
            }}
          />
          <footer className="app-footer"><span>G-Squad Administration</span><span>Live trading and payment processing are disabled</span></footer>
        </main>
      </div>
    </div>
  );
}

function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState('');
  const [showSplash, setShowSplash] = useState(true);
  const [branding, setBranding] = useState(applicationSettings);

  useEffect(() => {
    const splashTimer = window.setTimeout(() => setShowSplash(false), 8000);
    return () => window.clearTimeout(splashTimer);
  }, []);

  useEffect(() => {
    api('/api/auth/me')
      .then((result) => setUser(result.user))
      .catch((error) => {
        if (error.status !== 401) setAuthError(error.message);
      })
      .finally(() => setAuthLoading(false));
  }, []);

  useEffect(() => {
    api('/api/app-settings')
      .then(({ settings }) => {
        applicationSettings = { ...applicationSettings, ...settings };
        setBranding(applicationSettings);
        document.title = `${applicationSettings.organizationName} | Admin Console`;
      })
      .catch((error) => setAuthError(error.message));
  }, []);

  async function signOut() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
      setUser(null);
      setAuthError('');
    } catch (error) {
      setAuthError(error.message);
    }
  }

  if (showSplash) return <SplashScreen logo={branding.appLogo} />;
  if (authLoading) return <main className="boot-screen"><span className="spinner" aria-hidden="true" /><span>Loading G-Squad…</span></main>;
  if (user) return <>{authError && <div className="boot-error" role="alert">{authError}</div>}<Dashboard user={user} onLogout={signOut} /></>;
  return <><SignIn onSignIn={setUser} />{authError && <div className="boot-error" role="alert">{authError}</div>}</>;
}

createRoot(document.getElementById('root')).render(
  window.location.pathname.startsWith('/admin') ? <App /> : <UserPortal />,
);
