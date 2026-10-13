import clsx from 'clsx';
import { LoaderCircle, Mic, MicOff, Play, Square } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { StageView } from '../voice/model';

/*
 * The voice orb: a dotted globe drawn on a canvas, ringed by an orange
 * equalizer that opens up with the call audio. During a call a dashed orbit
 * appears around it with the microphone control at the top, and the globe
 * itself starts or stops the call. The globe adopts its colors from the
 * Tailwind palette through the `.orb` custom properties in styles.css, so
 * the canvas and the rest of the stage stay in step.
 */

// Geometry is expressed against the reference widget size and scaled down
// together so the orbit, the connector, and the microphone stay aligned.
const REFERENCE_SIZE = 440;
const GLOBE_RATIO = 343 / REFERENCE_SIZE;
const ORBIT_RADIUS_RATIO = 180 / REFERENCE_SIZE;
const CONTROL_RATIO = 66 / REFERENCE_SIZE;
const MIN_CONTROL_SIZE = 44;
const MIN_SIZE = 200;
const MAX_SIZE = 320;

type RgbColor = readonly [red: number, green: number, blue: number];

const fallbackColors = {
  accent: [255, 105, 0],
  front: [250, 250, 249],
  back: [168, 162, 158],
} satisfies Record<string, RgbColor>;

function rgbWithAlpha([red, green, blue]: RgbColor, alpha: number) {
  return `rgb(${red} ${green} ${blue} / ${alpha})`;
}

/**
 * Resolves a CSS color from the orb's custom properties into RGB components
 * for the canvas. Tailwind's palette is defined in OKLCH, which the canvas
 * API cannot modulate directly, so the browser converts it: assigning a
 * color to `fillStyle` and reading it back yields a normalized hex string.
 */
