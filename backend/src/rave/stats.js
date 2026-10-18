// Small robust-statistics helpers shared by scoring and (later) validation
function median(values) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Median absolute deviation, scaled (x1.4826) to match a standard deviation for normal data
function scaledMad(values) {
  const m = median(values);
  return 1.4826 * median(values.map((v) => Math.abs(v - m)));
}

module.exports = { median, scaledMad };
