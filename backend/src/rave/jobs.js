// The scheduled jobs, in one place. Times are UTC. See scheduler.js for how "due" works.
const { every } = require('./scheduler');
const { runCollection } = require('./collector');

function buildJobs() {
  return [
    {
      kind: 'apewisdom',
      label: 'Reddit mentions (ApeWisdom)',
      cadence: 'every 30 minutes, at :02 and :32 (the source scans about twice an hour)',
      times: every(30, 2),
      staleAfterMs: 90 * 60 * 1000,
      selfRecording: true,
      run: (pool) => runCollection(pool, { minIntervalMs: 5 * 60 * 1000 }),
    },
  ];
}

module.exports = { buildJobs };
