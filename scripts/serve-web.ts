/**
 * NAS 独立运行入口：采集 + 网页看板（不依赖 Mac 上的 App）。
 *
 *   NIO_DATA_DIR=/share/.../data tsx scripts/serve-web.ts
 *
 * 结构：
 *   8788  对外：静态前端 + /data/* 实时文件 + /api/tracks/* + /api/* 转发
 *   8789  内部：app-server（车辆/换电/签到/配置等接口 + 定时采集）
 *
 * 环境变量：
 *   NIO_WEB_PORT   对外端口（默认 8788）
 *   NIO_WEB_HOST   监听地址（默认 0.0.0.0）
 *   NIO_API_PORT   内部接口端口（默认 8789）
 *   NIO_DATA_DIR   数据目录（默认 ./data）
 *   NIO_ENV_FILE   配置文件（默认 ./deploy/.env）
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { startAppServer } from "./app-server.js";

const ROOT = path.resolve(process.cwd());
const DATA_DIR = path.resolve(process.env.NIO_DATA_DIR ?? path.join(ROOT, "data"));
const ENV_FILE = path.resolve(process.env.NIO_ENV_FILE ?? path.join(ROOT, "deploy", ".env"));
const STATIC_DIR = path.join(ROOT, "dist");
const WEB_PORT = Number(process.env.NIO_WEB_PORT ?? 8788);
const WEB_HOST = process.env.NIO_WEB_HOST ?? "0.0.0.0";
const API_PORT = Number(process.env.NIO_API_PORT ?? 8789);

/** 购车以来的完整范围；新月份会自动接上 */
const TRACK_TOTAL_MONTHS = Number(process.env.NIO_TRACK_MONTHS ?? 17);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

let trackTask: ChildProcess | null = null;
let trackLastRunAt = 0;
let trackLastResult = "";

function trackIndex(): { months: { month: string; trips: number }[]; totalTrips: number; totalKm: number } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "tracks-index.json"), "utf8"));
  } catch {
    return null;
  }
}

function runTrackFetch(months: number, force = false): void {
  if (trackTask) return;
  const args = ["tsx", "scripts/fetch-tracks.ts", "--months", String(months), "--out", DATA_DIR];
  if (force) args.push("--force");
  console.log(`[tracks] 开始抓取 ${months} 个月`);
  trackTask = spawn(process.execPath, ["node_modules/.bin/tsx", ...args.slice(1)], {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  trackTask.on("exit", (code) => {
    trackLastRunAt = Date.now();
    trackLastResult = code === 0 ? "ok" : `exit ${code}`;
    console.log(`[tracks] 结束（${trackLastResult}）`);
    trackTask = null;
  });
}

/** 每天 04:00 后刷新当月轨迹（当月文件会增长，必须重抓） */
let trackDayDone = "";
function scheduleDailyTracks(): void {
  setInterval(() => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getHours() < 4 || trackDayDone === day || trackTask) return;
    trackDayDone = day;
    const month = day.slice(0, 7);
    try {
      fs.rmSync(path.join(DATA_DIR, `tracks-${month}.json`), { force: true });
    } catch {
      // 忽略
    }
    runTrackFetch(1);
  }, 30 * 60 * 1000);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function sendFile(res: http.ServerResponse, filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-store",
    });
    fs.createReadStream(filePath).pipe(res);
    return true;
  } catch {
    return false;
  }
}

function proxy(req: http.IncomingMessage, res: http.ServerResponse, url: string): void {
  const upstream = http.request(
    { host: "127.0.0.1", port: APP.port, path: url, method: req.method, headers: req.headers },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) sendJson(res, 502, { ok: false, error: "upstream_unavailable" });
  });
  req.pipe(upstream);
}

let APP: { port: number };

async function main(): Promise<void> {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  APP = await startAppServer({
    port: API_PORT,
    host: "127.0.0.1",
    staticDir: STATIC_DIR,
    dataDir: DATA_DIR,
    envFile: ENV_FILE,
    enableScheduler: true,
  });
  console.log(`[web] 内部接口 127.0.0.1:${APP.port} · 数据目录 ${DATA_DIR}`);

  const server = http.createServer((req, res) => {
    const rawUrl = req.url ?? "/";
    const pathname = decodeURIComponent(rawUrl.split("?")[0]);
    const method = req.method ?? "GET";

    // 轨迹接口
    if (pathname === "/api/tracks/status" && method === "GET") {
      const idx = trackIndex();
      return sendJson(res, 200, {
        ok: true,
        running: trackTask !== null,
        lastRunAt: trackLastRunAt,
        lastResult: trackLastResult,
        months: idx?.months ?? [],
        totalTrips: idx?.totalTrips ?? 0,
        totalKm: idx?.totalKm ?? 0,
      });
    }
    if (pathname === "/api/tracks/sync" && method === "POST") {
      if (trackTask) return sendJson(res, 200, { ok: true, alreadyRunning: true });
      runTrackFetch(TRACK_TOTAL_MONTHS);
      return sendJson(res, 200, { ok: true, started: true });
    }

    // 实时数据文件：优先数据目录，其次打包内的 dist/data
    if (pathname.startsWith("/data/")) {
      const name = path.basename(pathname);
      const candidates = [path.join(DATA_DIR, name), path.join(STATIC_DIR, "data", name)];
      for (const candidate of candidates) {
        if (sendFile(res, candidate)) return;
      }
      return sendJson(res, 404, { ok: false, error: "not_found" });
    }

    // 其余 /api 转发给内部接口
    if (pathname.startsWith("/api/")) return proxy(req, res, rawUrl);

    // 静态文件
    const relative = pathname === "/" ? "index.html" : pathname.slice(1);
    const filePath = path.join(STATIC_DIR, relative);
    if (filePath.startsWith(STATIC_DIR) && sendFile(res, filePath)) return;
    if (sendFile(res, path.join(STATIC_DIR, "index.html"))) return;
    sendJson(res, 404, { ok: false, error: "not_found" });
  });

  server.listen(WEB_PORT, WEB_HOST, () => {
    console.log(`[web] 看板已启动：http://${WEB_HOST}:${WEB_PORT}`);
  });

  scheduleDailyTracks();
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

void main();
