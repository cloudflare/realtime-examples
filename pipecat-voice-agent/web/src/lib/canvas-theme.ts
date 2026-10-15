/*
 * Helpers for the orb's canvas drawing. A canvas cannot read Tailwind
 * classes, so colors come from the custom properties that `.orb` declares
 * in styles.css.
 */

export type RgbColor = readonly [red: number, green: number, blue: number];

/** Fallbacks matching the palette, used only if a property fails to resolve. */
export const stageFallbacks = {
  accent: [255, 105, 0],
  ink: [250, 250, 249],
  inkSoft: [168, 162, 158],
} satisfies Record<string, RgbColor>;

let probe: CanvasRenderingContext2D | null | undefined;

/**
 * Resolves a custom property into RGB components. Tailwind's palette is
 * defined in OKLCH, which the canvas API cannot modulate directly, so the
 * browser converts it: assigning a color to `fillStyle` and reading it back
 * yields a normalized hex string.
 */
export function resolveStageColor(element: Element, property: string, fallback: RgbColor) {
  const value = getComputedStyle(element).getPropertyValue(property).trim();
  if (probe === undefined) probe = document.createElement('canvas').getContext('2d');
  if (!value || !probe) return fallback;
  probe.fillStyle = '#010203';
  probe.fillStyle = value;
  const hex = /^#([\da-f]{6})/i.exec(String(probe.fillStyle))?.[1];
  if (!hex || hex === '010203') return fallback;
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ] as const;
}

export function rgbWithAlpha([red, green, blue]: RgbColor, alpha: number) {
  return `rgb(${red} ${green} ${blue} / ${alpha})`;
}
