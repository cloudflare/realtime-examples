import type { Hardware } from '@/shared/contracts/hardware.ts';
import { CoreMeter } from './core-meter.tsx';
import type { RGB } from '@/shared/contracts/robot.ts';
import { anchors } from '@/client/exhibit/diagram/diagram-model.ts';
import type { ExplanationTrigger } from '@/client/exhibit/diagram/diagram-model.ts';
import { BoardIllustration, ledColor } from './board-illustration.tsx';

export function BoardNode({
  led,
  cpu,
  expanded,
  onSelect,
}: { led?: RGB; cpu?: Hardware['cpuBusyBps'] } & ExplanationTrigger) {
  const color = ledColor(led),
    known = !!led;
  const ledOn = known && led!.some((value) => value > 0);
  return (
    <section
      data-anchor={anchors.board}
      className="relative z-1 grid w-full grid-cols-[104px_1fr] gap-x-4 self-center sm:grid-cols-[145px_1fr] sm:gap-x-6 lg:block lg:max-w-[260px] lg:px-1"
      aria-labelledby="board-title"
    >
      <button
        className="col-start-2 mt-3 flex w-full items-center gap-2.5 self-end text-left [&_h2]:text-lg [&_h2]:font-medium [&_h2]:tracking-tight sm:[&_h2]:text-[22px]"
        onClick={(event) => onSelect(event.currentTarget)}
        aria-haspopup="dialog"
        aria-expanded={expanded}
        aria-controls={expanded ? 'signal-detail' : undefined}
      >
        <h2 id="board-title">ESP32-S3</h2>
        <span className="text-sm text-muted" aria-hidden="true">
          ↗
        </span>
      </button>
      <p className="col-start-2 mt-1 font-mono text-[8px] text-muted sm:text-[9px]">N32R16V</p>
      <div className="col-start-1 row-start-1 row-end-5 mt-4 lg:mx-auto lg:mb-4">
        <div className="mx-auto w-[100px] max-w-full sm:w-[125px] lg:w-[183px]">
          <BoardIllustration led={led} />
          <div
            className="mt-1 grid grid-cols-2 px-[16%] text-center font-mono text-[9px] text-muted"
            aria-label="Board connectors, left to right"
          >
            <span>UART</span>
            <span>USB</span>
          </div>
        </div>
        <div className="mt-2 flex items-center justify-center gap-1.5 text-center text-[9px] leading-relaxed text-muted lg:text-[10px]">
          <span
            className="status-dot inline-block size-1.5 shrink-0 rounded-full"
            style={{ background: color }}
          />
          {known ? (ledOn ? 'Reported LED color' : 'LED is off') : 'Waiting for LED state'}
        </div>
      </div>
      <div className="col-start-2 mt-3 self-start lg:mt-0">
        <div className="border-t border-line py-2">
          <CoreMeter core={0} task="Wi-Fi · str0m radio" busyBps={cpu?.[0]} />
          <CoreMeter core={1} task="Opus decode → live FFT" busyBps={cpu?.[1]} />
        </div>
        <p className="mt-3 text-[10px] leading-relaxed text-muted">
          <span className="block font-mono text-[8px] tracking-wide">EITHER CORE</span>
          <span className="mt-1 block text-[11px] text-ink">HTTPS signaling</span>
        </p>
      </div>
      <span className="col-start-2 mt-3 block text-[10px] leading-relaxed text-muted lg:mt-4">
        USB power · Wi-Fi streams
      </span>
    </section>
  );
}
