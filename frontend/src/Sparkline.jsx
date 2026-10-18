// Tiny inline trend line (no axes) for table rows
export default function Sparkline({ values, width = 96, height = 28 }) {
  if (!values || values.length < 2) return <span className="muted">—</span>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * (width - 2) + 1).toFixed(1)},${(height - 3 - ((v - min) / span) * (height - 6)).toFixed(1)}`);
  const rising = values[values.length - 1] >= values[0];
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="last 24 hours of mentions">
      <polyline points={pts.join(' ')} fill="none" stroke={rising ? 'var(--ok)' : 'var(--accent-2)'} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={pts[pts.length - 1].split(',')[0]} cy={pts[pts.length - 1].split(',')[1]} r="2.2" fill={rising ? 'var(--ok)' : 'var(--accent-2)'} />
    </svg>
  );
}
