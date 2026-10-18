// What kind of listing is this? Funds behave differently from companies, and some tickers are ordinary words
// (A, IT, ALL, FOR) that ApeWisdom can mistake for a stock when people simply write the word in capitals.
const FUND_WORDS = /\b(etf|etn|etfs|fund|funds|trust|index|ishares|proshares|spdr|direxion|vaneck|wisdomtree|invesco|vanguard|leveraged|ultra(pro|short)?|2x|3x|bull|bear|daily|income shares|yieldmax|global x)\b/i;

const WORD_TICKERS = new Set([
  'A', 'ALL', 'ARE', 'BIG', 'CAN', 'CAR', 'CASH', 'COST', 'DD', 'DO', 'EAT', 'FOR', 'FREE', 'FUN', 'GO', 'GOOD', 'HAS', 'HE', 'HOLD', 'HOME',
  'IT', 'KEY', 'LOVE', 'LOW', 'MAN', 'MAY', 'ME', 'NEW', 'NOW', 'ON', 'ONE', 'OPEN', 'OR', 'OUT', 'PLAY', 'REAL', 'SAVE', 'SEE', 'SO', 'TRUE',
  'TV', 'UP', 'US', 'WELL', 'WORK', 'YOU', 'ANY', 'BE', 'BY', 'EDIT', 'FAST', 'FLY', 'HOT', 'LIFE', 'LIVE', 'MOVE', 'PEAK', 'RUN', 'TOP', 'WOW',
]);

function stockKind(ticker, name) {
  if (name && FUND_WORDS.test(name)) return 'etf';
  if (WORD_TICKERS.has(String(ticker).toUpperCase())) return 'ambiguous';
  return 'company';
}

module.exports = { stockKind, FUND_WORDS, WORD_TICKERS };
