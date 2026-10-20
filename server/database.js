if (process.env.VERCEL && !process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be configured for the Vercel deployment.');
}

if (process.env.DATABASE_URL) {
  module.exports = require('./postgres');
} else {
  const sqlite = require('./db');
  const { AsyncLocalStorage } = require('node:async_hooks');
  const transactionContext = new AsyncLocalStorage();
  let transactionTail = Promise.resolve();

  async function waitForTransactions() {
    while (true) {
      const pending = transactionTail;
      await pending;
      if (pending === transactionTail) return;
    }
  }

  module.exports = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        all: async (...parameters) => {
          if (!transactionContext.getStore()) await waitForTransactions();
          return statement.all(...parameters);
        },
        get: async (...parameters) => {
          if (!transactionContext.getStore()) await waitForTransactions();
          return statement.get(...parameters);
        },
        run: async (...parameters) => {
          if (!transactionContext.getStore()) await waitForTransactions();
          return statement.run(...parameters);
        },
      };
    },
    transaction(callback) {
      return async (...parameters) => {
        if (transactionContext.getStore()) {
          throw new Error('Nested database transactions are not supported.');
        }

        const previousTransaction = transactionTail;
        let releaseTransaction;
        transactionTail = new Promise((resolve) => {
          releaseTransaction = resolve;
        });
        await previousTransaction;
        try {
          sqlite.exec('BEGIN IMMEDIATE');
          return await transactionContext.run(true, async () => {
            try {
              const result = await callback(...parameters);
              sqlite.exec('COMMIT');
              return result;
            } catch (error) {
              sqlite.exec('ROLLBACK');
              throw error;
            }
          });
        } catch (error) {
          throw error;
        } finally {
          releaseTransaction();
        }
      };
    },
    ready: Promise.resolve(),
    close: () => sqlite.close(),
  };
}
