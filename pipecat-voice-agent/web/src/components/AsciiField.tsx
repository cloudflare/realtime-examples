import clsx from 'clsx';
import { useEffect, useRef, type RefObject } from 'react';
import { resolveStageColor, rgbWithAlpha, stageFallbacks } from '../lib/canvas-theme';

/*
 * A field of monospace glyphs behind the stage. It sits still until a mouse
 * moves across it; then nearby cells brighten in the accent color and cycle
 * their glyphs, fading over about a second. The field thins out around the
 * orb and toward the edges, and is fully static under prefers-reduced-motion.
 */

// Spaces in the glyph set leave empty cells, so the field reads sparse.
const GLYPHS = '/ > < | _ : . 0 1 { }';
const CELL = 15;
const FONT_SIZE = 12;
const TRAIL_RADIUS = 90;
const MAX_AGE = 70;
const MAX_TRAIL = 60;
const MIN_TRAIL_DISTANCE_SQUARED = 40;
const ACTIVE_OPACITY = 0.55;
// An extra mid stop keeps the edge fade from banding.
const MASK =
  'radial-gradient(ellipse 64% 70% at 50% 50%, black 30%, rgba(0,0,0,0.55) 62%, transparent 92%)';

export function AsciiField({
  focalElementRef,
  active = false,
}: {
  /** The element the field clears around, usually the orb. */
  focalElementRef?: RefObject<HTMLElement | null>;
  /** During a call the field drifts very slowly. */
  active?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    const pointerTarget = parent?.parentElement;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !parent || !pointerTarget || !ctx) return;

    const accent = resolveStageColor(canvas, '--stage-accent', stageFallbacks.accent);
    const ink = resolveStageColor(canvas, '--stage-ink', stageFallbacks.ink);
    const monoFont = getComputedStyle(canvas).fontFamily;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const desktop = window.matchMedia('(min-width: 1024px)');
    const dpr = Math.max(1, window.devicePixelRatio || 1);

    let width = 0;
    let height = 0;
    let columns = 0;
    let rows = 0;
    let total = 0;
    let cellX = new Float32Array(0);
    let cellY = new Float32Array(0);
    let seed = new Uint8Array(0);
    let influence = new Float32Array(0);
    let focalX = 0;
    let focalY = 0;

    const locateFocalPoint = () => {
      const rect = parent.getBoundingClientRect();
      const focal = focalElementRef?.current?.getBoundingClientRect();
      focalX = focal ? focal.left - rect.left + focal.width / 2 : width / 2;
      focalY = focal ? focal.top - rect.top + focal.height / 2 : height / 2;
    };

    const build = () => {
      const rect = parent.getBoundingClientRect();
      width = Math.round(rect.width);
      height = Math.round(rect.height);
      if (width === 0 || height === 0) return;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      columns = Math.ceil(width / CELL) + 1;
      rows = Math.ceil(height / CELL) + 1;
      total = columns * rows;
      cellX = new Float32Array(total);
      cellY = new Float32Array(total);
      seed = new Uint8Array(total);
      influence = new Float32Array(total);
      locateFocalPoint();
      for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
          const index = row * columns + column;
          cellX[index] = column * CELL + CELL / 2;
          cellY[index] = row * CELL + CELL / 2;
          seed[index] = Math.floor(Math.random() * GLYPHS.length);
        }
      }
    };

    const trail: { x: number; y: number; birth: number }[] = [];
    let lastX = -9e3;
    let lastY = -9e3;
    let frameCount = 0;
    let raf = 0;
    let looping = false;

    const paint = () => {
      if (width === 0 || height === 0) return;
      ctx.clearRect(0, 0, width, height);
      ctx.font = `${FONT_SIZE}px ${monoFont}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const radiusSquared = TRAIL_RADIUS * TRAIL_RADIUS;
      const reach = Math.hypot(width, height) / 2;

      influence.fill(0);
      for (const point of trail) {
        const age = frameCount - point.birth;
        if (age > MAX_AGE) continue;
        const decay = age / MAX_AGE;
        const minColumn = Math.max(0, Math.floor((point.x - TRAIL_RADIUS) / CELL));
        const maxColumn = Math.min(columns - 1, Math.ceil((point.x + TRAIL_RADIUS) / CELL));
        const minRow = Math.max(0, Math.floor((point.y - TRAIL_RADIUS) / CELL));
        const maxRow = Math.min(rows - 1, Math.ceil((point.y + TRAIL_RADIUS) / CELL));
        for (let row = minRow; row <= maxRow; row++) {
          for (let column = minColumn; column <= maxColumn; column++) {
            const index = row * columns + column;
            const dx = cellX[index] - point.x;
            const dy = cellY[index] - point.y;
            const distanceSquared = dx * dx + dy * dy;
            if (distanceSquared > radiusSquared) continue;
            const nearness = 1 - Math.sqrt(distanceSquared) / TRAIL_RADIUS;
            const value = nearness ** (1 + decay * 5) * (1 - decay * decay);
            if (value > influence[index]) influence[index] = value;
          }
        }
      }

      for (let index = 0; index < total; index++) {
        const x = cellX[index];
        const y = cellY[index];
        const distance = Math.hypot(x - focalX, y - focalY);
        // Cells clear out near the focal point and fade toward the edges.
        const clearing = Math.min(1, distance / (reach * 0.3));
        const edge = 1 - Math.min(1, Math.max(0, (distance - reach * 0.34) / (reach * 0.66)));
        const baseAlpha = 0.06 * clearing * edge;

        let glyphIndex = seed[index];
        let color = ink;
        let alpha = baseAlpha;
        const lift = influence[index];
        if (lift > 0.25) {
          glyphIndex = (seed[index] + Math.floor(frameCount * 0.06 + lift * 2)) % GLYPHS.length;
          color = accent;
          alpha = baseAlpha + lift * (ACTIVE_OPACITY - baseAlpha);
        }
        const glyph = GLYPHS[glyphIndex];
        if (glyph === ' ' || alpha < 0.01) continue;
        ctx.fillStyle = rgbWithAlpha(color, alpha);
        ctx.fillText(glyph, x, y);
      }
    };

    const tick = () => {
      frameCount++;
      while (trail.length > 0 && frameCount - trail[0].birth > MAX_AGE) trail.shift();
      paint();
      if (trail.length > 0) {
        raf = requestAnimationFrame(tick);
      } else {
        looping = false;
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!desktop.matches || event.pointerType !== 'mouse') return;
      const rect = parent.getBoundingClientRect();
      locateFocalPoint();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const dx = x - lastX;
      const dy = y - lastY;
      if (dx * dx + dy * dy <= MIN_TRAIL_DISTANCE_SQUARED) return;
      trail.push({ x, y, birth: frameCount });
      if (trail.length > MAX_TRAIL) trail.shift();
      lastX = x;
      lastY = y;
      if (!looping) {
        looping = true;
        raf = requestAnimationFrame(tick);
      }
    };
    const onPointerLeave = () => {
      lastX = -9e3;
      lastY = -9e3;
    };

    build();
    paint();
    if (!reduce) {
      pointerTarget.addEventListener('pointermove', onPointerMove);
      pointerTarget.addEventListener('pointerleave', onPointerLeave);
    }
    const observer = new ResizeObserver(() => {
      build();
      if (!looping) paint();
    });
    observer.observe(parent);
    if (focalElementRef?.current) observer.observe(focalElementRef.current);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
      pointerTarget.removeEventListener('pointermove', onPointerMove);
      pointerTarget.removeEventListener('pointerleave', onPointerLeave);
    };
  }, [focalElementRef]);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-[inherit]"
    >
      <canvas
        ref={canvasRef}
        className={clsx(
          'ascii-field absolute inset-0 font-mono transition-transform duration-[60s] ease-linear motion-reduce:transition-none',
          active ? 'scale-110 rotate-3' : 'scale-100 rotate-0',
        )}
        style={{ maskImage: MASK, WebkitMaskImage: MASK }}
      />
    </div>
  );
}
