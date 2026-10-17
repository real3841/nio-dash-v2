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
        <ellipse cx="171" cy="83" rx="145" ry="63" fill="rgba(0,0,0,.38)" />
        <rect x="68" y="8" width="43" height="22" rx="7" fill="#080d13" stroke="#185f53" />
        <rect x="229" y="8" width="43" height="22" rx="7" fill="#080d13" stroke="#185f53" />
        <rect x="68" y="125" width="43" height="22" rx="7" fill="#080d13" stroke="#185f53" />
        <rect x="229" y="125" width="43" height="22" rx="7" fill="#080d13" stroke="#185f53" />
        <path d="M42 77c0-33 30-55 71-58 38-3 76-3 114 0 41 3 71 25 71 58s-30 55-71 58c-38 3-76 3-114 0-41-3-71-25-71-58Z" fill="url(#tray-car-body)" stroke="#4a5567" strokeWidth="2" />
        <path d="M66 77c0-25 19-41 48-45l9 90c-34-3-57-19-57-45Zm208 0c0-25-19-41-48-45l-9 90c34-3 57-19 57-45Z" fill="none" stroke="#596578" strokeDasharray="4 5" opacity=".55" />
        <path d="M126 32h88l13 24v42l-13 24h-88l-13-24V56l13-24Z" fill="url(#tray-glass)" />
        <rect x="138" y="39" width="64" height="76" rx="17" fill="#17202e" stroke="#394456" />
        <path d="M143 77h54" stroke="#445065" strokeWidth="6" strokeLinecap="round" />
        <path d="M151 77h38" stroke="#2ac86d" strokeWidth="6" strokeLinecap="round" />
        <circle cx="170" cy="96" r="9" fill="#bd9160" opacity=".7" />
        <circle cx="170" cy="96" r="3" fill="#ffd394" />
        <path d="M44 49 10 77l34 28Z" fill="rgba(224,232,247,.12)" />
        <path d="M50 49c-6 8-9 17-9 28m9 29c-6-8-9-17-9-28" fill="none" stroke="#e4edf9" strokeWidth="4" strokeLinecap="round" />
        <path d="M291 46c5 9 8 19 8 31m-8 31c5-9 8-19 8-31" fill="none" stroke="#ed5367" strokeWidth="4" strokeLinecap="round" />
        <circle cx="236" cy="117" r="8" fill="none" stroke="#ff9e00" strokeWidth="2.5" />
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
