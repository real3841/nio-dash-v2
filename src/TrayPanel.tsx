import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchChangeData, fetchPowerData, fetchVehicleData, loadFetchMeta } from "./lib/storage";
import { extractVehicleStatus, statusFlagOn } from "./lib/vehicle";
import { subscribeNativeEvent } from "./platform/native-events";
import { appTransport } from "./platform/transport";
import type { NativeRoute } from "./platform/transport-contract";

interface TraySnapshot {
  soc: number | null;
  range: number | null;
  state: string;
  temperature: number | null;
  locked: boolean | null;
  tyre: string;
  warnings: number;
  power: string;
  updatedAt: number | null;
}

const EMPTY: TraySnapshot = {
  soc: null,
  range: null,
  state: "等待车辆数据",
  temperature: null,
  locked: null,
  tyre: "暂无数据",
  warnings: 0,
  power: "暂无家充数据",
  updatedAt: null,
};

function vehicleState(value: number): string {
  if (value === 1) return "行驶中";
  if (value === 2) return "充电中";
  return "已驻车";
}

function tyreLabel(values: Record<string, number> | undefined): string {
  if (!values || Object.keys(values).length === 0) return "暂无数据";
  const pressures = Object.values(values).filter((value) => Number.isFinite(value) && value > 0);
  if (pressures.length === 0) return "暂无数据";
  const minimum = Math.min(...pressures);
  return minimum < 210 ? "请检查胎压" : "胎压正常";
}