function readColor(
  element: HTMLElement,
  property: string,
  context: CanvasRenderingContext2D,
  fallback: RgbColor,
): RgbColor {
  const value = getComputedStyle(element).getPropertyValue(property).trim();
  if (!value) return fallback;
  context.fillStyle = '#010203';
  context.fillStyle = value;
  const hex = /^#([\da-f]{6})/i.exec(String(context.fillStyle))?.[1];
  if (!hex || hex === '010203') return fallback;
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

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
  const smoothedLevelRef = useRef(0);
  const repaintRef = useRef(() => {});
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
    const R = canvas.width * 0.33;
    const tilt = (-20 * Math.PI) / 180;
    const sinT = Math.sin(tilt);
    const cosT = Math.cos(tilt);

    const colors = {
      accent: readColor(canvas, '--orb-accent', ctx, fallbackColors.accent),
      front: readColor(canvas, '--orb-dot', ctx, fallbackColors.front),
      back: readColor(canvas, '--orb-dot-back', ctx, fallbackColors.back),
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

    let raf = 0;
    let level = smoothedLevelRef.current;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reduce = reducedMotion.matches;

    const frame = (time: number) => {
      const live = activeRef.current;
      const target = live ? Math.max(0.04, Math.min(1, getLevelRef.current())) : 0;
      level += (target - level) * 0.12;
      smoothedLevelRef.current = level;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const ry = time * (live ? 0.00018 : 0.00008) - 0.5;

      // Rim glow.
      const glowRadius = R * 1.5;
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

      // Faint rim.
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.004, 0, 7);
      ctx.strokeStyle = rgbWithAlpha(colors.accent, live ? 0.62 : 0.52);
      ctx.lineWidth = 1.5 * dpr;
      ctx.stroke();

      // Sphere dots: brighter and larger toward the front.
      for (const p of dots) {
        const v = rotate(p, ry);
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

      // Audio-reactive radial equalizer. Outside a call the amplitude is
      // small so the ring reads as a calm baseline; a live call opens it up.
      const bars = 90;
      const base = R * 1.06;
      const amp = (live ? 0.28 : 0.08) + level * 2.6;
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      for (let i = 0; i < bars; i++) {
        const angle = (i / bars) * Math.PI * 2 - Math.PI / 2;
        let wave =
          Math.sin(angle * 3 + time * 0.0016) +
          0.6 * Math.sin(angle * 7 - time * 0.0021) +
          0.4 * Math.sin(angle * 13 + time * 0.0009);
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

      // Reduced motion renders a single still frame: no spin, no equalizer loop.
      if (!reduce) raf = requestAnimationFrame(frame);
    };

    repaintRef.current = () => {
      if (reduce) frame(performance.now());
    };
    const onReducedMotionChange = () => {
      reduce = reducedMotion.matches;
      cancelAnimationFrame(raf);
      frame(performance.now());
    };
    reducedMotion.addEventListener('change', onReducedMotionChange);
    frame(performance.now());

    return () => {
      repaintRef.current = () => {};
      reducedMotion.removeEventListener('change', onReducedMotionChange);
      cancelAnimationFrame(raf);
    };
  }, [size]);

  // A still frame must be redrawn when the call state changes its colors.
  useEffect(() => {
    repaintRef.current();
  }, [active]);

  return (
    <canvas
      ref={canvasRef}
      className="orb block"
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}

/** Fits the widget to its container, so the globe scales with the stage. */
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

const centerIcons = {
  start: Play,
  cancel: LoaderCircle,
  call: Square,
  ending: LoaderCircle,
} satisfies Record<StageView['controls'], typeof Play>;

const centerLabels = {
  start: 'Start conversation',
  cancel: 'Cancel',
  call: 'End call',
  ending: 'Ending call',
} satisfies Record<StageView['controls'], string>;

export function Orb({
  controls,
  level,
  muted,
  canStart,
  onStart,
  onStop,
  onMute,
}: {
  controls: StageView['controls'];
  /** Combined 0..1 audio level of the person and the assistant. */
  level: number;
  muted: boolean;
  /** True when the start control is usable, so the globe can start a call too. */
  canStart: boolean;
  onStart: () => void;
  onStop: () => void;
  onMute: () => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const size = useWidgetSize(frame);
  const levelRef = useRef(level);
  levelRef.current = level;
  const getLevel = () => levelRef.current;

  const inCall = controls === 'call';
  const busy = controls === 'cancel' || controls === 'ending';
  const scale = (value: number) => Math.round((value * size) / REFERENCE_SIZE);
  const globeSize = Math.round(size * GLOBE_RATIO);
  // The canvas draws the sphere at a third of its width; the hit target
  // covers that sphere rather than the glow and equalizer around it.
  const hitSize = Math.round(globeSize * 0.66);
  const orbitRadius = scale(ORBIT_RADIUS_RATIO * REFERENCE_SIZE);
  const center = size / 2;
  const controlSize = Math.max(MIN_CONTROL_SIZE, scale(CONTROL_RATIO * REFERENCE_SIZE));
  const controlTop = Math.max(center - orbitRadius, controlSize / 2);
  const connectorTop = controlTop + controlSize / 2;
  const connectorHeight = Math.max(0, center - hitSize / 2 - connectorTop);
  const iconSize = Math.round(globeSize * 0.2);
  const Icon = centerIcons[controls];
  const disabled = controls === 'ending' || (controls === 'start' && !canStart);

  return (
    <div ref={frame} className="mb-7 flex w-full justify-center">
      <div className="relative isolate shrink-0" style={{ width: size, height: size }}>
        {/* Dashed orbit, present only during a call. */}
        <svg
          aria-hidden="true"
          className={clsx(
            'pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 overflow-visible text-stone-50 transition-opacity duration-500 motion-reduce:transition-none',
            inCall ? 'opacity-15' : 'opacity-0',
          )}
          width={orbitRadius * 2}
          height={orbitRadius * 2}
        >
          <circle
            cx={orbitRadius}
            cy={orbitRadius}
            r={orbitRadius - 0.5}
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            strokeDasharray="8 8"
          />
        </svg>

        {/* The globe starts and stops the call. The button is clipped to the
            sphere so clicks beside it fall through to the stage. */}
        <button
          type="button"
          className={clsx(
            'peer absolute top-1/2 left-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-full disabled:cursor-not-allowed',
            controls === 'start' && canStart && 'orb-pulse',
          )}
          style={{ width: hitSize, height: hitSize }}
          disabled={disabled}
          aria-label={centerLabels[controls]}
          onClick={controls === 'start' ? onStart : onStop}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-stone-900/40"
          style={{ width: hitSize, height: hitSize }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 transition-transform duration-300 peer-enabled:peer-hover:scale-105 peer-enabled:peer-active:scale-95 motion-reduce:transition-none"
        >
          <Globe size={globeSize} active={inCall || busy} getLevel={getLevel} />
        </div>
        <div
          aria-hidden="true"
          className={clsx(
            'pointer-events-none absolute top-1/2 left-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center transition-transform duration-300 peer-enabled:peer-hover:scale-110 peer-enabled:peer-active:scale-95 motion-reduce:transition-none',
            disabled && controls === 'start' ? 'text-stone-500' : 'text-orange-500',
          )}
          style={{ width: hitSize, height: hitSize }}
        >
          <Icon
            className={clsx(busy && 'motion-safe:animate-spin')}
            style={{ width: iconSize, height: iconSize }}
            strokeWidth={1.5}
          />
        </div>

        {/* Connector and microphone control on the orbit. */}
        <svg
          aria-hidden="true"
          className={clsx(
            'pointer-events-none absolute w-0.5 -translate-x-1/2 overflow-visible transition-opacity duration-200 motion-reduce:transition-none',
            inCall ? 'opacity-100' : 'opacity-0',
          )}
          style={{ left: center, top: connectorTop, height: connectorHeight }}
        >
          <line x1="1" y1="0" x2="1" y2="100%" className="orb-connector" />
        </svg>
        <div
          className={clsx(
            'absolute z-20 -translate-x-1/2 -translate-y-1/2 transition-opacity duration-200 motion-reduce:transition-none',
            inCall ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
          style={{ left: center, top: controlTop }}
          // Hidden controls leave the accessibility tree instead of fading only.
          inert={!inCall ? true : undefined}
        >
          <button
            type="button"
            onClick={onMute}
            aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
            aria-pressed={muted}
            title={muted ? 'Unmute microphone' : 'Mute microphone'}
            className={clsx(
              'flex items-center justify-center rounded-full border bg-stone-900 transition-colors motion-reduce:transition-none',
              muted
                ? 'border-white/10 text-orange-500 hover:bg-stone-800'
                : 'border-white/20 text-stone-50 hover:bg-stone-800',
            )}
            style={{ width: controlSize, height: controlSize }}
          >
            {muted ? (
              <MicOff className="size-5" aria-hidden="true" />
            ) : (
              <Mic className="size-5" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
