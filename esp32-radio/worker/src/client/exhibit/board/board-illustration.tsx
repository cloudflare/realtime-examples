import { useId } from 'react';
import type { CSSProperties } from 'react';
import type { RGB } from '@/shared/contracts/robot.ts';
import { anchors } from '@/client/exhibit/diagram/diagram-model.ts';

export function ledColor(rgb?: RGB): string {
  return rgb ? `rgb(${rgb.map((value) => Math.min(255, value * 8)).join(' ')})` : '#697366';
}

/** Board artwork and logical stream anchors; the LED follows reported hardware state. */
export function BoardIllustration({ led }: { led?: RGB }) {
  const patternId = useId();
  const color = ledColor(led),
    known = !!led,
    ledOn = !!led?.some((value) => value > 0);
  return (
    <svg
      className="pcb h-auto w-full drop-shadow-md"
      viewBox="0 0 230 365"
      role="img"
      aria-label={`ESP32-S3 board. UART connector on the left; USB connector on the right. Onboard LED ${known ? led!.join(', ') : 'state unknown'}.`}
    >
      <defs>
        <pattern id={patternId} width="14" height="14" patternUnits="userSpaceOnUse">
          <circle cx="7" cy="7" r=".65" fill="#608579" opacity=".35" />
        </pattern>
      </defs>
      <rect
        x="27"
        y="9"
        width="176"
        height="345"
        rx="11"
        fill="#284f43"
        stroke="#183d32"
        strokeWidth="2"
      />
      <rect x="30" y="12" width="170" height="339" rx="8" fill={`url(#${patternId})`} />
      {[0, 1].map((side) => (
        <g key={side}>
          {Array.from({ length: 16 }, (_, i) => (
            <g key={i}>
              <rect
                x={side ? 198 : 19}
                y={54 + i * 17}
                width="13"
                height="9"
                rx="1"
                fill="#b7a76f"
              />
              <circle cx={side ? 194 : 36} cy={58 + i * 17} r="3" fill="#d6c893" />
              <circle cx={side ? 194 : 36} cy={58 + i * 17} r="1.4" fill="#2a342a" />
            </g>
          ))}
        </g>
      ))}
      <path
        d="M72 50V27h18v25h18V27h18v25h18V27h17v32"
        stroke="#bab97f"
        strokeWidth="3"
        fill="none"
      />
      <path
        d="M54 115h-8v56h17m112-57h10v106h-15M80 228v19H62v41m97-49v30h16v40M98 255v42h17v26"
        stroke="#739383"
        fill="none"
      />
      <rect x="60" y="72" width="111" height="148" rx="5" fill="#c7cdc0" stroke="#8f9b90" />
      <path d="M64 77h103M64 215h103" stroke="#e8ebe2" />
      <text x="115" y="106" textAnchor="middle" className="pcb-brand">
        ESPRESSIF
      </text>
      <text x="115" y="136" textAnchor="middle" className="pcb-chip">
        ESP32-S3
      </text>
      <text x="115" y="156" textAnchor="middle" className="pcb-model">
        DUAL CORE · 240 MHz
      </text>
      <path d="M78 169h74" stroke="#a5afa4" />
      <text x="115" y="188" textAnchor="middle" className="pcb-model">
        32 MiB FLASH
      </text>
      <text x="115" y="203" textAnchor="middle" className="pcb-model">
        16 MiB PSRAM
      </text>
      <rect x="139" y="237" width="24" height="14" fill="#23382d" stroke="#769481" />
      <rect x="105" y="237" width="24" height="14" fill="#23382d" stroke="#769481" />
      <rect x="71" y="234" width="17" height="19" rx="2" fill="#e4e5cf" />
      <circle
        cx="79.5"
        cy="243.5"
        r="5.5"
        fill={color}
        className={ledOn ? 'led-lit' : ''}
        style={{ '--led-color': color } as CSSProperties}
        data-testid="board-led"
        data-rgb={led?.join(',') ?? 'unknown'}
      />
      <text x="80" y="272" textAnchor="middle" className="pcb-label">
        RGB / 38
      </text>
      <rect x="55" y="291" width="28" height="19" rx="3" fill="#192f25" stroke="#6e8c7c" />
      <circle cx="69" cy="300" r="6" fill="#899384" />
      <rect x="145" y="291" width="28" height="19" rx="3" fill="#192f25" stroke="#6e8c7c" />
      <circle cx="159" cy="300" r="6" fill="#899384" />
      <text x="69" y="323" textAnchor="middle" className="pcb-label">
        BOOT
      </text>
      <text x="159" y="323" textAnchor="middle" className="pcb-label">
        RESET
      </text>
      <g data-connector="uart">
        <rect x="60" y="328" width="35" height="32" rx="4" fill="#bdc4b8" stroke="#829488" />
        <rect x="65" y="343" width="25" height="12" rx="5" fill="#27382c" />
      </g>
      <g data-connector="usb">
        <rect x="138" y="328" width="35" height="32" rx="4" fill="#bdc4b8" stroke="#829488" />
        <rect x="143" y="343" width="25" height="12" rx="5" fill="#27382c" />
      </g>
      {/* Logical Wi-Fi streams meet the edge of the illustration. These
              markers do not represent USB connections or GPIO assignments. */}
      <g aria-hidden="true" className="hidden lg:block">
        <circle
          data-anchor={anchors.sources.audio}
          cx="213"
          cy="140"
          r="3.5"
          className="fill-surface stroke-audio"
          strokeWidth="1.5"
        />
        <circle
          data-anchor={anchors.sources.spectrum}
          cx="213"
          cy="192"
          r="3.5"
          className="fill-surface stroke-spectrum"
          strokeWidth="1.5"
        />
        <circle
          data-anchor={anchors.sources.robot}
          cx="213"
          cy="244"
          r="3.5"
          className="fill-surface stroke-robot"
          strokeWidth="1.5"
        />
      </g>
      <circle
        data-anchor={anchors.wifi}
        cx="213"
        cy="64"
        r="3.5"
        aria-hidden="true"
        className="fill-surface stroke-muted lg:hidden"
        strokeWidth="1.5"
      />
    </svg>
  );
}
