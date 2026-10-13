import { ChevronDown } from 'lucide-react';
import type { Timing } from '../lib/contracts';

export function ConnectionDetails({ timings }: { timings: Timing[] }) {
  if (!timings.length) return null;
  return (
    <details className="group border-t border-stone-200 text-sm text-stone-600">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between px-5 py-3 font-medium text-stone-700 sm:px-6 [&::-webkit-details-marker]:hidden">
        Connection details
        <ChevronDown
          className="size-4 transition-transform group-open:rotate-180 motion-reduce:transition-none"
          aria-hidden="true"
        />
      </summary>
      <div className="px-5 pb-5 sm:px-6">
        <p className="mb-3 max-w-2xl leading-6">
          Browser times include the server work beneath them. The same measurements are in the
          browser console.
        </p>
        <div className="max-h-64 overflow-auto">
          <table className="w-full text-left">
            <caption className="sr-only">Call startup measurements</caption>
            <thead>
              <tr className="border-b border-stone-200 text-stone-700">
                <th className="pb-2 font-medium">Operation</th>
                <th className="pb-2 font-medium">Measured at</th>
                <th className="pb-2 text-right font-medium">Time</th>
              </tr>
            </thead>
            <tbody>
              {timings.map((row, index) => (
                <tr
                  key={`${row.source}-${row.operation}-${index}`}
                  className={row.status === 'failed' ? 'text-red-700' : ''}
                >
                  <td className="py-1.5 pr-4">
                    {row.label}
                    {row.status === 'failed' ? ' (failed)' : ''}
                  </td>
                  <td className="py-1.5 pr-3 capitalize">{row.source}</td>
                  <td className="py-1.5 text-right font-mono text-xs tabular-nums">
                    {row.elapsed_ms < 1000
                      ? `${Math.round(row.elapsed_ms)} ms`
                      : `${(row.elapsed_ms / 1000).toFixed(2)} s`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  );
}
