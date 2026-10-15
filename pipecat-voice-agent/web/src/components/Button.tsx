import clsx from 'clsx';
import type { ButtonHTMLAttributes } from 'react';

// Disabled buttons fade to a pale tint of their own color instead of using
// opacity, so the label stays legible on any background.
const tones = {
  primary:
    'bg-orange-700 font-semibold text-white shadow-xs enabled:hover:bg-orange-800 disabled:bg-orange-50 disabled:text-orange-800 disabled:shadow-none',
  neutral:
    'border border-stone-300 bg-white text-stone-900 shadow-xs enabled:hover:bg-stone-50 disabled:border-stone-200 disabled:text-stone-500 disabled:shadow-none',
  danger: 'bg-red-700 text-white enabled:hover:bg-red-800 disabled:bg-red-50 disabled:text-red-800',
  quiet:
    'text-stone-600 enabled:hover:bg-stone-100 enabled:hover:text-stone-900 disabled:text-stone-500',
} satisfies Record<string, string>;

const sizes = {
  md: 'min-h-11 px-4 py-2 text-sm',
  sm: 'min-h-9 px-2.5 py-1.5 text-xs',
  icon: 'size-11 shrink-0',
} satisfies Record<string, string>;

/**
 * Use `tone` and `size` for appearance; `className` is for layout only
 * (width, margins). Overriding utilities through `className` is unreliable
 * because Tailwind resolves duplicates by stylesheet order.
 */
export function Button({
  tone = 'neutral',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: keyof typeof tones;
  size?: keyof typeof sizes;
}) {
  return (
    <button
      type="button"
      {...props}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed motion-reduce:transition-none',
        sizes[size],
        tones[tone],
        className,
      )}
    />
  );
}
