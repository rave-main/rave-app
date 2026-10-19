// The scheduled jobs, in one place. Times are UTC. See scheduler.js for how "due" works.
const { every } = require('./scheduler');
const { runCollection } = require('./collector');
const { runWikipedia } = require('./wikijob');
const { runPrices } = require('./pricejob');
const { runUniverse } = require('./universe');
const { runResearch, recordSpikes, updateLedger } = require('./research');

function buildJobs() {
  return [
    {
      kind: 'apewisdom',
      label: 'Reddit mentions (ApeWisdom)',
      cadence: 'every 30 minutes, at :02 and :32 (the source scans about twice an hour)',
      times: every(30, 2),
      staleAfterMs: 90 * 60 * 1000,
      selfRecording: true,
      // after a good run, note any new Hot/Extreme spikes for the forward ledger (a failure there never fails the run)
      run: async (pool, ctx) => {
        const result = await runCollection(pool, { minIntervalMs: 5 * 60 * 1000 });
        if (result.status === 'success') await recordSpikes(pool).catch((e) => (ctx?.log || console).error('RAVE recordSpikes failed:', e.message));
        return result;
      },
    },
    {
      kind: 'universe',
      label: 'Research universe (S&P 1500 lists)',
      cadence: 'weekly (checked daily at 03:10 UTC); the S&P 500, 400 and 600 company lists from Wikipedia',
      times: ['03:10'],
      staleAfterMs: 9 * 24 * 60 * 60 * 1000,
      run: (pool, ctx) => runUniverse(pool, ctx),
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
      label: 'Share prices (Yahoo Finance)',
      cadence: 'twice a day, 12:30 and 22:30 UTC (the US market closes at 20:00-21:00 UTC); history backfilled 2 years',
      times: ['12:30', '22:30'],
      staleAfterMs: 30 * 60 * 60 * 1000,
      run: (pool, ctx) => runPrices(pool, ctx),
    },
    {
      kind: 'research',
      label: 'Hypothesis tests (Wikipedia backtest + Reddit forward ledger)',
      cadence: 'twice a day, 05:15 and 23:15 UTC (after prices); fills in forward-ledger outcomes as prices arrive',
      times: ['05:15', '23:15'],
      staleAfterMs: 30 * 60 * 60 * 1000,
      run: async (pool, ctx) => ({ ...(await runResearch(pool, ctx)), ledger: await updateLedger(pool) }),
    },
  ];
}

module.exports = { buildJobs };
