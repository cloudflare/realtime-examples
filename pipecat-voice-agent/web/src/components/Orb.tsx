import clsx from 'clsx';
import { AudioLines, LoaderCircle } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type Ref } from 'react';
import { resolveStageColor, rgbWithAlpha, stageFallbacks } from '../lib/canvas-theme';
import type { StageView } from '../voice/model';

/*
 * The voice orb: a dotted globe drawn on a canvas, ringed by fine orange
 * ticks that open into an equalizer with the call audio. It is decorative;
 * the call controls live in the row under the stage. The canvas adopts its
 * colors from the Tailwind palette through the `.orb` custom properties in
 * styles.css, and it only animates while a call is live.
 */

const MIN_SIZE = 160;
const MAX_SIZE = 250;
// The sphere's radius as a share of the canvas; the glow and ticks use the rest.
const SPHERE_FRACTION = 0.36;
const GLOW_RADIUS = 1.38;
// The call measures levels with an 8x gain that suits the microphone meter.
// The globe was tuned for gentler input (2.6x for the person and 3.4x for the
// assistant), so levels are scaled back before they reach it.
const USER_LEVEL_SCALE = 2.6 / 8;
const AGENT_LEVEL_SCALE = 3.4 / 8;
// Caps the equalizer so loud input never swallows the rim.
const MAX_AMPLITUDE = 1.3;
// Below this the settling equalizer is flat enough to stop drawing.
const SETTLED_LEVEL = 0.004;

/** The animated globe. `getLevel` is read every frame, so audio never forces a render. */
function Globe({
  size,
  active,
  getLevel,
}: {
  size: number;
  active: boolean;
  getLevel: () => number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef(active);
  const getLevelRef = useRef(getLevel);
  const levelRef = useRef(0);
  const wakeRef = useRef(() => {});
  activeRef.current = active;
  getLevelRef.current = getLevel;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const R = canvas.width * SPHERE_FRACTION;
    const tilt = (-20 * Math.PI) / 180;
    const sinT = Math.sin(tilt);
    const cosT = Math.cos(tilt);

    const colors = {
      accent: resolveStageColor(canvas, '--stage-accent', stageFallbacks.accent),
      front: resolveStageColor(canvas, '--stage-ink', stageFallbacks.ink),
      back: resolveStageColor(canvas, '--stage-ink-soft', stageFallbacks.inkSoft),
    };

    const dots: number[][] = [];
    for (let lat = -76; lat <= 76; lat += 9) {
      const latR = (lat * Math.PI) / 180;
      const ring = Math.max(1, Math.round(Math.cos(latR) * 34));
      for (let i = 0; i < ring; i++) {
        const lon = (i / ring) * 2 * Math.PI;
        dots.push([Math.cos(latR) * Math.sin(lon), Math.sin(latR), Math.cos(latR) * Math.cos(lon)]);
      }
    }
    dots.push([0, 1, 0], [0, -1, 0]);

    const rotate = (p: number[], ry: number) => {
      const cyr = Math.cos(ry);
      const syr = Math.sin(ry);
      const x = p[0] * cyr + p[2] * syr;
      const z = -p[0] * syr + p[2] * cyr;
      return [x, p[1] * cosT - z * sinT, p[1] * sinT + z * cosT];
    };

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let raf = 0;
    let level = levelRef.current;
    // Rotation and wave phase accumulate only while frames run, so a still
    // frame looks the same before and after a call.
    let rotation = -0.5;
    let phase = 0;
    let lastTime: number | undefined;

    const draw = (live: boolean) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Rim glow.
      const glowRadius = R * GLOW_RADIUS;
      const glow = ctx.createRadialGradient(cx, cy, R * 0.86, cx, cy, glowRadius);
      glow.addColorStop(0, rgbWithAlpha(colors.accent, 0));
      glow.addColorStop(0.32, rgbWithAlpha(colors.accent, live ? 0.09 : 0.045));
      glow.addColorStop(1, rgbWithAlpha(colors.accent, 0));
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, cy, glowRadius, 0, 7);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';

      // Thin rim.
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.004, 0, 7);
      ctx.strokeStyle = rgbWithAlpha(colors.accent, live ? 0.62 : 0.52);
      ctx.lineWidth = 1.5 * dpr;
      ctx.stroke();

      // Sphere dots: brighter and larger toward the front.
      for (const p of dots) {
        const v = rotate(p, rotation);
        const x = cx + R * v[0];
        const y = cy - R * v[1];
        if (v[2] > 0) {
          const depth = 0.5 + v[2] * 0.5;
          ctx.fillStyle = rgbWithAlpha(colors.front, 0.13 + depth * 0.24);
          ctx.beginPath();
          ctx.arc(x, y, (0.7 + depth * 0.65) * dpr, 0, 7);
          ctx.fill();
        } else {
          ctx.fillStyle = rgbWithAlpha(colors.back, 0.06 + (1 - Math.abs(v[2])) * 0.12);
          ctx.beginPath();
          ctx.arc(x, y, 0.7 * dpr, 0, 7);
          ctx.fill();
        }
      }

      // A ring of ticks just outside the rim. Outside a call they lie flat;
      // a live call opens them into an equalizer that follows the audio.
      const bars = 90;
      const base = R * 1.06;
      const amp = Math.min(MAX_AMPLITUDE, (live ? 0.28 : 0.08) + level * 2.6);
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      for (let i = 0; i < bars; i++) {
        const angle = (i / bars) * Math.PI * 2 - Math.PI / 2;
        let wave =
          Math.sin(angle * 3 + phase * 0.0016) +
          0.6 * Math.sin(angle * 7 - phase * 0.0021) +
          0.4 * Math.sin(angle * 13 + phase * 0.0009);
        wave = wave / 2 + 0.5;
        const length = R * 0.03 + R * 0.24 * amp * Math.max(0.05, wave);
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        ctx.strokeStyle = rgbWithAlpha(colors.accent, 0.35 + (0.4 + level * 0.5) * wave);
        ctx.lineWidth = (1.5 + level * 1.5) * dpr;
        ctx.beginPath();
        ctx.moveTo(cx + c * base, cy + s * base);
        ctx.lineTo(cx + c * (base + length), cy + s * (base + length));
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
    };

    const frame = (time: number) => {
      raf = 0;
      const live = activeRef.current;
      const target = live ? Math.max(0.04, Math.min(1, getLevelRef.current())) : 0;
      level += (target - level) * 0.12;
      if (!live && level < SETTLED_LEVEL) level = 0;
      levelRef.current = level;
      const elapsed = lastTime === undefined ? 0 : time - lastTime;
      lastTime = time;
      phase += elapsed;
      if (live) rotation += elapsed * 0.00018;
      draw(live);
      // Frames continue only while the call is live or the ticks are still
      // settling after it; otherwise the globe rests on this still frame.
      if (!reducedMotion.matches && (live || level > 0)) {
        raf = requestAnimationFrame(frame);
      } else {
        lastTime = undefined;
      }
    };
    const wake = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };
    wakeRef.current = wake;
    reducedMotion.addEventListener('change', wake);
    frame(performance.now());

    return () => {
      wakeRef.current = () => {};
      reducedMotion.removeEventListener('change', wake);
      cancelAnimationFrame(raf);
    };
  }, [size]);

  // A call starting or ending wakes the loop so the globe follows it.
  useEffect(() => {
    wakeRef.current();
  }, [active]);

  return <canvas ref={canvasRef} className="orb block" style={{ width: size, height: size }} />;
}

