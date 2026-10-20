const db = require('../server/database');
const { bootstrapAdmin } = require('../server/admin-bootstrap');

async function createAdmin() {
  const created = await bootstrapAdmin();
  console.log(created ? 'Created the initial super-admin.' : 'An admin account already exists; no changes made.');
}

createAdmin()
  .catch((error) => {
    console.error('Could not create admin:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.close();
  });
