import React from 'react';
import { BRAND } from '../branding';

/**
 * The crown crest. One definition so the mark cannot drift between the title
 * bar, the sign-in screen and anywhere else it appears.
 */
export const BrandCrest: React.FC<{ className?: string; glyphClassName?: string }> = ({
  className = 'size-6 rounded-md',
  glyphClassName = 'size-3.5',
}) => (
  <span
    aria-hidden="true"
    className={`${className} bg-gradient-to-br from-amber-400 via-amber-600 to-amber-700 flex items-center justify-center ring-1 ring-amber-300/40 shrink-0`}
  >
    <svg className={`${glyphClassName} text-black`} fill="currentColor" viewBox="0 0 24 24">
      <path d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm14 3c0 .6-.4 1-1 1H6c-.6 0-1-.4-1-1v-1h14v1z" />
    </svg>
  </span>
);

/** Two-tone wordmark: the lead half in white, the tail half in brand gold. */
export const BrandWordmark: React.FC<{ className?: string }> = ({
  className = 'text-[13px]',
}) => (
  <span className={`font-bold tracking-tight font-mono whitespace-nowrap ${className}`}>
    <span className="text-white">{BRAND.wordmark.lead}</span>
    <span className="text-primary">{BRAND.wordmark.tail}</span>
  </span>
);

/**
 * The full brand lockup.
 * - `sm`: crest beside the wordmark (window chrome).
 * - `md`: stacked and centered, for the sign-in / sign-up screen.
 */
export const BrandMark: React.FC<{ size?: 'sm' | 'md'; className?: string }> = ({
  size = 'sm',
  className = '',
}) =>
  size === 'md' ? (
    <span className={`flex flex-col items-center gap-3 ${className}`}>
      <BrandCrest className="size-12 rounded-xl" glyphClassName="size-7" />
      <BrandWordmark className="text-lg" />
    </span>
  ) : (
    <span className={`flex items-center gap-2 ${className}`}>
      <BrandCrest />
      <BrandWordmark />
    </span>
  );
