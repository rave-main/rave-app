const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, signedInAgent, resetRave, seedHistory } = require('./helpers');
const wiki = require('../src/rave/wiki');
const { runWikipedia } = require('../src/rave/wikijob');
const { scoreStock } = require('../src/rave/scoring');
const { simulateCounts } = require('./rave-sim');

let pool, app;
before(async () => ({ pool, app } = await setup()));
after(() => pool.end());

const resp = (body, status = 200, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body, text: async () => JSON.stringify(body) });
const fastOpts = { retryDelayMs: 1, pauseMs: 0 };

// A fake of the two Wikimedia services, shaped like the real responses
const PAGES = {
  'Tesla, Inc.': { extract: 'Tesla, Inc. is an American multinational automotive and clean energy company (Nasdaq: TSLA).' },
  'Apple Inc.': { extract: 'Apple Inc. is an American multinational technology company (Nasdaq: AAPL).' },
  GameStop: { extract: 'GameStop Corp. is an American video game retailer (NYSE: GME).' },
  Mercury: { disambiguation: true, extract: 'Mercury may refer to:' },
  Cat: { extract: 'The cat is a small carnivorous mammal.' },
  'Palantir Technologies': { extract: 'Palantir Technologies Inc. is an American software company (NYSE: PLTR).' },
};
const REDIRECTS = { 'NVIDIA': 'Nvidia', 'Palantir': 'Palantir Technologies' };
PAGES.Nvidia = { extract: 'Nvidia Corporation is an American multinational technology company (Nasdaq: NVDA).' };

function fakeWikipedia({ views = {}, fail = [], failAll = false } = {}) {
  const calls = { api: 0, views: [] };
  const fetchImpl = async (url) => {
    if (url.includes('wikimedia.org/api/rest_v1')) {
      const article = decodeURIComponent(url.split('/user/')[1].split('/daily/')[0]).replace(/_/g, ' ');
      const [start, end] = url.split('/daily/')[1].split('/').map((x) => x.slice(0, 8));
      calls.views.push({ article, start, end });
      if (failAll || fail.includes(article)) return resp({}, 500);
      const series = views[article];
      if (!series) return resp({ type: 'not_found' }, 404);
      const items = [];
      for (let d = Date.UTC(+start.slice(0, 4), +start.slice(4, 6) - 1, +start.slice(6, 8)); d <= Date.UTC(+end.slice(0, 4), +end.slice(4, 6) - 1, +end.slice(6, 8)); d += 86400000) {
        const day = new Date(d).toISOString().slice(0, 10);
        if (series(day) !== undefined) items.push({ project: 'en.wikipedia', article: article.replace(/ /g, '_'), granularity: 'daily', timestamp: `${day.replace(/-/g, '')}00`, access: 'all-access', agent: 'user', views: series(day) });
      }
      return resp({ items });
    }
    calls.api++;
    const u = new URL(url);
    const titles = u.searchParams.get('titles').split('|');
    const pages = [];
    const redirects = [];
    for (const requested of titles) {
      const target = REDIRECTS[requested] || requested;
      if (target !== requested) redirects.push({ from: requested, to: target });
      const p = PAGES[target];
      if (!p) pages.push({ title: target, missing: true });
      else if (u.searchParams.get('prop') === 'extracts') pages.push({ pageid: 1, title: target, extract: p.extract });
      else pages.push({ pageid: 1, title: target, ...(p.disambiguation ? { pageprops: { disambiguation: '' } } : {}) });
    }
    return resp({ batchcomplete: true, query: { redirects, pages } });
  };
  return { fetchImpl, calls };
}

test('candidate titles strip legal suffixes and try the common company title forms first', () => {
  assert.deepEqual(wiki.candidateTitles('Tesla').slice(0, 3), ['Tesla, Inc.', 'Tesla Inc.', 'Tesla (company)']);
  assert.equal(wiki.candidateTitles('Alphabet Inc. Class A')[0], 'Alphabet, Inc.');
  assert.ok(wiki.candidateTitles('Micron Technology').includes('Micron Technology'));
  assert.ok(wiki.candidateTitles('AMC Entertainment Holdings').includes('AMC Entertainment'));
  assert.deepEqual(wiki.candidateTitles(''), []);
  assert.ok(wiki.candidateTitles('Foo').length <= 18);
  // cleaned-up bases for the awkward names seen on the real leaderboard
  assert.ok(wiki.candidateTitles('Meta Platforms (Facebook)').includes('Meta Platforms'));
  assert.ok(wiki.candidateTitles('SPDR S&amp;P 500 ETF Trust').includes('SPDR S&P 500 ETF Trust'));
  assert.ok(wiki.candidateTitles('Invesco QQQ ETF').includes('Invesco QQQ'));
  const vt = wiki.candidateTitles('Vanguard Group, Inc. - Vanguard Total World Stock ETF');
  assert.ok(vt.includes('Vanguard Total World Stock ETF') && vt.includes('Vanguard Total World Stock'));
});

