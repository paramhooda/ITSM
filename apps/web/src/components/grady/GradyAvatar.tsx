import { cn } from '@/lib/utils';

/** Grady, the service assistant: a friendly cartoon agent with a headset. Pure SVG so it stays crisp at any size. */
export function GradyAvatar({ size = 40, className, mood = 'happy' }: { size?: number; className?: string; mood?: 'happy' | 'thinking' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={cn('shrink-0 select-none', className)} role="img" aria-label="Grady">
      <defs>
        <linearGradient id="grady-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#3b82f6" />
          <stop offset="100%" stopColor="#1d4ed8" />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="31" fill="url(#grady-bg)" />
      {/* shoulders */}
      <path d="M10 62c3-9 11-13 22-13s19 4 22 13z" fill="#1e3a8a" />
      <path d="M22 50c2.5 2 5.5 3 10 3s7.5-1 10-3l-1 7H23z" fill="#dbeafe" />
      {/* neck + head */}
      <rect x="27" y="40" width="10" height="9" rx="4" fill="#f2c9a1" />
      <circle cx="32" cy="31" r="15.5" fill="#ffd9b3" />
      {/* hair */}
      <path d="M16.5 30c-.5-9 6.5-16 15.5-16s16 7 15.5 16c-2-5-6-8-15.5-8s-13.5 3-15.5 8z" fill="#1e293b" />
      {/* headset */}
      <path d="M17.5 31a14.5 14.5 0 0 1 29 0" fill="none" stroke="#0f172a" strokeWidth="2.6" strokeLinecap="round" />
      <rect x="14" y="29" width="5" height="9" rx="2.5" fill="#0f172a" />
      <rect x="45" y="29" width="5" height="9" rx="2.5" fill="#0f172a" />
      <path d="M47.5 38c0 6-4 9-9.5 9.5" fill="none" stroke="#0f172a" strokeWidth="2" strokeLinecap="round" />
      <circle cx="37.5" cy="47.8" r="2" fill="#0f172a" />
      {/* eyes */}
      {mood === 'thinking' ? (
        <>
          <path d="M24 33h5" stroke="#0f172a" strokeWidth="2.4" strokeLinecap="round" />
          <ellipse cx="38.5" cy="33" rx="2.2" ry="2.8" fill="#0f172a" />
          <circle cx="39.2" cy="32" r=".8" fill="#fff" />
        </>
      ) : (
        <>
          <ellipse cx="26" cy="33" rx="2.2" ry="2.8" fill="#0f172a" />
          <ellipse cx="38" cy="33" rx="2.2" ry="2.8" fill="#0f172a" />
          <circle cx="26.8" cy="32" r=".8" fill="#fff" />
          <circle cx="38.8" cy="32" r=".8" fill="#fff" />
        </>
      )}
      {/* cheeks + smile */}
      <circle cx="22.5" cy="38.5" r="2.4" fill="#f9a8d4" opacity=".65" />
      <circle cx="41.5" cy="38.5" r="2.4" fill="#f9a8d4" opacity=".65" />
      <path d={mood === 'thinking' ? 'M27.5 41.5q4.5 2.5 9 0' : 'M26.5 40.5q5.5 5.5 11 0'} fill="none" stroke="#0f172a" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}
