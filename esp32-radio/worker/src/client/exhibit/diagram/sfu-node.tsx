import { Icon } from '@/client/ui/icons.tsx';
import { anchors } from './diagram-model.ts';
import type { ExplanationTrigger } from './diagram-model.ts';

export function SfuNode({ expanded, onSelect }: ExplanationTrigger) {
  return (
    <section
      className="relative z-1 mt-8 mb-7 grid w-full justify-self-center pt-6 text-center lg:my-0 lg:mt-14 lg:block lg:w-[145px] lg:self-center lg:pt-0 xl:w-[158px]"
      aria-label="Cloudflare Realtime SFU relay"
    >
      <button
        data-anchor={anchors.sfuInput}
        className="relative flex w-full items-center justify-center gap-2 rounded-t-lg border border-cloud-line bg-cloud p-3 hover:bg-cloud-hover aria-expanded:bg-cloud-hover lg:flex-col lg:gap-0 lg:px-2 lg:pt-5 lg:pb-3 [&>strong]:text-base [&>strong]:font-medium [&>strong]:tracking-tight"
        onClick={(event) => onSelect(event.currentTarget)}
        aria-haspopup="dialog"
        aria-expanded={expanded}
        aria-controls={expanded ? 'signal-detail' : undefined}
      >
        <span className="text-cloud-ink lg:mb-1.5 [&_svg]:h-7 [&_svg]:w-8 lg:[&_svg]:h-9 lg:[&_svg]:w-11">
          <Icon name="cloud" />
        </span>
        <strong>Cloudflare</strong>
        <span className="text-[11px] text-muted">Realtime SFU</span>
        <span className="absolute right-2 top-1 text-sm text-muted" aria-hidden="true">
          ↗
        </span>
      </button>
      <div className="flex justify-around gap-2 rounded-b-lg border border-t-0 border-cloud-line bg-cloud-pale px-4 py-0.5 lg:block lg:px-0 lg:py-1">
        <span
          data-anchor={anchors.relay.audio}
          className="flex h-7 items-center justify-between gap-1.5 font-mono text-[8px] tracking-wide lg:-mx-1 [&_i]:size-1 [&_i]:rounded-full [&_i]:border [&_i]:border-current [&_i]:bg-surface lg:[&_i]:size-1.5 text-audio"
        >
          <i />
          AUDIO
          <i />
        </span>
        <span
          data-anchor={anchors.relay.spectrum}
          className="flex h-7 items-center justify-between gap-1.5 font-mono text-[8px] tracking-wide lg:-mx-1 [&_i]:size-1 [&_i]:rounded-full [&_i]:border [&_i]:border-current [&_i]:bg-surface lg:[&_i]:size-1.5 text-spectrum"
        >
          <i />
          SPECTRUM
          <i />
        </span>
        <span
          data-anchor={anchors.relay.robot}
          className="flex h-7 items-center justify-between gap-1.5 font-mono text-[8px] tracking-wide lg:-mx-1 [&_i]:size-1 [&_i]:rounded-full [&_i]:border [&_i]:border-current [&_i]:bg-surface lg:[&_i]:size-1.5 text-robot"
        >
          <i />
          ROBOT ⇄<i />
        </span>
      </div>
    </section>
  );
}