test('judgeExtract accepts listed companies and funds and rejects disambiguation pages and unrelated articles', () => {
  assert.deepEqual(wiki.judgeExtract(PAGES.GameStop.extract, 'GME'), { ok: true, confidence: 'high' });
  assert.equal(wiki.judgeExtract('Acme Corp is a manufacturer of anvils.', 'ACME').ok, true);
  assert.equal(wiki.judgeExtract('Acme Corp is a manufacturer of anvils.', 'ACME').confidence, 'medium');
  assert.equal(wiki.judgeExtract('Mercury may refer to: the planet, the element.', 'MER').ok, false);
  assert.equal(wiki.judgeExtract('The cat is a small carnivorous mammal.', 'CAT').ok, false);
  assert.equal(wiki.judgeExtract('', 'X').ok, false);
});

test('resolveArticles follows redirects, skips missing and disambiguation pages, and verifies the lead paragraph', async () => {
  const { fetchImpl } = fakeWikipedia();
  const out = await wiki.resolveArticles(
    [{ ticker: 'TSLA', name: 'Tesla' }, { ticker: 'AAPL', name: 'Apple' }, { ticker: 'NVDA', name: 'NVIDIA' }, { ticker: 'PLTR', name: 'Palantir' },
      { ticker: 'MER', name: 'Mercury' }, { ticker: 'CAT', name: 'Cat' }, { ticker: 'NOPE', name: 'Zzzz Nonexistent' }],
    { fetchImpl, ...fastOpts }
  );
  const by = Object.fromEntries(out.map((r) => [r.ticker, r]));
  assert.equal(by.TSLA.article, 'Tesla, Inc.');
  assert.equal(by.AAPL.article, 'Apple Inc.', 'the second candidate ("Apple Inc.") is the real title');
  assert.equal(by.NVDA.article, 'Nvidia', 'a redirect is followed to the canonical article');
  assert.equal(by.PLTR.article, 'Palantir Technologies');
  assert.equal(by.TSLA.confidence, 'high');
  assert.equal(by.MER.status, 'unresolved', 'a disambiguation page is never accepted');
  assert.equal(by.CAT.article, null);
  assert.equal(by.CAT.status, 'rejected', 'an article that does not look like a company is rejected');
  assert.equal(by.CAT.rejectedArticle, 'Cat');
  assert.equal(by.NOPE.status, 'unresolved');
});

test('fetchViews parses daily views, treats 404 as no data, and retries 429 honouring Retry-After', async () => {
  const days = { GameStop: (d) => Number(d.slice(8)) * 10 };
  const { fetchImpl, calls } = fakeWikipedia({ views: days });
  const rows = await wiki.fetchViews('GameStop', '2026-09-01', '2026-09-03', { fetchImpl, ...fastOpts });
  assert.deepEqual(rows, [{ day: '2026-09-01', views: 10 }, { day: '2026-09-02', views: 20 }, { day: '2026-09-03', views: 30 }]);
  assert.deepEqual(await wiki.fetchViews('No Such Page', '2026-09-01', '2026-09-03', { fetchImpl, ...fastOpts }), []);
  assert.equal(calls.views[0].start, '20260901');

  let n = 0;
  const limited = async () => (++n < 3 ? resp({}, 429, { 'retry-after': '0' }) : resp({ items: [{ timestamp: '2026090100', views: 5 }] }));
  assert.deepEqual(await wiki.fetchViews('X', '2026-09-01', '2026-09-01', { fetchImpl: limited, ...fastOpts }), [{ day: '2026-09-01', views: 5 }]);
  assert.equal(n, 3);
  await assert.rejects(wiki.fetchViews('X', '2026-09-01', '2026-09-01', { fetchImpl: async () => resp({}, 403), ...fastOpts }), /HTTP 403/);
});

