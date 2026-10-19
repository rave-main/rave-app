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

const changesTable = (rows) => `<table class="wikitable"><tbody><tr><th rowspan="2">Effective Date</th><th colspan="2">Added</th><th colspan="2">Removed</th><th rowspan="2">Reason</th></tr><tr><th>Ticker</th><th>Security</th><th>Ticker</th><th>Security</th></tr>${rows.join('')}</tbody></table>`;
const change = (date, at, an, rt, rn, rowspan = '') => `<tr>${date ? `<td${rowspan}>${date}</td>` : ''}<td>${at}</td><td>${an}</td><td>${rt}</td><td>${rn}</td><td>Market cap change</td></tr>`;

test('dates are read in the forms Wikipedia uses', () => {
  const { parseDate } = require('../src/rave/universe');
  assert.equal(parseDate('October 6, 2025'), '2025-10-06');
  assert.equal(parseDate('6 October 2025'), '2025-10-06');
  assert.equal(parseDate('2025-10-06'), '2025-10-06');
  assert.equal(parseDate('March 4, 2024[12]'), '2024-03-04');
  assert.equal(parseDate('Reason'), null);
});

test('the changes table gives who joined and who left and when, and a date shared by two rows applies to both', () => {
  const { parseChanges } = require('../src/rave/universe');
  const html = changesTable([
    change('October 6, 2025', 'APP', 'AppLovin', 'QRVO', 'Qorvo', ' rowspan="2"'),
    change('', 'EME', 'Emcor', 'ENPH', 'Enphase Energy'),
    change('June 2, 2023', '', '', 'XYZ', 'Gone Inc.'),
  ]);
  assert.deepEqual(parseChanges(html).map((c) => [c.day, c.added, c.removed]), [['2025-10-06', 'APP', 'QRVO'], ['2025-10-06', 'EME', 'ENPH'], ['2023-06-02', null, 'XYZ']]);
});

test('the job keeps companies that left as inactive rows, dates the joiners, and does not treat a promotion as a departure', async () => {
  await resetRave(pool);
  await pool.query('DELETE FROM universe');
  const pageOf = (prefix, n, changes) => page(Array.from({ length: n }, (_, i) => row(`${prefix}${i}`, `Company ${prefix} ${i}`))) + changesTable(changes);
  const fetchImpl = async (url) => {
    const name = decodeURIComponent(url.match(/page=([^&]+)/)[1]);
    const html = name.includes('500')
      ? pageOf('A', 120, [change('May 1, 2024', 'A5', 'Company A 5', 'GONE1', 'Gone One'), change('June 1, 2022', 'A6', 'Company A 6', 'B9', 'Company B 9'), change('May 1, 2018', 'A7', 'x', 'OLD', 'Old')])
      : name.includes('400') ? pageOf('B', 110, [change('January 5, 2023', 'B3', 'Company B 3', 'GONE2', 'Gone Two')]) : pageOf('C', 105, []);
    return { ok: true, status: 200, json: async () => ({ parse: { text: html } }), text: async () => '' };
  };
  const d = await runUniverse(pool, { fetchImpl, force: true });
  assert.equal(d.changes.sp500.found, 3);
  const get = async (t) => (await pool.query('SELECT active, added_day::text AS "addedDay", removed_day::text AS "removedDay", index_name FROM universe WHERE ticker = $1', [t])).rows[0];
  assert.deepEqual(await get('GONE1'), { active: false, addedDay: null, removedDay: '2024-05-01', index_name: 'sp500' });
  assert.equal((await get('GONE2')).removedDay, '2023-01-05');
  assert.equal((await get('A5')).addedDay, '2024-05-01');
  assert.equal((await get('A7')).addedDay, null, 'a change before 2021 is not used');
  assert.deepEqual(await get('B9'), { active: true, addedDay: null, removedDay: null, index_name: 'sp400' }, 'B9 is in the 400 now: leaving the 500 earlier must not remove it');
});
