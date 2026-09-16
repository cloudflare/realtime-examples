import type { Telemetry } from '@/shared/contracts/robot.ts';
import { formatTime } from '@/client/ui/format.ts';

export function TelemetryReadout({ telemetry }: { telemetry?: Telemetry }) {
  const hardware = telemetry?.hardware;
  const temperature = hardware?.chipTemperatureMc;
  const internal = hardware?.internal.free ?? telemetry?.heap;
  return (
    <div className="border-b border-line pb-3.5">
      <dl className="grid grid-cols-2 gap-x-3 gap-y-3 sm:grid-cols-4 sm:gap-2 [&_dt]:text-[10px] [&_dt]:text-muted [&_dd]:mt-1 [&_dd]:font-mono [&_dd]:text-lg [&_small]:text-[10px] [&_small]:text-muted">
        <div>
          <dt>Chip temperature</dt>
          <dd data-testid="chip-temperature">
            {temperature == null ? '––' : Math.round(temperature / 1000)}
            <small> °C</small>
          </dd>
        </div>
        <div>
          <dt>Wi-Fi</dt>
          <dd>
            {telemetry?.rssi ?? '––'}
            <small> dBm</small>
          </dd>
        </div>
        <div>
          <dt>Free internal RAM</dt>
          <dd data-testid="internal-free">
            {internal === undefined ? '––' : Math.round(internal / 1024)}
            <small> KiB</small>
          </dd>
        </div>
        <div>
          <dt>Free PSRAM</dt>
          <dd data-testid="psram-free">
            {hardware ? (hardware.psram.free / (1024 * 1024)).toFixed(1) : '––'}
            <small> MiB</small>
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-[10px] text-muted">
        Uptime{' '}
        <span className="font-mono">{telemetry ? formatTime(telemetry.uptimeMs) : '–:––'}</span>
      </p>
    </div>
  );
}
