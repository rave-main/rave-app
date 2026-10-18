const v = require('../src/rave/validation');

const DAY = 86400000;
const START = '2023-01-02'; // a Monday
const day = (i) => new Date(Date.parse(`${START}T00:00:00Z`) + i * DAY).toISOString().slice(0, 10);
const isWeekday = (i) => { const d = new Date(Date.parse(`${START}T00:00:00Z`) + i * DAY).getUTCDay(); return d !== 0 && d !== 6; };

function gauss(r) { return Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r()); }

// A synthetic market. Attention spikes at random days; `effect` decides what (if anything) prices do about it.
//   volMult / drift: applied on the 5 trading days starting `effectLag` calendar days after the spike day
//   sameDayVol: the stock also moves a lot ON the spike day itself (news moves both; not tradable)
//   attentionFollowsPrice: attention spikes the day AFTER a big price move instead of leading it
function world({ tickers = 30, days = 1100, seed = 1, effect = {}, attentionFollowsPrice = false }) {
  const r = v.makeRng(seed);
  const trading = Array.from({ length: days }, (_, i) => i).filter(isWeekday);
  const mkt = trading.map(() => 0.0003 + 0.009 * gauss(r));
  const mktByDay = new Map(trading.map((d, k) => [d, mkt[k]]));
  const benchClose = [];
  let b = 100;
  const bench = trading.map((d, k) => { const open = b * (1 + 0.3 * mkt[k]); b *= 1 + mkt[k]; benchClose.push(b); return { day: day(d), open, close: b, volume: 1e8 }; });

  const series = [];
  for (let t = 0; t < tickers; t++) {
    const spikeAt = new Set();
    const attn = Array.from({ length: days }, (_, i) => Math.round(1500 * (i % 7 >= 5 ? 0.7 : 1) * Math.exp(0.12 * gauss(r))));
    for (let i = 40; i < days - 30; i++) {
      if (!attentionFollowsPrice && r() < 1 / 55) {
        spikeAt.add(i);
        const len = 1 + Math.floor(r() * 3);
        const mult = 3 + 3 * r();
        for (let k = 0; k < len; k++) attn[i + k] = Math.round(attn[i + k] * mult);
      }
    }
    // idiosyncratic returns, with the effect injected
    const idio = trading.map(() => 0.015 * gauss(r));
    const volume = trading.map(() => 1e6 * Math.exp(0.15 * gauss(r)));
    const tIndex = new Map(trading.map((d, k) => [d, k]));
    // first trading day on/after calendar day `cal`; past the end of the data there is none (no effect is injected)
    const firstTradingFrom = (cal) => { let c = cal; while (c < days && !tIndex.has(c)) c++; return c < days ? tIndex.get(c) : trading.length; };
    for (const s of spikeAt) {
      if (effect.sameDayVol && tIndex.has(s)) idio[tIndex.get(s)] *= effect.sameDayVol;
      const e0 = firstTradingFrom(s + (effect.lag ?? 2));
      for (let k = 0; k < 5 && e0 + k < trading.length; k++) {
        if (effect.volMult) { idio[e0 + k] *= effect.volMult; volume[e0 + k] *= 1 + (effect.volMult - 1) * 0.5; }
        if (effect.drift) idio[e0 + k] += effect.drift;
      }
    }
    if (attentionFollowsPrice) {
      for (let k = 1; k < trading.length - 3; k++) {
        if (Math.abs(idio[k]) > 2.2 * 0.015 && r() < 0.9) {
          const a = trading[k] + 1;
          for (let q = 0; q < 2 && a + q < days; q++) attn[a + q] = Math.round(attn[a + q] * 4);
        }
      }
    }
    let close = 50;
    const prices = trading.map((d, k) => {
      const ret = 1.1 * mkt[k] + idio[k];
      const open = close * (1 + 0.3 * ret);
      close *= 1 + ret;
      return { day: day(d), open, close, volume: volume[k] * (1 + 4 * Math.abs(idio[k])) };
    });
    series.push({ ticker: `S${t}`, startDay: START, values: attn, prices, spikes: [...spikeAt] });
  }
  return { series, bench };
}


module.exports = { world, START, day, isWeekday, gauss };
