import { Icon } from './ui/icons.tsx';
import { Exhibit } from './exhibit/exhibit.tsx';
import { useRadio } from './radio/use-radio.ts';

export function App() {
  const { state, signal, actions, audioRef } = useRadio();
  return (
    <div className="mx-auto max-w-[1360px] px-4 pb-6 sm:px-6 lg:px-10 max-lg:max-w-[720px]">
      <a
        className="sr-only z-10 rounded bg-paper focus:not-sr-only focus:fixed focus:top-3 focus:left-5 focus:p-3"
        href="#exhibit"
      >
        Skip to the exhibit
      </a>
      <header className="flex items-center justify-between gap-3 border-b border-line py-5 sm:gap-5 sm:py-6">
        <a
          className="flex items-center gap-2 text-xs font-medium tracking-widest no-underline sm:gap-3 sm:text-sm"
          href="/"
          aria-label="Pocket Radio exhibit home"
        >
          <span
            className="size-9 rounded-lg bg-ink p-2 text-lime-100 [&_svg]:size-full"
            aria-hidden="true"
          >
            <Icon name="wave" />
          </span>
          <span>
            POCKET RADIO
            <span className="mt-1 block font-mono text-[7px] font-normal tracking-wide text-muted sm:text-[9px]">
              ESP32 × CLOUDFLARE
            </span>
          </span>
        </a>
        <div className="flex items-center gap-2 font-mono text-[8px] tracking-wide sm:text-[10px]">
          <span
            className={`status-dot inline-block size-1.5 shrink-0 rounded-full ${state.room.online ? 'bg-spectrum shadow-[0_0_0_4px_var(--color-core)]' : 'bg-muted'}`}
          />
          <span>
            {state.auth === 'required'
              ? 'PRIVATE ACCESS'
              : state.auth === 'checking'
                ? 'CHECKING THE BOARD'
                : state.room.online
                  ? 'BOARD IS ON AIR'
                  : 'BOARD IS OFFLINE'}
          </span>
        </div>
      </header>
      <main id="exhibit">
        <div className="flex items-end justify-between gap-5 py-7 sm:py-8">
          <h1 className="my-2 text-4xl font-medium leading-tight tracking-[-0.045em] sm:text-5xl">
            Follow the signal<span className="text-robot">.</span>
          </h1>
          <div className="hidden items-center gap-3.5 pb-1 text-muted lg:flex [&>span:last-child]:font-mono [&>span:last-child]:text-[9px] [&>span:last-child]:leading-relaxed">
            <span className="font-mono text-3xl text-ink">
              {state.room.viewers.toString().padStart(2, '0')}
            </span>
            <span>LISTENERS</span>
          </div>
        </div>
        <Exhibit state={state} signal={signal} actions={actions} />
      </main>
      <audio ref={audioRef} autoPlay playsInline />
    </div>
  );
}