test('saveViews/loadWikiSeries round-trip across months, merge into existing months, and report the last stored day', async () => {
  await resetRave(pool);
  await wiki.saveViews(pool, 'Foo', [{ day: '2026-08-30', views: 1 }, { day: '2026-08-31', views: 2 }, { day: '2026-09-01', views: 3 }]);
  await wiki.saveViews(pool, 'Foo', [{ day: '2026-09-02', views: 4 }, { day: '2026-08-31', views: 22 }]); // merge and correct
  const series = (await wiki.loadWikiSeries(pool, ['Foo', 'Bar'])).get('Foo');
  assert.deepEqual(series.map((p) => [new Date(p.t).toISOString().slice(0, 10), p.mentions]), [['2026-08-30', 1], ['2026-08-31', 22], ['2026-09-01', 3], ['2026-09-02', 4]]);
  assert.equal(await wiki.lastStoredDay(pool, 'Foo'), '2026-09-02');
  assert.equal(await wiki.lastStoredDay(pool, 'Bar'), null);
  assert.deepEqual([...(await wiki.loadWikiSeries(pool, ['Bar'])).get('Bar')], []);
});

const trackedHistory = async () => {
  await seedHistory(pool, { TSLA: simulateCounts({ days: 2, level: 30, seed: 1 }), GME: simulateCounts({ days: 2, level: 30, seed: 2 }) });
  await pool.query(`UPDATE tickers SET name = CASE ticker WHEN 'TSLA' THEN 'Tesla' ELSE 'GameStop' END`);
};

test('the Wikipedia job resolves tracked stocks, backfills history, then only fetches new days', async () => {
  await resetRave(pool);
  await trackedHistory();
  const today = new Date().toISOString().slice(0, 10);
  const series = { 'Tesla, Inc.': () => 1000, GameStop: () => 500 };
  const { fetchImpl, calls } = fakeWikipedia({ views: series });
  const first = await runWikipedia(pool, { fetchImpl, pauseMs: 0, log: { log() {}, error() {} } });
  const mapping = (await pool.query('SELECT ticker, article, status FROM wiki_pages WHERE article IS NOT NULL ORDER BY ticker')).rows;
  assert.equal(first.newlyResolved, 2, JSON.stringify(mapping));
  assert.equal(first.articlesFetched, 2);
  assert.ok(first.daysAdded > 2 * 1700, `${first.daysAdded} days of history backfilled (about 5 years each)`);
  const back = calls.views.find((c) => c.article === 'GameStop');
  assert.ok(Number(back.start.slice(0, 4)) <= new Date().getUTCFullYear() - 4, `backfill starts ${back.start}`);
  const { rows: pages } = await pool.query('SELECT ticker, article, status, source FROM wiki_pages ORDER BY ticker');
  assert.deepEqual(pages.filter((p) => ['GME', 'TSLA'].includes(p.ticker)).map((p) => [p.ticker, p.article, p.status]), [['GME', 'GameStop', 'resolved'], ['TSLA', 'Tesla, Inc.', 'resolved']]);

  const before = calls.views.length;
  const second = await runWikipedia(pool, { fetchImpl, pauseMs: 0, log: { log() {}, error() {} } });
  assert.equal(second.daysAdded, 0, 'already complete up to yesterday: nothing new to store');
  const again = calls.views.slice(before).map((c) => c.article);
  assert.ok(!again.includes('GameStop') && !again.includes('Tesla, Inc.'), 'articles that are up to date are not requested again');
  assert.equal(again.length, 0, 'nothing is asked again');
  assert.ok(today);
});

test('a manual article override is respected by the matcher and used for views; clearing it stops fetching', async () => {
  await resetRave(pool);
  await trackedHistory();
  const { agent } = await signedInAgent(app);
  await agent.put('/api/rave/wiki/TSLA').send({ article: 'Tesla Roadster' }).expect(200);
  await agent.put('/api/rave/wiki/NOPE').send({ article: 'X' }).expect(404);
  await agent.put('/api/rave/wiki/TSLA').send({ article: 'bad|title' }).expect(400);
  const { fetchImpl, calls } = fakeWikipedia({ views: { 'Tesla Roadster': () => 7, GameStop: () => 9 } });
  await runWikipedia(pool, { fetchImpl, pauseMs: 0, log: { log() {}, error() {} } });
  assert.ok(calls.views.some((c) => c.article === 'Tesla Roadster'), 'the override article is fetched');
  assert.ok(!calls.views.some((c) => c.article === 'Tesla, Inc.'), 'the automatic match is not used');
  const { rows: [t] } = await pool.query(`SELECT article, source FROM wiki_pages WHERE ticker = 'TSLA'`);
  assert.deepEqual([t.article, t.source], ['Tesla Roadster', 'override']);
  const list = await agent.get('/api/rave/wiki').expect(200);
  assert.equal(list.body.find((r) => r.ticker === 'TSLA').source, 'override');
});

