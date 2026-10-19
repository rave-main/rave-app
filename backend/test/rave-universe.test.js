const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, resetRave } = require('./helpers');
const { parseIndexTable, runUniverse } = require('../src/rave/universe');

let pool;
before(async () => ({ pool } = await setup()));
after(() => pool.end());

// Shaped like Wikipedia's constituents table (first cell: ticker link, second: company link), plus a decoy table
const row = (t, name, article, sector = 'Industrials') => `<tr>\n<td><a rel="nofollow" class="external text" href="https://www.nyse.com/quote/XNYS:${t}">${t}</a>\n</td>\n<td><a href="/wiki/${encodeURIComponent((article || name).replace(/ /g, '_'))}" title="${article || name}">${name}</a></td>\n<td>${sector}</td>\n</tr>`;
const table = (rows) => `<table class="wikitable sortable"><tbody><tr><th>Symbol</th><th>Security</th><th>Sector</th></tr>${rows.join('\n')}</tbody></table>`;
const page = (rows) => `<div><table class="wikitable"><tr><td>Date</td><td>Added</td></tr><tr><td>2020</td><td>X</td></tr></table>${table(rows)}</div>`;

test('the constituents table is found among other tables, with tickers, names, articles and sectors', () => {
  const rows = parseIndexTable(page([
    row('MMM', '3M', '3M'), row('BRK.B', 'Berkshire Hathaway', 'Berkshire Hathaway', 'Financials'),
    row('JNJ', 'Johnson &amp; Johnson', 'Johnson & Johnson', 'Health Care'),
    '<tr><td><a>ZZZ</a></td><td><a href="/w/index.php?title=Nothing&amp;redlink=1" class="new">Nothing Inc.</a></td><td>X</td></tr>',
  ]));
  assert.deepEqual(rows.map((r) => r.ticker), ['MMM', 'BRK.B', 'JNJ', 'ZZZ']);
  assert.equal(rows[2].name, 'Johnson & Johnson');
  assert.equal(rows[2].article, 'Johnson & Johnson');
  assert.equal(rows[3].article, null, 'a red link means no article');
  assert.equal(rows[1].sector, 'Financials');
});

const fakeWikipedia = (counts) => async (url) => {
  const name = decodeURIComponent(url.match(/page=([^&]+)/)[1]);
  const n = counts[name] ?? 0;
  const prefix = name.includes('500') ? 'A' : name.includes('400') ? 'B' : 'C';
  const html = page(Array.from({ length: n }, (_, i) => row(`${prefix}${i}`, `Company ${prefix} ${i}`)));
  return { ok: true, status: 200, json: async () => ({ parse: { text: html } }), text: async () => '' };
};

test('the universe job saves each list, puts the articles in the Wikipedia mapping, and refreshes weekly', async () => {
  await resetRave(pool);
  await pool.query('DELETE FROM universe');
  const fetchImpl = fakeWikipedia({ 'List_of_S&P_500_companies': 120, 'List_of_S&P_400_companies': 110, 'List_of_S&P_600_companies': 105 });
  const first = await runUniverse(pool, { fetchImpl });
  assert.equal(first.total, 335);
  const { rows: [c] } = await pool.query('SELECT count(*)::int AS n, count(DISTINCT index_name)::int AS lists FROM universe');
  assert.equal(c.lists, 3);
  assert.equal(c.n, 335);
  const { rows: [w] } = await pool.query(`SELECT count(*)::int AS n FROM wiki_pages WHERE source = 'index' AND status = 'resolved'`);
  assert.equal(w.n, c.n);
  const again = await runUniverse(pool, { fetchImpl });
  assert.equal(again.skipped, 'refreshed recently');
  await assert.rejects(runUniverse(pool, { fetchImpl: fakeWikipedia({}), force: true }), /no index list could be read/);
});

test('a manual Wikipedia choice is never replaced by the index list', async () => {
  await resetRave(pool);
  await pool.query('DELETE FROM universe');
  await pool.query(`INSERT INTO wiki_pages (ticker, article, status, confidence, source) VALUES ('A0', 'My choice', 'override', 'manual', 'override')`);
  await runUniverse(pool, { fetchImpl: fakeWikipedia({ 'List_of_S&P_500_companies': 120, 'List_of_S&P_400_companies': 120, 'List_of_S&P_600_companies': 120 }), force: true });
  const { rows: [m] } = await pool.query(`SELECT article, source FROM wiki_pages WHERE ticker = 'A0'`);
  assert.deepEqual([m.article, m.source], ['My choice', 'override']);
});
