// Some companies list several share classes under different tickers (GOOGL and GOOG are both Alphabet). They are
// one company, so the Radar shows them as ONE row: mentions are added together and the first ticker in the group
// (the "main" ticker) carries the Wikipedia article and price. Groups are found two ways:
//  1. the same company name on the leaderboard (after tidying), which catches pairs automatically;
//  2. a short list for pairs whose names differ.
const { displayName } = require('./text');

const KNOWN = [['GOOGL', 'GOOG'], ['BRK.B', 'BRK.A'], ['FOXA', 'FOX'], ['NWSA', 'NWS'], ['LEN', 'LEN.B'], ['UAA', 'UA']];

const norm = (name) => displayName(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// rows: [{ ticker, name, mentions }] -> Map(ticker -> mainTicker) only for tickers that belong to a group
function shareClassGroups(rows) {
  const present = new Set(rows.map((r) => r.ticker));
  const parent = new Map(rows.map((r) => [r.ticker, r.ticker]));
  const find = (t) => (parent.get(t) === t ? t : find(parent.get(t)));
  const join = (a, b) => { const [x, y] = [find(a), find(b)]; if (x !== y) parent.set(y, x); };

  const byName = new Map();
  for (const r of rows) {
    const key = norm(r.name);
    if (!key || key === r.ticker.toLowerCase()) continue;
    if (byName.has(key)) join(byName.get(key), r.ticker); else byName.set(key, r.ticker);
  }
  for (const group of KNOWN) {
    const here = group.filter((t) => present.has(t));
    for (const t of here.slice(1)) join(here[0], t);
  }
  const groups = new Map();
  for (const r of rows) {
    const root = find(r.ticker);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(r.ticker);
  }
  const out = new Map();
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const known = KNOWN.find((g) => g.some((t) => members.includes(t)));
    const ordered = [...members].sort((a, b) => {
      const ia = known ? known.indexOf(a) : -1, ib = known ? known.indexOf(b) : -1;
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.length - b.length || a.localeCompare(b);
    });
    for (const t of ordered) out.set(t, ordered);
  }
  return out; // ticker -> all members, main ticker first
}

module.exports = { shareClassGroups, KNOWN };
