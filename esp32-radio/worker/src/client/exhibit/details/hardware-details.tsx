import type { Hardware } from '@/shared/contracts/hardware.ts';
import { formatBytes } from '@/client/ui/format.ts';

export function HardwareDetails({
  hardware,
  radioStack,
  analysisStack,
}: {
  hardware?: Hardware | null;
  radioStack?: number;
  analysisStack?: number;
}) {
  return (
    <div className="mt-3 border-t border-line pt-3 text-xs leading-relaxed">
      <p>
        CPU bars show non-idle task time over one second. Temperature is measured inside the chip.
      </p>
      {hardware ? (
        <>
          <table className="mt-3 w-full table-fixed text-[10px] [&_th]:pb-1 [&_th]:font-medium [&_td]:py-1 [&_td]:text-right [&_td]:font-mono [&_th]:text-right [&_th:first-child]:text-left [&_td:first-child]:text-left [&_td:first-child]:font-sans">
            <thead>
              <tr>
                <th>Memory</th>
                <th>Free</th>
                <th>Minimum</th>
                <th>Largest block</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ['Internal', hardware.internal],
                  ['PSRAM', hardware.psram],
                ] as const
              ).map(([label, memory]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td>{formatBytes(memory.free)}</td>
                  <td>{formatBytes(memory.minimumFree)}</td>
                  <td>{formatBytes(memory.largestBlock)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3">
            Stack headroom: radio {formatBytes(radioStack)}, analysis {formatBytes(analysisStack)},
            sampler {formatBytes(hardware.samplerStackFree)}. These are minima since boot.
          </p>
          <p className="mt-2">
            Last sampling cost: {(hardware.sampleCostUs / 1000).toFixed(2)} ms.
          </p>
        </>
      ) : null}
    </div>
  );
}
