import { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, useMap } from "react-leaflet";
import L from "leaflet";
import { fetchEnvConfig } from "../lib/env-config";
import { mapCoordsForProvider } from "../lib/gcj02";
import { saveDrawerOpen } from "../lib/drawer-state";
import { mapTileFromEnv, type MapTileConfig } from "../lib/map-tiles";
import { isNativeApp } from "../platform/transport";
import { AmapTrackMap } from "./AmapTrackMap";

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

/** 深色底图：Esri 的 Dark Gray，不需要 Key。subdomains 必须给，否则 Leaflet 取子域时会崩 */
const DARK_TILES: MapTileConfig = {
  provider: "osm",
  url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
  attribution: '&copy; <a href="https://www.esri.com/">Esri</a>',
  subdomains: ["a"],
  maxZoom: 16,
};

/** 高德底图是浅色，粉色压不住，改用青色 */
const COLOR_DARK = "#ff5ec8";
const COLOR_DOT_DARK = "#ff8ada";
const COLOR_LIGHT = "#0091b3";
const COLOR_DOT_LIGHT = "#00b8d4";

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
  light,
}: {
  trips: TrackTrip[];
  mode: "line" | "dot";
  tileConfig: MapTileConfig;
  boundsKey: string;
  light: boolean;
}) {
  const map = useMap();
  const fitted = useRef<string>("");
  const isLight = light;
  const lineColor = isLight ? COLOR_LIGHT : COLOR_DARK;
  const dotColor = isLight ? COLOR_DOT_LIGHT : COLOR_DOT_DARK;

  useEffect(() => {
    const renderer = L.canvas({ padding: 0.3 });
    const group = L.layerGroup().addTo(map);
    const bounds: L.LatLng[] = [];

    for (const trip of trips) {
      if (trip.p.length < 2) continue;
      const latlngs: [number, number][] = [];
      for (const p of trip.p) {
        const mapped = mapCoordsForProvider(p[1], p[0], tileConfig.provider);
        latlngs.push([mapped.lat, mapped.lng]);
      }

      if (mode === "line") {
        L.polyline(latlngs, {
          renderer,
          color: lineColor,
          weight: 2,
          opacity: isLight ? 0.75 : 0.5,
          interactive: false,
        }).addTo(group);
      } else {
        const step = Math.max(1, Math.ceil(latlngs.length / 160));
        for (let i = 0; i < latlngs.length; i += step) {
          L.circleMarker(latlngs[i], {
            renderer,
            radius: 1.4,
            stroke: false,
            fillColor: dotColor,
            fillOpacity: isLight ? 0.8 : 0.6,
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
  }, [map, trips, mode, tileConfig.provider, boundsKey, isLight, lineColor, dotColor]);

  return null;
}

export function HistoryTrackMap({ embedded = false }: { embedded?: boolean }) {
  const [openState, setOpenState] = useState(false);
  const open = embedded || openState;

  const [index, setIndex] = useState<TrackIndex | null>(null);
  const [months, setMonths] = useState<Record<string, TrackTrip[]>>({});
  const [active, setActive] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"line" | "dot">("line");
  const [status, setStatus] = useState<"idle" | "loading" | "empty" | "ready">("idle");
  const [appTiles, setAppTiles] = useState<MapTileConfig>(() => mapTileFromEnv({}));
  const [useDark, setUseDark] = useState(false);
  const [amapKey, setAmapKey] = useState("");
  const [amapCode, setAmapCode] = useState("");
  const [amapFailed, setAmapFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [syncStatus, setSyncStatus] = useState<TrackSyncStatus | null>(null);

  const tileConfig = useDark ? DARK_TILES : appTiles;

  useEffect(() => {
    if (!open) return;
    const load = () => {
      void fetchEnvConfig()
        .then((cfg) => {
          setAppTiles(mapTileFromEnv(cfg.map));
          setAmapKey(cfg.map.NIO_AMAP_JS_KEY?.trim() ?? "");
          setAmapCode(cfg.map.NIO_AMAP_JS_SECURITY_CODE?.trim() ?? "");
        })
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
        // 忽略，下一轮重试
      }
      if (!cancelled) timer = window.setTimeout(poll, 2500);
    };

    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open]);

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

  const startSync = async (monthCount: number) => {
    try {
      const res = await fetch("/api/tracks/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ months: monthCount, refreshCurrent: true }),
      });
      if (res.ok) setSyncStatus((await res.json()) as TrackSyncStatus);
    } catch {
      // 忽略
    }
  };

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
    padding: "5px 12px",
    fontSize: 11,
    cursor: "pointer",
  });

  const syncing = Boolean(syncStatus?.running);
  /** 有高德 Key 且没加载失败时，用高德矢量地图（深色下也能显示中文路名） */
  const useAmap = Boolean(amapKey) && !amapFailed;

  const body = (
    <>
      {status === "empty" && (
        <div className="muted" style={{ padding: "10px 0" }}>
          <p style={{ margin: "0 0 10px" }}>还没有轨迹数据。</p>
          {isNativeApp() ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" onClick={() => void startSync(1)} style={segStyle(false)}>
                抓取当月
              </button>
              <button type="button" onClick={() => void startSync(60)} style={segStyle(false)}>
                补全全部历史
              </button>
            </div>
          ) : (
            <p style={{ margin: 0 }}>
              在项目目录运行 <code>npm run tracks:fetch</code> 抓取后重新打开。
            </p>
          )}
        </div>
      )}

      {status === "loading" && <p className="muted">读取轨迹索引…</p>}

      {index && (
        <>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", margin: "10px 0 0" }}>
            {isNativeApp() ? (
              <>
                <button
                  type="button"
                  onClick={() => void startSync(1)}
                  disabled={syncing}
                  style={{ ...segStyle(false), opacity: syncing ? 0.5 : 1 }}
                >
                  {syncing ? "抓取中…" : "刷新当月"}
                </button>
                <button
                  type="button"
                  onClick={() => void startSync(60)}
                  disabled={syncing}
                  style={{ ...segStyle(false), opacity: syncing ? 0.5 : 1 }}
                >
                  补全历史
                </button>
              </>
            ) : (
              <span className="muted" style={{ fontSize: 11 }}>
                用 <code>npm run tracks:fetch -- --months 60</code> 补全历史
              </span>
            )}
            <span className="muted" style={{ fontSize: 11 }}>
              {syncing
                ? `${syncStatus?.month ?? ""} · ${syncStatus?.done}/${syncStatus?.total}`
                : (syncStatus?.lastError ?? "")}
            </span>
          </div>

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

          <div style={{ display: "flex", gap: 6, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" onClick={() => setMode("line")} style={segStyle(mode === "line")}>
              轨迹线
            </button>
            <button type="button" onClick={() => setMode("dot")} style={segStyle(mode === "dot")}>
              点云
            </button>
            <button type="button" onClick={() => setUseDark((v) => !v)} style={{ ...segStyle(useDark), marginLeft: 8 }}>
              深色
            </button>
            <span className="muted" style={{ fontSize: 11, marginLeft: "auto" }}>
              {trips.length} 趟 · {shown.points.toLocaleString()} 点 ·{" "}
              {useAmap ? "高德矢量" : useDark ? "Esri 深色" : tileConfig.provider === "amap" ? "高德栅格" : "OSM"}
            </span>
          </div>

          <div style={{ height: 420, borderRadius: 12, overflow: "hidden" }}>
            {useAmap ? (
              <AmapTrackMap
                trips={trips}
                mode={mode}
                dark={useDark}
                boundsKey={boundsKey}
                amapKey={amapKey}
                securityCode={amapCode || undefined}
                onError={() => setAmapFailed(true)}
              />
            ) : (
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
                  subdomains={tileConfig.subdomains ?? ["a"]}
                />
                {useDark && (
                  <TileLayer
                    url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}"
                    maxZoom={16}
                    subdomains={["a"]}
                    opacity={0.85}
                  />
                )}
                <TrackLayer
                  trips={trips}
                  mode={mode}
                  tileConfig={tileConfig}
                  boundsKey={`${boundsKey}-${useDark ? "dark" : "light"}`}
                  light={!useDark}
                />
              </MapContainer>
            )}
          </div>
        </>
      )}
    </>
  );

  if (embedded) return <div style={{ marginTop: 16, borderTop: "1px solid rgba(255,255,255,.08)", paddingTop: 12 }}>{body}</div>;

  return (
    <details
      className="trend-drawer"
      open={openState}
      onToggle={(e) => {
        const next = (e.currentTarget as HTMLDetailsElement).open;
        setOpenState(next);
        saveDrawerOpen(TRACK_DRAWER_KEY, next);
      }}
    >
      <summary>
        <span>历史轨迹</span>
        <span className="drawer-summary-meta">
          {status === "empty" ? "暂无数据" : index ? `${active.size} 个月 · ${trips.length} 趟` : "读取中…"}
        </span>
      </summary>
      {openState && body}
    </details>
  );
}
