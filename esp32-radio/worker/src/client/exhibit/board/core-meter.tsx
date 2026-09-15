export function CoreMeter({
  core,
  task,
  busyBps,
}: {
  core: 0 | 1;
  task: string;
  busyBps?: number | null;
}) {
  const known = busyBps !== undefined && busyBps !== null;
  return (
    <div className="py-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="rounded bg-core px-1.5 py-1 font-mono text-[8px] tracking-wide">
          CORE {core}
        </span>
        <span
          className="w-[5ch] text-right font-mono text-[10px] text-muted"
          data-testid={`cpu-${core}`}
        >
          {known ? `${Math.round(busyBps / 100)}%` : '––'}
        </span>
      </div>
      <div className="mt-1 text-[11px]">{task}</div>
      <div className="mt-1.5 h-[3px] overflow-hidden rounded bg-core" aria-hidden="true">
        <span
          className="block size-full origin-left bg-spectrum"
          style={{ transform: `scaleX(${known ? busyBps / 10000 : 0})` }}
        />
      </div>
    </div>
  );
}
