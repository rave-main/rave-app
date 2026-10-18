// The scheduled jobs, in one place. Times are UTC. See scheduler.js for how "due" works.
const { every } = require('./scheduler');
const { runCollection } = require('./collector');
const { runWikipedia } = require('./wikijob');
const { runPrices } = require('./pricejob');

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
    {
      kind: 'wikipedia',
      label: 'Wikipedia page views',
      cadence: 'twice a day, 04:30 and 16:30 UTC (daily views are published the following day); history backfilled 5 years',
      times: ['04:30', '16:30'],
      staleAfterMs: 30 * 60 * 60 * 1000,
      run: (pool, ctx) => runWikipedia(pool, ctx),
    },
    {
      kind: 'prices',
      label: 'Stock prices (Yahoo, Stooq fallback)',
      cadence: 'twice a day, 12:30 and 22:30 UTC (the US market closes at 20:00-21:00 UTC); history backfilled 5 years',
      times: ['12:30', '22:30'],
      staleAfterMs: 30 * 60 * 60 * 1000,
      run: (pool, ctx) => runPrices(pool, ctx),
    },
  ];
}

module.exports = { buildJobs };
