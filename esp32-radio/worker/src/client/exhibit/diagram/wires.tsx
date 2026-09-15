import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import { anchors } from './diagram-model.ts';
import type { Branch, Selection } from './diagram-model.ts';
import { layoutWires } from './wire-layout.ts';
import type { BranchPoints, Point, Wire, WireLayout } from './wire-layout.ts';

function measureLayout(root: HTMLDivElement, desktop: boolean): WireLayout {
  const bounds = root.getBoundingClientRect();
  // The overlay starts inside the container border, like absolute children.
  const base = { left: bounds.left + root.clientLeft, top: bounds.top + root.clientTop };
  const rect = (anchor: string) => {
    const node = root.querySelector(`[data-anchor="${anchor}"]`);
    if (!node) throw new Error(`Missing diagram anchor: ${anchor}`);
    return node.getBoundingClientRect();
  };
  const point = (anchor: string, edge: 'left' | 'right' | 'top'): Point => {
    const box = rect(anchor);
    return {
      x:
        (edge === 'top' ? box.left + box.width / 2 : edge === 'left' ? box.left : box.right) -
        base.left,
      y: (edge === 'top' ? box.top : box.top + box.height / 2) - base.top,
    };
  };
  if (!desktop)
    return {
      mode: 'mobile',
      source: point(anchors.wifi, 'right'),
      relay: point(anchors.sfuInput, 'top'),
      boardBottom: rect(anchors.board).bottom - base.top,
    };
  const branch = (name: Branch): BranchPoints => ({
    source: point(anchors.sources[name], 'right'),
    relayIn: point(anchors.relay[name], 'left'),
    relayOut: point(anchors.relay[name], 'right'),
    receiver: point(anchors.receivers[name], 'left'),
  });
  return {
    mode: 'desktop',
    branches: { audio: branch('audio'), spectrum: branch('spectrum'), robot: branch('robot') },
  };
}

export function Wires({
  container,
  active,
  selected,
  returning,
}: {
  container: RefObject<HTMLDivElement | null>;
  active: Record<Branch, boolean>;
  selected: Selection | null;
  returning: boolean;
}) {
  const [wires, setWires] = useState<Wire[]>([]);
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    // Keep the drawing's orientation aligned with Tailwind's lg breakpoint.
    const desktop = matchMedia('(min-width: 64rem)');
    const measure = () => setWires(layoutWires(measureLayout(root, desktop.matches)));
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    root.querySelectorAll('[data-anchor]').forEach((node) => observer.observe(node));
    desktop.addEventListener('change', measure);
    measure();
    return () => {
      observer.disconnect();
      desktop.removeEventListener('change', measure);
    };
  }, [container]);
  return (
    <svg className="wires" aria-hidden="true">
      {wires.map((wire) => {
        const lit =
          wire.branch === 'wifi' ? Object.values(active).some(Boolean) : active[wire.branch];
        const reverse = returning && (wire.branch === 'robot' || wire.branch === 'wifi');
        const dim =
          selected &&
          selected !== wire.branch &&
          wire.branch !== 'wifi' &&
          selected !== 'sfu' &&
          selected !== 'board';
        return (
          <g
            key={`${wire.branch}-${wire.segment}`}
            className={`wire wire-${wire.branch} ${dim ? 'wire-dim' : ''}`}
            data-wire={`${wire.branch}-${wire.segment}`}
          >
            <path d={wire.d} className="wire-track" />
            {lit || reverse ? (
              <path d={wire.d} className={`wire-flow ${reverse ? 'wire-return' : ''}`} />
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
