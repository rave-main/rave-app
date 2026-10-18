// Small text helpers shared by the collector, the Wikipedia matcher and the API.
const ENTITIES = { '&amp;': '&', '&quot;': '"', '&lt;': '<', '&gt;': '>', '&apos;': "'", '&#39;': "'", '&#039;': "'" };

// ApeWisdom sends HTML entities in names ("Vanguard S&amp;P 500 ETF"); store and show the plain text
const decodeEntities = (t) => String(t).replace(/&(?:amp|quot|lt|gt|apos|#0?39);/g, (m) => ENTITIES[m]);

// A name for people: entities decoded, spaces tidied, and a fund-family prefix dropped
// ("Invesco Capital Management LLC - Invesco S&P 500 Momentum ETF" -> "Invesco S&P 500 Momentum ETF")
function displayName(name, ticker = '') {
  if (!name) return ticker;
  const plain = decodeEntities(name).replace(/\s+/g, ' ').trim();
  const parts = plain.split(' - ');
  return (parts.length > 1 && parts[parts.length - 1].length >= 8 ? parts[parts.length - 1] : plain) || ticker;
}

module.exports = { decodeEntities, displayName };
