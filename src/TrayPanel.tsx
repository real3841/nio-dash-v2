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
          <span className="tray-app-icon">⌁</span>
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
        <span className="tray-road-line left" />
        <span className="tray-road-line right" />
        <svg viewBox="0 0 180 280" aria-hidden="true">
          <defs>
            <linearGradient id="tray-car-body" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#586273" />
              <stop offset="1" stopColor="#1b202a" />
            </linearGradient>
          </defs>
          <ellipse cx="90" cy="145" rx="65" ry="118" fill="rgba(0,0,0,.44)" />
          <rect x="42" y="18" width="96" height="242" rx="42" fill="url(#tray-car-body)" stroke="rgba(255,255,255,.22)" />
          <path d="M58 74 Q90 48 122 74 L116 121 H64 Z" fill="#17243a" />
          <path d="M64 158 H116 L123 215 Q90 235 57 215 Z" fill="#17212f" />
          <rect x="60" y="125" width="60" height="30" rx="10" fill="#252b35" />
          <path d="M50 42 Q90 23 130 42" stroke="#e7f1ff" strokeWidth="4" strokeLinecap="round" />
          <path d="M52 238 Q90 252 128 238" stroke="#ff6a5f" strokeWidth="4" strokeLinecap="round" />
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
