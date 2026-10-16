const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export function ShareIcon() {
  return (
    <svg className="action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g {...STROKE}>
        <path d="M8 10H6a1.5 1.5 0 0 0-1.5 1.5v8A1.5 1.5 0 0 0 6 21h12a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 18 10h-2" />
        <path d="M12 15.5V3M8.2 6.8 12 3l3.8 3.8" />
      </g>
    </svg>
  );
}

export function ResetIcon() {
  return (
    <svg className="action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g {...STROKE}>
        <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5" />
        <path d="M3.5 3.8v4.7h4.7" />
      </g>
    </svg>
  );
}
