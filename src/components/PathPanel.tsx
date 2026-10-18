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
    border: active ? "1px solid transparent" : "1px solid rgba(128,128,128,.35)",
    borderRadius: 9,
    padding: "8px 12px",
    fontSize: 12.5,
    cursor: "pointer",
    background: active ? "#2563eb" : "transparent",
    color: active ? "#ffffff" : "inherit",
    fontWeight: active ? 600 : 500,
    opacity: active ? 1 : 0.72,
    transition: "background .15s, opacity .15s",
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
