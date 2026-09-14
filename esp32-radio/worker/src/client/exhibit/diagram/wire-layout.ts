import { BRANCHES } from './diagram-model.ts';
import type { Branch } from './diagram-model.ts';

export type Point = { x: number; y: number };
export type BranchPoints = { source: Point; relayIn: Point; relayOut: Point; receiver: Point };
export type Wire = { branch: Branch | 'wifi'; segment: 'source' | 'receiver'; d: string };
export type WireLayout =
  | { mode: 'desktop'; branches: Record<Branch, BranchPoints> }
  | { mode: 'mobile'; source: Point; relay: Point; boardBottom: number };

/** Coordinates are relative to the diagram's inner border, independent of DOM measurement. */
export function layoutWires(layout: WireLayout): Wire[] {
  if (layout.mode === 'mobile') {
    const { source, relay, boardBottom } = layout;
    const gutter = source.x + 10,
      lane = boardBottom + 18,
      radius = 6;
    // Route through the gap beside the PCB, then below the core labels.
    return [
      {
        branch: 'wifi',
        segment: 'source',
        d: `M ${source.x} ${source.y} H ${gutter - radius} Q ${gutter} ${source.y} ${gutter} ${source.y + radius} V ${lane - radius} Q ${gutter} ${lane} ${gutter + radius} ${lane} H ${relay.x - radius} Q ${relay.x} ${lane} ${relay.x} ${lane + radius} V ${relay.y}`,
      },
    ];
  }
  const curve = (a: Point, b: Point) => {
    const midpoint = (a.x + b.x) / 2;
    return `M ${a.x} ${a.y} C ${midpoint} ${a.y}, ${midpoint} ${b.y}, ${b.x} ${b.y}`;
  };
  return BRANCHES.flatMap((branch): Wire[] => {
    const points = layout.branches[branch];
    return [
      { branch, segment: 'source', d: curve(points.source, points.relayIn) },
      { branch, segment: 'receiver', d: curve(points.relayOut, points.receiver) },
    ];
  });
}
