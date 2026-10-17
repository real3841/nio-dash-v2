interface Props {
  hasCharger: boolean;
  locked: boolean | null;
  tyre: string;
}

export function TrayVehicleScene({ hasCharger, locked, tyre }: Props) {
  return (
    <div className={`tray-car-scene ${hasCharger ? "has-charger" : ""}`}>
      <svg className="tray-car-graphic" viewBox={hasCharger ? "0 0 440 155" : "0 0 340 155"} aria-hidden="true">
        <defs>
          <linearGradient id="tray-car-body" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#384252" />
            <stop offset=".55" stopColor="#252e3d" />
            <stop offset="1" stopColor="#1a202b" />
          </linearGradient>
          <linearGradient id="tray-glass" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#17233a" />
            <stop offset=".5" stopColor="#253b60" />
            <stop offset="1" stopColor="#17233a" />
          </linearGradient>
          <radialGradient id="charger-glow">
            <stop offset="0" stopColor="#ffbd67" stopOpacity=".45" />
            <stop offset="1" stopColor="#ffbd67" stopOpacity="0" />
          </radialGradient>
        </defs>
        <ellipse cx="172" cy="80" rx="150" ry="62" fill="rgba(0,0,0,.38)" />
        <rect x="68" y="8" width="43" height="22" rx="7" fill="#080d13" stroke="#185f53" />
        <rect x="229" y="8" width="43" height="22" rx="7" fill="#080d13" stroke="#185f53" />
        <rect x="68" y="125" width="43" height="22" rx="7" fill="#080d13" stroke="#185f53" />
        <rect x="229" y="125" width="43" height="22" rx="7" fill="#080d13" stroke="#185f53" />
        <path d="M44 77 4 46v62Z" fill="rgba(224,232,247,.14)" />
        <rect x="160" y="16" width="10" height="8" rx="2" fill="#2b3442" />
        <rect x="160" y="130" width="10" height="8" rx="2" fill="#2b3442" />
        <path d="M76 22H272Q300 22 302 50V104Q300 132 272 132H76Q46 130 43 100V54Q46 24 76 22Z" fill="url(#tray-car-body)" stroke="#4a5567" strokeWidth="2" />
        <path d="M112 30H240Q256 30 258 46V108Q256 124 240 124H112Q98 124 96 108V46Q98 30 112 30Z" fill="url(#tray-glass)" />
        <rect x="136" y="38" width="86" height="78" rx="12" fill="#17202e" stroke="#394456" />
        <path d="M150 64h58" stroke="#445065" strokeWidth="5" strokeLinecap="round" />
        <path d="M160 64h44" stroke="#2ac86d" strokeWidth="5" strokeLinecap="round" />
        <circle cx="179" cy="90" r="9" fill="#bd9160" opacity=".55" />
        <circle cx="179" cy="90" r="3.5" fill="#ffd394" />
        <path d="M49 46Q42 77 49 108" fill="none" stroke="#e4edf9" strokeWidth="4" strokeLinecap="round" strokeDasharray="10 5" />
        <path d="M297 50Q303 77 297 104" fill="none" stroke="#ed5367" strokeWidth="4" strokeLinecap="round" />
        {hasCharger && (
          <g>
            <ellipse cx="389" cy="77" rx="48" ry="66" fill="url(#charger-glow)" />
            <rect x="370" y="25" width="40" height="106" rx="11" fill="#252d3a" stroke="#424c5c" />
            <rect x="376" y="35" width="28" height="28" rx="6" fill="#080e18" />
            <circle cx="390" cy="75" r="3" fill="#39dc8b" />
            <rect x="367" y="130" width="46" height="7" rx="3.5" fill="#0a0d12" opacity=".55" />
          </g>
        )}
      </svg>
      <span className="tray-car-badge">
        {locked == null ? "状态未知" : locked ? "已上锁" : "未上锁"} · {tyre}
      </span>
    </div>
  );
}
