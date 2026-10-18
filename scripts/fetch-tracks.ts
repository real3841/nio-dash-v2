/**
 * 抓取历史行程轨迹，输出给「历史轨迹」面板使用。
 *
 *   npm run tracks:fetch                      # 抓最近 6 个月，写到 public/data（开发模式）
 *   npm run tracks:fetch -- --months 12       # 抓 12 个月
 *   npm run tracks:fetch -- --force           # 忽略缓存重抓
 *
 * 打包后的 App 读的是应用数据目录，需要指定：
 *   npm run tracks:fetch -- --out "$HOME/Library/Application Support/蔚来车辆看板/data"
 *
 * 输出：
 *   tracks-<YYYY-MM>.json   { month, trips: [{ s, e, k, c, p: [[lng, lat, ts], ...] }] }
 *   tracks-index.json       { generatedAt, months: [...], totalTrips, totalKm, totalPoints }
 */
import fs from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";

const ROOT = process.cwd();

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith("--")) {
    return process.argv[idx + 1];
  }
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  return fallback;
}

const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const MONTHS = Number(arg("months", "6"));
const DELAY_MS = Number(arg("delay", "1100"));
const FORCE = flag("force");
const ENV_FILE = arg("env");
const OUT_ARG = arg("out");

const APP_SUPPORT = path.join(process.env.HOME ?? "", "Library", "Application Support");

/**
 * 找配置文件：显式 --env 优先；否则依次尝试项目内 deploy/.env、.env，
 * 以及 macOS 上 App 自己的 config.env（原生版与开发版两个目录都看一眼）。
 */
