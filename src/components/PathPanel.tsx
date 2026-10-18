import { useState } from "react";
import { DailyPathMap } from "./DailyPathMap";
import { HistoryTrackMap } from "./HistoryTrackMap";
import { saveDrawerOpen } from "../lib/drawer-state";
import type { JourneyHistoryItem } from "../lib/trip";
import type { VehicleSnapshot } from "../lib/vehicle";

const PATH_DRAWER_KEY = "nio-path-drawer";

type Tab = "tracks" | "daily";

/**
 * 「行驶轨迹」抽屉：历史轨迹在前，每日路径在后，用标签页来回切换，
 * 而不是上下堆叠。
 */
export function PathPanel({
  history,
  journeys,
  current,
}: {
  history: VehicleSnapshot[];
  journeys?: JourneyHistoryItem[];
  current?: { lat: number; lng: number; ts: number } | null;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("tracks");

  const tabStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    border: 0,
    borderRadius: 8,
    padding: "7px 10px",
    fontSize: 12,
    cursor: "pointer",
    background: active ? "rgba(96,165,250,.18)" : "rgba(255,255,255,.05)",
    color: active ? "#dbeafe" : "#8b93a7",
    fontWeight: active ? 600 : 400,
    transition: "background .15s",
  });

  return (
    <details
      className="trend-drawer path-drawer"
      open={open}
      onToggle={(e) => {
        const next = (e.currentTarget as HTMLDetailsElement).open;
        setOpen(next);
        saveDrawerOpen(PATH_DRAWER_KEY, next);
      }}
    >
      <summary>
        <span>行驶轨迹</span>
        <span className="drawer-summary-meta">{tab === "tracks" ? "历史轨迹" : "每日路径"}</span>
      </summary>

      {open && (
        <>
          <div style={{ display: "flex", gap: 6, margin: "10px 0 12px" }}>
            <button type="button" onClick={() => setTab("tracks")} style={tabStyle(tab === "tracks")}>
              历史轨迹
            </button>
            <button type="button" onClick={() => setTab("daily")} style={tabStyle(tab === "daily")}>
              每日路径
            </button>
          </div>

          {tab === "tracks" ? (
            <HistoryTrackMap embedded />
          ) : (
            <DailyPathMap history={history} journeys={journeys} current={current} embedded />
          )}
        </>
      )}
    </details>
  );
}
