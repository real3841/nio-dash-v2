interface Props {
  hasCharger: boolean;
  locked: boolean | null;
  tyre: string;
}

export function TrayVehicleScene({ hasCharger, locked, tyre }: Props) {
  return (
    <div className="tray-car-scene">
      <svg className="tray-car-graphic" viewBox="20 18 740 264" aria-hidden="true">
        <defs>
          <linearGradient id="tray-car-body" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#4a5163" />
            <stop offset="1" stopColor="#222733" />
          </linearGradient>
          <linearGradient id="tray-car-glass" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#36486b" />
            <stop offset="1" stopColor="#131a28" />
          </linearGradient>
          <radialGradient id="tray-car-lamp" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="#ffcf8a" stopOpacity="0.55" />
            <stop offset="1" stopColor="#ffcf8a" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="tray-car-beam" cx="0" cy="0.5" r="1">
            <stop offset="0" stopColor="#cfe0ff" stopOpacity="0.35" />
            <stop offset="1" stopColor="#cfe0ff" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect x="40" y="34" width="700" height="232" rx="26" fill="rgba(255,255,255,0.025)" stroke="rgba(255,255,255,0.06)" />
        <path d="M 120 50 V 250 M 660 50 V 250" stroke="rgba(255,255,255,0.07)" strokeDasharray="10 10" />
        <g transform="rotate(180 390 150)">
          {hasCharger && <circle cx="75" cy="150" r="90" fill="url(#tray-car-lamp)" />}
          <ellipse cx="390" cy="158" rx="236" ry="96" fill="rgba(0,0,0,0.45)" />
          <path d="M 612 150 L 760 70 L 760 230 Z" fill="url(#tray-car-beam)" />
          {hasCharger && (
            <g>
              <rect x="50" y="74" width="50" height="152" rx="14" fill="#2b313d" stroke="rgba(255,255,255,0.18)" />
              <rect x="60" y="188" width="30" height="22" rx="5" fill="#0a0d12" />
              <circle cx="75" cy="172" r="4" fill="#34d399" />
              <rect x="42" y="68" width="66" height="10" rx="5" fill="#1b1f27" />
            </g>
          )}
          <rect x="206" y="56" width="58" height="20" rx="7" fill="#05070b" stroke="rgba(52,211,153,0.6)" />
          <rect x="481" y="56" width="58" height="20" rx="7" fill="#05070b" stroke="rgba(52,211,153,0.6)" />
          <rect x="206" y="224" width="58" height="20" rx="7" fill="#05070b" stroke="rgba(52,211,153,0.6)" />
          <rect x="481" y="224" width="58" height="20" rx="7" fill="#05070b" stroke="rgba(52,211,153,0.6)" />
          <path d="M 215 72 H 540 C 585 72 610 100 612 150 C 610 200 585 228 540 228 H 215 C 185 228 168 205 168 150 C 168 95 185 72 215 72 Z" fill="url(#tray-car-body)" stroke="rgba(255,255,255,0.18)" />
          <rect x="436" y="62" width="16" height="10" rx="4" fill="#3a4152" />
          <rect x="436" y="228" width="16" height="10" rx="4" fill="#3a4152" />
          <path d="M 236 84 H 215 C 192 84 180 108 180 150 C 180 192 192 216 215 216 H 236 Q 226 150 236 84 Z" fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.1)" strokeDasharray="4 4" />
          <path d="M 474 84 H 540 C 578 84 598 108 600 150 C 598 192 578 216 540 216 H 474 Q 484 150 474 84 Z" fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.1)" strokeDasharray="4 4" />
          <path d="M 270 98 Q 242 102 240 150 Q 242 198 270 202 Z" fill="url(#tray-car-glass)" />
          <path d="M 432 96 Q 470 100 472 150 Q 470 200 432 204 Z" fill="url(#tray-car-glass)" />
          <rect x="272" y="96" width="158" height="108" rx="22" fill="#1d222c" stroke="rgba(255,255,255,0.12)" />
          <rect x="296" y="170" width="110" height="8" rx="4" fill="rgba(255,255,255,0.1)" />
          <rect x="296" y="170" width="88.5" height="8" rx="4" fill="#22c55e" />
          <circle cx="351" cy="138" r="18" fill="rgba(255,200,130,0.18)" />
          <circle cx="351" cy="138" r="5" fill="#ffd9a0" />
          <path d="M 590 96 Q 604 108 606 124" stroke="#e8f0ff" strokeWidth="4" strokeLinecap="round" fill="none" />
          <path d="M 590 204 Q 604 192 606 176" stroke="#e8f0ff" strokeWidth="4" strokeLinecap="round" fill="none" />
          <path d="M 174 104 Q 168 150 174 196" stroke="#ff4d4d" strokeWidth="4" strokeLinecap="round" fill="none" opacity="0.8" />
        </g>
      </svg>
      <span className="tray-car-badge">
        {locked == null ? "状态未知" : locked ? "已上锁" : "未上锁"} · {tyre}
      </span>
    </div>
  );
}