test('the job fails loudly when most article fetches fail, and records nothing it could not fetch', async () => {
  await resetRave(pool);
  await trackedHistory();
  const { fetchImpl } = fakeWikipedia({ failAll: true });
  await assert.rejects(runWikipedia(pool, { fetchImpl, pauseMs: 0, retryDelayMs: 1, log: { log() {}, error() {} } }), /Wikipedia page views failing for \d+ of \d+ articles/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM wiki_months')).rows[0].n, 0);
  assert.ok((await pool.query(`SELECT count(*)::int AS n FROM wiki_pages WHERE article IS NOT NULL`)).rows[0].n >= 2, 'but the article matches found so far are kept');
});

test('wiki scoring uses the page-views wording and no persistence cap: a one-day jump is Hot at once', () => {
  const days = 80;
  const base = Date.UTC(2026, 0, 5);
  const mk = (spike) => Array.from({ length: days }, (_, i) => ({ t: base + i * 86400000, mentions: Math.round(2000 * (1 + 0.1 * Math.sin(i * 1.7)) * (i === days - 1 ? spike : 1)), market: null, ranked: true, rank: null, rank24hAgo: null, mentions24hAgo: null }));
  const flat = scoreStock(mk(1), { ticker: 'GME', source: 'wiki' });
  assert.equal(flat.short.label, 'Quiet');
  const jump = scoreStock(mk(4), { ticker: 'GME', source: 'wiki' });
  assert.ok(['Hot', 'Extreme'].includes(jump.short.label), jump.short.label);
  assert.notEqual(jump.short.unconfirmed, true);
  assert.match(jump.short.explanation, /page views/);
  assert.match(jump.short.explanation, /the latest full day/);
  assert.doesNotMatch(jump.short.explanation, /Rank #|leaderboard/);
  assert.equal(jump.medium.status, 'ok');
  // the same one-day jump on the Reddit profile is capped until a second reading confirms it
  const reddit = scoreStock(mk(4), { ticker: 'GME' });
  assert.equal(reddit.short.label, 'Rising');
  assert.equal(reddit.short.unconfirmed, true);
});

test('stocks include the wiki signal and an agreement flag; the single-stock endpoint returns the article and history', async () => {
  await resetRave(pool);
  const { agent } = await signedInAgent(app);
  await seedHistory(pool, { GME: simulateCounts({ days: 3, level: 30, seed: 8 }) });
  await pool.query(`INSERT INTO wiki_pages (ticker, article, status, confidence, source) VALUES ('GME', 'GameStop', 'resolved', 'high', 'auto')`);
  const base = Date.now() - 60 * 86400000;
  await wiki.saveViews(pool, 'GameStop', Array.from({ length: 59 }, (_, i) => ({ day: new Date(base + i * 86400000).toISOString().slice(0, 10), views: 1000 + (i % 7) * 20 })));
  const { body } = await agent.get('/api/rave/stocks').expect(200);
  const gme = body.find((s) => s.ticker === 'GME');
  assert.equal(gme.wiki.article, 'GameStop');
  assert.equal(gme.wiki.scores.short.status, 'ok');
  assert.equal(gme.wiki.views.now, 1000 + (58 % 7) * 20, 'latest full day of page views');
  assert.equal(gme.wiki.views.before, 1000 + (57 % 7) * 20);
  assert.equal(gme.kind, 'company');
  assert.match(['none', 'reddit', 'wiki', 'both'].join(), new RegExp(gme.agreement));
  assert.equal(body.find((s) => s.ticker === 'GME').wiki.status, 'resolved');
  const one = await agent.get('/api/rave/stocks/GME').expect(200);
  assert.equal(one.body.wiki.article, 'GameStop');
  assert.ok(one.body.wiki.history.length >= 50);
});

test('run-now and diagnostics endpoints require sign-in, start jobs, and report probe results', async () => {
  const { agent } = await signedInAgent(app);
  await require('supertest')(app).post('/api/rave/jobs/wikipedia/run').expect(401);
  await agent.post('/api/rave/jobs/nope/run').expect(404);
  const { runDiagnostics } = require('../src/rave/diagnostics');
  const results = await runDiagnostics([], { fetchImpl: async (url) => resp(url.includes('wikimedia') ? { items: [{ views: 5 }] } : url.includes('wikipedia.org') ? { query: { pages: [{ title: 'GameStop' }] } } : { results: [{}] }) });
  assert.deepEqual(results.slice(0, 3).map((r) => [r.source, r.ok]), [['apewisdom', true], ['wikipedia-api', true], ['wikimedia-pageviews', true]]);
  assert.deepEqual(results.slice(3).map((r) => r.source), ['yahoo-prices'], 'the price source is probed too');
  const blocked = await runDiagnostics([], { fetchImpl: async () => { const e = new Error('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; } });
  assert.ok(blocked.every((r) => !r.ok && /ENOTFOUND/.test(r.detail)));
});
