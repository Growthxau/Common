G-Squad — Complete User-Side Application

Build the complete user-side application for G-Squad, a multi-user Deriv automated trading platform. This is a new application whose admin panel has already been created. Integrate the user side with the existing admin backend and database.

IMPORTANT: Do not rebuild, replace, or damage the existing admin panel, authentication, database, or backend. Inspect and reuse the existing architecture, API routes, database models, and design system. Implement the user-side features as part of the existing project.

1. Design and Navigation

- Use a clean, modern fintech design.
- Light background with blue primary buttons.
- Professional cards, readable typography, clear status indicators, and responsive layouts.
- Prioritize a mobile-first experience while supporting desktop.
- Prevent content from hiding underneath the header or bottom navigation.
- Ensure proper scrolling, spacing, loading states, error messages, and empty states.
- Use a consistent header and fixed bottom navigation that does not cover page content.

Bottom navigation:

- Dashboard
- Wallet
- Bot
- Risk
- Account

Keep the interface simple and focused on the user's essential activities.

2. Welcome, Registration and Login

Create a polished welcome page with the G-Squad logo, a short introduction, and Login and Register buttons.

Registration fields:

- Full name
- Email address
- Password
- Confirm password
- Acceptance of terms and privacy policy

Requirements:

- Verify email addresses before granting normal account access.
- Provide secure login, logout, password reset, and email verification flows.
- Use the existing authentication system where available.
- Generate a unique user account ID in the format GSQ-XXXXXX.
- Enforce unique email addresses and account IDs.
- Protect all private pages and API requests.
- Never store passwords in plaintext.
- Never allow users to access another user's wallet or trading records.

3. User Dashboard

Create a professional dashboard displaying:

- Available wallet balance in USD.
- Total deposited.
- Total withdrawn.
- Realized profit/loss.
- Current bot status.
- User's configured stake.
- Maximum daily loss.
- Daily profit target and progress.
- Recent trading activity.
- Important account notifications.

Include a clear Start Bot or Stop Bot control and a visible status indicator.

Do not display fabricated balances or profits. Clearly label any development or demo data.

4. Personal Wallet

Each user must have an individual internal G-Squad wallet denominated in USD.

Display:

- Available balance.
- Reserved funds, if applicable.
- Funds committed to active trading rounds.
- Total deposits and withdrawals.
- Realized profit/loss.
- Complete transaction history.

Implement a persistent wallet ledger with unique transaction references and auditable entries.

Rules:

- Update balances only through trusted server-side operations.
- Prevent negative balances, unauthorized balance changes, and duplicate credits or debits.
- Use database transactions and idempotency protection.
- Never let the frontend directly set a user's wallet balance.
- Keep wallet balances and actual admin Deriv account funds clearly distinguished.

5. Deposit System

Create a deposit page with:

- Amount input in USD.
- Supported payment method display.
- Payment instructions.
- Unique deposit reference.
- Deposit status and transaction history.

Support the future integration of USDT on the TRON network (TRC20), with the payment provider configurable by the administrator.

Deposit workflow:

1. User submits a deposit request.
2. Backend creates a pending deposit record.
3. Payment is verified using trusted provider confirmation or an authenticated administrator workflow.
4. Credit the wallet only after confirmed payment.
5. Record the payment reference and ledger entry.
6. Prevent duplicate payment processing.

Never mark an unverified payment as successful. Do not build fake payment confirmations.

6. Withdrawal System

Create a withdrawal page where users can:

- Enter an amount.
- Select a supported withdrawal method.
- Provide the required destination details securely.
- Review fees and the estimated net amount where configured.
- Submit and track withdrawal requests.

Workflow:

1. Validate the available balance on the backend.
2. Reserve or debit the requested amount safely according to the existing ledger design.
3. Create a pending withdrawal record.
4. Allow the administrator or approved payment provider to process it.
5. Update the status only after the appropriate payment result is confirmed.
6. Release reserved funds if a withdrawal fails or is cancelled.
7. Prevent duplicate withdrawals and concurrent overspending.

Display pending, processing, completed, rejected, and failed statuses accurately.

7. Bot Control

Create a dedicated Bot page with:

- Start Bot and Stop Bot buttons.
- Connection status.
- Trading engine status.
- Current market.
- Current trading round status.
- Last signal status.
- Current stake.
- Daily profit/loss.
- Daily target progress.
- Clear messages for paused, disconnected, waiting, and stopped states.

The user's bot should wait for approved signals and participate only while the user is eligible.

