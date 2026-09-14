import type { Hardware } from '@/shared/contracts/hardware.ts';
import { HardwareDetails } from './hardware-details.tsx';
import { AnchoredDialog } from '@/client/ui/anchored-dialog.tsx';
import { descriptions } from './signal-descriptions.ts';
import type { SignalDetails } from '@/client/exhibit/diagram/diagram-model.ts';
import type { SpectrumStats } from '@/shared/contracts/robot.ts';

export function SignalPopover({
  details,
  analysis,
  hardware,
  radioStack,
  close,
}: {
  details: SignalDetails | null;
  analysis?: SpectrumStats;
  hardware?: Hardware | null;
  radioStack?: number;
  close: () => void;
}) {
  const detail = details ? descriptions[details.selection] : undefined;
  return (
    <AnchoredDialog
      id="signal-detail"
      closeLabel="Close signal explanation"
      anchor={details?.anchor ?? null}
      title={detail?.title}
      onClose={close}
    >
      {detail?.chain ? (
        <p className="mb-3 font-mono text-[11px] leading-relaxed text-spectrum">{detail.chain}</p>
      ) : null}
      <p>{detail?.body}</p>
      {details?.selection === 'board' ? (
        <HardwareDetails
          hardware={hardware}
          radioStack={radioStack}
          analysisStack={analysis?.stackFree}
        />
      ) : null}
      {details?.selection === 'spectrum' && analysis ? (
        <p className="mt-3 border-t border-line pt-3 text-xs leading-relaxed text-muted">
          Analysis: {(analysis.meanUs / 1000).toFixed(2)} ms/packet average · {analysis.errors}{' '}
          decode errors. Task timing, not CPU use.
        </p>
      ) : null}
    </AnchoredDialog>
  );
}
