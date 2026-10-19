import React, { useEffect, useState } from 'react';

async function userApi(path, options = {}) {
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
    error.nextStep = body.nextStep;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

function formatMoney(minor, currency = 'USD') {
  if (minor === null || minor === undefined) return '—';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function PortalBrand() {
  return <a className="portal-brand" href="/user"><span className="portal-brand-mark">G</span><span><strong>G-Squad</strong><small>MEMBER PORTAL</small></span></a>;
}

function UserAuth({ onAuthenticate, initialMode = 'welcome', token = '' }) {
  const [mode, setMode] = useState(initialMode);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [verificationPending, setVerificationPending] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setFeedback('');
    try {
      if (mode === 'verify') {
        const result = await userApi('/api/user/verify-email', { method: 'POST', body: JSON.stringify({ token }) });
        setFeedback(result.message);
        setMode('login');
        window.history.replaceState({}, '', '/user');
        return;
      }
      if (mode === 'reset') {
        const result = await userApi('/api/user/password/reset', {
          method: 'POST',
          body: JSON.stringify({ token, password, confirmPassword }),
        });
        setFeedback(result.message);
        setPassword('');
        setConfirmPassword('');
        setMode('login');
        window.history.replaceState({}, '', '/user');
        return;
      }
      if (mode === 'forgot') {
        const result = await userApi('/api/user/password/forgot', {
          method: 'POST',
          body: JSON.stringify({ email }),
        });
        setFeedback(result.message);
        setMode('forgot-sent');
        return;
      }
      const endpoint = mode === 'register' ? '/api/user/register' : '/api/user/login';
      const payload = mode === 'register'
        ? { name, email, password, confirmPassword, termsAccepted }
        : { email, password };
      const result = await userApi(endpoint, { method: 'POST', body: JSON.stringify(payload) });
      if (mode === 'register') {
        setFeedback(result.message);
        setMode('sent');
      } else {
        onAuthenticate(result.user);
      }
    } catch (requestError) {
      setError(requestError.message);
      setVerificationPending(requestError.nextStep === 'resend_verification'
        || (requestError.status === 403 && mode === 'login'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="portal-auth-layout">
      <section className="portal-auth-aside">
        <PortalBrand />
        <div className="portal-hero-copy">
          <span className="portal-kicker">YOUR ACCOUNT, AT A GLANCE</span>
          <h1>A clearer view of your G-Squad account.</h1>
          <p>Manage your account preferences, follow wallet activity and get help from the support team.</p>
          <div className="portal-hero-note"><span className="portal-status-dot" /> Email verification required · Trading and payments disabled</div>
        </div>
        <div className="portal-aside-footer">Secure account access <span>·</span> Private by design</div>
      </section>
      <section className="portal-auth-main">
        <div className="portal-auth-card">
          {mode === 'welcome' && <div className="portal-welcome"><p className="portal-kicker">MEMBER ACCESS</p><h2>Welcome to G-Squad</h2><p className="portal-auth-subtitle">Sign in to review your account or create a new member account.</p><button className="portal-primary-button" onClick={() => setMode('login')}>Log in</button><button className="portal-secondary-button portal-welcome-register" onClick={() => setMode('register')}>Create an account</button></div>}
          {mode === 'sent' && <div className="portal-message-state"><p className="portal-kicker">CHECK YOUR EMAIL</p><h2>Verify your address</h2><p className="portal-auth-subtitle">{feedback}</p><p className="portal-auth-subtitle">The verification link expires after one hour. Check your spam folder if it does not arrive.</p>{error && <p className="portal-error" role="alert">{error}</p>}<button className="portal-secondary-button" onClick={async () => { setBusy(true); setError(''); try { const result = await userApi('/api/user/resend-verification', { method: 'POST', body: JSON.stringify({ email }) }); setFeedback(result.message); } catch (requestError) { setError(requestError.message); } finally { setBusy(false); } }} disabled={busy}>{busy ? 'Sending…' : 'Resend verification email'}</button></div>}
          {mode === 'forgot-sent' && <div className="portal-message-state"><p className="portal-kicker">PASSWORD RECOVERY</p><h2>Check your inbox</h2><p className="portal-auth-subtitle">{feedback}</p>{error && <p className="portal-error" role="alert">{error}</p>}<button className="portal-text-button" onClick={() => { setMode('login'); setError(''); }}>Back to sign in</button></div>}
          {!['welcome', 'sent', 'forgot-sent'].includes(mode) && <>
            <p className="portal-kicker">{mode === 'register' ? 'CREATE YOUR ACCOUNT' : mode === 'forgot' ? 'PASSWORD RECOVERY' : mode === 'verify' ? 'EMAIL VERIFICATION' : mode === 'reset' ? 'RESET PASSWORD' : 'MEMBER ACCESS'}</p>
            <h2>{mode === 'register' ? 'Get started' : mode === 'forgot' ? 'Reset your password' : mode === 'verify' ? 'Verify your email' : mode === 'reset' ? 'Choose a new password' : 'Welcome back'}</h2>
            <p className="portal-auth-subtitle">{mode === 'register' ? 'Create a G-Squad account to access your member dashboard.' : mode === 'forgot' ? 'We will email you a secure reset link if an account matches.' : mode === 'verify' ? 'Confirm your email address to activate your account.' : mode === 'reset' ? 'Use a new password of at least 14 characters.' : 'Sign in to review your account and wallet activity.'}</p>
            <form className="portal-form" onSubmit={submit}>
              {mode === 'register' && <label className="portal-field"><span>Full name</span><input autoComplete="name" maxLength="80" minLength="2" required value={name} onChange={(event) => setName(event.target.value)} /></label>}
              {['register', 'login', 'forgot'].includes(mode) && <label className="portal-field"><span>Email address</span><input type="email" autoComplete="email" maxLength="254" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>}
              {['register', 'login', 'reset'].includes(mode) && <label className="portal-field"><span>{mode === 'reset' ? 'New password' : 'Password'}</span><input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={mode === 'login' ? 1 : 14} maxLength="1024" required value={password} onChange={(event) => setPassword(event.target.value)} />{mode !== 'login' && <small>Use at least 14 characters.</small>}</label>}
              {['register', 'reset'].includes(mode) && <label className="portal-field"><span>Confirm password</span><input type="password" autoComplete="new-password" minLength="14" maxLength="1024" required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>}
              {mode === 'register' && <label className="portal-terms"><input type="checkbox" checked={termsAccepted} onChange={(event) => setTermsAccepted(event.target.checked)} required /><span>I accept the <a href="#terms" onClick={(event) => { event.preventDefault(); setFeedback('G-Squad is in development. Trading and payments are unavailable; do not deposit funds.'); }}>terms of service</a> and <a href="#privacy" onClick={(event) => { event.preventDefault(); setFeedback('We use account details to operate this portal. Passwords are hashed and sessions use secure cookies.'); }}>privacy notice</a>.</span></label>}
              {error && <p className="portal-error" role="alert">{error}</p>}
              {verificationPending && <button className="portal-text-button" type="button" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { const result = await userApi('/api/user/resend-verification', { method: 'POST', body: JSON.stringify({ email }) }); setFeedback(result.message); setVerificationPending(false); setMode('sent'); } catch (requestError) { setError(requestError.message); } finally { setBusy(false); } }}>Resend verification email</button>}
              {feedback && <p className="portal-success" role="status">{feedback}</p>}
              {mode === 'verify' && <p className="portal-auth-subtitle">This one-time link expires after one hour.</p>}
              <button className="portal-primary-button" type="submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'register' ? 'Create account' : mode === 'login' ? 'Sign in securely' : mode === 'verify' ? 'Verify email' : mode === 'forgot' ? 'Send reset link' : 'Update password'}</button>
            </form>
            {mode === 'login' && <p className="portal-switch"><button type="button" onClick={() => { setMode('forgot'); setError(''); setFeedback(''); }}>Forgot password?</button></p>}
            <p className="portal-switch"><button type="button" onClick={() => { setMode(mode === 'register' ? 'login' : 'welcome'); setError(''); setFeedback(''); }}>{mode === 'register' ? 'Back to sign in' : 'Back'}</button></p>
          </>}
          <div className="portal-auth-divider" />
          <a className="portal-admin-link" href="/">Administration sign-in <span aria-hidden="true">↗</span></a>
        </div>
        <p className="portal-auth-disclaimer">Accounts start with a zero USD balance. Deposits, withdrawals and trading are unavailable in this build.</p>
      </section>
    </main>
  );
}

function PortalMetric({ label, value, detail, icon, color = 'blue' }) {
  return <article className="portal-metric"><span className={`portal-metric-icon portal-tone-${color}`} aria-hidden="true">{icon}</span><p>{label}</p><strong>{value}</strong><small>{detail}</small></article>;
}

function PortalHeading({ eyebrow = 'MEMBER PORTAL', title, description, action }) {
  return <div className="portal-heading"><div><p className="portal-kicker">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{action}</div>;
}

function EmptyActivity({ title, detail }) {
  return <div className="portal-empty"><span aria-hidden="true">◌</span><strong>{title}</strong><p>{detail}</p></div>;
}

function OverviewPage({ dashboard, onNavigate }) {
  const { user, ledger, tradingActivity } = dashboard;
  return (
    <div className="portal-page-stack">
      <PortalHeading eyebrow="ACCOUNT OVERVIEW" title={`Good to see you, ${user.name.split(' ')[0]}`} description="Your account summary and latest activity." action={<span className="portal-readonly">TRADING DISABLED</span>} />
      <div className="portal-alert"><span aria-hidden="true">i</span><p><strong>Account services are in development.</strong> Your wallet and account activity are shown as recorded. Trading execution and payment processing are disabled.</p></div>
      <section className="portal-metrics" aria-label="Account summary">
        <PortalMetric label="Wallet balance" value={formatMoney(user.walletBalanceMinor, user.currency)} detail="Available recorded balance" icon="$" color="blue" />
        <PortalMetric label="Total deposited" value={formatMoney(dashboard.walletTotals.depositsMinor, user.currency)} detail="Verified ledger credits" icon="↓" color="violet" />
        <PortalMetric label="Total withdrawn" value={formatMoney(dashboard.walletTotals.withdrawalsMinor, user.currency)} detail="Recorded ledger debits" icon="↑" color="cyan" />
        <PortalMetric label="Realized P/L" value={formatMoney(dashboard.realizedProfitLossMinor, user.currency)} detail="Deriv-confirmed settlements only" icon="↗" color="green" />
        <PortalMetric label="Bot status" value={dashboard.tradingEnabled && user.botEnabled ? 'Running' : 'Stopped'} detail={dashboard.tradingEnabled ? 'Confirmed by trading service' : 'Trading engine disabled'} icon="◉" color="amber" />
        <PortalMetric label="Configured stake" value={formatMoney(user.configuredStakeMinor, user.currency)} detail="Saved risk setting" icon="◇" color="blue" />
        <PortalMetric label="Daily loss limit" value={user.maxDailyLossMinor ? formatMoney(user.maxDailyLossMinor, user.currency) : 'Not set'} detail="Your account risk setting" icon="!" color="amber" />
        <PortalMetric label="Daily target" value={user.dailyProfitTargetMinor ? formatMoney(user.dailyProfitTargetMinor, user.currency) : 'Not set'} detail={`${formatMoney(dashboard.dailyProfitLossMinor, user.currency)} realized today`} icon="◎" color="violet" />
      </section>
      <section className="portal-overview-grid">
        <article className="portal-card">
          <div className="portal-card-heading"><div><h2>Recent wallet activity</h2><p>Latest recorded ledger entries</p></div><button className="portal-text-button" onClick={() => onNavigate('wallet')}>View wallet <span aria-hidden="true">→</span></button></div>
          {ledger.length ? <ActivityTable entries={ledger.slice(0, 5)} currency={user.currency} /> : <EmptyActivity title="No wallet activity yet" detail="Recorded deposits, withdrawals and trading settlements will appear here." />}
        </article>
        <article className="portal-card portal-status-card">
          <div className="portal-card-heading"><div><h2>Platform status</h2><p>Services available to your account</p></div><span className="portal-status-tag">IN DEVELOPMENT</span></div>
          <div className="portal-status-row"><span>Market data</span><strong>Unavailable</strong></div>
          <div className="portal-status-row"><span>Trade execution</span><strong>Disabled</strong></div>
          <div className="portal-status-row"><span>Deposits & withdrawals</span><strong>Disabled</strong></div>
          <button className="portal-secondary-button" onClick={() => onNavigate('bot')}>Bot controls</button>
        </article>
      </section>
      <article className="portal-card"><div className="portal-card-heading"><div><h2>Recent trading activity</h2><p>Only confirmed records belonging to your account</p></div><button className="portal-text-button" onClick={() => onNavigate('activity')}>Full history →</button></div>
        {tradingActivity.length ? <TradingActivityTable records={tradingActivity.slice(0, 5)} currency={user.currency} /> : <EmptyActivity title="No trading activity" detail="There are no trade records for your account. No trades are being executed." />}
      </article>
      <p className="portal-page-note">G-Squad does not provide investment advice. No returns or trading activity are being represented.</p>
    </div>
  );
}

function ActivityTable({ entries, currency }) {
  return (
    <div className="portal-activity-list">
      {entries.map((entry) => <div className="portal-activity-row" key={entry.id}>
        <span className={`portal-activity-icon ${entry.direction === 'credit' ? 'is-credit' : 'is-debit'}`}>{entry.direction === 'credit' ? '↓' : '↑'}</span>
        <span className="portal-activity-description"><strong>{entry.entryType[0].toUpperCase() + entry.entryType.slice(1)}</strong><small>{formatDate(entry.createdAt)}</small></span>
        <strong className={entry.direction === 'credit' ? 'portal-credit' : ''}>{entry.direction === 'debit' ? '−' : '+'}{formatMoney(entry.amountMinor, currency)}</strong>
      </div>)}
    </div>
  );
}

function WalletPage({ dashboard }) {
  const { user, deposits, withdrawals } = dashboard;
  const [ledger, setLedger] = useState(dashboard.ledger);
  const [cursor, setCursor] = useState(dashboard.ledgerNextCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [ledgerError, setLedgerError] = useState('');
  useEffect(() => {
    setLedger(dashboard.ledger);
    setCursor(dashboard.ledgerNextCursor);
  }, [dashboard.ledger, dashboard.ledgerNextCursor]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setLedgerError('');
    try {
      const result = await userApi(`/api/user/ledger?cursor=${encodeURIComponent(cursor)}`);
      setLedger((current) => [...current, ...result.records]);
      setCursor(result.nextCursor);
    } catch (requestError) {
      setLedgerError(requestError.message);
    } finally {
      setLoadingMore(false);
    }
  }
  return (
    <div className="portal-page-stack">
      <PortalHeading title="Your wallet" description="View your recorded balance and immutable wallet activity." />
      <section className="portal-wallet-summary">
        <div><span>RECORDED BALANCE</span><strong>{formatMoney(user.walletBalanceMinor, user.currency)}</strong><small>Account currency: {user.currency}</small></div>
        <div className="portal-wallet-actions"><button className="portal-secondary-button" disabled title="Payment processing is disabled">Deposit</button><button className="portal-secondary-button" disabled title="Payment processing is disabled">Withdraw</button></div>
      </section>
      <div className="portal-alert portal-alert-warm"><span aria-hidden="true">!</span><p><strong>Payments are not enabled.</strong> No deposit or withdrawal request can be submitted or processed from this account.</p></div>
      <section className="portal-metrics portal-wallet-metrics">
        <PortalMetric label="Available" value={formatMoney(user.walletBalanceMinor - dashboard.reservedFundsMinor - dashboard.committedStakeMinor, user.currency)} detail="Recorded wallet balance less commitments" icon="$" color="blue" />
        <PortalMetric label="Reserved" value={formatMoney(dashboard.reservedFundsMinor, user.currency)} detail="No withdrawal reservations" icon="◌" color="violet" />
        <PortalMetric label="Committed to rounds" value={formatMoney(dashboard.committedStakeMinor, user.currency)} detail="Active eligible rounds only" icon="⇄" color="cyan" />
        <PortalMetric label="Realized P/L" value={formatMoney(dashboard.realizedProfitLossMinor, user.currency)} detail="Confirmed live settlements" icon="↗" color="green" />
      </section>
      <article className="portal-card"><div className="portal-card-heading"><div><h2>Wallet ledger</h2><p>Balance changes recorded for your account</p></div></div>
        {ledger.length ? <ActivityTable entries={ledger} currency={user.currency} /> : <EmptyActivity title="No ledger entries" detail="Your ledger will show any future verified wallet activity." />}
        {ledgerError && <p className="portal-error" role="alert">{ledgerError}</p>}
        {cursor && <button className="portal-secondary-button portal-ledger-more" onClick={loadMore} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load older transactions'}</button>}
      </article>
      <div className="portal-record-grid">
        <PortalRecordList title="Deposit requests" records={deposits} currency={user.currency} />
        <PortalRecordList title="Withdrawal requests" records={withdrawals} currency={user.currency} />
      </div>
    </div>
  );
}

function PortalRecordList({ title, records, currency }) {
  return <article className="portal-card"><div className="portal-card-heading"><div><h2>{title}</h2><p>Request history</p></div></div>{records.length ? <div className="portal-request-list">{records.map((record) => <div className="portal-request-row" key={record.id}><div><strong>{formatMoney(record.amountMinor, record.currency || currency)}</strong><small>{formatDate(record.createdAt)}</small></div><span className={`portal-record-status status-${record.status}`}>{record.status}</span></div>)}</div> : <EmptyActivity title="No requests" detail="There are no recorded requests." />}</article>;
}

function TradingActivityTable({ records, currency }) {
  return <div className="portal-trades">{records.map((record) => {
    const resultKnown = record.confirmedByDeriv && record.tradeStatus === 'confirmed'
      && record.allocatedProfitLossMinor !== null;
    const status = resultKnown
      ? record.allocatedProfitLossMinor > 0 ? 'won' : record.allocatedProfitLossMinor < 0 ? 'lost' : 'settled'
      : record.tradeStatus || record.roundStatus;
    return <div className="portal-trade-row" key={record.roundId}>
      <div><strong>{record.roundId}</strong><small>{formatDate(record.executedAt || record.settledAt)}</small></div>
      <div><span>Stake</span><strong>{formatMoney(record.contributedStakeMinor, record.currency || currency)}</strong></div>
      <div><span>Result</span><strong>{resultKnown ? formatMoney(record.allocatedProfitLossMinor, record.currency || currency) : 'Not confirmed'}</strong></div>
      <div><span>Status</span><span className={`portal-record-status status-${status}`}>{status}</span></div>
      <div><span>Ledger ref.</span><small>{record.ledgerReference || '—'}</small></div>
    </div>;
  })}</div>;
}

function BotPage({ dashboard, onSaved, onNavigate }) {
  const { user } = dashboard;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');

  async function controlBot(action) {
    setBusy(true);
    setError('');
    setFeedback('');
    try {
      const result = await userApi(`/api/user/bot/${action}`, { method: 'POST', body: '{}' });
      setFeedback(result.message || 'Bot status updated.');
      await onSaved();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="portal-page-stack">
      <PortalHeading title="Bot control" description="Manage your personal bot status and view the execution service state." />
      <div className="portal-alert portal-alert-warm"><span aria-hidden="true">!</span><p><strong>Trading is not enabled on this installation.</strong> Start attempts are rejected until the Deriv connection, approved signals and trading engine are independently enabled. No trade can be placed here.</p></div>
      <section className="portal-card portal-bot-control">
        <div className="portal-card-heading"><div><h2>My bot</h2><p>Your account's bot participation status</p></div><span className={`portal-status-tag ${user.botEnabled && dashboard.tradingEnabled ? 'is-live' : ''}`}>{user.botEnabled && dashboard.tradingEnabled ? 'RUNNING' : 'STOPPED'}</span></div>
        <div className="portal-bot-actions"><button className="portal-primary-button" type="button" disabled={busy || user.botEnabled} onClick={() => controlBot('start')}>{busy ? 'Please wait…' : 'Start bot'}</button><button className="portal-secondary-button" type="button" disabled={busy || !user.botEnabled} onClick={() => controlBot('stop')}>Stop bot</button><button className="portal-secondary-button" type="button" onClick={() => onNavigate('risk')}>Edit risk settings</button></div>
        {error && <p className="portal-error" role="alert">{error}</p>}
        {feedback && <p className="portal-success" role="status">{feedback}</p>}
        <div className="portal-bot-status-grid">
          <StatusItem label="Deriv connection" value="Not connected" />
          <StatusItem label="Trading engine" value="Disabled" />
          <StatusItem label="Current market" value="Unavailable" />
          <StatusItem label="Trading round" value={dashboard.committedStakeMinor ? 'Participation committed' : 'No active round'} />
          <StatusItem label="Last approved signal" value="Unavailable" />
          <StatusItem label="Current stake" value={formatMoney(user.configuredStakeMinor, user.currency)} />
          <StatusItem label="Daily realized P/L" value={formatMoney(dashboard.dailyProfitLossMinor, user.currency)} />
          <StatusItem label="Risk limits" value={dashboard.riskLimitReached ? 'Reached — participation blocked' : 'Not reached'} />
        </div>
        <p className="portal-page-note">Bot start/stop requests are sent to the backend. The engine remains authoritative: a saved setting is never shown as a running bot unless the service confirms it.</p>
      </section>
    </div>
  );
}

function StatusItem({ label, value }) {
  return <div className="portal-bot-status-item"><span>{label}</span><strong>{value}</strong></div>;
}

function RiskPage({ dashboard, onSaved }) {
  const { user } = dashboard;
  const [stake, setStake] = useState((user.configuredStakeMinor / 100).toFixed(2));
  const [dailyLoss, setDailyLoss] = useState(user.maxDailyLossMinor === null ? '' : (user.maxDailyLossMinor / 100).toFixed(2));
  const [profitTarget, setProfitTarget] = useState(user.dailyProfitTargetMinor === null ? '' : (user.dailyProfitTargetMinor / 100).toFixed(2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');

  useEffect(() => {
    setStake((user.configuredStakeMinor / 100).toFixed(2));
    setDailyLoss(user.maxDailyLossMinor === null ? '' : (user.maxDailyLossMinor / 100).toFixed(2));
    setProfitTarget(user.dailyProfitTargetMinor === null ? '' : (user.dailyProfitTargetMinor / 100).toFixed(2));
  }, [user.configuredStakeMinor, user.maxDailyLossMinor, user.dailyProfitTargetMinor]);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setFeedback('');
    const toMinor = (value) => value === '' ? null : Math.round(Number(value) * 100);
    const configuredStakeMinor = toMinor(stake);
    const maxDailyLossMinor = toMinor(dailyLoss);
    const dailyProfitTargetMinor = toMinor(profitTarget);
    if (configuredStakeMinor === null || !Number.isSafeInteger(configuredStakeMinor)
        || [maxDailyLossMinor, dailyProfitTargetMinor].some((value) => value !== null && (!Number.isSafeInteger(value) || value <= 0))) {
      setBusy(false);
      setError('Enter valid USD amounts with no more than two decimal places.');
      return;
    }
    try {
      await userApi('/api/user/risk-settings', {
        method: 'PUT',
        body: JSON.stringify({ configuredStakeMinor, maxDailyLossMinor, dailyProfitTargetMinor }),
      });
      setFeedback('Risk settings saved. They do not enable trading.');
      await onSaved();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  const targetProgress = user.dailyProfitTargetMinor
    ? Math.min(100, Math.max(0, dashboard.dailyProfitLossMinor / user.dailyProfitTargetMinor * 100))
    : 0;
  return (
    <div className="portal-page-stack">
      <PortalHeading title="Risk settings" description="Set personal limits. Settings are enforced by the backend before participation; trading is currently disabled." />
      <div className="portal-alert"><span aria-hidden="true">i</span><p><strong>Your settings do not activate a bot.</strong> Stake cannot exceed your available wallet balance. Daily limits are stored for future engine eligibility checks.</p></div>
      <form className="portal-card portal-risk-form" onSubmit={submit}>
        <div className="portal-card-heading"><div><h2>Personal limits</h2><p>Amounts are denominated in USD.</p></div><span className="portal-status-tag">TRADING OFF</span></div>
        <label className="portal-field"><span>Stake per round (USD)</span><div className="portal-input-suffix"><input type="number" required min="0" max={(user.walletBalanceMinor / 100).toFixed(2)} step="0.01" value={stake} onChange={(event) => setStake(event.target.value)} /><span>USD</span></div><small>Available wallet balance: {formatMoney(user.walletBalanceMinor, user.currency)}</small></label>
        <label className="portal-field"><span>Maximum daily loss (USD)</span><div className="portal-input-suffix"><input type="number" min="0.01" step="0.01" value={dailyLoss} onChange={(event) => setDailyLoss(event.target.value)} placeholder="No limit set" /><span>USD</span></div></label>
        <label className="portal-field"><span>Daily profit target (USD)</span><div className="portal-input-suffix"><input type="number" min="0.01" step="0.01" value={profitTarget} onChange={(event) => setProfitTarget(event.target.value)} placeholder="No target set" /><span>USD</span></div></label>
        {user.dailyProfitTargetMinor && <div className="portal-progress-section"><div><span>Target progress</span><strong>{formatMoney(dashboard.dailyProfitLossMinor, user.currency)} / {formatMoney(user.dailyProfitTargetMinor, user.currency)}</strong></div><div className="portal-progress-track"><span style={{ width: `${targetProgress}%` }} /></div></div>}
        {dashboard.riskLimitReached && <p className="portal-error" role="status">A daily limit is reached. New participation is not eligible.</p>}
        {error && <p className="portal-error" role="alert">{error}</p>}
        {feedback && <p className="portal-success" role="status">{feedback}</p>}
        <button className="portal-primary-button portal-save-button" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save risk settings'}</button>
      </form>
    </div>
  );
}

function ActivityPage({ dashboard }) {
  return <div className="portal-page-stack">
    <PortalHeading title="Trading activity" description="Your account's trade records and settlement references." action={<span className="portal-readonly">CONFIRMED RECORDS ONLY</span>} />
    {dashboard.tradingActivity.length
      ? <article className="portal-card"><div className="portal-card-heading"><div><h2>Trade history</h2><p>Only records associated with your account are shown.</p></div></div><TradingActivityTable records={dashboard.tradingActivity} currency={dashboard.user.currency} /></article>
      : <article className="portal-card"><EmptyActivity title="No trading activity" detail="There are no trade records for your account. Trades and results will only appear after the backend confirms them." /></article>}
  </div>;
}

function NotificationsPage({ dashboard, onSaved }) {
  const [error, setError] = useState('');
  async function markRead(id) {
    setError('');
    try {
      await userApi(`/api/user/notifications/${encodeURIComponent(id)}/read`, { method: 'PATCH', body: '{}' });
      await onSaved();
    } catch (requestError) {
      setError(requestError.message);
    }
  }
  return <div className="portal-page-stack">
    <PortalHeading title="Notifications" description="Important account, wallet and security updates." />
    {error && <p className="portal-error" role="alert">{error}</p>}
    {dashboard.notifications.length ? <article className="portal-card"><div className="portal-notification-list">{dashboard.notifications.map((item) => <div className={`portal-notification${item.readAt ? '' : ' is-unread'}`} key={item.id}><span className="portal-notification-dot" /><div><strong>{item.title}</strong><p>{item.message}</p><small>{formatDate(item.createdAt)}</small></div>{!item.readAt && <button className="portal-text-button" onClick={() => markRead(item.id)}>Mark read</button>}</div>)}</div></article>
      : <article className="portal-card"><EmptyActivity title="No notifications" detail="Important verified account notices will appear here." /></article>}
  </div>;
}

function AccountPage({ dashboard, onSaved, onNavigate, onLogout }) {
  const { user } = dashboard;
  const [name, setName] = useState(user.name);
  const [preferences, setPreferences] = useState(user.notificationPreferences);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState('');
  const [recoveryFeedback, setRecoveryFeedback] = useState('');

  useEffect(() => {
    setName(user.name);
    setPreferences(user.notificationPreferences);
  }, [user.name, user.notificationPreferences]);

  async function saveProfile(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setFeedback('');
    try {
      await userApi('/api/user/profile', {
        method: 'PUT',
        body: JSON.stringify({ name, notificationPreferences: preferences }),
      });
      setFeedback('Account profile saved.');
      await onSaved();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function changePassword(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setFeedback('');
    try {
      await userApi('/api/user/password/change', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setFeedback('Password changed. Other active sessions were signed out.');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function requestPasswordReset() {
    setRecoveryBusy(true);
    setRecoveryError('');
    setRecoveryFeedback('');
    try {
      const result = await userApi('/api/user/password/forgot', {
        method: 'POST',
        body: JSON.stringify({ email: user.email }),
      });
      setRecoveryFeedback(result.message);
    } catch (requestError) {
      setRecoveryError(requestError.message);
    } finally {
      setRecoveryBusy(false);
    }
  }

  return <div className="portal-page-stack">
    <PortalHeading title="Account" description="Manage your profile, security, notifications and support access." />
    <article className="portal-card"><div className="portal-card-heading"><div><h2>Profile</h2><p>Account details are private to your account.</p></div><span className={`portal-status-tag ${user.emailVerified ? 'is-live' : ''}`}>{user.emailVerified ? 'EMAIL VERIFIED' : 'EMAIL NOT VERIFIED'}</span></div>
      <div className="portal-account-identity"><StatusItem label="G-Squad account ID" value={user.accountId} /><StatusItem label="Email address" value={user.email} /><StatusItem label="Verification" value={user.emailVerified ? 'Verified' : 'Pending'} /></div>
      <form className="portal-profile-form" onSubmit={saveProfile}>
        <label className="portal-field"><span>Full name</span><input required minLength="2" maxLength="80" value={name} onChange={(event) => setName(event.target.value)} /></label>
        <div className="portal-preference-group"><strong>Notification preferences</strong>{Object.entries(preferences).map(([key, enabled]) => <label className="portal-checkbox-row" key={key}><input type="checkbox" checked={enabled} onChange={(event) => setPreferences({ ...preferences, [key]: event.target.checked })} /><span>{key[0].toUpperCase() + key.slice(1)} alerts</span></label>)}</div>
        {error && <p className="portal-error" role="alert">{error}</p>}
        {feedback && <p className="portal-success" role="status">{feedback}</p>}
        <button className="portal-primary-button portal-save-button" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save profile'}</button>
      </form>
    </article>
    <form className="portal-card portal-password-form" onSubmit={changePassword}>
      <div className="portal-card-heading"><div><h2>Change password</h2><p>Passwords are hashed; the existing password is required.</p></div></div>
      <label className="portal-field"><span>Current password</span><input type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
      <div className="portal-password-grid"><label className="portal-field"><span>New password</span><input type="password" autoComplete="new-password" minLength="14" maxLength="1024" required value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label><label className="portal-field"><span>Confirm new password</span><input type="password" autoComplete="new-password" minLength="14" maxLength="1024" required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label></div>
      {error && <p className="portal-error" role="alert">{error}</p>}
      <button className="portal-primary-button portal-save-button" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
    </form>
    <article className="portal-card portal-account-links"><div className="portal-card-heading"><div><h2>More</h2><p>Account help and important information</p></div></div><button className="portal-text-button" onClick={() => onNavigate('support')}>Contact support →</button><details><summary>Terms of service</summary><p>G-Squad is under development. Do not deposit funds. The member portal does not execute trades or process payments. Use of the account is subject to the platform being made available for your jurisdiction.</p></details><details><summary>Privacy notice</summary><p>G-Squad stores the account information, hashed password, session records and activity needed to operate this service. Email and wallet information are only shown within the authenticated account. Contact support for account-related questions.</p></details><button className="portal-secondary-button portal-logout-button" onClick={onLogout}>Sign out</button></article>
    <article className="portal-card portal-account-links"><div className="portal-card-heading"><div><h2>Account recovery</h2><p>Send a single-use password reset link to your verified email.</p></div></div>{recoveryError && <p className="portal-error" role="alert">{recoveryError}</p>}{recoveryFeedback && <p className="portal-success" role="status">{recoveryFeedback}</p>}<button className="portal-secondary-button" onClick={requestPasswordReset} disabled={recoveryBusy}>{recoveryBusy ? 'Sending…' : 'Email password reset link'}</button><p className="portal-page-note">Session security: server-stored token, HttpOnly and SameSite cookie. Deriv credentials are never available in the member portal.</p></article>
  </div>;
}

function SupportPage({ dashboard, onSaved }) {
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setFeedback('');
    try {
      await userApi('/api/user/support', {
        method: 'POST',
        body: JSON.stringify({ subject, message }),
      });
      setSubject('');
      setMessage('');
      setFeedback('Your request has been sent to the support team.');
      await onSaved();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="portal-page-stack">
      <PortalHeading title="Help & support" description="Send a message to the support team and review your previous requests." />
      <form className="portal-card portal-support-form" onSubmit={submit}>
        <div className="portal-card-heading"><div><h2>Send a support request</h2><p>We will attach your account ID automatically.</p></div></div>
        <label className="portal-field"><span>Subject</span><input required minLength="3" maxLength="120" value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="How can we help?" /></label>
        <label className="portal-field"><span>Message</span><textarea required minLength="10" maxLength="2000" rows="5" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Describe what you need help with…" /></label>
        {error && <p className="portal-error" role="alert">{error}</p>}
        {feedback && <p className="portal-success" role="status">{feedback}</p>}
        <button className="portal-primary-button portal-save-button" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send request'}</button>
      </form>
      <article className="portal-card"><div className="portal-card-heading"><div><h2>Your support requests</h2><p>Updates from our team will appear here.</p></div></div>
        {dashboard.support.length ? <div className="portal-support-list">{dashboard.support.map((item) => <article className="portal-support-item" key={item.id}><div className="portal-support-item-heading"><div><strong>{item.subject}</strong><small>Sent {formatDate(item.createdAt)}</small></div><span className={`portal-record-status status-${item.status}`}>{item.status.replace('_', ' ')}</span></div><p>{item.message}</p>{item.response && <div className="portal-support-response"><strong>Support response</strong><p>{item.response}</p></div>}</article>)}</div> : <EmptyActivity title="No support requests" detail="Your messages and responses will appear here." />}
      </article>
    </div>
  );
}

function UserPortalApp() {
  const [user, setUser] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [page, setPage] = useState('overview');
  const [authLoading, setAuthLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const query = new URLSearchParams(window.location.search);
  const verificationToken = query.get('verify') || '';
  const resetToken = query.get('reset') || '';

  useEffect(() => {
    document.title = 'G-Squad | Member Portal';
    userApi('/api/user/me')
      .then((result) => setUser(result.user))
      .catch((requestError) => {
        if (requestError.status !== 401) setError(requestError.message);
      })
      .finally(() => setAuthLoading(false));
  }, []);

  async function loadDashboard() {
    setLoading(true);
    setError('');
    try {
      const result = await userApi('/api/user/dashboard');
      setDashboard(result);
      setUser(result.user);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (user) loadDashboard();
  }, [user?.id]);

  async function signOut() {
    try {
      await userApi('/api/user/logout', { method: 'POST' });
      setDashboard(null);
      setUser(null);
      setError('');
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  if (authLoading) return <main className="portal-loading"><span className="portal-spinner" /><span>Loading your account…</span></main>;
  if (!user) return <><UserAuth initialMode={verificationToken ? 'verify' : resetToken ? 'reset' : 'welcome'} token={verificationToken || resetToken} onAuthenticate={(account) => { setError(''); setUser(account); }} />{error && <div className="portal-global-error" role="alert">{error}</div>}</>;

  const navigation = [
    { id: 'overview', icon: '▦', label: 'Dashboard' },
    { id: 'wallet', icon: '$', label: 'Wallet' },
    { id: 'bot', icon: '◉', label: 'Bot' },
    { id: 'risk', icon: '◇', label: 'Risk' },
    { id: 'account', icon: '♙', label: 'Account' },
  ];
  const titles = { overview: 'Dashboard', wallet: 'Wallet', bot: 'Bot', risk: 'Risk', account: 'Account', activity: 'Trading activity', notifications: 'Notifications', support: 'Help & support' };

  return (
    <div className="portal-shell">
      <aside className={`portal-sidebar${menuOpen ? ' is-open' : ''}`}>
        <PortalBrand />
        <div className="portal-nav-label">YOUR ACCOUNT</div>
        <nav className="portal-navigation" aria-label="Account navigation">
          {navigation.map((item) => <button key={item.id} className={`portal-nav-item${page === item.id ? ' is-active' : ''}`} onClick={() => { setPage(item.id); setMenuOpen(false); }}><span aria-hidden="true">{item.icon}</span>{item.label}</button>)}
          <button className={`portal-nav-item${page === 'activity' ? ' is-active' : ''}`} onClick={() => { setPage('activity'); setMenuOpen(false); }}><span aria-hidden="true">↗</span>Activity</button>
          <button className={`portal-nav-item${page === 'notifications' ? ' is-active' : ''}`} onClick={() => { setPage('notifications'); setMenuOpen(false); }}><span aria-hidden="true">♧</span>Notifications</button>
          <button className={`portal-nav-item${page === 'support' ? ' is-active' : ''}`} onClick={() => { setPage('support'); setMenuOpen(false); }}><span aria-hidden="true">?</span>Support</button>
        </nav>
        <div className="portal-sidebar-footer"><span className="portal-avatar">{user.name.slice(0, 1).toUpperCase()}</span><span><strong>{user.name}</strong><small>{user.accountId}</small></span></div>
      </aside>
      {menuOpen && <button className="portal-scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
      <div className="portal-main">
        <header className="portal-topbar">
          <button className="portal-menu-toggle" aria-label="Open navigation" onClick={() => setMenuOpen(true)}>☰</button>
          <div className="portal-breadcrumb"><span>G-Squad</span><span>/</span><strong>{titles[page]}</strong></div>
          <div className="portal-top-actions"><span className="portal-header-status"><i /> Services in development</span><button className="portal-signout" onClick={signOut}>Sign out</button></div>
        </header>
        <main className="portal-content">
          {error && <div className="portal-error-banner" role="alert"><span>{error}</span><button onClick={loadDashboard}>Retry</button></div>}
          {loading && !dashboard ? <div className="portal-loading-panel"><span className="portal-spinner" />Loading your account details…</div> : dashboard && <>
            {page === 'overview' && <OverviewPage dashboard={dashboard} onNavigate={setPage} />}
            {page === 'wallet' && <WalletPage dashboard={dashboard} />}
            {page === 'bot' && <BotPage dashboard={dashboard} onSaved={loadDashboard} onNavigate={setPage} />}
            {page === 'risk' && <RiskPage dashboard={dashboard} onSaved={loadDashboard} />}
            {page === 'activity' && <ActivityPage dashboard={dashboard} />}
            {page === 'notifications' && <NotificationsPage dashboard={dashboard} onSaved={loadDashboard} />}
            {page === 'account' && <AccountPage dashboard={dashboard} onSaved={loadDashboard} onNavigate={setPage} onLogout={signOut} />}
            {page === 'support' && <SupportPage dashboard={dashboard} onSaved={loadDashboard} />}
          </>}
          <footer className="portal-footer"><span>© {new Date().getFullYear()} G-Squad</span><span>Trading and payment processing are disabled</span></footer>
        </main>
      </div>
      <nav className="portal-bottom-nav" aria-label="Main navigation">
        {navigation.map((item) => <button key={item.id} className={page === item.id ? 'is-active' : ''} onClick={() => { setPage(item.id); setMenuOpen(false); }}><span aria-hidden="true">{item.icon}</span><small>{item.label}</small></button>)}
      </nav>
    </div>
  );
}

export function UserPortal() {
  return <UserPortalApp />;
}
