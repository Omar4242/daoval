// The signature motif: an ECG waveform. Used as a quiet static divider throughout
// the app (matches the original), but can draw itself in once — like a monitor
// coming online — when `animate` is set. Reserved for the sign-in hero; everywhere
// else stays still, per "spend your boldness in one place."
export default function TraceRule({ animate = false, tall = false }) {
  const height = tall ? 40 : 14
  const points = tall
    ? '0,20 240,20 270,20 283,6 298,36 313,20 345,20 365,20 378,4 390,34 402,20 800,20'
    : '0,7 260,7 285,7 295,1 305,13 315,7 340,7 355,7 365,2 372,12 380,7 800,7'

  return (
    <svg
      className={`trace-rule${animate ? ' trace-rule--animate' : ''}`}
      style={{ height }}
      viewBox={`0 0 800 ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline
        points={points}
        fill="none"
        stroke="var(--primary)"
        strokeWidth={tall ? 2 : 1.4}
        strokeLinejoin="round"
        strokeLinecap="round"
        pathLength="1"
      />
    </svg>
  )
}
