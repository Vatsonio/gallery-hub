interface Point {
  date: string;
  count: number;
}

interface Props {
  points: Point[];
  /** A11y label. */
  label: string;
  width?: number;
  height?: number;
}

/**
 * 30-bar sparkline rendered as pure SVG. Each day gets one thin vertical
 * bar with a smooth gradient fill; the most recent day sits at the right.
 * Server-rendered to keep the dashboard hydration cost near zero.
 */
export function MetricsSparkline({
  points,
  label,
  width = 600,
  height = 80,
}: Props): React.JSX.Element {
  const max = Math.max(1, ...points.map((p) => p.count));
  const n = points.length;
  const slot = n > 0 ? width / n : width;
  const barW = Math.max(2, Math.floor(slot * 0.7));
  const gap = slot - barW;
  const gradientId = "metrics-spark-fill";

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="w-full h-full"
      role="img"
      aria-label={label}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#ff4d6d" stopOpacity="0.6" />
          <stop offset="100%" stopColor="#ff4d6d" stopOpacity="0.15" />
        </linearGradient>
      </defs>
      {points.map((p, i) => {
        const h = (p.count / max) * (height - 4);
        const x = i * slot + gap / 2;
        const y = height - h;
        return (
          <rect
            key={p.date}
            x={x.toFixed(2)}
            y={y.toFixed(2)}
            width={barW.toFixed(2)}
            height={Math.max(1, h).toFixed(2)}
            fill={`url(#${gradientId})`}
            rx="1"
          >
            <title>{`${p.date} · ${p.count}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}
