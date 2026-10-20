G-Squad — Full Security and Plisio Payment Integration Update

Update my existing G-Squad project in the current GitHub repository. Do not rebuild the app, replace existing interfaces, or remove working features. Inspect the current code, database, authentication, admin panel, user dashboard, and Plisio integration before making changes. Reuse existing components and infrastructure wherever possible.

1. Secure the entire application

- Protect all API routes with server-side authentication and authorization.
- Enforce strict separation between regular users and administrators.
- Ensure users can only access their own profile, wallet, transactions, and trading records.
- Validate all input on the server and protect against SQL injection, XSS, CSRF, IDOR, brute-force attacks, and unauthorized requests.
- Use secure password hashing, session handling, cookies, rate limiting, and account recovery.
- Add stronger admin authentication, preferably MFA if supported by the existing setup.
- Keep Plisio API secrets, Deriv PAT, database credentials, and other secrets exclusively on the backend.
- Never expose secrets in frontend code, API responses, browser storage, console logs, or GitHub.
- Check dependencies and configuration for known vulnerabilities. Preserve existing authentication and working features.

2. Keep Plisio payments inside G-Squad

- Users must initiate deposits and withdrawals from within G-Squad.
- Do not redirect users to the Plisio website.
- Inspect the official Plisio API documentation and determine whether the existing account supports White Label or another legitimate in-app payment flow.
- Use the supported in-app method to display payment instructions, QR code, payment address, amount, cryptocurrency, network, expiry, and status.
- If a payment method cannot support an in-app flow, report the limitation instead of silently redirecting users or pretending the feature works.
- Never fabricate a payment address, QR code, transaction hash, payment status, or receipt.

3. Deposit workflow with admin approval

1. An authenticated user enters a deposit amount and selects an available supported cryptocurrency/network.
2. The backend validates the amount, creates a unique deposit order, and obtains the payment invoice/details from Plisio.
3. The user sees the payment instructions and status inside G-Squad.
4. The backend verifies the payment using Plisio's documented callback-signature verification and transaction-status verification where appropriate.
5. The system records the actual payment state, amount received, currency, network, provider reference, and transaction hash when available.
6. After Plisio confirms completion, the deposit appears in the admin panel as Awaiting Admin Approval.
7. The admin reviews the verified transaction details and selects Approve or Reject.
8. Credit the user's USD wallet exactly once, only after the verified payment is completed and an authorized admin approves it.
9. Require a rejection reason. Record the admin, decision, timestamp, and reason in the audit log.
10. If a confirmed payment is rejected, flag it for reconciliation and appropriate refund handling. Never erase the payment record or pretend the funds were not received.

Use distinct statuses, such as:

- Awaiting Payment
- Payment Pending
- Payment Confirmed — Awaiting Admin Approval
- Approved — Wallet Credited
- Rejected — Review Required
- Expired
- Failed
- Refund Pending
- Refunded

Only use statuses that accurately represent the real transaction state. Do not let a browser redirect, screenshot, user-submitted transaction hash, or client request prove that a payment was received.

4. Withdrawal workflow with admin approval

1. Users submit withdrawal requests inside G-Squad.
2. Collect the amount, supported cryptocurrency/network, and destination address.
3. Validate the destination, available balance, withdrawal limits, and applicable fees on the backend.
4. Reserve the withdrawal amount atomically so it cannot be spent or withdrawn twice.
5. Display the request in the admin panel with the user account ID, requested amount, currency, network, destination, fees, net payout, timestamp, and status.
6. Admin can approve or reject the request. Require a rejection reason.
7. Initiate a Plisio payout only after an authorized admin approves it.
8. Use documented Plisio endpoints and idempotency or unique references where supported to prevent duplicate payouts.
9. Verify the actual payout status before marking it completed.
10. For failed payouts, release or restore the reserved amount exactly once. For pending or uncertain payouts, reconcile with Plisio before retrying. Never automatically issue a second payout just because a request timed out.
11. Record the admin decision, provider reference, transaction hash when available, fees, timestamps, and status changes.

Use clear withdrawal statuses, such as:

- Pending Admin Approval
- Approved — Processing
- Processing
- Completed
- Rejected
- Failed — Balance Reconciliation Required

Do not mark a withdrawal successful merely because the payout request was accepted by the API.

