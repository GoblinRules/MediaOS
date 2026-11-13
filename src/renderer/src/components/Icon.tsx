// Inline SVG icons (24x24, stroke). Drawn for MediaOS; no icon font or external files.
import type { ReactNode } from 'react'

const PATHS: Record<string, ReactNode> = {
  home: <path d="M3 11 12 4l9 7M5 10v10h5v-6h4v6h5V10" />,
  libraries: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  apps: (
    <>
      <circle cx="6" cy="6" r="2" />
      <circle cx="12" cy="6" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="6" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="18" cy="12" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="12" cy="18" r="2" />
      <circle cx="18" cy="18" r="2" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
    </>
  ),
  play: <path d="M7 4.5v15l13-7.5z" fill="currentColor" />,
  pause: <path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z" fill="currentColor" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.5v.5" />
    </>
  ),
  back: <path d="M15 5 8 12l7 7" />,
  next: <path d="m9 5 7 7-7 7" />,
  check: <path d="m4 12.5 5 5L20 6.5" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  wifi: (
    <>
      <path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0" />
      <circle cx="12" cy="19" r="1" fill="currentColor" />
    </>
  ),
  ethernet: <path d="M4 20V10h3V7h3V4h4v3h3v3h3v10zM8 20v-4M12 20v-4M16 20v-4" />,
  display: (
    <>
      <rect x="2.5" y="4" width="19" height="13" rx="1.5" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  sound: <path d="M4 9.5h4L13 5v14l-5-4.5H4zM16.5 9a4 4 0 0 1 0 6M19 6.5a8 8 0 0 1 0 11" />,
  remote: (
    <>
      <rect x="7" y="2.5" width="10" height="19" rx="3" />
      <circle cx="12" cy="8" r="2" />
      <path d="M10 13h4M10 16h4" />
    </>
  ),
  bluetooth: <path d="m7 7 10 10-5 4.5v-19L17 7 7 17" />,
  power: <path d="M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0" />,
  restart: <path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v5h5" />,
  moon: <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z" />,
  star: <path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z" />,
  heart: <path d="M12 20s-7.5-4.6-7.5-10A4.5 4.5 0 0 1 12 7.3 4.5 4.5 0 0 1 19.5 10C19.5 15.4 12 20 12 20z" />,
  eye: (
    <>
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: <path d="M3 3l18 18M10.6 6.1A10 10 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3 3.6M6.5 7.6C3.8 9.3 2 12 2 12s3.6 6 10 6c1.6 0 3-.4 4.3-1" />,
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />,
  edit: <path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />,
  film: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" />
    </>
  ),
  tv: (
    <>
      <rect x="2.5" y="6" width="19" height="13" rx="1.5" />
      <path d="m8 2 4 4 4-4" />
    </>
  ),
  server: (
    <>
      <rect x="3" y="4" width="18" height="7" rx="1.5" />
      <rect x="3" y="13" width="18" height="7" rx="1.5" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  warning: <path d="M12 3 2 20h20zM12 10v4.5M12 17.5v.5" />,
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  rewind: <path d="M11 6 3 12l8 6zM21 6l-8 6 8 6z" fill="currentColor" />,
  forward: <path d="m13 6 8 6-8 6zM3 6l8 6-8 6z" fill="currentColor" />,
  playNext: <path d="M5 5.5v13l10-6.5zM17 5.5h2.5v13H17z" fill="currentColor" />,
  skipBack: <path d="M12 5a7 7 0 1 1-7 7M5 5v4h4" />,
  skipForward: <path d="M12 5a7 7 0 1 0 7 7M19 5v4h-4" />,
  subtitles: (
    <>
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <path d="M6 13h4M12 13h6M6 16h8" />
    </>
  ),
  keyboard: (
    <>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
    </>
  ),
  refresh: <path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" />,
  shield: <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" />,
  list: <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />,
  pointer: <path d="m5 3 14 7-6 2-2 6z" />,
  gamepad: (
    <>
      <path d="M6 8h12a4 4 0 0 1 4 4l-.6 4a2.5 2.5 0 0 1-4.4 1.2L15 15H9l-2 2.2A2.5 2.5 0 0 1 2.6 16L2 12a4 4 0 0 1 4-4z" />
      <path d="M7 11v3M5.5 12.5h3M16 12h.01M18 13.5h.01" />
    </>
  ),
  phone: (
    <>
      <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
      <path d="M11 18h2" />
    </>
  ),
  lock: (
    <>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
      <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
    </>
  ),
  download: <path d="M12 4v11M7 10l5 5 5-5M4 20h16" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" />
    </>
  ),
  sliders: <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4" />,
  pin: <path d="M9 3h6l-1 6 3 3H7l3-3zM12 12v9" />,
}

export type IconName = keyof typeof PATHS

export function Icon({ name, size = '1.5em', className }: { name: string; size?: string; className?: string }): ReactNode {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name] ?? PATHS.info}
    </svg>
  )
}
