const attrs = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

export function SearchIcon() {
  return (
    <svg {...attrs}>
      <circle cx="11" cy="11" r="7" />
      <path d="m16.5 16.5 4.5 4.5" />
    </svg>
  )
}

export function HomeIcon() {
  return (
    <svg {...attrs}>
      <path d="m3 11 9-8 9 8" />
      <path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5" />
    </svg>
  )
}

export function ChatIcon() {
  return (
    <svg {...attrs}>
      <path d="M12 20a8 8 0 1 0-7.1-4.3L4 20l4.3-.9A8 8 0 0 0 12 20Z" />
    </svg>
  )
}

export function PlusIcon() {
  return (
    <svg {...attrs}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export function DocIcon() {
  return (
    <svg {...attrs} width={18} height={18}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  )
}

export function CalendarIcon() {
  return (
    <svg {...attrs} width={14} height={14}>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 10h16M9 3v4M15 3v4" />
    </svg>
  )
}

export function ChevronLeftIcon() {
  return (
    <svg {...attrs} width={14} height={14}>
      <path d="m14 6-6 6 6 6" />
    </svg>
  )
}