/** Fits the globe to its container, so it scales with the stage. */
function useWidgetSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState(MAX_SIZE);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth;
      if (width > 0) setSize(Math.round(Math.min(MAX_SIZE, Math.max(MIN_SIZE, width))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

export function Orb({
  ref,
  controls,
  userLevel,
  agentLevel,
}: {
  /** Receives the globe's box, which the stage background clears around. */
  ref?: Ref<HTMLDivElement>;
  controls: StageView['controls'];
  /** 0..1 audio levels as the call reports them. */
  userLevel: number;
  agentLevel: number;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const size = useWidgetSize(frame);
  const levels = useRef({ user: userLevel, agent: agentLevel });
  levels.current = { user: userLevel, agent: agentLevel };
  const getLevel = () =>
    Math.max(levels.current.user * USER_LEVEL_SCALE, levels.current.agent * AGENT_LEVEL_SCALE);

  const inCall = controls === 'call';
  const busy = controls === 'cancel' || controls === 'ending';
  const iconSize = Math.round(size * 0.2);

  return (
    <div ref={frame} className="mb-5 flex w-full justify-center" aria-hidden="true">
      <div ref={ref} className="relative shrink-0" style={{ width: size, height: size }}>
        <Globe size={size} active={inCall || busy} getLevel={getLevel} />
        <div
          className={clsx(
            'absolute inset-0 flex items-center justify-center transition-colors duration-300 motion-reduce:transition-none',
            inCall ? 'text-orange-500' : busy ? 'text-stone-300' : 'text-stone-400',
          )}
        >
          {busy ? (
            <LoaderCircle
              className="motion-safe:animate-spin"
              style={{ width: iconSize, height: iconSize }}
              strokeWidth={1.5}
            />
          ) : (
            <AudioLines style={{ width: iconSize, height: iconSize }} strokeWidth={1.5} />
          )}
        </div>
      </div>
    </div>
  );
}
