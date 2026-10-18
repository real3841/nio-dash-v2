import { useEffect, useRef } from "react";
import { loadAmap } from "../lib/amap-loader";

type Pt = [number, number, number];

interface TrackTrip {
  s: number;
  e: number;
  k: number;
  c: number;
  p: Pt[];
}

const DARK_COLOR = "#ff5ec8";
const LIGHT_COLOR = "#0091b3";

/**
 * 高德 JS API 矢量地图。坐标是 GCJ-02 原始值，不需要转换。
 * 深色用 amap://styles/dark，能保留中文路名。
 */
export function AmapTrackMap({
  trips,
  mode,
  dark,
  boundsKey,
  amapKey,
  securityCode,
  onError,
}: {
  trips: TrackTrip[];
  mode: "line" | "dot";
  dark: boolean;
  boundsKey: string;
  amapKey: string;
  securityCode?: string;
  onError: (message: string) => void;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const overlaysRef = useRef<any[]>([]);
  const fittedRef = useRef("");
  const errorRef = useRef(onError);
  errorRef.current = onError;

  // 初始化地图 / 切换样式
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const AMap = await loadAmap(amapKey, securityCode);
        if (cancelled || !boxRef.current) return;

        const style = dark ? "amap://styles/dark" : "amap://styles/normal";
        if (!mapRef.current) {
          const map = new AMap.Map(boxRef.current, {
            zoom: 11,
            center: [121.6, 38.91],
            viewMode: "2D",
            mapStyle: style,
          });
          mapRef.current = map;
          // 地图完全就绪后再设一次样式，避免创建阶段样式被忽略
          map.on("complete", () => {
            mapRef.current?.setMapStyle(style);
          });
        } else {
          mapRef.current.setMapStyle(style);
        }
      } catch (error) {
        if (!cancelled) errorRef.current(error instanceof Error ? error.message : String(error));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [amapKey, securityCode, dark]);

  // 重绘轨迹
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.AMap) return;

    const AMap = window.AMap;
    if (overlaysRef.current.length) {
      map.remove(overlaysRef.current);
      overlaysRef.current = [];
    }

    const color = dark ? DARK_COLOR : LIGHT_COLOR;
    const overlays: any[] = [];
    const bounds: any[] = [];

    for (const trip of trips) {
      if (trip.p.length < 2) continue;
      const path = trip.p.map((p) => [p[0], p[1]]);

      if (mode === "line") {
        overlays.push(
          new AMap.Polyline({
            path,
            strokeColor: color,
            strokeWeight: dark ? 2 : 2.4,
            strokeOpacity: dark ? 0.55 : 0.8,
            lineJoin: "round",
            showDir: false,
            bubble: false,
          }),
        );
      } else {
        const step = Math.max(1, Math.ceil(path.length / 120));
        for (let i = 0; i < path.length; i += step) {
          overlays.push(
            new AMap.CircleMarker({
              center: path[i],
              radius: 2,
              strokeOpacity: 0,
              fillColor: color,
              fillOpacity: dark ? 0.65 : 0.85,
              bubble: false,
            }),
          );
        }
      }
      bounds.push(path[0], path[path.length - 1]);
    }

    if (overlays.length) {
      map.add(overlays);
      overlaysRef.current = overlays;
    }

    if (bounds.length && fittedRef.current !== boundsKey) {
      fittedRef.current = boundsKey;
      map.setFitView(overlays, false, [40, 40, 40, 40]);
    }
  }, [trips, mode, dark, boundsKey]);

  // 卸载时销毁
  useEffect(() => {
    return () => {
      if (mapRef.current) {
        mapRef.current.destroy();
        mapRef.current = null;
      }
      overlaysRef.current = [];
    };
  }, []);

  return <div ref={boxRef} style={{ height: "100%", width: "100%" }} />;
}
