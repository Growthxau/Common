Continue developing my existing G-Squad project in GitHub Codespaces. Both the admin panel and user-side application have already been built.

Implement the persistent database, wallet backend, and admin-managed configuration system. Do not rebuild either interface or replace the existing framework.

1. Inspect the existing project first

- Identify the framework, backend API, authentication system, database, and existing configuration.
- Determine whether a database is already configured and whether it is actually connected and working.
- Reuse existing database models and infrastructure where practical.
- If no suitable persistent database exists, recommend and implement PostgreSQL with safe migrations.
- Do not create duplicate systems or remove working functionality.

2. Admin-managed configuration
Create a protected Configuration/Settings section in the existing admin UI so authorized administrators can manage application settings without editing source code or redeploying for ordinary configuration changes.

Include:

- Deriv API connection settings and App ID.
- Secure Deriv PAT entry, replacement, and connection testing.
- Trading engine enable/disable and emergency stop.
- Allowed market and contract settings.
- Maximum combined stake and global risk limits.
- Deposit methods and payment-provider configuration.
- Withdrawal settings, minimums, maximums, and applicable fees.
- Application-wide operational settings.

Persist non-secret settings in the database. Store secret credentials in an appropriate encrypted server-side secret store or secure backend configuration service. Never expose secrets in frontend code, browser storage, logs, API responses, or GitHub.

The admin UI must mask stored secrets and must never return the existing PAT to the browser. Allow authorized administrators to replace a secret without revealing its current value.

Validate every setting on the server. Enforce admin authorization on every configuration endpoint, audit sensitive changes, and prevent unsafe changes while trading is active.

Do not pretend that configuration changes are successful until persistence is confirmed.

3. Database and wallet backend
Persist:

- User accounts and authentication records.
- Individual USD wallet balances and reserved funds.
- Wallet ledger entries.
- Deposit and withdrawal requests.
- User stake and risk settings.
- Trading rounds and frozen participant contributions.
- Deriv trade records and confirmed results.
- Individual profit/loss allocations.
- Admin configuration and audit logs.

Use exact decimal arithmetic or integer minor units for financial calculations. Use database transactions, idempotency keys, and concurrency controls to prevent negative balances, duplicate credits, and concurrent overspending.

Keep each user's wallet separate from the real Deriv account balance.

4. Shared trading engine
Prepare the backend for the intended G-Squad model:

- Each user independently starts or stops their bot.
- When a signal is approved, identify eligible users and freeze their stake contributions.
- Calculate and validate the combined stake.
- Submit one combined trade through the configured admin Deriv account only when the integration is operational and the arrangement is authorized.
- Record the actual confirmed Deriv contract details and settlement.
- Allocate actual net profit or loss proportionally to each user's contribution.
- Update each user's wallet exactly once.

Handle rejected orders, timeouts, duplicate signals, and settlement recovery safely. Never fabricate trade results or estimated payouts.

5. Security and operational requirements

- Keep all secret credentials server-side.
- Use secure admin authentication, role-based authorization, password hashing, rate limiting, and audit logs.
- Validate and sanitize configuration inputs.
- Require explicit confirmation for sensitive actions such as changing credentials or enabling live trading.
- Provide a safe demo/test mode.
- Do not enable real-money trading automatically after deployment or restart.
- Do not accept customer deposits until payment verification and wallet accounting are operational and the business model has been appropriately authorized.

6. Implementation

- Make the smallest safe changes to the existing codebase.
- Do not rebuild the admin panel or user app.
- Add migrations and tests as needed.
- Test database persistence, admin permissions, configuration updates, secret masking, wallet accounting, duplicate settlement prevention, and the existing application build.
- Report the database found or created, files changed, environment variables still required, configuration now manageable through the admin UI, tests performed, and remaining setup steps.

Start by inspecting the project, then implement these changes incrementally without destructive edits.

Continue working on my existing G-Squad project. First inspect the current implementation and fix any incomplete parts without rebuilding the app or removing working features.

1. Database: Verify that the database is configured, connected, persistent, and migrations work. If missing, set up a suitable persistent database and document the required connection settings.

2. Admin configuration: Verify that the admin can manage application settings through the existing admin UI, including Deriv App ID, securely entering or replacing the Deriv PAT, trading controls, risk limits, and payment settings. Keep secrets server-side and never expose them in the browser or logs.

3. Wallet and trading backend: Verify user balances, stake reservations, trading rounds, actual Deriv settlement records, and proportional profit/loss allocation. Prevent negative balances and duplicate payouts.

4. Security: Verify admin permissions, API protection, input validation, audit logs, and secure secret handling. Keep live trading disabled by default.

5. Testing: Run the available tests and production build. Fix errors introduced by these changes. Test database persistence, admin settings, wallet accounting, and duplicate-settlement prevention using safe test data or demo mode.

6. Final report: Do not just describe what should be done. Implement what is possible in the existing project, then report:

- Whether the database is working and which database is used.
- Which features are implemented and tested.
- Which files were changed.
- Which environment variables or external services I still need to configure.
- Any errors or unfinished work.
- The exact next step I should take.

Make minimal, safe changes. Do not claim a feature works unless you have verified it. Do not enable real-money trading or accept real deposits until the relevant integrations are verified.
