import type { ReactNode } from 'react';
import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  size,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';

export function AnchoredDialog({
  id,
  anchor,
  title,
  children,
  onClose,
  closeLabel = 'Close explanation',
}: {
  id: string;
  anchor: HTMLElement | null;
  title: ReactNode;
  children: ReactNode;
  onClose: () => void;
  closeLabel?: string;
}) {
  const { refs, floatingStyles, context } = useFloating({
    open: anchor !== null,
    onOpenChange: (open) => {
      if (!open) onClose();
    },
    elements: { reference: anchor },
    placement: 'bottom-start',
    strategy: 'fixed',
    middleware: [
      offset(10),
      flip({ padding: 12, fallbackPlacements: ['top-start', 'right-start', 'left-start'] }),
      shift({ padding: 12 }),
      size({
        padding: 12,
        apply({ availableHeight, elements }) {
          elements.floating.style.maxHeight = `${Math.max(120, availableHeight)}px`;
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  });
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'dialog' });
  const { getFloatingProps } = useInteractions([dismiss, role]);
  if (!anchor) return null;
  return (
    <FloatingPortal>
      <FloatingFocusManager
        context={context}
        modal={false}
        returnFocus
        initialFocus={refs.floating}
      >
        <section
          ref={refs.setFloating}
          style={floatingStyles}
          {...getFloatingProps()}
          id={id}
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-body`}
          tabIndex={-1}
          className="z-30 w-[min(390px,calc(100vw-24px))] overflow-y-auto overscroll-contain rounded-xl border border-line bg-leaf p-4 text-ink shadow-lg outline-none"
        >
          <h2
            id={`${id}-title`}
            className="pr-10 text-xl leading-7 font-medium tracking-tight wrap-anywhere"
          >
            {title}
          </h2>
          <button
            type="button"
            className="absolute top-2 right-2 inline-flex size-11 items-center justify-center rounded-md text-muted hover:bg-panel hover:text-ink active:bg-core"
            onClick={onClose}
            aria-label={closeLabel}
          >
            <span aria-hidden="true" className="text-2xl leading-none">
              ×
            </span>
          </button>
          <div
            id={`${id}-body`}
            className="mt-2 text-sm leading-relaxed wrap-anywhere text-muted empty:mt-0"
          >
            {children}
          </div>
        </section>
      </FloatingFocusManager>
    </FloatingPortal>
  );
}
