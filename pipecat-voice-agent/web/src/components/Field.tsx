import clsx from 'clsx';
import { ChevronDown } from 'lucide-react';
import type { SelectHTMLAttributes } from 'react';

/**
 * Shared text input, select, and textarea styling. Padding and line height
 * give a 46px field without a min-height, so textareas need no override.
 * Set `aria-invalid` for the error border; callers should not pass conflicting
 * utilities, since Tailwind resolves duplicates by stylesheet order.
 */
export const fieldClass =
  'w-full min-w-0 rounded-lg border border-stone-500 bg-white px-3.5 py-2.5 text-base text-stone-900 shadow-xs placeholder:text-stone-500 enabled:hover:border-stone-600 aria-invalid:border-red-700 disabled:cursor-not-allowed disabled:border-stone-300 disabled:bg-stone-100 disabled:text-stone-500';

/**
 * A native select with our own indicator. Browsers draw the built-in arrow
 * flush against the edge, so it is hidden and replaced by a chevron that sits
 * inside the field's padding.
 */
export function Select({
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { className?: string }) {
  return (
    <span className={clsx('relative block', className)}>
      <select {...props} className={clsx(fieldClass, 'appearance-none pr-10')} />
      <ChevronDown
        className="pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2 text-stone-600"
        aria-hidden="true"
      />
    </span>
  );
}
