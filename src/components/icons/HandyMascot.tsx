/** PromptFlow's mascot: the voice orb (same box as the old glove so layouts hold). */
const HandyMascot = ({ className = "" }: { className?: string }) => (
  <svg
    className={className}
    viewBox="0 0 151 165"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <defs>
      <linearGradient id="pf-orb-grad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#8B7CFF" />
        <stop offset="1" stopColor="#FF6FB5" />
      </linearGradient>
    </defs>
    <circle cx="75.5" cy="82.5" r="70" fill="url(#pf-orb-grad)" />
    {[
      [41, 26],
      [58, 50],
      [75.5, 72],
      [93, 50],
      [110, 26],
    ].map(([x, h]) => (
      <rect
        key={x}
        x={x - 6}
        y={82.5 - h / 2}
        width="12"
        height={h}
        rx="6"
        fill="#fff"
      />
    ))}
  </svg>
);

export default HandyMascot;
