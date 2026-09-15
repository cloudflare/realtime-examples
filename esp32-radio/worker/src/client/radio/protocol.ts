import { robotMessageSchema } from '@/shared/contracts/robot.ts';
import type { RobotMessage } from '@/shared/contracts/robot.ts';

export type SpectrumFrame = {
  pts: number;
  positionMs: number;
  paused: boolean;
  bands: Uint8Array;
  revision?: number;
};

export function parseRobot(data: unknown): RobotMessage | undefined {
  if (typeof data !== 'string' || data.length > 4096) return;
  try {
    const parsed = robotMessageSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return;
  }
}

/** Wrapping transport milliseconds order frames across track changes and song restarts. */
export function newerTimestamp(next: number, previous: number): boolean {
  const distance = (next - previous) >>> 0;
  return distance > 0 && distance < 0x8000_0000;
}
export function parseSpectrum(data: unknown, previous?: number): SpectrumFrame | undefined {
  if (!(data instanceof ArrayBuffer) || (data.byteLength !== 44 && data.byteLength !== 48)) return;
  const view = new DataView(data);
  const version = view.getUint8(0);
  if (
    !((version === 1 && data.byteLength === 44) || (version === 2 && data.byteLength === 48)) ||
    view.getUint8(1) > 1
  )
    return;
  const pts = view.getUint32(4, true);
  if (previous !== undefined && !newerTimestamp(pts, previous)) return;
  return {
    pts,
    positionMs: view.getUint32(8, true),
    paused: view.getUint8(1) === 1,
    bands: new Uint8Array(data, 12, 32).slice(),
    ...(version === 2 ? { revision: view.getUint32(44, true) } : {}),
  };
}

export function commandId(): string {
  // getRandomValues also works on a phone's HTTP development origin.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
