import type { SignalBuffer } from '@/client/radio/session-state.ts';
import { BranchPanel } from '@/client/exhibit/branch-panel.tsx';
import type { ExplanationTrigger } from '@/client/exhibit/diagram/diagram-model.ts';
import { SpectrumCanvas } from './spectrum-canvas.tsx';

export function SpectrumPanel({
  signal,
  live,
  paused,
  ...explanation
}: ExplanationTrigger & { signal: SignalBuffer; live: boolean; paused: boolean }) {
  return (
    <BranchPanel
      branch="spectrum"
      label="Spectrum stream"
      title="See the music."
      caption="LIVE FFT · DATA CHANNEL"
      live={live}
      {...explanation}
    >
      <div className="min-w-0">
        <SpectrumCanvas signal={signal} />
        <div
          className="mt-1 flex justify-between font-mono text-[9px] text-muted"
          aria-hidden="true"
        >
          <span>30 Hz</span>
          <span>100</span>
          <span>1k</span>
          <span>5k</span>
          <span>20k</span>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap justify-between gap-x-2 gap-y-1 font-mono text-[8px] tracking-wide text-spectrum">
        <span>{paused ? 'PAUSED' : '32 BANDS · 25 UPDATES / SEC'}</span>
      </div>
    </BranchPanel>
  );
}
