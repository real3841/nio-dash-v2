export const TRAY_CARD_IDS = ["battery", "lock", "temperature", "tyre", "charger", "monthPower"] as const;
export const TRAY_ACTION_IDS = ["refresh", "dashboard", "token", "log", "quit"] as const;
export const TRAY_EXTRA_IDS = ["schedule", "sections", "swapCount"] as const;

export type TrayCardId = (typeof TRAY_CARD_IDS)[number];
export type TrayActionId = (typeof TRAY_ACTION_IDS)[number];
export type TrayExtraId = (typeof TRAY_EXTRA_IDS)[number];
export type TraySection = "vehicle" | "charging";

export const TRAY_CARD_SECTION: Record<TrayCardId, TraySection> = {
  battery: "vehicle",
  lock: "vehicle",
  temperature: "vehicle",
  tyre: "vehicle",
  charger: "charging",
  monthPower: "charging",
};

export const TRAY_WIDE_CARDS: ReadonlySet<TrayCardId> = new Set(["battery", "monthPower"]);

export interface TrayLayout {
  title: string;
  cardOrder: TrayCardId[];
  hiddenCards: TrayCardId[];
  hiddenActions: TrayActionId[];
  hiddenExtras: TrayExtraId[];
}

export const DEFAULT_TRAY_LAYOUT: TrayLayout = {
  title: "我的蔚来",
  cardOrder: [...TRAY_CARD_IDS],
  hiddenCards: [],
  hiddenActions: [],
  hiddenExtras: [],
};

/** 半宽卡片落单时撑满整行，避免右侧留空。 */
export function wideCards(cards: TrayCardId[]): Set<TrayCardId> {
  const wide = new Set<TrayCardId>();
  let halfInRow = 0;
  cards.forEach((id, index) => {
    if (TRAY_WIDE_CARDS.has(id)) {
      wide.add(id);
      halfInRow = 0;
      return;
    }
    halfInRow += 1;
    const next = cards[index + 1];
    if (halfInRow % 2 === 1 && (next == null || TRAY_WIDE_CARDS.has(next))) wide.add(id);
  });
  return wide;
}

function validIds<T extends string>(raw: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(raw)) return [];
  const allowedSet = new Set<string>(allowed);
  return [...new Set(raw.filter((value): value is T => typeof value === "string" && allowedSet.has(value)))];
}

export function normalizeTrayLayout(raw: unknown): TrayLayout {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const savedOrder = validIds(source.cardOrder, TRAY_CARD_IDS);
  const missing = TRAY_CARD_IDS.filter((id) => !savedOrder.includes(id));
  const title = typeof source.title === "string" && source.title.trim()
    ? source.title.trim().slice(0, 24)
    : DEFAULT_TRAY_LAYOUT.title;
  return {
    title,
    cardOrder: [...savedOrder, ...missing],
    hiddenCards: validIds(source.hiddenCards, TRAY_CARD_IDS),
    hiddenActions: validIds(source.hiddenActions, TRAY_ACTION_IDS),
    hiddenExtras: validIds(source.hiddenExtras, TRAY_EXTRA_IDS),
  };
}

export function moveTrayCard(order: TrayCardId[], source: TrayCardId, target: TrayCardId): TrayCardId[] {
  const from = order.indexOf(source);
  const to = order.indexOf(target);
  if (from < 0 || to < 0 || from === to) return order;
  const next = [...order];
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
}

export async function loadTrayLayout(): Promise<TrayLayout> {
  const { appFetch } = await import("../platform/transport");
  const response = await appFetch("/api/tray-layout");
  if (!response.ok) return DEFAULT_TRAY_LAYOUT;
  return normalizeTrayLayout(await response.json());
}

export async function saveTrayLayout(layout: TrayLayout): Promise<void> {
  const { appFetch } = await import("../platform/transport");
  const response = await appFetch("/api/tray-layout", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(layout),
  });
  if (!response.ok) throw new Error(`保存菜单栏布局失败 (${response.status})`);
}
