import type { ReactNode } from 'react';
import { Icon } from '@/client/ui/icons.tsx';
import { anchors, branchStyles } from './diagram/diagram-model.ts';
import type { Branch, ExplanationTrigger } from './diagram/diagram-model.ts';

type HeadingProps = ExplanationTrigger & {
  branch: Branch;
  title: string;
  caption: string;
  live: boolean;
};

/** Common branch layout; each panel supplies its own controls and content. */
export function BranchPanel({
  children,
  label,
  ...heading
}: HeadingProps & { label: string; children: ReactNode }) {
  const { branch, expanded } = heading;
  return (
    <section
      data-anchor={anchors.receivers[branch]}
      className={`relative rounded-lg border border-line bg-leaf p-4 shadow-xs sm:p-5 before:absolute before:top-9 before:-left-3.5 before:h-px before:w-3.5 before:bg-(--branch) sm:before:-left-[18px] sm:before:w-[18px] lg:before:hidden ${branchStyles[branch].variable} ${expanded ? 'border-(--branch)' : ''}`}
      aria-label={label}
    >
      <BranchHeading {...heading} />
      {children}
    </section>
  );
}

function BranchHeading({ branch, title, caption, expanded, onSelect, live }: HeadingProps) {
  return (
    <div className="mb-3.5 flex items-center justify-between gap-2">
      <button
        className="flex min-h-10 items-center gap-2 text-left sm:gap-2.5 [&_h2]:text-base [&_h2]:font-medium [&_h2]:leading-tight [&_h2]:tracking-tight sm:[&_h2]:text-lg"
        aria-haspopup="dialog"
        aria-expanded={expanded}
        aria-controls={expanded ? 'signal-detail' : undefined}
        onClick={(event) => onSelect(event.currentTarget)}
      >
        <span
          className={`flex size-7 shrink-0 items-center justify-center rounded-md bg-[color-mix(in_oklch,var(--branch)_8%,transparent)] text-(--branch) sm:size-8 `}
        >
          <Icon name={branchStyles[branch].icon} />
        </span>
        <span>
          <h2>{title}</h2>
          <span className="mt-1 block font-mono text-[8px] tracking-wide text-muted">
            {caption}
          </span>
        </span>
        <span className="text-sm text-muted" aria-hidden="true">
          ↗
        </span>
      </button>
      <span
        className={`flex items-center gap-1 font-mono text-[8px] whitespace-nowrap text-muted [&_i]:size-1 [&_i]:rounded-full [&_i]:bg-current ${live ? 'text-(--branch)' : ''}`}
      >
        <i />
        {live ? 'LIVE' : 'IDLE'}
      </span>
    </div>
  );
}
