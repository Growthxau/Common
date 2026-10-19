# G-Squad

G-Squad is a Node.js, Express, React, and SQLite application with separate member and administrator portals, authenticated access, audited configuration, risk-limit management, and account/ledger views.

> **Live-money readiness:** Trading execution, Deriv account authorization, deposits, withdrawals, wallet mutation, and settlement are not implemented. Their status is always disabled; this application must not be used to accept funds or claim verified trading activity.

## Requirements

- Node.js 22.13 or newer
- npm

## Configure and run

1. Install dependencies:

   ```sh
   npm install
   ```

2. Copy `.env.example` to `.env`, then set a unique admin username and a strong password of at least 14 characters. Keep `.env` out of source control. Deriv credentials are read by the backend only and do not activate a connection.

3. Bootstrap a super-admin:

   ```sh
   npm run admin:create
   ```

   The command reads `ADMIN_USERNAME` and `ADMIN_PASSWORD`, stores a scrypt password hash, and does not create a public registration route. Additional staff accounts are created by a super-admin from **Employee access**.

4. Start the development server:

   ```sh
   npm run dev
   ```

   Open <http://localhost:3000>.

5. To enable member registration, configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM`. Set `APP_ORIGIN` to the exact public origin so verification and password-reset links point to the deployed application. In production, `APP_ORIGIN` must use HTTPS. Registration remains unavailable until SMTP is configured.

For a production-style static build and server:

```sh
npm run build
npm start
```

Set `NODE_ENV=production` and `APP_ORIGIN` to the exact HTTPS origin when deploying behind TLS. If the app is behind a trusted reverse proxy, configure `TRUST_PROXY` for that proxy. Configure `PORT` and `GSQUAD_DB_PATH` as needed. SQLite data is stored in the ignored `data/` directory by default.

## Administration

- **Employee access:** Super-admins can provision employee accounts and assign either `admin` (read-only operational access) or `super_admin` (full administrative access). Initial passwords must be at least 14 characters.
- **Application settings:** Super-admins can configure organization name, support email, default currency, and timezone. Integration secrets stay in server environment variables and are never returned to the browser.
- **Risk management:** Super-admins can record daily loss/profit targets, combined-stake and exposure limits, and the emergency-stop setting. These settings do not enable execution.
- **Audit:** Sign-ins, employee creation, and configuration changes are recorded in the append-only audit log.
- Legacy records previously marked as synthetic are hidden from ordinary account, payment, support, and liability views; they are retained rather than destructively deleted.

## Member portal

- Visit <http://localhost:3000/user> for the member welcome, registration, sign-in, and account recovery flows. Registration creates a `GSQ-XXXXXX` account ID and empty USD wallet, and requires email verification before login. There is no public staff registration.
- The member portal includes Dashboard, Wallet, Bot, Risk, Trading activity, Notifications, Account, and Support views. Members can review their own ledger, confirmed trade records, and support history; update personal risk settings; and manage notification preferences and passwords.
- Deposits and withdrawals are shown as unavailable. The UI cannot create payment requests, and no unverified payment is credited. Bot start is rejected while the trading engine is disabled; stop requests persist. Saving risk preferences does not enable execution.
- Member passwords use scrypt hashes; verification and reset tokens are hashed in SQLite, expire after one hour, and are sent via configured SMTP. Member sessions use expiring, server-stored tokens in HttpOnly, SameSite cookies. Account APIs require an authenticated session and same-origin state-changing requests.

## Implemented safeguards and limitations

- Scrypt password hashes, rate-limited sign-in, HttpOnly/SameSite server-stored sessions, same-origin checks, and server-side role enforcement.
- Persistent SQLite schema with foreign keys, integer minor-unit balances, unique idempotency keys, immutable wallet ledger entries, and frozen trading-round snapshots.
- No public staff registration. Financial actions, risk-triggered execution, live trading, payment processing, member wallet changes, and settlement endpoints are not implemented.
- Personal risk settings are persisted and validated, but no trading engine currently consumes them. Real trade settlement, deposits/withdrawals, and user notifications require their respective verified backend integrations.
- Integration secrets are not editable in the UI or exposed by API. Configure them through a secrets manager or protected deployment environment.

Before using this system for live operations, implement and independently verify user authentication, regulated payment provider workflows, Deriv authorization and approval, signal review, participant freezing, transactional balance/risk checks, trade reconciliation, proportional settlement, monitoring, backups, deployment hardening, and security/accounting review.

## Validate

Build the production assets before running the integration tests, which also exercise the production server:

```sh
npm run build
npm test
```
