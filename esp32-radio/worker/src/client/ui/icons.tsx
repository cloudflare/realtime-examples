import type { SVGProps } from 'react';

export function Icon({
  name,
  ...props
}: SVGProps<SVGSVGElement> & {
  name:
    | 'play'
    | 'pause'
    | 'sound'
    | 'muted'
    | 'restart'
    | 'arrow'
    | 'chip'
    | 'cloud'
    | 'wave'
    | 'control';
}) {
  const paths = {
    play: <path d="m8 5 11 7-11 7Z" />,
    pause: (
      <>
        <path d="M8 5v14M16 5v14" />
      </>
    ),
    sound: (
      <>
        <path d="m11 5-5 4H3v6h3l5 4Z" />
        <path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" />
      </>
    ),
    muted: (
      <>
        <path d="m11 5-5 4H3v6h3l5 4Z" />
        <path d="m16 9 5 6m0-6-5 6" />
      </>
    ),
    restart: (
      <>
        <path d="M3 11a9 9 0 1 1 2 7M3 4v7h7" />
      </>
    ),
    arrow: (
      <>
        <path d="M4 12h16m-6-6 6 6-6 6" />
      </>
    ),
    chip: (
      <>
        <rect x="6" y="6" width="12" height="12" rx="2" />
        <path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4" />
      </>
    ),
    cloud: <path d="M6 18a4 4 0 1 1 .7-7.94A6 6 0 0 1 18.4 9a4.5 4.5 0 1 1 .1 9Z" />,
    wave: <path d="M2 12h3l3-8 4 16 4-12 3 4h3" />,
    control: (
      <>
        <path d="M4 7h16M4 17h16" />
        <circle cx="9" cy="7" r="3" />
        <circle cx="16" cy="17" r="3" />
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
