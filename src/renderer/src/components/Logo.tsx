// The MediaOS logo: a glowing TV screen with a play button. Same drawing as assets/brand/mediaos-mark.svg.
import { useId, type ReactNode } from 'react'

export function LogoMark({ size = '2.4rem', className }: { size?: string; className?: string }): ReactNode {
  // Gradient ids must be unique on the page, because the logo can be drawn more than once.
  const id = useId().replace(/:/g, '')
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 512 512" aria-hidden focusable="false">
      <defs>
        <linearGradient id={`${id}t`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1c2333" />
          <stop offset="1" stopColor="#0b0d12" />
        </linearGradient>
        <linearGradient id={`${id}s`} x1="92" y1="118" x2="420" y2="344" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#46d4ff" />
          <stop offset="0.55" stopColor="#4f8cff" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
        <linearGradient id={`${id}h`} x1="0" y1="118" x2="0" y2="344" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity="0.22" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <radialGradient id={`${id}g`} cx="256" cy="236" r="210" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#4f8cff" stopOpacity="0.4" />
          <stop offset="1" stopColor="#4f8cff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="512" height="512" rx="112" fill={`url(#${id}t)`} />
      <rect x="1.5" y="1.5" width="509" height="509" rx="110.5" fill="none" stroke="#fff" strokeOpacity="0.08" strokeWidth="3" />
      <circle cx="256" cy="236" r="210" fill={`url(#${id}g)`} />
      <rect x="92" y="118" width="328" height="226" rx="40" fill={`url(#${id}s)`} />
      <rect x="92" y="118" width="328" height="226" rx="40" fill={`url(#${id}h)`} />
      <path d="M230 186v90l74-45z" fill="#f2f4f8" stroke="#f2f4f8" strokeWidth="26" strokeLinejoin="round" />
      <path d="M206 398h100" stroke="#f2f4f8" strokeOpacity="0.9" strokeWidth="26" strokeLinecap="round" />
    </svg>
  )
}

/** "MediaOS" with "OS" in the brand gradient. Sized by the parent's font-size. */
export function Wordmark({ className }: { className?: string }): ReactNode {
  return (
    <span className={className ? `wordmark ${className}` : 'wordmark'}>
      Media<b>OS</b>
    </span>
  )
}
