export const BRANCHES = ['audio', 'spectrum', 'robot'] as const;
export type Branch = (typeof BRANCHES)[number];
export type Selection = Branch | 'board' | 'sfu';

export type SignalDetails = { selection: Selection; anchor: HTMLButtonElement };
export type ExplanationTrigger = {
  expanded: boolean;
  onSelect: (anchor: HTMLButtonElement) => void;
};

/** Shared anchors for drawing board-to-SFU and SFU-to-browser streams. */
export const anchors = {
  board: 'board',
  wifi: 'source-wifi',
  sfuInput: 'sfu-input',
  sources: { audio: 'source-audio', spectrum: 'source-spectrum', robot: 'source-robot' },
  relay: { audio: 'sfu-audio', spectrum: 'sfu-spectrum', robot: 'sfu-robot' },
  receivers: { audio: 'leaf-audio', spectrum: 'leaf-spectrum', robot: 'leaf-robot' },
} as const;

export const branchStyles = {
  audio: { text: 'text-audio', variable: '[--branch:var(--color-audio)]', icon: 'sound' },
  spectrum: { text: 'text-spectrum', variable: '[--branch:var(--color-spectrum)]', icon: 'wave' },
  robot: { text: 'text-robot', variable: '[--branch:var(--color-robot)]', icon: 'control' },
} as const;
