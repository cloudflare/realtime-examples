import type { CSSProperties } from 'react';
import type { RGB } from '@/shared/contracts/robot.ts';

const colors: { name: string; rgb: RGB; display: string }[] = [
  { name: 'coral', rgb: [32, 3, 0], display: '#db704f' },
  { name: 'amber', rgb: [28, 18, 0], display: '#c89535' },
  { name: 'green', rgb: [0, 24, 5], display: '#4b9471' },
  { name: 'turquoise', rgb: [0, 24, 24], display: 'oklch(0.63 0.085 195)' },
  { name: 'blue', rgb: [0, 10, 32], display: '#548abb' },
  { name: 'violet', rgb: [18, 0, 32], display: 'oklch(0.61 0.105 305)' },
  { name: 'rose', rgb: [32, 0, 12], display: 'oklch(0.65 0.105 350)' },
  { name: 'off', rgb: [0, 0, 0], display: '#e5e5dd' },
];

export function LedControls({
  led,
  disabled,
  pending,
  onChange,
}: {
  led?: RGB;
  disabled: boolean;
  pending: boolean;
  onChange: (rgb: RGB) => void;
}) {
  return (
    <fieldset
      className="mt-3 mb-1 min-w-0 border-0 p-0 [&_legend]:font-mono [&_legend]:text-[9px] [&_legend]:tracking-wide [&_legend]:text-muted"
      disabled={disabled}
    >
      <legend>ONBOARD LED · GPIO38</legend>
      <div className="mt-2 grid w-fit grid-cols-4 gap-1 [&_button]:flex [&_button]:size-11 [&_button]:items-center [&_button]:justify-center [&_button]:rounded-md [&_button]:border [&_button]:border-transparent [&_button]:p-1 [&_button]:text-xl [&_button[aria-pressed=true]]:border-ink [&_button>span]:size-6 [&_button>span]:rounded-full [&_button>span]:bg-(--swatch) [&_button>span]:ring-1 [&_button>span]:ring-inset [&_button>span]:ring-ink/10">
        {colors.map((color) => (
          <button
            type="button"
            key={color.name}
            aria-label={color.name === 'off' ? 'Turn LED off' : `Set LED to ${color.name}`}
            aria-disabled={disabled || pending}
            aria-pressed={led?.join(',') === color.rgb.join(',')}
            data-rgb={color.rgb.join(',')}
            style={{ '--swatch': color.display } as CSSProperties}
            onClick={() => {
              if (!disabled && !pending) onChange(color.rgb);
            }}
          >
            {color.name === 'off' ? '○' : <span aria-hidden="true" />}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
