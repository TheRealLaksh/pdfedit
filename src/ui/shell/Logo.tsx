/** Same drawing as public/icon.svg: a page with a text cursor. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden focusable="false">
      <rect width="64" height="64" rx="14" fill="var(--accent)" />
      <g fill="none" stroke="var(--accent-text)" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 21h16M20 32h9M20 43h9" />
        <path d="M38 29h12M38 49h12M44 29v20" />
      </g>
    </svg>
  );
}