function resolveEnvFile(): string | undefined {
  if (ENV_FILE) return path.resolve(ENV_FILE);
  const candidates = [
    path.join(ROOT, "deploy", ".env"),
    path.join(ROOT, ".env"),
    path.join(APP_SUPPORT, "蔚来车辆看板", "config.env"),
    path.join(APP_SUPPORT, "nio-mac", "config.env"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

const ENV_PATH = resolveEnvFile();
if (ENV_PATH) loadEnv({ path: ENV_PATH });

// 配置文件在 App 数据目录时，默认输出到同级的 data/，省得每次手写 --out
const defaultOut =
  ENV_PATH && ENV_PATH.startsWith(APP_SUPPORT)
    ? path.join(path.dirname(ENV_PATH), "data")
    : path.join("public", "data");
const OUT_DIR = path.resolve(OUT_ARG ?? defaultOut);

const TOKEN = process.env.NIO_VEHICLE_ACCESS_TOKEN?.trim() ?? "";
const VID = process.env.NIO_VEHICLE_ID?.trim() ?? "";
const TOKEN_APP_ID = process.env.NIO_TOKEN_APP_ID?.trim() || "10002";

if (!TOKEN || !VID) {
  console.error(
    ENV_PATH
      ? `配置文件 ${ENV_PATH} 里缺少 NIO_VEHICLE_ACCESS_TOKEN 或 NIO_VEHICLE_ID`
      : "没有找到配置文件。请用 --env 指定，例如：\n" +
        '  npm run tracks:fetch -- --env "$HOME/Library/Application Support/蔚来车辆看板/config.env"',
  );
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Mobile/15E148 NIOAppCN/6.9.0 (com.do1.WeiLaiApp; build:2672; OS:iOS) webview/lg _dsbridge";

const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  "User-Agent": UA,
  "x-request-brand": "nio",
  Accept: "application/json, text/plain, */*",
  Origin: "null",
};

function gateway(pathname: string, query: [string, string][] = []): string {
  const url = new URL(`https://gateway-front-external.nio.com/moat/1100461${pathname}`);
  for (const [key, value] of [
    ["origin_app_id", TOKEN_APP_ID],
    ["token_app_id", TOKEN_APP_ID],
    ["language", "zh-Hans"],
    ["lang", "zh-Hans"],
    ["hash_type", "sha256"],
    ["app_ver", "6.9.0"],
    ...query,
  ] as [string, string][]) {
    url.searchParams.append(key, value);
  }
  return url.toString();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let requestCount = 0;

async function getJson<T = unknown>(url: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await sleep(DELAY_MS);
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30_000) });
      requestCount += 1;
      const body = (await res.json()) as { result_code?: string; debug_msg?: string } & T;
      if (body.result_code && body.result_code !== "success") {
        throw new Error(`result_code=${body.result_code} ${body.debug_msg ?? ""}`);
      }
      return body;
    } catch (error) {
      lastError = error;
      await sleep(2500 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

type RawPoint = { longitude?: number; latitude?: number; timestamp?: number; speed?: number };
type TripTuple = [number, number, number];

function normalizeTrack(track: RawPoint[] | undefined): TripTuple[] {
  const out: TripTuple[] = [];
  for (const point of track ?? []) {
    if (typeof point.longitude !== "number" || typeof point.latitude !== "number") continue;
    const ts = point.timestamp ?? 0;
    if (!out.length || out[out.length - 1][2] !== ts) {
      out.push([
        Math.round(point.longitude * 1e6) / 1e6,
        Math.round(point.latitude * 1e6) / 1e6,
        ts,
      ]);
    }
  }
  return out;
}

interface MonthJourneyItem {
  trip_id?: string;
  journey_id?: string;
  start_time?: number;
  end_time?: number;
  trip_odometer?: number;
  is_comb?: boolean;
}

interface JourneyDetail {
  trip_id?: string;
  start_time?: number;
  end_time?: number;
  trip_odometer?: number;
  is_comb?: boolean;
  track?: RawPoint[];
  atom_trips?: { trip_id?: string; track?: RawPoint[] }[];
}

async function fetchTrip(id: string): Promise<{ s: number; e: number; k: number; c: number; p: TripTuple[] }> {
  const body = await getJson<{ data?: JourneyDetail }>(gateway(`/api/1/vehicle/${VID}/journey_merge/${id}`));
  const detail = body.data ?? {};
  let track = normalizeTrack(detail.track);

  const atoms = Array.isArray(detail.atom_trips) ? detail.atom_trips : [];
  if (atoms.length) {
    const merged: TripTuple[] = [];
    for (const atom of atoms) {
      if (!atom?.trip_id) continue;
      const sub = await getJson<{ data?: JourneyDetail }>(
        gateway(`/api/1/vehicle/${VID}/journey_merge/${atom.trip_id}`),
      );
      merged.push(...normalizeTrack(sub.data?.track));
    }
    if (merged.length > track.length) {
      merged.sort((a, b) => a[2] - b[2]);
      track = merged;
    }
  }

  return {
    s: detail.start_time ?? 0,
    e: detail.end_time ?? 0,
    k: Math.round((detail.trip_odometer ?? 0) * 10) / 10,
    c: atoms.length || detail.is_comb ? 1 : 0,
    p: track,
  };
}

async function fetchMonth(month: string, lastMonth = ""): Promise<{ lastMonth: string; trips: number }> {
  const file = path.join(OUT_DIR, `tracks-${month}.json`);
  if (!FORCE && fs.existsSync(file)) {
    const cached = JSON.parse(fs.readFileSync(file, "utf8")) as { trips?: unknown[] };
    console.log(`  ${month} 已存在（${cached.trips?.length ?? 0} 趟），跳过`);
    return { lastMonth: lastMonth, trips: cached.trips?.length ?? 0 };
  }

  const list = await getJson<{ data?: { detail?: MonthJourneyItem[]; last_month?: string } }>(
    gateway(`/api/1/vehicle/${VID}/journey_merge/month_journeys`, [
      ["month", month],
      ["last_month", ""],
      ["next_month", ""],
    ]),
  );
  const items = list.data?.detail ?? [];
  console.log(`  ${month}：${items.length} 趟`);

  const trips = [] as { s: number; e: number; k: number; c: number; p: TripTuple[] }[];
  let done = 0;
  for (const item of items) {
    const id = item.trip_id || item.journey_id;
    if (!id) continue;
    try {
      const trip = await fetchTrip(id);
      if (!trip.s) trip.s = item.start_time ?? 0;
      if (!trip.e) trip.e = item.end_time ?? 0;
      if (!trip.k) trip.k = item.trip_odometer ?? 0;
      trips.push(trip);
    } catch (error) {
      console.warn(`    行程 ${id.slice(0, 8)} 失败：${error instanceof Error ? error.message : error}`);
    }
    done += 1;
    if (done % 20 === 0) console.log(`    进度 ${done}/${items.length}（累计请求 ${requestCount}）`);
  }

  fs.writeFileSync(file, JSON.stringify({ month, trips }));
  const points = trips.reduce((sum, t) => sum + t.p.length, 0);
  const km = trips.reduce((sum, t) => sum + t.k, 0);
  console.log(`  ${month} 完成：${trips.length} 趟 · ${points} 点 · ${km.toFixed(1)} km`);
  return { lastMonth: list.data?.last_month ?? "", trips: trips.length };
}

function rebuildIndex(): void {
  const files = fs
    .readdirSync(OUT_DIR)
    .filter((name) => /^tracks-\d{4}-\d{2}\.json$/.test(name))
    .sort();

  const months = files.map((name) => {
    const data = JSON.parse(fs.readFileSync(path.join(OUT_DIR, name), "utf8")) as {
      month: string;
      trips: { k?: number; p?: unknown[] }[];
    };
    return {
      month: data.month,
      trips: data.trips.length,
      km: Math.round(data.trips.reduce((sum, t) => sum + (t.k ?? 0), 0) * 10) / 10,
      points: data.trips.reduce((sum, t) => sum + (t.p?.length ?? 0), 0),
    };
  });

  const index = {
    generatedAt: new Date().toISOString(),
    months,
    totalTrips: months.reduce((sum, m) => sum + m.trips, 0),
    totalKm: Math.round(months.reduce((sum, m) => sum + m.km, 0) * 10) / 10,
    totalPoints: months.reduce((sum, m) => sum + m.points, 0),
  };

  fs.writeFileSync(path.join(OUT_DIR, "tracks-index.json"), JSON.stringify(index));
  console.log(
    `索引已更新：${months.length} 个月 · ${index.totalTrips} 趟 · ${index.totalKm} km · ${index.totalPoints} 点`,
  );
}

async function main(): Promise<void> {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  let month = today.slice(0, 7);
  console.log(`配置：${ENV_PATH ?? "(未找到)"}`);
  console.log(`开始抓取：目标 ${MONTHS} 个月，起始 ${month}，输出到 ${OUT_DIR}`);

  let lastMonth = "";
  for (let i = 0; i < MONTHS && month; i += 1) {
    const result = await fetchMonth(month, lastMonth);
    lastMonth = result.lastMonth;
    if (!lastMonth) {
      console.log("  已到最早月份");
      break;
    }
    month = lastMonth;
  }

  rebuildIndex();
  console.log(`完成，累计请求 ${requestCount} 次`);
}

await main();
