import { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, useMap } from "react-leaflet";
import L from "leaflet";
import { fetchEnvConfig } from "../lib/env-config";
import { mapCoordsForProvider } from "../lib/gcj02";
import { saveDrawerOpen } from "../lib/drawer-state";
import { mapTileFromEnv, type MapTileConfig } from "../lib/map-tiles";
import { isNativeApp } from "../platform/transport";

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

interface TrackSyncStatus {
  running: boolean;
  month: string | null;
  done: number;
  total: number;
  lastError: string | null;
  finishedAt: number | null;
}

/** 深色底图：Esri 的 Dark Gray，不需要 Key，用作可选的观感方案 */
const DARK_TILES: MapTileConfig = {
  provider: "osm",
  url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
  attribution: '&copy; <a href="https://www.esri.com/">Esri</a>',
  maxZoom: 16,
};

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
  tileConfig,
  boundsKey,
}: {
  trips: TrackTrip[];
  mode: "line" | "dot";
  tileConfig: MapTileConfig;
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
        // 高德底图用 GCJ-02 原始坐标；OSM / Esri 需要 WGS-84
        const mapped = mapCoordsForProvider(p[1], p[0], tileConfig.provider);
        latlngs.push([mapped.lat, mapped.lng]);
      }

      if (mode === "line") {
        L.polyline(latlngs, {
          renderer,
          color: "#ff5ec8",
          weight: 1.2,
          opacity: 0.45,
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
            fillOpacity: 0.6,
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
  }, [map, trips, mode, tileConfig.provider, boundsKey]);

  return null;
}

export function HistoryTrackMap() {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState<TrackIndex | null>(null);
  const [months, setMonths] = useState<Record<string, TrackTrip[]>>({});
  const [active, setActive] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"line" | "dot">("line");
  const [status, setStatus] = useState<"idle" | "loading" | "empty" | "ready">("idle");
  const [appTiles, setAppTiles] = useState<MapTileConfig>(() => mapTileFromEnv({}));
  const [useDark, setUseDark] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [syncStatus, setSyncStatus] = useState<TrackSyncStatus | null>(null);

  const tileConfig = useDark ? DARK_TILES : appTiles;

  useEffect(() => {
    if (!open) return;
    const load = () => {
      void fetchEnvConfig()
        .then((cfg) => setAppTiles(mapTileFromEnv(cfg.map)))
        .catch(() => setAppTiles(mapTileFromEnv({})));
    };
    load();
    window.addEventListener("nio-map-config-updated", load);
    return () => window.removeEventListener("nio-map-config-updated", load);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStatus("loading");
    setIndex(null);
    setMonths({});
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
  }, [open, reloadToken]);

  // 原生模式下轮询同步进度；结束后刷新索引
  useEffect(() => {
    if (!open || !isNativeApp()) return;
    let timer = 0;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(`/api/tracks/status?_=${Date.now()}`);
        if (res.ok) {
          const next = (await res.json()) as TrackSyncStatus;
          if (cancelled) return;
          setSyncStatus((prev) => {
            if (prev?.running && !next.running) setReloadToken((v) => v + 1);
            return next;
          });
        }
      } catch {
        // 轮询失败忽略，下一轮重试
      }
      if (!cancelled) timer = window.setTimeout(poll, 2500);
    };

    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open]);

  const startSync = async (months: number) => {
    try {
      const res = await fetch("/api/tracks/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ months, refreshCurrent: true }),
      });
      if (res.ok) setSyncStatus((await res.json()) as TrackSyncStatus);
    } catch {
      // 忽略，状态轮询会把结果带回来
    }
  };

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

  const chipStyle = (on: boolean): React.CSSProperties => ({
    background: on ? "rgba(255,94,200,.16)" : "rgba(255,255,255,.05)",
    border: `1px solid ${on ? "rgba(255,94,200,.5)" : "transparent"}`,
    color: on ? "#ffb3e6" : "#8b93a7",
    borderRadius: 7,
    padding: "4px 9px",
    fontSize: 11,
    cursor: "pointer",
    fontVariantNumeric: "tabular-nums",
  });

  const segStyle = (on: boolean): React.CSSProperties => ({
    background: on ? "rgba(255,255,255,.12)" : "rgba(255,255,255,.05)",
    border: 0,
    color: on ? "#e8ecf4" : "#8b93a7",
    borderRadius: 7,
    padding: "5px 14px",
    fontSize: 11,
    cursor: "pointer",
  });

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
        <div className="muted" style={{ padding: "12px 0" }}>
          <p style={{ margin: "0 0 10px" }}>还没有轨迹数据。</p>
          {isNativeApp() ? (
            <button type="button" onClick={() => void startSync(24)} style={segStyle(false)}>
              开始抓取历史轨迹
            </button>
          ) : (
            <p style={{ margin: 0 }}>
              在项目目录运行 <code>npm run tracks:fetch</code> 抓取后重新打开。
            </p>
          )}
        </div>
      )}

      {open && status === "loading" && <p className="muted">读取轨迹索引…</p>}

      {open && index && (
        <>
          {isNativeApp() && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "10px 0 0" }}>
              <button
                type="button"
                onClick={() => void startSync(24)}
                disabled={syncStatus?.running}
                style={{ ...segStyle(false), opacity: syncStatus?.running ? 0.5 : 1 }}
              >
                {syncStatus?.running ? "抓取中…" : "同步"}
              </button>
              <span className="muted" style={{ fontSize: 11 }}>
                {syncStatus?.running
                  ? `${syncStatus.month ?? ""} · ${syncStatus.done}/${syncStatus.total}`
                  : (syncStatus?.lastError ?? "")}
              </span>
            </div>
          )}

          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "10px 0" }}>
            {index.months.map((m) => (
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
                style={chipStyle(active.has(m.month))}
              >
                {m.month.slice(2)}
                <span style={{ opacity: 0.6, marginLeft: 4 }}>{m.trips}</span>
              </button>
            ))}
          </div>

          <div style={{ display: "flex", gap: 6, marginBottom: 10, alignItems: "center" }}>
            <button type="button" onClick={() => setMode("line")} style={segStyle(mode === "line")}>
              轨迹线
            </button>
            <button type="button" onClick={() => setMode("dot")} style={segStyle(mode === "dot")}>
              点云
            </button>
            <button
              type="button"
              onClick={() => setUseDark((v) => !v)}
              style={{ ...segStyle(useDark), marginLeft: 8 }}
              title="深色底图（Esri），不使用高德 Key"
            >
              深色
            </button>
            <span className="muted" style={{ fontSize: 11, marginLeft: "auto" }}>
              {trips.length} 趟 · {shown.points.toLocaleString()} 点 · {tileConfig.provider === "amap" ? "高德" : "OSM"}
            </span>
          </div>

          <div style={{ height: 420, borderRadius: 12, overflow: "hidden" }}>
            <MapContainer
              key={`${tileConfig.provider}-${tileConfig.url}`}
              center={[38.91, 121.6]}
              zoom={11}
              scrollWheelZoom
              preferCanvas
              style={{ height: "100%", width: "100%" }}
            >
              <TileLayer
                url={tileConfig.url}
                attribution={tileConfig.attribution}
                maxZoom={tileConfig.maxZoom}
                subdomains={tileConfig.subdomains}
              />
              <TrackLayer
                trips={trips}
                mode={mode}
                tileConfig={tileConfig}
                boundsKey={`${boundsKey}-${tileConfig.provider}`}
              />
            </MapContainer>
          </div>
        </>
      )}
    </details>
  );
}
