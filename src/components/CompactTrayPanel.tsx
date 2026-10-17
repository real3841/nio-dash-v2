import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";
import { fetchChangeData, fetchPowerData, fetchVehicleData, loadChangeFetchMeta, loadFetchMeta, type FetchMeta } from "../lib/storage";
import {
  DEFAULT_TRAY_LAYOUT,
  TRAY_ACTION_IDS,
  TRAY_CARD_SECTION,
  TRAY_EXTRA_IDS,
  loadTrayLayout,
  moveTrayCard,
  saveTrayLayout,
  wideCards,
  type TrayActionId,
  type TrayCardId,
  type TrayExtraId,
  type TrayLayout,
  type TraySection,
} from "../lib/tray-layout";
import { extractVehicleStatus, pollVehicleState, statusFlagOn } from "../lib/vehicle";
import { sortedMonthKeys, workStateLabel, type PowerFile } from "../lib/power";
import { analyzeServiceOrders } from "../lib/change";
import { fetchEnvConfig } from "../lib/env-config";
import { changeScheduleLabel, monthPowerSummary, vehicleScheduleLabel, type MonthPowerSummary } from "../lib/tray-extras";
import { subscribeNativeEvent } from "../platform/native-events";
import { appTransport } from "../platform/transport";
import type { NativeRoute } from "../platform/transport-contract";
import { IconBattery, IconKey, IconLock, IconPlug, IconTemp, IconTyre } from "./icons";
import { TrayVehicleScene } from "./TrayVehicleScene";

interface TraySnapshot {
  soc: number | null;
  range: number | null;
  state: string;
  insideTemperature: number | null;
  outsideTemperature: number | null;
  locked: boolean | null;
  tyre: string;
  tyreDetail: string;
  warnings: number;
  hasPower: boolean;
  powerState: string;
  monthPower: string | null;
  monthSummary: MonthPowerSummary | null;
  vehicleSchedule: string;
  changeSchedule: string;
  vehicleFetch: FetchMeta | null;
  changeFetch: FetchMeta | null;
  swapCount: number | null;
}

const EMPTY: TraySnapshot = {
  soc: null,
  range: null,
  state: "等待车辆数据",
  insideTemperature: null,
  outsideTemperature: null,
  locked: null,
  tyre: "暂无数据",
  tyreDetail: "暂无胎压",
  warnings: 0,
  hasPower: false,
  powerState: "暂无家充数据",
  monthPower: null,
  monthSummary: null,
  vehicleSchedule: vehicleScheduleLabel(undefined, null, new Date().getHours()),
  changeSchedule: changeScheduleLabel(undefined),
  vehicleFetch: null,
  changeFetch: null,
  swapCount: null,
};

const CARD_LABELS: Record<TrayCardId, string> = {
  battery: "电池",
  lock: "车锁",
  temperature: "温度",
  tyre: "胎压",
  charger: "家充桩",
  monthPower: "本月家充（有家充数据时显示）",
};

const EXTRA_LABELS: Record<TrayExtraId, string> = {
  schedule: "拉取频率标签",
  sections: "分区标题",
  swapCount: "底部换电次数",
};

const SECTION_TITLES: Record<TraySection, string> = {
  vehicle: "车 况",
  charging: "充 电",
};

