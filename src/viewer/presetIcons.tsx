import type { PresetId } from "./lineArt/presets";

const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
const THIN = { strokeWidth: 1.3 };

const ICONS: Record<PresetId, React.ReactNode> = {
  front: (
    <g {...STROKE}>
      <path d="M2.5 19.5h19V17h-19z" />
      <path d="M6 17V5h12v12" />
      <path d="M6 9h12M6 13h12" {...THIN} />
    </g>
  ),
  iso: (
    <g {...STROKE}>
      <ellipse cx="12" cy="6" rx="6" ry="2.4" />
      <ellipse cx="12" cy="6" rx="3.4" ry="1.2" {...THIN} />
      <path d="M6 6v9M18 6v9" />
      <path d="M6 10c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4" {...THIN} />
      <path d="M6 14.2c-2.8.5-4.5 1.3-4.5 2.3 0 1.8 4.7 3.2 10.5 3.2s10.5-1.4 10.5-3.2c0-1-1.7-1.8-4.5-2.3" />
    </g>
  ),
  wallRoom: (
    <g {...STROKE}>
      <path d="M2.5 2.5v19" />
      <path d="M2.5 6 1 7.5M2.5 10.5 1 12M2.5 15 1 16.5M2.5 19.5 1 21" strokeWidth={1.2} />
      <path d="M5.5 3v18" />
      <path d="M5.5 6.5h11M5.5 17.5h11" />
      <ellipse cx="16.5" cy="12" rx="2.8" ry="5.5" />
      <path d="M9.5 6.5v11M13 6.5v11" {...THIN} />
    </g>
  ),
  mountSide: (
    <>
      <circle cx="12" cy="12" r="9.5" {...STROKE} />
      <g fill="currentColor">
        <rect x="7.4" y="6.6" width="2.4" height="4.4" rx="1.2" />
        <rect x="14.2" y="6.6" width="2.4" height="4.4" rx="1.2" />
        <rect x="7.4" y="13" width="2.4" height="4.4" rx="1.2" />
        <rect x="14.2" y="13" width="2.4" height="4.4" rx="1.2" />
      </g>
    </>
  ),
  printLayout: (
    <g {...STROKE}>
      <path d="M1.5 15.5 12 10l10.5 5.5L12 21z" />
      <path d="M4.5 13.5v-5M11.5 13.5v-5" />
      <ellipse cx="8" cy="8.5" rx="3.5" ry="1.6" />
      <path d="M4.5 13.5c0 .9 1.6 1.6 3.5 1.6s3.5-.7 3.5-1.6" />
      <ellipse cx="15.5" cy="15.8" rx="3.4" ry="1.6" />
    </g>
  ),
};

export function PresetIcon({ id }: { id: PresetId }) {
  return (
    <svg className={`preset-icon preset-icon-${id}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {ICONS[id]}
    </svg>
  );
}
