// Brand name, not translated.
const BRAND = ["Prompt", "Flow"] as const;

/** The PromptFlow wordmark: a gradient voice orb and the name. */
const HandyTextLogo = ({
  width,
  height,
  className,
}: {
  width?: number;
  height?: number;
  className?: string;
}) => (
  <svg
    width={width}
    height={height}
    className={className}
    viewBox="0 0 640 128"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    role="img"
    aria-label="PromptFlow"
  >
    <defs>
      <linearGradient id="pf-logo-grad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#8B7CFF" />
        <stop offset="1" stopColor="#FF6FB5" />
      </linearGradient>
    </defs>
    <circle cx="64" cy="64" r="56" fill="url(#pf-logo-grad)" />
    {[
      [36, 22],
      [50, 40],
      [64, 56],
      [78, 40],
      [92, 22],
    ].map(([x, h]) => (
      <rect
        key={x}
        x={x - 5}
        y={64 - h / 2}
        width="10"
        height={h}
        rx="5"
        fill="#fff"
      />
    ))}
    <text
      x="144"
      y="88"
      fill="currentColor"
      fontFamily="ui-rounded, -apple-system, 'SF Pro Rounded', system-ui, sans-serif"
      fontSize="74"
      fontWeight="700"
      letterSpacing="-1.5"
    >
      {BRAND[0]}
      <tspan fill="url(#pf-logo-grad)">{BRAND[1]}</tspan>
    </text>
  </svg>
);

export default HandyTextLogo;
