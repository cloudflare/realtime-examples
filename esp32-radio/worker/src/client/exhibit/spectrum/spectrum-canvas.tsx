import { useEffect, useRef } from 'react';
import type { SignalBuffer } from '@/client/radio/session-state.ts';

/** Draw the board's bands, never an FFT of audio in the browser. */
export function SpectrumCanvas({ signal }: { signal: SignalBuffer }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const shown = new Float32Array(32);
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0,
      last = 0;
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      if (document.hidden || now - last < (reduced.matches ? 100 : 32)) return;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const width = canvas.clientWidth,
        height = canvas.clientHeight,
        scale = Math.min(devicePixelRatio || 1, 2);
      if (
        canvas.width !== Math.round(width * scale) ||
        canvas.height !== Math.round(height * scale)
      ) {
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
      }
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.clearRect(0, 0, width, height);
      context.strokeStyle = '#d9e1da';
      context.lineWidth = 0.7;
      for (let row = 0; row < 4; row++) {
        const y = Math.round((row * height) / 4) + 0.5;
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(width, y);
        context.stroke();
      }
      const fresh = signal.at > 0 && now - signal.at < 1200;
      for (let i = 0; i < 32; i++) {
        const target = fresh && signal.frame ? signal.frame.bands[i] / 255 : 0;
        shown[i] = reduced.matches
          ? target
          : shown[i] + (target - shown[i]) * Math.min(1, dt * (target > shown[i] ? 22 : 8));
        const barHeight = Math.max(2, shown[i] * (height - 5)),
          barWidth = Math.max(1, width / 32 - 3);
        context.fillStyle = fresh ? '#2b7463' : '#b7c9bd';
        context.fillRect((i * width) / 32, height - barHeight, barWidth, barHeight);
      }
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [signal]);
  return (
    <canvas
      ref={ref}
      className="block h-20 w-full"
      role="img"
      aria-label="32 frequency bands calculated on core 1 of the ESP32-S3"
    />
  );
}
