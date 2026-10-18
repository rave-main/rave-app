require('dotenv').config();
const { createApp } = require('./src/app');
const { createPool, migrate } = require('./src/db');
const { startScheduler } = require('./src/rave/scheduler');
const { buildJobs } = require('./src/rave/jobs');

const PORT = process.env.PORT || 3000;

async function main() {
  const pool = createPool();
  await migrate(pool);
  const app = createApp({ pool });
  const server = app.listen(PORT, () => {
    console.log(`rave-app API listening on port ${PORT}`);
    console.log(`Allowed origins: ${process.env.FRONTEND_ORIGIN || 'http://localhost:5173'}`);
  });

  // RAVE_COLLECTOR=off disables all scheduled collection (e.g. for a second local instance)
  const stopScheduler = process.env.RAVE_COLLECTOR === 'off' ? () => {} : startScheduler(pool, buildJobs());
  process.on('SIGTERM', () => {
    stopScheduler();
    server.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
