# G-Squad

G-Squad is a Node.js, Express, and React application with separate member and administrator portals, authenticated access, audited configuration, risk-limit management, and account/ledger views. It uses SQLite for local development and Neon Postgres for persistent Vercel deployments.

> **Live-money readiness:** Trading execution, Deriv account authorization, deposits, withdrawals, wallet mutation, and settlement are not implemented. Their status is always disabled; this application must not be used to accept funds or claim verified trading activity.

## Requirements

- Node.js 22.13 or newer
- npm

## Configure and run

1. Install dependencies:

   ```sh
   npm install
   ```

2. Copy `.env.example` to `.env`, then set a unique admin username and a strong password of at least 14 characters. Keep `.env` out of source control. Set `GSQUAD_SECRETS_KEY` to a generated base64-encoded 32-byte key before saving a Deriv PAT through the admin UI. Protect and back up this key separately from the database; losing it makes stored PATs unrecoverable. Deriv credentials do not activate a connection.

3. Bootstrap a super-admin:

   ```sh
   npm run admin:create
   ```

   The command reads `ADMIN_USERNAME` and `ADMIN_PASSWORD`, stores a scrypt password hash, and does not create a public registration route. Additional staff accounts are created by a super-admin from **Employee access**.

4. Start the development server:

   ```sh
   npm run dev
   ```

   Open <http://localhost:3000> for the member portal or <http://localhost:3000/admin> for administration.

5. To enable member registration, configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM`. Use `SMTP_SECURE=true` for implicit TLS (commonly port 465); port 587 typically uses STARTTLS. On Vercel, account links automatically use the project's production URL, or the deployment URL if no production URL is available. `APP_ORIGIN` is optional and can override this with your custom domain (for example, `https://example.com`). Outside Vercel, set `APP_ORIGIN` to the exact public HTTPS origin in production. Registration remains unavailable until SMTP is configured.

For a production-style static build and server:

```sh
npm run build
npm start
```

Set `NODE_ENV=production` when deploying behind TLS. On Vercel, the app detects its public URL automatically; set `APP_ORIGIN` only if you need account links to use a custom domain. Outside Vercel, set `APP_ORIGIN` to the exact HTTPS origin. If the app is behind a trusted reverse proxy, configure `TRUST_PROXY` for that proxy. Configure `PORT` and `GSQUAD_DB_PATH` as needed. Local SQLite data is stored in the ignored `data/` directory by default. On Vercel, configure `DATABASE_URL` for Neon; local SQLite is intentionally not used there.

## Administration

- **Employee access:** Super-admins can provision employee accounts and assign either `admin` (read-only operational access) or `super_admin` (full administrative access). Initial passwords must be at least 14 characters.
- **Application settings:** Super-admins can configure organization name, support email, default currency, timezone, a PNG/JPEG/WebP application logo (up to 1 MB), and Deriv App ID. The logo is used throughout both portals and is shown by itself on the eight-second splash screen. A Deriv PAT can be replaced through the UI; it is encrypted with AES-256-GCM before storage, masked from API responses, and audited without recording its value. The encryption key must be supplied by the deployment environment. Deriv connection testing is not implemented.
- **Risk management:** Super-admins can record daily loss/profit targets, combined-stake and exposure limits, and the emergency-stop setting. These settings do not enable execution.
- **Audit:** Sign-ins, employee creation, and configuration changes are recorded in the append-only audit log.
- Legacy records previously marked as synthetic are hidden from ordinary account, payment, support, and liability views; they are retained rather than destructively deleted.

## Member portal

- Visit the main domain (for example, <https://your-project.vercel.app>) for the member welcome, registration, sign-in, and account recovery flows. Visit `/admin` on that domain for administration. Registration creates a `GSQ-XXXXXX` account ID and empty USD wallet, and requires email verification before login. There is no public staff registration.
- The member portal is restricted to mobile devices and includes Dashboard, Wallet, Bot, Risk, Trading activity, Notifications, Account, and Support views. Members can review their own ledger, confirmed trade records, and support history; update personal risk settings; and manage notification preferences and passwords. Notifications are checked while the portal is open, with a louder in-app sound and vibration alert for newly received notices when supported by the device.
- Deposits and withdrawals are shown as unavailable. The UI cannot create payment requests, and no unverified payment is credited. Bot start is rejected while the trading engine is disabled; stop requests persist. Saving risk preferences does not enable execution.
- Member passwords use scrypt hashes; verification and reset tokens are hashed in the database, expire after one hour, and are sent via configured SMTP. Member sessions use expiring, server-stored tokens in HttpOnly, SameSite cookies. Account APIs require an authenticated session and same-origin state-changing requests.

## Implemented safeguards and limitations

- Scrypt password hashes, rate-limited sign-in, HttpOnly/SameSite server-stored sessions, same-origin checks, and server-side role enforcement.
- SQLite and PostgreSQL schemas with foreign keys, integer minor-unit balances, unique idempotency keys, immutable wallet ledger entries, and frozen trading-round snapshots.
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

## Deploy to Vercel with Neon

1. Create a Neon Postgres database from the Vercel Marketplace and connect it to this project. Ensure Vercel provides the `DATABASE_URL` environment variable for Production (and Preview if needed). The app initializes and updates its schema on first request.
2. Add the SMTP variables listed above in Vercel. Set `APP_ORIGIN` only when you want email links to use a custom HTTPS domain; otherwise the Vercel production URL is detected automatically.
3. Deploy. Vercel serves the built Vite frontend from the public asset directory and runs the exported Express app as a Node.js function for API requests. The member portal is `/`; the admin portal is `/admin`.
4. To carry over an existing local SQLite database, link the repository to the Vercel project, pull its Production variables into the ignored local `.env` file, then run:

   ```sh
   vercel env pull .env --environment=production
   npm run db:migrate
   ```

   Run this once against a new, empty Neon database. The migration copies accounts, sessions, settings, audit records, and wallet/trading records. Do not run it again on a database that already contains those rows.
5. For a fresh Neon database that did not receive migrated accounts, create the first administrator:

   ```sh
   npm run admin:create
   ```

   Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` in the local `.env` first. The admin account is stored in Neon and can then sign in at `/admin`. If you migrated an existing SQLite database, its administrator accounts were copied too; sign in with an existing account instead of running this command.

For Vercel deployments, `DATABASE_URL` is required; the app fails clearly rather than using an ephemeral local SQLite file. Keep the Neon connection string private. Set Vercel’s `DATABASE_URL` using the Neon Marketplace integration rather than committing it to the repository.
