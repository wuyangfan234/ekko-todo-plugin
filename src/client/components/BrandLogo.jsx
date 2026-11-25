/**
 * Ekko ToDo brand mark — 01 间隔 / Interval.
 * Two precise brackets frame a solid task block; currentColor follows the host theme.
 */
export function BrandLogo({ size = 20, className = '' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      className={className}
      aria-hidden="true"
      style={{ flex: 'none', display: 'block' }}
    >
      <g fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="square" strokeLinejoin="miter">
        <path d="M33 18H19V82H33" />
        <path d="M67 18H81V82H67" />
      </g>
      <rect x="43" y="43" width="14" height="14" fill="currentColor" />
    </svg>
  )
}
