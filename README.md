# G-Squad administration

G-Squad is a Node.js, Express, React, and SQLite administration application with authenticated staff access, audited configuration, risk-limit management, and account/ledger views.

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

## Implemented safeguards and limitations

- Scrypt password hashes, rate-limited sign-in, HttpOnly/SameSite server-stored sessions, same-origin checks, and server-side role enforcement.
- Persistent SQLite schema with foreign keys, integer minor-unit balances, unique idempotency keys, immutable wallet ledger entries, and frozen trading-round snapshots.
- No public staff registration. Financial actions, risk-triggered execution, live trading, payment processing, balance changes, and settlement endpoints are not implemented.
- Integration secrets are not editable in the UI or exposed by API. Configure them through a secrets manager or protected deployment environment.

Before using this system for live operations, implement and independently verify user authentication, regulated payment provider workflows, Deriv authorization and approval, signal review, participant freezing, transactional balance/risk checks, trade reconciliation, proportional settlement, monitoring, backups, deployment hardening, and security/accounting review.
