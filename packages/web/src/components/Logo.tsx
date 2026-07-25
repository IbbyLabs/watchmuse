import type { SVGProps } from 'react';

/**
 * Watchmuse logomark: a play glyph with a curation sparkle on a violet tile —
 * "watch" + the recommended pick. Doubles as the app's favicon (see
 * public/favicon.svg — keep the two in sync).
 */
export function Logo({ className = 'h-7 w-7', title, ...props }: SVGProps<SVGSVGElement> & { title?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      {...props}
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <linearGradient id="wm-logo-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#9d5cf0" />
          <stop offset="1" stopColor="#7c3aed" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#wm-logo-grad)" />
      {/* Play triangle — rounded, sitting left of centre. */}
      <path d="M11 9.8 21 16 11 22.2Z" fill="#fff" stroke="#fff" strokeWidth="2.4" strokeLinejoin="round" />
      {/* Four-point curation sparkle, upper-right. */}
      <path
        d="M24.5 5.4c.5 2.4 1.2 3.1 3.6 3.6-2.4.5-3.1 1.2-3.6 3.6-.5-2.4-1.2-3.1-3.6-3.6 2.4-.5 3.1-1.2 3.6-3.6Z"
        fill="#fff"
      />
    </svg>
  );
}
