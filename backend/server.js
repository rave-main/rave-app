require('dotenv').config();
const { createApp } = require('./src/app');
const { createPool, migrate } = require('./src/db');
const { startCollector } = require('./src/rave/collector');

const PORT = process.env.PORT || 3000;

async function main() {
  const pool = createPool();
  await migrate(pool);
  const app = createApp({ pool });
  const server = app.listen(PORT, () => {
    console.log(`rave-app API listening on port ${PORT}`);
    console.log(`Allowed origins: ${process.env.FRONTEND_ORIGIN || 'http://localhost:5173'}`);
  });

  // RAVE_COLLECTOR=off disables the ApeWisdom collector (e.g. for a second local instance)
  const stopCollector = process.env.RAVE_COLLECTOR === 'off' ? () => {} : startCollector(pool);
  process.on('SIGTERM', () => {
    stopCollector();
    server.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