Starting or stopping the user's bot must update persistent backend state, not just the frontend.

A user stopping their bot must prevent participation in future rounds without corrupting a trade that has already been submitted.

Do not claim a bot is running or connected unless the backend confirms it.

8. Risk Management

Create a dedicated Risk page where users can configure:

- Stake amount in USD.
- Maximum daily loss.
- Daily profit target.

Requirements:

- Validate all inputs on both frontend and backend.
- Prevent stakes exceeding available eligible funds or configured limits.
- Apply risk settings before including a user in a new trading round.
- Stop further participation when the user's daily loss limit or profit target is reached.
- Prevent users from bypassing risk limits through repeated requests.
- Display saved settings and clear validation messages.
- Do not expose hidden strategy rules or internal trading algorithms.

Do not add unnecessary trading controls or strategy settings to the user interface.

9. Shared Deriv Trading Model

Prepare the user side to integrate with the existing admin trading engine.

The intended model is:

- Each user has an individual internal wallet and independently starts or stops their bot.
- When the backend approves a signal, it identifies eligible users.
- The backend freezes the participant list and each user's exact stake for that trading round.
- The backend calculates the combined stake.
- One combined trade is submitted through the configured admin Deriv account, subject to the account's capabilities and authorization for this business model.
- The backend records the actual Deriv contract ID, confirmed stake, payout, and net result.
- The backend distributes the actual net profit or loss proportionally to each participant's stake contribution.
- Each participant's wallet is updated exactly once.

For example, if the combined stake is $100 and the confirmed net profit is $20, a participant contributing $25 receives a $5 allocation of the profit. The original stake is accounted for separately so it is not accidentally credited twice.

Use actual confirmed Deriv settlement data. Never calculate profits from assumed returns or fixed percentages.

Implement safe handling for rejected trades, insufficient funds, network timeouts, duplicate signals, partial failures, and repeated settlement messages.

Do not enable real-money trading until the backend integration and the proposed operating model have been verified.

10. Trading Activity

Create a personal trading history page displaying only the current user's records:

- Trading round ID.
- Date and time.
- User's contributed stake.
- Contract outcome.
- Allocated profit or loss.
- Settlement status.
- Wallet transaction reference.

Display pending, won, lost, rejected, and failed states only when supported by actual backend records.

Provide useful empty states when the user has no trading activity.

11. Account and Profile

Create an Account page containing:

- Full name.
- Email address and verification status.
- G-Squad account ID.
- Password change and password reset options.
- Notification preferences.
- Security settings.
- Support access.
- Terms and privacy policy.
- Logout.

Do not display the admin's Deriv credentials or other users' private information.

12. Notifications and Support

Provide in-app notifications for important events:

- Deposit confirmation.
- Withdrawal status changes.
- Bot connection problems.
- Daily loss limit reached.
- Daily profit target reached.
- Important account or security alerts.

Do not send notifications every time a trade is placed, won, or lost. Show trading activity in the history page instead.

Build a support page that fits the existing G-Squad design and integrates with the existing support system if one exists.

13. Backend and Security

Reuse the existing backend and database. Add only the necessary models, API endpoints, validation, and migrations.

Enforce server-side authorization on every user-specific endpoint.

Implement:

- Secure sessions or the existing secure authentication mechanism.
- Password hashing and rate limiting.
- Input validation.
- Database transactions.
- Idempotent payment and settlement processing.
- Audit logs for financial operations.
- Ownership checks for every wallet, transaction, and trading record.
- Secure error handling without exposing credentials or sensitive internals.

Keep DERIV_PAT and DERIV_APP_ID exclusively on the backend in environment variables or an appropriate secret manager. Never expose the PAT in frontend code, browser storage, API responses, or GitHub.

14. Implementation and Testing

Implement the user side in the existing project without removing admin functionality.

- Reuse existing components, routes, and database structures where appropriate.
- Avoid unnecessary dependencies and unrelated refactoring.
- Implement working functionality rather than static mockups.
- Clearly label any features that still require external provider configuration.
- Test registration, login, authorization, wallet accounting, deposit verification, withdrawal processing, bot controls, risk limits, and settlement idempotency.
- Ensure the app builds successfully and works on mobile.
- Use demo funds and test data until all required integrations are verified.

When finished, summarize the pages created, backend functionality implemented, database changes, tests performed, and configuration still required.

Begin by implementing the complete user-side application and integrating it with the existing G-Squad admin system. Preserve the established project architecture and do not rebuild the admin panel.
