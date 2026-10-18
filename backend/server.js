require('dotenv').config();
const { createApp } = require('./src/app');
const { createPool, migrate } = require('./src/db');

const PORT = process.env.PORT || 3000;

async function main() {
  const pool = createPool();
  await migrate(pool);
  const app = createApp({ pool });
  app.listen(PORT, () => {
    console.log(`rave-app API listening on port ${PORT}`);
    console.log(`Allowed origins: ${process.env.FRONTEND_ORIGIN || 'http://localhost:5173'}`);
  });
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
