import { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, useMap } from "react-leaflet";
import L from "leaflet";
import { mapCoordsFromGcj02 } from "../lib/gcj02";
import { saveDrawerOpen } from "../lib/drawer-state";

const TRACK_DRAWER_KEY = "nio-track-history-drawer";

/** 轨迹点：[经度, 纬度, 时间戳]，原始值为 GCJ-02 */
type Pt = [number, number, number];

interface TrackTrip {
  s: number;
  e: number;
  k: number;
  c: number;
  p: Pt[];
}

interface MonthFile {
  month: string;
  trips: TrackTrip[];
}

interface MonthMeta {
  month: string;
  trips: number;
  km: number;
  points: number;
}

interface TrackIndex {
  generatedAt: string;
  months: MonthMeta[];
  totalTrips: number;
  totalKm: number;
  totalPoints: number;
}

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${path}?_=${Date.now()}`);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function TrackLayer({
  trips,
  mode,
  boundsKey,
}: {
  trips: TrackTrip[];
  mode: "line" | "dot";
  boundsKey: string;
}) {
  const map = useMap();
  const fitted = useRef<string>("");

  useEffect(() => {
    const renderer = L.canvas({ padding: 0.3 });
    const group = L.layerGroup().addTo(map);
    const bounds: L.LatLng[] = [];

    for (const trip of trips) {
      if (trip.p.length < 2) continue;
      const latlngs: [number, number][] = [];
      for (const p of trip.p) {
        // 原始坐标是 GCJ-02，OSM/Esri 底图需要 WGS-84
        const wgs = mapCoordsFromGcj02(p[1], p[0]);
        latlngs.push([wgs.lat, wgs.lng]);
      }

      if (mode === "line") {
        L.polyline(latlngs, {
          renderer,
          color: "#ff5ec8",
          weight: 1.2,
          opacity: 0.42,
          interactive: false,
        }).addTo(group);
      } else {
        const step = Math.max(1, Math.ceil(latlngs.length / 160));
        for (let i = 0; i < latlngs.length; i += step) {
          L.circleMarker(latlngs[i], {
            renderer,
            radius: 1.1,
            stroke: false,
            fillColor: "#ff8ada",
            fillOpacity: 0.55,
            interactive: false,
          }).addTo(group);
        }
      }

      for (let i = 0; i < latlngs.length; i += Math.max(1, Math.floor(latlngs.length / 10))) {
        bounds.push(L.latLng(latlngs[i]));
      }
    }

    if (trips.length === 0) return () => void map.removeLayer(group);

    if (bounds.length && fitted.current !== boundsKey) {
      fitted.current = boundsKey;
      map.fitBounds(L.latLngBounds(bounds), { padding: [24, 24] });
    }

    return () => {
      map.removeLayer(group);
    };
  }, [map, trips, mode, boundsKey]);

  return null;
}

export function HistoryTrackMap() {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState<TrackIndex | null>(null);
  const [months, setMonths] = useState<Record<string, TrackTrip[]>>({});
  const [active, setActive] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"line" | "dot">("line");
  const [status, setStatus] = useState<"idle" | "loading" | "empty" | "ready">("idle");

  // 打开时读索引
  useEffect(() => {
    if (!open || index) return;
    let cancelled = false;
    setStatus("loading");
    void (async () => {
      const idx = await fetchJson<TrackIndex>("/data/tracks-index.json");
      if (cancelled) return;
      if (!idx || !idx.months?.length) {
        setStatus("empty");
        return;
      }
      setIndex(idx);
      const latest = idx.months[idx.months.length - 1].month;
      setActive(new Set([latest]));
      setStatus("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, [open, index]);

  // 按需读月份文件
  useEffect(() => {
    if (!open) return;
    for (const month of active) {
      if (months[month]) continue;
      void (async () => {
        const file = await fetchJson<MonthFile>(`/data/tracks-${month}.json`);
        if (!file) return;
        setMonths((prev) => (prev[month] ? prev : { ...prev, [month]: file.trips }));
      })();
    }
  }, [open, active, months]);

  const trips = useMemo(() => {
    const out: TrackTrip[] = [];
    for (const month of active) out.push(...(months[month] ?? []));
    return out;
  }, [active, months]);

  const shown = useMemo(() => {
    let km = 0;
    let points = 0;
    for (const t of trips) {
      km += t.k ?? 0;
      points += t.p.length;
    }
    return { km, points };
  }, [trips]);

  const summaryMeta =
    status === "empty"
      ? "暂无数据"
      : index
        ? `${active.size} 个月 · ${trips.length} 趟 · ${shown.km.toFixed(0)} km`
        : "读取中…";

  const boundsKey = useMemo(() => [...active].sort().join(","), [active]);

  return (
    <details
      className="trend-drawer"
      open={open}
      onToggle={(e) => {
        const next = (e.currentTarget as HTMLDetailsElement).open;
        setOpen(next);
        saveDrawerOpen(TRACK_DRAWER_KEY, next);
      }}
    >
      <summary>
        <span>历史轨迹</span>
        <span className="drawer-summary-meta">{summaryMeta}</span>
      </summary>

      {open && status === "empty" && (
        <p className="muted" style={{ padding: "12px 0" }}>
          还没有轨迹数据。在项目目录运行 <code>npm run tracks:fetch</code> 抓取后重新打开。
        </p>
      )}

      {open && status === "loading" && <p className="muted">读取轨迹索引…</p>}

      {open && index && (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "10px 0" }}>
            {index.months.map((m) => {
              const on = active.has(m.month);
              return (
                <button
                  key={m.month}
                  type="button"
                  onClick={() =>
                    setActive((prev) => {
                      const next = new Set(prev);
                      if (next.has(m.month)) next.delete(m.month);
                      else next.add(m.month);
                      return next;
                    })
                  }
                  style={{
                    background: on ? "rgba(255,94,200,.16)" : "rgba(255,255,255,.05)",
                    border: `1px solid ${on ? "rgba(255,94,200,.5)" : "transparent"}`,
                    color: on ? "#ffb3e6" : "#8b93a7",
                    borderRadius: 7,
                    padding: "4px 9px",
                    fontSize: 11,
                    cursor: "pointer",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {m.month.slice(2)}
                  <span style={{ opacity: 0.6, marginLeft: 4 }}>{m.trips}</span>
                </button>
              );
            })}
          </div>

          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            {(["line", "dot"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                style={{
                  background: mode === m ? "rgba(255,255,255,.12)" : "rgba(255,255,255,.05)",
                  border: 0,
                  color: mode === m ? "#e8ecf4" : "#8b93a7",
                  borderRadius: 7,
                  padding: "5px 14px",
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                {m === "line" ? "轨迹线" : "点云"}
              </button>
            ))}
            <span className="muted" style={{ fontSize: 11, alignSelf: "center", marginLeft: "auto" }}>
              {trips.length} 趟 · {shown.points.toLocaleString()} 点
            </span>
          </div>

          <div style={{ height: 420, borderRadius: 12, overflow: "hidden" }}>
            <MapContainer
              center={[38.91, 121.6]}
              zoom={11}
              scrollWheelZoom
              preferCanvas
              style={{ height: "100%", width: "100%" }}
            >
              <TileLayer
                url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"
                attribution="Tiles &copy; Esri"
                maxZoom={16}
                maxNativeZoom={16}
              />
              <TrackLayer trips={trips} mode={mode} boundsKey={boundsKey} />
            </MapContainer>
          </div>
        </>
      )}
    </details>
  );
}
