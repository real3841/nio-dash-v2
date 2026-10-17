export type StockStatus = "in_stock" | "out_of_stock" | "unknown" | "error" | "disabled";

export interface StockWatchItemSnapshot {
  id: string;
  name: string;
  ok: boolean;
  status: StockStatus;
  label: string;
  detectedText: string | null;
  evidence: string | null;
  goodsName: string | null;
  at: number;
  error: string | null;
  url: string;
  alert: boolean;
}

export interface StockWatchState {
  items: StockWatchItemSnapshot[];
  pollSec: number;
  cookieConfigured?: boolean;
  tokenConfigured?: boolean;
}

/** 接口返回缺少 items 时视为无效，避免整页渲染崩溃。 */
export function asStockWatchState(value: unknown): StockWatchState | null {
  if (!value || typeof value !== "object") return null;
  const state = value as Partial<StockWatchState>;
  if (!Array.isArray(state.items)) return null;
  return { ...state, items: state.items, pollSec: typeof state.pollSec === "number" ? state.pollSec : 900 };
}

export async function fetchStockWatch(): Promise<StockWatchState | null> {
  try {
    const res = await fetch("/api/stock-watch");
    if (!res.ok) return null;
    return asStockWatchState(await res.json());
  } catch {
    return null;
  }
}

export const STOCK_WATCH_POLL_OPTIONS = [
  { sec: 60, label: "1 分钟" },
  { sec: 180, label: "3 分钟" },
  { sec: 300, label: "5 分钟" },
  { sec: 600, label: "10 分钟" },
  { sec: 900, label: "15 分钟" },
  { sec: 1800, label: "30 分钟" },
] as const;

export function formatStockWatchPollSec(pollSec: number): string {
  const match = STOCK_WATCH_POLL_OPTIONS.find((opt) => opt.sec === pollSec);
  if (match) return match.label;
  if (pollSec % 60 === 0) return `每 ${pollSec / 60} 分钟`;
  return `每 ${pollSec} 秒`;
}

export async function saveStockWatchAuth(input: {
  cookie?: string;
  token?: string;
}): Promise<StockWatchState | null> {
  try {
    const res = await fetch("/api/stock-watch/auth", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { state?: unknown };
    return asStockWatchState(data.state);
  } catch {
    return null;
  }
}

export async function saveStockWatchPollSec(pollSec: number): Promise<StockWatchState | null> {
  try {
    const res = await fetch("/api/stock-watch/poll-sec", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pollSec }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { state?: unknown };
    return asStockWatchState(data.state);
  } catch {
    return null;
  }
}

export async function triggerStockWatchCheck(targetId?: string): Promise<StockWatchState | null> {
  try {
    const query = targetId ? `?id=${encodeURIComponent(targetId)}` : "";
    const res = await fetch(`/api/stock-watch/check${query}`, { method: "POST" });
    if (!res.ok) return null;
    return asStockWatchState(await res.json());
  } catch {
    return null;
  }
}

export async function ackStockWatchAlert(targetId?: string): Promise<void> {
  try {
    await fetch("/api/stock-watch/ack-alert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(targetId ? { id: targetId } : {}),
    });
  } catch {
    // ignore
  }
}

export function stockStatusTone(
  status: StockStatus,
): "success" | "danger" | "warning" | "neutral" {
  if (status === "in_stock") return "success";
  if (status === "out_of_stock") return "danger";
  if (status === "error") return "warning";
  return "neutral";
}

export function stockWatchSummaryLabel(state: StockWatchState | null | undefined): string {
  if (!state?.items.length) return "尚未检查";
  if (state.items.some((item) => item.status === "in_stock")) return "有货";
  if (state.items.some((item) => item.status === "error")) return "检查失败";
  if (state.items.some((item) => item.status === "unknown")) return "无法确认";
  return "库存不足";
}

export function stockWatchSummaryTone(
  state: StockWatchState | null | undefined,
): "success" | "danger" | "warning" | "neutral" {
  if (!state?.items.length) return "neutral";
  if (state.items.some((item) => item.status === "in_stock")) return "success";
  if (state.items.some((item) => item.status === "error")) return "warning";
  if (state.items.some((item) => item.status === "unknown")) return "warning";
  return "danger";
}

export async function notifyStockInStock(item: StockWatchItemSnapshot): Promise<void> {
  if (!("Notification" in window)) return;

  let permission = Notification.permission;
  if (permission === "default") {
    permission = await Notification.requestPermission();
  }
  if (permission !== "granted") return;

  const changedOnly = item.status !== "in_stock" && item.evidence?.includes("响应有变化");
  const body = changedOnly
    ? `${item.goodsName ?? item.name} 的库存响应有变化`
    : item.goodsName
      ? `${item.goodsName} 现在有货了`
      : "监控的商品现在有货了";
  const notification = new Notification(changedOnly ? `${item.name} 响应变化` : `${item.name} 有货提醒`, {
    body,
  });
  notification.onclick = () => {
    window.open(item.url, "_blank", "noopener,noreferrer");
    window.focus();
  };
}
