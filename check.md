Build a new application called G-Squad, a multi-user Deriv automated trading platform, using Node.js for the backend.

Design: Use a clean, modern fintech design with a light background, blue buttons, responsive layouts, and a professional admin dashboard.

Build the complete admin panel with these pages:

1. Admin Login — Separate, secure admin authentication.
2. Dashboard — Total users, active bots, admin Deriv balance, total user wallet liabilities, daily profit/loss, combined stake, pending deposits and withdrawals.
3. Deriv Connection — Configure DERIV_PAT and DERIV_APP_ID securely through backend environment variables. Display connection status, account currency, and verified account balance.
4. Trading Engine — Global bot start/stop, emergency stop, live market status, approved signals, eligible users, combined stake, trade execution status, and actual Deriv results.
5. User Management — Search users, view account IDs, wallet balances, configured stakes, bot status, and account activity.
6. Deposits — View and verify deposit transactions, approve or reject requests, and prevent duplicate credits.
7. Withdrawals — Review withdrawal requests, verify available balances, record payment references, and track statuses.
8. Trade History — Display contract IDs, actual stake, payout, profit/loss, execution status, and timestamps.
9. Profit Sharing — Show each trading round's combined stake, frozen participant list, individual stake contributions, proportional profit/loss allocations, and settlement status.
10. Risk Management — Maximum daily loss, daily profit target, maximum combined stake, exposure limits, and emergency-stop rules.
11. Wallet Ledger — Record every deposit, withdrawal, stake allocation, profit, loss, and balance adjustment.
12. Notifications — Important alerts for connection failures, payment issues, risk limits, and reached trading targets.
13. Support Management — View and respond to user support requests.
14. Security and Settings — Admin permissions, audit logs, application settings, and secure credential management.

Trading model:

- Each registered user has an individual G-Squad wallet and can independently start or stop their bot.
- When the backend approves a trading signal, identify all eligible users whose bots are running.
- Freeze the eligible users and their exact stake contributions for that trading round.
- Calculate the combined stake and validate it against available funds and risk limits.
- Execute one combined trade through the configured admin Deriv account, subject to Deriv's approval of this business model and the account's trading capabilities.
- Obtain the actual confirmed stake, payout, and profit/loss from Deriv.
- Allocate the actual net result proportionally to each participating user's stake contribution.
- Update each user's internal wallet exactly once and record an auditable settlement.
- Handle rejected trades, disconnections, concurrent signals, insufficient funds, and duplicate settlement attempts safely.

Security requirements:

- Keep DERIV_PAT and DERIV_APP_ID on the backend only.
- Never expose the PAT in frontend code, browser storage, API responses, or GitHub.
- Use secure admin sessions, server-side authorization, password hashing, rate limiting, and audit logs.
- Implement transactional wallet accounting and idempotent payment and settlement processing.
- Never fabricate balances, trading signals, profits, payouts, or successful transactions.

Technical requirements:

- Build a new application from scratch using Node.js.
- Use a suitable frontend framework, backend API, and persistent database.
- Organize the project into clear modules for authentication, users, wallets, payments, Deriv connectivity, trading, risk management, and settlements.
- Make the admin interface fully responsive on mobile and desktop.
- Use demo funds and test data during development.
- Build and test each module before enabling real-money operations.
- Do not claim the platform is production-ready until security, accounting, payment processing, and Deriv integration have been verified.

Start by creating the project structure, database schema, secure admin authentication, and complete admin dashboard UI. Then implement the backend modules in stages. Provide a clear summary of created files, implemented features, and remaining setup requirements.