function fetchStatus(label: string, meta: FetchMeta | null): string {
  if (!meta) return `${label} 尚未同步`;
  const date = new Date(meta.at);
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const today = date.toDateString() === new Date().toDateString();
  return `${label} ${meta.ok ? "✓" : "✕"} ${today ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`}`;
}

const ACTION_LABELS: Record<TrayActionId, string> = {
  refresh: "刷新",
  dashboard: "看板",
  token: "Token",
  log: "日志",
  quit: "退出",
};

function vehicleState(value: number): string {
  if (value === 1) return "行驶中";
  if (value === 2) return "充电中";
  return "已驻车";
}

function tyreSummary(values: Record<string, number> | undefined): { label: string; detail: string; warning: boolean } {
  if (!values) return { label: "暂无数据", detail: "暂无胎压", warning: false };
  const pressures = Object.values(values).filter((value) => Number.isFinite(value) && value > 0);
  if (pressures.length === 0) return { label: "暂无数据", detail: "暂无胎压", warning: false };
  const average = pressures.reduce((total, value) => total + value, 0) / pressures.length;
  const bar = average > 20 ? average / 100 : average;
  const warning = (average > 20 ? Math.min(...pressures) < 210 : Math.min(...pressures) < 2.1);
  return { label: warning ? "请检查胎压" : "胎压正常", detail: `${bar.toFixed(1)} bar`, warning };
}

function hasPowerDetails(power: PowerFile | null): power is PowerFile {
  return Boolean(
    power && (
      power.spot ||
      power.realtime ||
      power.services?.length ||
      Object.keys(power.months ?? {}).length
    ),
  );
}

/** 让原生面板高度跟随内容，超出屏幕时由原生侧封顶、网页内滚动。 */
function useNativePanelHeight() {
  const [node, setNode] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!node || appTransport.kind !== "wkwebview") return;
    let reported = 0;
    const observer = new ResizeObserver(() => {
      const height = Math.ceil(node.getBoundingClientRect().height);
      if (height === reported) return;
      reported = height;
      void appTransport.call("app.resizePanel", { height }).catch(() => undefined);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return setNode;
}

function NioMark() {
  return (
    <svg viewBox="0 0 200 188" aria-hidden="true">
      <path d="M141.76 83.54c1.62 3.96 1.94 5.73 3.4 8.83 1.2 2.51 2.59 4.37 4.47 5.74 3.85 2.8 8.73 2.9 14.62 2.9H200c0-26.79-10.53-52.48-29.29-71.42C151.96 10.64 126.52 0 100 0S48.04 10.64 29.29 29.59C10.53 48.53 0 74.22 0 101.01h35.75c5.89 0 10.76-.1 14.62-2.9 1.88-1.37 3.27-3.23 4.47-5.74 1.46-3.1 1.78-4.87 3.4-8.83 7-17.06 23.48-28.18 41.76-28.18s34.76 11.12 41.76 28.18Z" />
      <path d="m152.53 187.88-40.08-40.89c-4.73-4.83-7.95-7.82-11.94-7.82-4 0-7.22 2.99-11.95 7.82l-40.08 40.89a101.2 101.2 0 0 1-37.37-41.67l35.53-36.25c3.54-3.61 6.06-6.08 9.75-7.5 3.66-1.41 7.63-1.45 13.35-1.45h61.54c5.72 0 9.69.04 13.35 1.45 3.69 1.42 6.21 3.89 9.74 7.5l35.54 36.25a101.3 101.3 0 0 1-37.38 41.67Z" />
    </svg>
  );
}

export function CompactTrayPanel() {
  const [snapshot, setSnapshot] = useState<TraySnapshot>(EMPTY);
  const [layout, setLayout] = useState<TrayLayout>(DEFAULT_TRAY_LAYOUT);
  const [draft, setDraft] = useState<TrayLayout>(DEFAULT_TRAY_LAYOUT);
  const [editing, setEditing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<"all" | "vehicle" | "charging">("all");
  const [draggedCard, setDraggedCard] = useState<TrayCardId | null>(null);
  const panelRef = useNativePanelHeight();

  const load = useCallback(async () => {
    const [vehicleResult, power, change, meta, changeMeta, config] = await Promise.all([
      fetchVehicleData().catch(() => null),
      fetchPowerData().catch(() => null),
      fetchChangeData().catch(() => null),
      loadFetchMeta().catch(() => null),
      loadChangeFetchMeta().catch(() => null),
      fetchEnvConfig().catch(() => null),
    ]);
    const status = vehicleResult ? extractVehicleStatus(vehicleResult.data) : null;
    const tyre = tyreSummary(status?.tyre_status);
    const validPower = hasPowerDetails(power) ? power : null;
    const monthKey = validPower ? sortedMonthKeys(validPower)[0] : undefined;
    const month = monthKey ? validPower?.months?.[monthKey] : undefined;
    setSnapshot({
      soc: status?.soc_status.soc ?? null,
      range: status?.soc_status.remaining_range ?? null,
      state: status ? vehicleState(status.exterior_status.vehicle_state) : EMPTY.state,
      insideTemperature: status?.hvac_status.temperature ?? null,
      outsideTemperature: status?.hvac_status.outside_temperature ?? null,
      locked: status ? statusFlagOn(status.door_status.vehicle_lock_status) : null,
      tyre: tyre.label,
      tyreDetail: tyre.detail,
      warnings: [tyre.warning, change == null].filter(Boolean).length,
      hasPower: Boolean(validPower),
      powerState: validPower
        ? validPower.realtime?.effective_state_desc ?? workStateLabel(validPower.spot?.work_state)
        : EMPTY.powerState,
      monthPower: month ? `${month.total_real_charge_kwh.toFixed(1)} kWh` : null,
      monthSummary: monthPowerSummary(validPower),
      vehicleSchedule: vehicleScheduleLabel(config?.vehicle, pollVehicleState(status), new Date().getHours()),
      changeSchedule: changeScheduleLabel(config?.change),
      vehicleFetch: meta,
      changeFetch: changeMeta,
      swapCount: change?.resultData?.data ? analyzeServiceOrders(change).swapCompleted : null,
    });
  }, []);

  useEffect(() => {
    void Promise.all([
      load(),
      loadTrayLayout().then((saved) => {
        setLayout(saved);
        setDraft(saved);
      }),
    ]);
    return subscribeNativeEvent("dashboard.updated", () => void load());
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

  const saveEditing = useCallback(async () => {
    await saveTrayLayout(draft);
    setLayout(draft);
    setEditing(false);
  }, [draft]);

  const toggleEdit = () => {
    if (editing) {
      setDraft(layout);
      setEditing(false);
    } else {
      setDraft(layout);
      setEditing(true);
    }
  };

  const toggleCard = (id: TrayCardId) => {
    setDraft((current) => ({
      ...current,
      hiddenCards: current.hiddenCards.includes(id)
        ? current.hiddenCards.filter((value) => value !== id)
        : [...current.hiddenCards, id],
    }));
  };

  const toggleAction = (id: TrayActionId) => {
    setDraft((current) => ({
      ...current,
      hiddenActions: current.hiddenActions.includes(id)
        ? current.hiddenActions.filter((value) => value !== id)
        : [...current.hiddenActions, id],
    }));
  };

  const toggleExtra = (id: TrayExtraId) => {
    setDraft((current) => ({
      ...current,
      hiddenExtras: current.hiddenExtras.includes(id)
        ? current.hiddenExtras.filter((value) => value !== id)
        : [...current.hiddenExtras, id],
    }));
  };

  const dropCard = (event: DragEvent, target: TrayCardId) => {
    event.preventDefault();
    if (!draggedCard) return;
    setDraft((current) => ({ ...current, cardOrder: moveTrayCard(current.cardOrder, draggedCard, target) }));
    setDraggedCard(null);
  };

  const actionHandlers: Record<TrayActionId, () => void> = {
    refresh: () => void refresh(),
    dashboard: () => open("dashboard"),
    token: () => open("settings/token"),
    log: () => open("settings/log"),
    quit: () => void appTransport.call("app.quit", {}),
  };

  const visibleCards = useMemo(() => layout.cardOrder.filter((id) => {
    if (layout.hiddenCards.includes(id)) return false;
    if (id === "charger" && !snapshot.hasPower) return false;
    if (id === "monthPower" && !snapshot.monthSummary) return false;
    if (activeTab === "all") return true;
    return TRAY_CARD_SECTION[id] === activeTab;
  }), [activeTab, layout, snapshot.hasPower, snapshot.monthSummary]);

  const showExtra = (id: TrayExtraId) => !layout.hiddenExtras.includes(id);

  const cardGroups: { section: TraySection | null; cards: TrayCardId[] }[] = showExtra("sections")
    ? (["vehicle", "charging"] as const)
      .map((section) => ({ section, cards: visibleCards.filter((id) => TRAY_CARD_SECTION[id] === section) }))
      .filter((group) => group.cards.length > 0)
    : [{ section: null, cards: visibleCards }];

  const renderCard = (id: TrayCardId, wide: boolean) => {
    const span = wide ? " tray-card-wide" : "";
    switch (id) {
      case "battery":
        return (
          <article className="tray-info-card tray-battery-card" key={id}>
            <span className="tray-info-icon blue"><IconBattery /></span>
            <span className="tray-info-copy"><strong>电池</strong><small>实际 {snapshot.range == null ? "— km" : `${Math.round(snapshot.range)} km`} · {snapshot.state}</small></span>
            <span className="tray-battery-value">{snapshot.soc == null ? "—" : snapshot.soc.toFixed(1)}<small>%</small></span>
            <button type="button" onClick={() => void refresh()} aria-label="刷新电池状态">↻</button>
          </article>
        );
      case "lock":
        return (
          <article className={`tray-info-card${span}`} key={id}>
            <span className="tray-info-icon"><IconLock /></span>
            <span className="tray-info-copy"><strong>车锁</strong><small>{snapshot.locked == null ? "状态未知" : snapshot.locked ? "已上锁 · 车门全关" : "未上锁 · 请确认"}</small></span>
          </article>
        );
      case "temperature":
        return (
          <article className={`tray-info-card${span}`} key={id}>
            <span className="tray-info-icon"><IconTemp /></span>
            <span className="tray-info-copy"><strong>{snapshot.insideTemperature == null ? "—" : `${snapshot.insideTemperature.toFixed(1)}°`}</strong><small>车内 · 车外 {snapshot.outsideTemperature == null ? "—" : `${snapshot.outsideTemperature.toFixed(1)}°`}</small></span>
          </article>
        );
      case "charger":
        return (
          <article className={`tray-info-card tray-charger-card${span}`} key={id}>
            <span className="tray-info-icon amber"><IconPlug /></span>
            <span className="tray-info-copy"><strong>家充桩</strong><small>{snapshot.powerState}{snapshot.monthPower ? ` · 本月 ${snapshot.monthPower}` : ""}</small></span>
          </article>
        );
      case "tyre":
        return (
          <article className={`tray-info-card${span}`} key={id}>
            <span className="tray-info-icon"><IconTyre /></span>
            <span className="tray-info-copy"><strong>胎压</strong><small>{snapshot.tyreDetail} · {snapshot.tyre}</small></span>
          </article>
        );
      case "monthPower":
        return snapshot.monthSummary && (
          <article className="tray-info-card tray-month-card" key={id}>
            <span className="tray-info-icon hot">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 3 5 14h6l-1 7 8-11h-6z" /></svg>
            </span>
            <span className="tray-info-copy"><strong>{snapshot.monthSummary.title}</strong><small>{snapshot.monthSummary.detail}</small></span>
            <span className="tray-meter"><b style={{ width: `${Math.round(snapshot.monthSummary.ratio * 100)}%` }} /></span>
          </article>
        );
    }
  };

  if (editing) {
    return (
      <main className="tray-panel tray-edit-panel" ref={panelRef}>
        <header className="tray-edit-header">
          <div><strong>编辑小面板</strong><small>拖动卡片调整顺序</small></div>
          <button type="button" onClick={toggleEdit}>取消</button>
        </header>
        <label className="tray-title-field">
          <span>车辆名称</span>
          <input value={draft.title} maxLength={24} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
        </label>
        <section className="tray-edit-section">
          <h2>状态卡片</h2>
          {draft.cardOrder.map((id) => (
            <div
              className="tray-edit-row"
              key={id}
              draggable
              onDragStart={() => setDraggedCard(id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => dropCard(event, id)}
            >
              <span className="tray-drag-handle">☰</span>
              <span>{CARD_LABELS[id]}</span>
              <input type="checkbox" checked={!draft.hiddenCards.includes(id)} onChange={() => toggleCard(id)} aria-label={`显示${CARD_LABELS[id]}`} />
            </div>
          ))}
        </section>
        <section className="tray-edit-section">
          <h2>快捷按钮</h2>
          <div className="tray-edit-actions">
            {TRAY_ACTION_IDS.map((id) => (
              <label key={id}>
                <input type="checkbox" checked={!draft.hiddenActions.includes(id)} onChange={() => toggleAction(id)} />
                {ACTION_LABELS[id]}
              </label>
            ))}
          </div>
        </section>
        <section className="tray-edit-section">
          <h2>其他元素</h2>
          <div className="tray-edit-actions">
            {TRAY_EXTRA_IDS.map((id) => (
              <label key={id}>
                <input type="checkbox" checked={!draft.hiddenExtras.includes(id)} onChange={() => toggleExtra(id)} />
                {EXTRA_LABELS[id]}
              </label>
            ))}
          </div>
        </section>
        <div className="tray-edit-footer">
          <button type="button" onClick={() => setDraft(DEFAULT_TRAY_LAYOUT)}>恢复默认</button>
          <button className="primary" type="button" onClick={() => void saveEditing()}>保存布局</button>
        </div>
      </main>
    );
  }

  return (
    <main className="tray-panel" ref={panelRef}>
      <header className="tray-header">
        <button className="tray-vehicle-title" type="button" onClick={() => open("dashboard")}>
          <span className="tray-app-icon"><NioMark /></span>
          <span><strong>{layout.title}</strong><small><i /> {snapshot.soc == null ? "—" : `${snapshot.soc.toFixed(1)}%`} · {snapshot.range == null ? "— km" : `${Math.round(snapshot.range)} km`} · {snapshot.state}</small></span>
        </button>
        <button className="tray-round-button tray-settings" type="button" onClick={toggleEdit} aria-label="编辑小面板">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7h10m4 0h2M4 17h2m4 0h10" />
            <circle cx="16" cy="7" r="2" />
            <circle cx="8" cy="17" r="2" />
          </svg>
        </button>
        <button className={`tray-round-button tray-refresh ${refreshing ? "is-spinning" : ""}`} type="button" onClick={() => void refresh()} aria-label="立即刷新" disabled={refreshing}>↻</button>
      </header>

      <button className="tray-scene-button" type="button" onClick={() => open("dashboard")} aria-label="打开完整看板">
        <TrayVehicleScene hasCharger={snapshot.hasPower} locked={snapshot.locked} tyre={snapshot.tyre} />
      </button>

      <nav className="tray-actions" aria-label="快捷操作">
        {TRAY_ACTION_IDS.filter((id) => !layout.hiddenActions.includes(id)).map((id) => (
          <button className={id === "refresh" ? "active" : ""} type="button" key={id} onClick={actionHandlers[id]}>
            <span>{id === "refresh" ? "↻" : id === "dashboard" ? "▣" : id === "token" ? <IconKey /> : id === "log" ? "☷" : "⏻"}</span>
            {ACTION_LABELS[id]}
          </button>
        ))}
      </nav>

      <nav className="tray-tabs" aria-label="状态分类">
        <button className={activeTab === "all" ? "active" : ""} type="button" onClick={() => setActiveTab("all")}>全部</button>
        <button className={activeTab === "vehicle" ? "active" : ""} type="button" onClick={() => setActiveTab("vehicle")}>车况 {snapshot.warnings > 0 && <b>{snapshot.warnings}</b>}</button>
        {snapshot.hasPower && <button className={activeTab === "charging" ? "active" : ""} type="button" onClick={() => setActiveTab("charging")}>充电</button>}
        <button type="button" onClick={() => open("dashboard")}>换电</button>
      </nav>

      <section className="tray-summary">
        <strong>{activeTab === "charging" ? "充电" : "整车"}</strong>
        <span>· {visibleCards.length} 项状态</span>
        {showExtra("schedule") && (
          <span className="tray-schedule">
            <em>{snapshot.vehicleSchedule}</em>
            <em>{snapshot.changeSchedule}</em>
          </span>
        )}
      </section>

      {cardGroups.map(({ section, cards }) => {
        const wide = wideCards(cards);
        return (
          <div key={section ?? "all"}>
            {section && cards.length > 0 && <h3 className="tray-section-title">{SECTION_TITLES[section]}</h3>}
            <section className="tray-info-grid">
              {cards.map((id) => renderCard(id, wide.has(id)))}
            </section>
          </div>
        );
      })}
      {activeTab === "charging" && visibleCards.length === 0 && <p className="tray-empty">暂无家充数据</p>}

      <footer>
        <button type="button" onClick={() => open("settings/log")}>
          {fetchStatus("车辆", snapshot.vehicleFetch)} · {fetchStatus("换电", snapshot.changeFetch)}
        </button>
        {showExtra("swapCount") && snapshot.swapCount != null
          ? <button className="tray-footer-link" type="button" onClick={() => open("dashboard")}>换电 {snapshot.swapCount} 次 ›</button>
          : <button className="tray-footer-link" type="button" onClick={() => open("settings/log")}>查看诊断 ›</button>}
      </footer>
    </main>
  );
}