export function TrayPanel() {
  const [snapshot, setSnapshot] = useState<TraySnapshot>(EMPTY);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [vehicleResult, power, change, meta] = await Promise.all([
      fetchVehicleData().catch(() => null),
      fetchPowerData().catch(() => null),
      fetchChangeData().catch(() => null),
      loadFetchMeta().catch(() => null),
    ]);
    const status = vehicleResult ? extractVehicleStatus(vehicleResult.data) : null;
    const warningCount = [
      status?.door_status && Object.values(status.door_status).some((value) => value > 1),
      tyreLabel(status?.tyre_status) === "请检查胎压",
      change == null,
    ].filter(Boolean).length;
    const powerRecord = power as unknown as { ok?: boolean; charging?: boolean; power?: number } | null;
    setSnapshot({
      soc: status?.soc_status.soc ?? null,
      range: status?.soc_status.remaining_range ?? null,
      state: status ? vehicleState(status.exterior_status.vehicle_state) : EMPTY.state,
      temperature: status?.hvac_status.outside_temperature ?? null,
      locked: status ? statusFlagOn(status.door_status.vehicle_lock_status) : null,
      tyre: tyreLabel(status?.tyre_status),
      warnings: warningCount,
      power: powerRecord?.charging
        ? `正在充电${typeof powerRecord.power === "number" ? ` · ${powerRecord.power} kW` : ""}`
        : powerRecord?.ok
          ? "家充在线"
          : "暂无家充数据",
      updatedAt: meta?.at ?? null,
    });
  }, []);

  useEffect(() => {
    void load();
    const unsubscribeDashboard = subscribeNativeEvent("dashboard.updated", () => void load());
    return () => {
      unsubscribeDashboard();
    };
  }, [load]);

  const open = useCallback((route: NativeRoute) => {
    void appTransport.call("app.openDashboard", { route });
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await appTransport.call("sync.refresh", { target: "all" });
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const updated = useMemo(() => {
    if (!snapshot.updatedAt) return "尚未同步";
    return `更新于 ${new Date(snapshot.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  }, [snapshot.updatedAt]);

  return (
    <main className="tray-panel">
      <header className="tray-header">
        <button className="tray-vehicle-title" type="button" onClick={() => open("dashboard")}>
          <span className="tray-app-icon" aria-hidden="true">
            <svg viewBox="0 0 200 188">
              <path d="M141.76 83.54c1.62 3.96 1.94 5.73 3.4 8.83 1.2 2.51 2.59 4.37 4.47 5.74 3.85 2.8 8.73 2.9 14.62 2.9H200c0-26.79-10.53-52.48-29.29-71.42C151.96 10.64 126.52 0 100 0S48.04 10.64 29.29 29.59C10.53 48.53 0 74.22 0 101.01h35.75c5.89 0 10.76-.1 14.62-2.9 1.88-1.37 3.27-3.23 4.47-5.74 1.46-3.1 1.78-4.87 3.4-8.83 7-17.06 23.48-28.18 41.76-28.18s34.76 11.12 41.76 28.18Z" />
              <path d="m152.53 187.88-40.08-40.89c-4.73-4.83-7.95-7.82-11.94-7.82-4 0-7.22 2.99-11.95 7.82l-40.08 40.89a101.2 101.2 0 0 1-37.37-41.67l35.53-36.25c3.54-3.61 6.06-6.08 9.75-7.5 3.66-1.41 7.63-1.45 13.35-1.45h61.54c5.72 0 9.69.04 13.35 1.45 3.69 1.42 6.21 3.89 9.74 7.5l35.54 36.25a101.3 101.3 0 0 1-37.38 41.67Z" />
            </svg>
          </span>
          <span>
            <strong>我的蔚来</strong>
            <small>
              <i /> {snapshot.soc == null ? "—" : `${snapshot.soc.toFixed(1)}%`} ·{" "}
              {snapshot.range == null ? "— km" : `${Math.round(snapshot.range)} km`} · {snapshot.state}
            </small>
          </span>
        </button>
        <button className="tray-round-button" type="button" onClick={() => open("settings/token")} aria-label="打开设置">
          ⚙
        </button>
        <button
          className={`tray-round-button tray-refresh ${refreshing ? "is-spinning" : ""}`}
          type="button"
          onClick={() => void refresh()}
          aria-label="立即刷新"
          disabled={refreshing}
        >
          ↻
        </button>
      </header>

      <button className="tray-car-scene" type="button" onClick={() => open("dashboard")} aria-label="打开完整看板">
        <svg className="tray-car-graphic" viewBox="0 0 340 155" aria-hidden="true">
          <defs>
            <linearGradient id="tray-car-body" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#f4f6fa" />
              <stop offset=".55" stopColor="#dce1e9" />
              <stop offset="1" stopColor="#b7bec9" />
            </linearGradient>
            <linearGradient id="tray-glass" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#6f88ad" />
              <stop offset=".5" stopColor="#b7c6dc" />
              <stop offset="1" stopColor="#6f88ad" />
            </linearGradient>
          </defs>
          <ellipse cx="171" cy="83" rx="145" ry="63" fill="rgba(0,0,0,.35)" />
          <rect x="68" y="8" width="43" height="22" rx="8" fill="#171d27" />
          <rect x="229" y="8" width="43" height="22" rx="8" fill="#171d27" />
          <rect x="68" y="125" width="43" height="22" rx="8" fill="#171d27" />
          <rect x="229" y="125" width="43" height="22" rx="8" fill="#171d27" />
          <path d="M42 77c0-33 30-55 71-58 38-3 76-3 114 0 41 3 71 25 71 58s-30 55-71 58c-38 3-76 3-114 0-41-3-71-25-71-58Z" fill="url(#tray-car-body)" stroke="#f9fbff" strokeWidth="2" />
          <path d="M66 77c0-25 19-41 48-45l9 90c-34-3-57-19-57-45Zm208 0c0-25-19-41-48-45l-9 90c34-3 57-19 57-45Z" fill="none" stroke="#aeb7c5" strokeDasharray="4 5" opacity=".55" />
          <path d="M126 32h88l13 24v42l-13 24h-88l-13-24V56l13-24Z" fill="url(#tray-glass)" />
          <rect x="138" y="39" width="64" height="76" rx="22" fill="#dfe5ee" stroke="#b5bfce" />
          <path d="M142 77h56" stroke="#aab4c2" strokeWidth="7" strokeLinecap="round" />
          <path d="M151 77h38" stroke="#27c36a" strokeWidth="7" strokeLinecap="round" />
          <rect x="130" y="18" width="40" height="12" rx="6" fill="#e7ebf1" stroke="#c3cad4" />
          <rect x="173" y="18" width="40" height="12" rx="6" fill="#e7ebf1" stroke="#c3cad4" />
          <rect x="130" y="125" width="40" height="12" rx="6" fill="#f5f6f8" stroke="#c3cad4" />
          <rect x="173" y="125" width="40" height="12" rx="6" fill="#f5f6f8" stroke="#c3cad4" />
          <path d="M50 49c-6 8-9 17-9 28m9 29c-6-8-9-17-9-28" fill="none" stroke="#8ba0bd" strokeWidth="5" strokeLinecap="round" />
          <path d="M291 46c5 9 8 19 8 31m-8 31c5-9 8-19 8-31" fill="none" stroke="#d7dde7" strokeWidth="4" strokeLinecap="round" />
          <circle cx="236" cy="117" r="9" fill="none" stroke="#ff9e00" strokeWidth="3" />
        </svg>
        <span className="tray-car-badge">
          {snapshot.locked == null ? "状态未知" : snapshot.locked ? "已上锁" : "未上锁"} · {snapshot.tyre}
        </span>
      </button>

      <nav className="tray-actions" aria-label="快捷操作">
        <button type="button" onClick={() => void refresh()}>刷新</button>
        <button type="button" onClick={() => open("dashboard")}>看板</button>
        <button type="button" onClick={() => open("settings/token")}>Token</button>
        <button type="button" onClick={() => open("settings/log")}>日志</button>
        <button type="button" onClick={() => void appTransport.call("app.quit", {})}>退出</button>
      </nav>

      <section className="tray-pills">
        <span className="active">车辆</span>
        <span>能源</span>
        <span>安全 {snapshot.warnings > 0 && <b>{snapshot.warnings}</b>}</span>
      </section>

      <section className="tray-grid">
        <article className="tray-card blue">
          <span className="tray-card-icon">⌁</span>
          <span><strong>车辆状态</strong><small>{snapshot.state} · {snapshot.locked ? "已锁车" : "请确认锁车"}</small></span>
        </article>
        <article className="tray-card warm">
          <span className="tray-card-icon">◌</span>
          <span><strong>环境温度</strong><small>{snapshot.temperature == null ? "暂无数据" : `${snapshot.temperature.toFixed(1)} °C`}</small></span>
        </article>
        <article className="tray-card">
          <span className="tray-card-icon">◉</span>
          <span><strong>轮胎</strong><small>{snapshot.tyre}</small></span>
        </article>
        <article className="tray-card">
          <span className="tray-card-icon">ϟ</span>
          <span><strong>家充</strong><small>{snapshot.power}</small></span>
        </article>
      </section>

      <footer>
        <span>{updated}</span>
        <button type="button" onClick={() => open("settings/log")}>查看诊断</button>
      </footer>
    </main>
  );
}
