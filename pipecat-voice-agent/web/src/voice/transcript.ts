import type { AssistantStatus, ConversationEntry, ToolStatus } from './conversation';
import type { CallView } from './model';

const speechStatuses = {
  preparing: 'Audio not started at export.',
  speaking: 'Speaking at export (not yet fully spoken).',
  complete: '',
  interrupted: 'Interrupted (not fully spoken).',
  audio_failed: 'Audio failed (not fully spoken).',
} satisfies Record<AssistantStatus, string>;

const toolStatuses = {
  running: 'Running at export',
  complete: 'Done',
  empty: 'No results',
  failed: 'Failed',
  cancelled: 'Cancelled',
} satisfies Record<ToolStatus, string>;

const callStatuses = {
  idle: 'Not started',
  connecting: 'Connecting',
  connected: 'Ongoing',
  ending: 'Ending',
  ended: 'Ended',
} satisfies Record<CallView['phase'], string>;

// The UI displays plain text. Preserve that interpretation in Markdown,
// including text that happens to contain HTML, links, or heading syntax.
function markdownText(text: string): string {
  return text.replace(/([\\`*_{}[\]<>#|])/g, '\\$1');
}

function timestamp(at: number): string {
  return `${new Date(at).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

function entryMarkdown(entry: ConversationEntry, name: string, ended: boolean): string {
  switch (entry.kind) {
    case 'user':
      return `## You\n\n${markdownText(entry.text)}`;
    case 'assistant': {
      const status =
        ended && (entry.status === 'preparing' || entry.status === 'speaking')
          ? 'Not fully spoken before the call ended.'
          : speechStatuses[entry.status];
      return [
        `## ${markdownText(name)}`,
        ...(status ? [`> ${status}`] : []),
        markdownText(entry.text),
      ].join('\n\n');
    }
    case 'tool': {
      const status =
        entry.status === 'running' && ended
          ? 'Unfinished when the call ended; outcome unknown'
          : toolStatuses[entry.status];
      const sources =
        entry.status === 'complete'
          ? (entry.sources ?? []).map(
              (source) => `- [${markdownText(source.title)}](<${new URL(source.url).href}>)`,
            )
          : [];
      return [
        `## Tool: ${markdownText(entry.tool.label)}`,
        `Status: ${status}`,
        ...(sources.length ? [sources.join('\n')] : []),
      ].join('\n\n');
    }
  }
}

export function createTranscript(view: CallView, fallbackName: string, exportedAt = Date.now()) {
  const name = (view.agentName ?? fallbackName).trim() || 'Assistant';
  const startedAt = view.startedAt ?? view.connectedAt;
  const ended = view.phase === 'ending' || view.phase === 'ended';
  const status = ended && view.error ? 'Ended with an error' : callStatuses[view.phase];
  const header = [
    `# ${markdownText(name)} conversation`,
    [
      ...(view.callId ? [`- Call ID: ${view.callId}`] : []),
      ...(startedAt !== undefined ? [`- Call started: ${timestamp(startedAt)}`] : []),
      `- Exported: ${timestamp(exportedAt)}`,
      `- Call status: ${status}`,
    ].join('\n'),
    ...(view.error ? [`Error: ${markdownText(view.error)}`] : []),
    'User messages are speech-recognition transcripts. Assistant replies include generated text, which may not have been fully spoken.',
  ];
  return {
    filename: `voice-chat-${new Date(exportedAt).toISOString().slice(0, 19).replaceAll(':', '-')}Z.md`,
    markdown:
      [...header, ...view.history.map((entry) => entryMarkdown(entry, name, ended))].join('\n\n') +
      '\n',
  };
}