5. User transaction history and receipts

Create or update the existing transaction-history area without adding unnecessary pages.

For every deposit and withdrawal, show:

- Unique G-Squad transaction reference
- Transaction type
- Requested and actual amounts
- Currency and network
- Fees, where applicable
- Destination or payment address when appropriate
- Plisio transaction/reference ID
- Blockchain transaction hash when available
- Request and completion timestamps
- Payment status
- Admin approval/rejection status
- Rejection reason, where applicable

Provide an in-app receipt/details view that users can open after each transaction. Receipts must use actual recorded data and clearly distinguish pending, confirmed, approved, rejected, failed, and completed transactions.

6. Admin payment management

Update the existing admin panel to provide a secure transaction-management list.

Include:

- Separate deposit and withdrawal filters
- Search by user ID, G-Squad reference, Plisio reference, and transaction hash
- Filters for date, amount, network, and status
- Full transaction details and status history
- Approve and reject actions with confirmation
- Mandatory rejection reasons
- Clear indication of whether Plisio has actually confirmed the transaction
- Admin audit trail showing who performed each action and when
- Reconciliation alerts for confirmed payments awaiting review, uncertain payouts, and wallet/provider mismatches

Only authorized administrators may approve, reject, or initiate payouts. Enforce these permissions on the server, not just by hiding buttons in the interface.

7. Protect wallet balances and accounting

- Use the database as the authoritative source for G-Squad wallet balances.
- Maintain an immutable or properly auditable ledger for credits, debits, reservations, releases, and adjustments.
- Use exact decimal arithmetic or integer minor units; never rely on floating-point arithmetic for financial calculations.
- Use database transactions, concurrency controls, and unique transaction constraints.
- Prevent negative balances, duplicate credits, duplicate debits, and duplicate payouts.
- Keep pending deposits out of available balance until all required payment-verification and approval steps are complete.
- Never delete financial history to correct an error. Use auditable reversing entries or adjustments.
- Separate G-Squad internal wallet balances from the actual balance in the connected Deriv account.

8. Protect the Deriv trading integration

- Keep the Deriv PAT and other credentials backend-only.
- Do not expose trading credentials or internal strategy details to users.
- Only the trusted backend may create trading orders and record confirmed settlement results.
- Preserve existing trading features and risk-management settings.
- Do not credit trading profits based on simulated, assumed, or unconfirmed results.
- Keep live trading disabled if credentials, authorization, settlement verification, or required configuration is incomplete.

9. Monitoring and incident protection

- Record important authentication, administrative, payment, withdrawal, and wallet events.
- Mask secrets and sensitive payment information in logs.
- Add useful error handling and alerts for repeated failed logins, suspicious requests, callback failures, and mismatched balances.
- Provide a safe way to revoke sessions and rotate compromised credentials.
- Check backup and recovery procedures.
- Never log full API secrets, passwords, or authentication tokens.

10. Testing and delivery

Test at minimum:

- Unauthorized access to admin routes
- Attempts to access another user's wallet or transactions
- Invalid or forged Plisio callbacks
- Replayed callbacks and duplicate deposits
- Deposits that remain pending or fail
- Confirmed deposits awaiting admin approval
- Admin approval and rejection
- Concurrent withdrawals against the same wallet
- Duplicate payout attempts
- Failed, pending, completed, and uncertain payouts
- Wallet-ledger consistency
- Receipt accuracy and user/admin visibility
- Existing login, registration, dashboard, and trading features

Use mocked or sandbox transactions for testing. Do not use real money or trigger real payouts during tests.

Before changing the project:

1. Inspect the current implementation and identify what already works.
2. Reuse the existing database and components where suitable.
3. Make minimal, targeted changes and add migrations safely if required.
4. Run available tests and the production build.
5. Do not remove existing functionality or overwrite configuration unnecessarily.
6. Do not commit secrets or expose credentials.
7. Do not claim security or payment completion unless verified.

Finally, provide a concise report listing:

- Files changed
- Features implemented
- Security issues fixed
- Tests and build results
- Remaining issues
- Required Plisio dashboard settings and environment variables
- Anything that still needs my manual action

Do not invent Plisio API endpoints, callback-signature rules, White Label capabilities, or network support. Follow the official documentation and clearly report anything that cannot be verified.
