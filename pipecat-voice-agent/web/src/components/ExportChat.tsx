import { Download } from 'lucide-react';
import type { CallView } from '../voice/model';
import { createTranscript } from '../voice/transcript';
import { Button } from './Button';

export function ExportChat({ view, name }: { view: CallView; name: string }) {
  if (!view.history.length) return null;

  const download = () => {
    const { filename, markdown } = createTranscript(view, name);
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    // Let the browser start reading the download before releasing its URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <Button
      tone="quiet"
      size="icon"
      onClick={download}
      aria-label="Export chat"
      title="Export chat as Markdown"
    >
      <Download className="size-4" aria-hidden="true" />
    </Button>
  );
}
