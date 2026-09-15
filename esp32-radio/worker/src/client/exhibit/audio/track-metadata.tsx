import { useId, useState } from 'react';
import type { Track } from '@/shared/contracts/track.ts';
import { AnchoredDialog } from '@/client/ui/anchored-dialog.tsx';

export function TrackMetadata({ track }: { track?: Track }) {
  const id = useId();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        type="button"
        className="min-w-0 flex-1 text-left enabled:hover:underline underline-offset-4"
        disabled={!track}
        aria-label={track ? `Track information: ${track.title}` : 'Music'}
        aria-haspopup="dialog"
        aria-expanded={!!anchor && !!track}
        aria-controls={anchor && track ? id : undefined}
        onClick={(event) => setAnchor(event.currentTarget)}
      >
        <span className="block truncate text-base leading-6 font-medium" data-testid="track-title">
          {track?.title ?? 'Music'}
        </span>
        <span
          className="mt-0.5 block h-4.5 truncate text-xs leading-4.5 text-muted"
          data-testid="track-artist"
        >
          {track?.artist ?? ''}
        </span>
      </button>
      <AnchoredDialog
        id={id}
        closeLabel="Close track information"
        anchor={track ? anchor : null}
        title={track?.title}
        onClose={() => setAnchor(null)}
      >
        {track?.artist ? <p>{track.artist}</p> : null}
      </AnchoredDialog>
    </>
  );
}
