function Icon({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <svg className="pictogram" viewBox="0 0 64 64" role="img" aria-label={label} focusable="false">
      {children}
    </svg>
  );
}

const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 3.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export function KeyholeIcon({ label }: { label: string }) {
  return (
    <Icon label={label}>
      <circle cx="36" cy="18" r="9" {...STROKE} />
      <path d="M29 25 L26 46 Q26 53 36 53 Q46 53 46 46 L43 25" {...STROKE} />
      <path d="M8 12 C 8 26, 16 30, 22 27" {...STROKE} />
      <path d="M22 27 l -7 -2 M22 27 l -1 7" {...STROKE} />
    </Icon>
  );
}

export function WindIcon({ label }: { label: string }) {
  return (
    <Icon label={label}>
      <line x1="32" y1="6" x2="32" y2="58" {...STROKE} />
      <ellipse cx="32" cy="16" rx="15" ry="5" {...STROKE} />
      <ellipse cx="32" cy="28" rx="15" ry="5" {...STROKE} />
      <ellipse cx="32" cy="40" rx="15" ry="5" {...STROKE} />
      <ellipse cx="32" cy="52" rx="15" ry="5" {...STROKE} />
    </Icon>
  );
}

export function PressIcon({ label }: { label: string }) {
  return (
    <Icon label={label}>
      <path d="M32 8 V38" {...STROKE} />
      <path d="M20 28 L32 40 L44 28" {...STROKE} />
      <line x1="14" y1="52" x2="50" y2="52" {...STROKE} />
    </Icon>
  );
}

export function TwistIcon({ label }: { label: string }) {
  return (
    <Icon label={label}>
      <path d="M32 8 V22" {...STROKE} />
      <path d="M20 30 A16 16 0 1 0 44 30" {...STROKE} />
      <path d="M44 30 l 8 -2 M44 30 l 2 8" {...STROKE} />
    </Icon>
  );
}

export function ClickIcon({ label }: { label: string }) {
  return (
    <Icon label={label}>
      <path d="M22 10 V34 C22 42, 32 42, 32 34 V26" {...STROKE} />
      <path d="M42 44 L52 34 M52 44 L42 34" {...STROKE} />
    </Icon>
  );
}

export function GlueDropIcon({ label }: { label: string }) {
  return (
    <Icon label={label}>
      <path d="M32 8 C 20 26, 14 34, 14 42 A18 18 0 0 0 50 42 C 50 34, 44 26, 32 8 Z" {...STROKE} />
    </Icon>
  );
}

export function WallMountIcon({ label }: { label: string }) {
  return (
    <Icon label={label}>
      <line x1="14" y1="8" x2="14" y2="56" {...STROKE} />
      <path d="M14 14 L6 22 M14 24 L6 32 M14 34 L6 42 M14 44 L6 52" {...STROKE} />
      <circle cx="14" cy="32" r="4" {...STROKE} />
      <path d="M22 32 H50" {...STROKE} />
      <path d="M42 24 L50 32 L42 40" {...STROKE} />
    </Icon>
  );
}

export function ScrewdriverIcon({ label }: { label: string }) {
  return (
    <Icon label={label}>
      <circle cx="16" cy="32" r="8" {...STROKE} />
      <path d="M28 32 H44" {...STROKE} />
      <path d="M44 22 L58 32 L44 42 Z" {...STROKE} />
    </Icon>
  );
}

export function RotateIcon({ label }: { label: string }) {
  return (
    <Icon label={label}>
      <circle cx="32" cy="32" r="10" {...STROKE} />
      <path d="M32 8 A24 24 0 1 1 11 20" {...STROKE} />
      <path d="M11 20 l -2 -10 M11 20 l 10 3" {...STROKE} />
    </Icon>
  );
}

export function NoPullIcon({ label }: { label: string }) {
  return (
    <Icon label={label}>
      <path d="M10 32 H40" {...STROKE} />
      <path d="M40 32 l -7 -6 M40 32 l -7 6" {...STROKE} />
      <path d="M42 14 C 48 20, 52 26, 52 32 C 52 40, 46 46, 42 50" {...STROKE} />
      <line x1="14" y1="12" x2="50" y2="52" {...STROKE} />
    </Icon>
  );
}

export function NoSupportsIcon({ label }: { label: string }) {
  return (
    <Icon label={label}>
      <line x1="8" y1="52" x2="56" y2="52" {...STROKE} />
      <path d="M18 52 L18 26 L46 26 L46 52" {...STROKE} />
      <circle cx="32" cy="16" r="10" {...STROKE} />
      <line x1="24.5" y1="8.5" x2="39.5" y2="23.5" {...STROKE} />
    </Icon>
  );
}
