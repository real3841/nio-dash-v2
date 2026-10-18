import { useEffect, useRef, useState } from "react";
import { AUTH_SLOTS } from "../lib/auth-slots";

interface AuthSlotView {
  id: string;
  label: string;
  method: "GET" | "POST";
  address: string;
  needsUrl: boolean;
  ok: boolean | null;
  kind: "sign" | "auth" | "generic" | null;
  error?: string | null;
  at?: number | null;
  capture: string;
  search: string;
  /** 后端支持停用时才有 */
  optional?: boolean;
  enabled?: boolean;
}

interface QuickAuthResponse {
  ok: boolean;
  error?: string;
  result?: {
    tokenUpdated: boolean;
    updated: string[];
    power: string | null;
    warnings: string[];
  };
  runs?: Record<string, string>;
}

interface Props {
  onDone?: () => void | Promise<void>;
}

const RUN_LABELS: Record<string, string> = { vehicle: "车况", change: "换电订单", checkin: "签到" };

const UPDATED_LABELS: Record<string, string> = {
  NIO_VEHICLE_API_URL: "车辆状态",
  NIO_VEHICLE_STATUS_URL: "车况整包",
  NIO_JOURNEY_API_URL: "最近行程",
  NIO_DAILY_API_URL: "当日里程",
  NIO_CHANGE_API_URL: "换电订单",
  NIO_CHECKIN_API_URL: "签到",
};

function updatedLine(updated: string[]): string | null {
  const names = updated.flatMap((key) => (UPDATED_LABELS[key] ? [UPDATED_LABELS[key]] : []));
  return names.length > 0 ? `已换地址：${names.join("、")}` : null;
}

function runLines(runs: QuickAuthResponse["runs"]): string[] {
  return Object.entries(runs ?? {}).map(
    ([name, status]) => `${RUN_LABELS[name] ?? name}：${status === "ok" ? "已刷新" : `刷新失败 · ${status}`}`,
  );
}

function withDefaults(slot: Partial<AuthSlotView> & { id: string }): AuthSlotView {
  const def = AUTH_SLOTS.find((entry) => entry.id === slot.id);
  return {
    label: def?.label ?? slot.id,
    method: def?.method ?? "GET",
    needsUrl: def?.needsUrl ?? false,
    ok: null,
    kind: null,
    ...slot,
    address: slot.address || def?.address || "",
    capture: def?.capture ?? "",
    search: def?.search ?? "",
  };
}

/** 按失效类型告诉用户这次到底要贴什么 */
function whatToPaste(slot: AuthSlotView): string {
  if (slot.kind === "auth") return "这次只要贴新的 Bearer Token，地址不用换。";
  if (slot.kind === "sign" || slot.needsUrl) {
    return "这次只要把完整地址贴到「完整地址」，必须带 sign= 和 timestamp=。Token 没问题就不用填。";
  }
  return "先试着只贴新的 Bearer Token；还不行再把完整地址也贴上。";
}

/** 车况的两条接口放在同一个按钮下：小组件接口和 icar 车况整包互为备份 */
const SLOT_GROUPS: Record<string, string[]> = { widget: ["widget", "status"] };
const GROUPED_IDS = new Set(Object.values(SLOT_GROUPS).flatMap((ids) => ids.slice(1)));
const MEMBER_LABELS: Record<string, string> = {
  widget: "小组件接口（免签名，只需 Token）",
  status: "车况整包（icar，含轮胎）",
};

function groupOf(id: string): string {
  return Object.entries(SLOT_GROUPS).find(([, ids]) => ids.includes(id))?.[0] ?? id;
}

function membersOf(id: string, slots: AuthSlotView[]): AuthSlotView[] {
  const ids = SLOT_GROUPS[id] ?? [id];
  return ids.flatMap((memberId) => slots.filter((slot) => slot.id === memberId));
}

function groupMark(members: AuthSlotView[]): { text: string; tone: "failed" | "off" } | null {
  const enabled = members.filter((slot) => slot.enabled !== false);
  if (enabled.length === 0) return { text: "未接入", tone: "off" };
  const failedMember = enabled.find((slot) => failureLabel(slot));
  if (failedMember) return { text: failureLabel(failedMember)!, tone: "failed" };
  if (enabled.length < members.length) return { text: "部分接入", tone: "off" };
  return null;
}

function memberStatus(slot: AuthSlotView): string {
  if (slot.enabled === false) return `未接入。${slot.capture} 抓包里搜 ${slot.search}`;
  if (slot.ok == null) return "还没有拉取记录";
  const when = formatCheckedAt(slot.at) ?? "最近";
  return slot.ok ? `${when} 拉取成功` : `${when} 失败：${slot.error ?? failureLabel(slot)}`;
}

function notConnectedHint(slots: AuthSlotView[]): string {
  const off = slots.filter((slot) => slot.enabled === false).map((slot) => slot.label);
  if (off.length === 0) return "所有接口都已接入。";
  return `未接入：${off.join("、")}。要接入就点它，鼠标停在按钮上可看在哪里抓包。`;
}

function backupNote(members: AuthSlotView[]): string | null {
  const working = members.find((slot) => slot.enabled !== false && slot.ok === true);
  if (members.length < 2 || !working) return null;
  return `看板不受影响：车况数据正在由「${MEMBER_LABELS[working.id] ?? working.label}」提供。`;
}

function formatCheckedAt(at: number | null | undefined): string | null {
  if (!at) return null;
  return new Date(at).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const EMPTY_SLOTS: AuthSlotView[] = AUTH_SLOTS.map((slot) => ({
  ...slot,
  ok: null,
  kind: null,
}));

function failureLabel(slot: AuthSlotView): string | null {
  if (slot.enabled === false || slot.ok !== false) return null;
  if (slot.kind === "sign") return "签名失效";
  if (slot.kind === "auth") return "登录失效";
  return "拉取失败";
}

function pickSlot(slots: AuthSlotView[]): string {
  const failed = slots.filter((slot) => slot.ok === false);
  return (failed.find((slot) => slot.kind === "sign") ?? failed[0] ?? slots[0])?.id ?? "widget";
}

export function QuickAuthPanel({ onDone }: Props) {
  const [slots, setSlots] = useState<AuthSlotView[]>(EMPTY_SLOTS);
  const [selectedId, setSelectedId] = useState("widget");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const picked = useRef(false);

  const loadSlots = async () => {
    const res = await fetch("/api/auth-slots");
    const body = (await res.json()) as { ok?: boolean; slots?: Array<Partial<AuthSlotView> & { id: string }> };
    const next = (body.slots ?? []).map(withDefaults);
    setSlots(next);
    if (!picked.current && next.length > 0) setSelectedId(pickSlot(next));
  };

  useEffect(() => {
    void loadSlots().catch(() => setError("读不到接口状态"));
  }, []);

  const selected = slots.find((slot) => slot.id === groupOf(selectedId)) ?? slots[0];
  const members = selected ? membersOf(selected.id, slots) : [];
  const mark = groupMark(members);
  const firstFailed = members.find((slot) => slot.enabled !== false && failureLabel(slot));

  const submitFields = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setLines([]);
    try {
      const res = await fetch("/api/quick-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slot: selected.id, url, token }),
      });
      const body = (await res.json()) as QuickAuthResponse;
      if (!res.ok || !body.ok || !body.result) {
        setError(body.error ?? `更新失败 (${res.status})`);
        return;
      }
      const r = body.result;
      const next: string[] = [];
      next.push(r.tokenUpdated ? "Token 已写入车况、换电和补充接口" : "Token 未变");
      const changed = updatedLine(r.updated);
      if (changed) next.push(changed);
      next.push(...runLines(body.runs), ...r.warnings);
      setLines(next);
      setUrl("");
      setToken("");
      await onDone?.();
      await loadSlots();
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法连接本地服务");
    } finally {
      setBusy(false);
    }
  };

  const disableSlot = async (slot: AuthSlotView) => {
    setBusy(true);
    setError(null);
    setLines([]);
    try {
      const res = await fetch("/api/auth-slots/disable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slot: slot.id }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setError(body.error ?? `停用失败 (${res.status})`);
        return;
      }
      setLines([`已停用「${MEMBER_LABELS[slot.id] ?? slot.label}」，以后不再拉取。要恢复时把完整地址贴回来即可`]);
      await onDone?.();
      await loadSlots();
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法连接本地服务");
    } finally {
      setBusy(false);
    }
  };

  const submitHar = async (payload: string) => {
    setBusy(true);
    setError(null);
    setLines([]);
    try {
      const res = await fetch("/api/quick-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: payload }),
      });
      const body = (await res.json()) as QuickAuthResponse;
      if (!res.ok || !body.ok || !body.result) {
        setError(body.error ?? `更新失败 (${res.status})`);
        return;
      }
      const r = body.result;
      const next = [
        r.tokenUpdated ? "Token 已写入车况、换电和补充接口" : "Token 未变",
        updatedLine(r.updated) ?? "",
        r.power ? `加电：${r.power}` : "",
        ...runLines(body.runs),
        ...r.warnings,
      ].filter(Boolean);
      setLines(next);
      setFileName(null);
      await onDone?.();
      await loadSlots();
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法连接本地服务");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sync-hub-panel-body quick-auth-panel">
      <p className="muted">标黄的是失效的接口，虚线的是还没接入的。点它，把抓到的内容贴进来。</p>
      <div className="auth-slot-list" role="tablist" aria-label="要更新的接口">
        {slots
          .filter((slot) => !GROUPED_IDS.has(slot.id))
          .map((slot) => {
            const chipMark = groupMark(membersOf(slot.id, slots));
            const active = slot.id === selected?.id;
            return (
              <button
                key={slot.id}
                type="button"
                role="tab"
                aria-selected={active}
                title={`${slot.capture} 抓包里搜 ${slot.search}`}
                className={`auth-slot-chip${active ? " active" : ""}${chipMark ? ` ${chipMark.tone}` : ""}`}
                onClick={() => {
                  picked.current = true;
                  setSelectedId(slot.id);
                  setUrl("");
                  setError(null);
                }}
              >
                {slot.label}
                {chipMark ? <span className="auth-slot-mark">{chipMark.text}</span> : null}
              </button>
            );
          })}
      </div>

      {selected && (
        <form
          className="auth-slot-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submitFields();
          }}
        >
          <p className="auth-slot-prompt">{mark ? `${selected.label} · ${mark.text}` : selected.label}</p>
          {members.map((member) => (
            <div className="auth-slot-source" key={member.id}>
              {members.length > 1 && <p className="auth-slot-source-name">{MEMBER_LABELS[member.id] ?? member.label}</p>}
              <p className="auth-slot-address">
                <span>{member.method}</span>
                <code>{member.address}</code>
              </p>
              <div className="auth-slot-source-row">
                <p className={`auth-slot-status${failureLabel(member) ? " failed" : ""}`}>{memberStatus(member)}</p>
                {member.optional && member.enabled !== false && (
                  <button
                    type="button"
                    className="btn ghost btn-small"
                    disabled={busy}
                    title="清掉这条的地址，以后不再拉取；顶部状态不再因为它变黄"
                    onClick={() => void disableSlot(member)}
                  >
                    不用这条
                  </button>
                )}
              </div>
            </div>
          ))}
          {firstFailed && <p className="auth-slot-status">{whatToPaste(firstFailed)}</p>}
          {firstFailed && backupNote(members) && <p className="auth-slot-status">{backupNote(members)}</p>}
          <p className="auth-slot-guide">{notConnectedHint(slots)}</p>
          <label className="auth-slot-field">
            <span>完整地址</span>
            <textarea
              rows={3}
              value={url}
              disabled={busy}
              placeholder={
                members.length > 1
                  ? "贴 widget/info 或 rvs/vehicle/…/status 的完整 URL，会自动识别是哪一条"
                  : selected.needsUrl
                  ? "把抓到的这一条完整 URL 贴在这里"
                  : "这条不用换地址。只有抓包里顺手复制到了，才贴在这里"
              }
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <label className="auth-slot-field">
            <span>Bearer Token</span>
            <input
              type="password"
              autoComplete="off"
              value={token}
              disabled={busy}
              placeholder="贴 Authorization 里 Bearer 后面的内容"
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <p className="muted api-hint">
            {selected.needsUrl
              ? "签名只属于这一条。Token 六个接口共用，填一次就会一起换。"
              : "这条只认 Token。六个接口共用同一个 Bearer。"}
          </p>
          <div className="row quick-auth-actions">
            <button type="submit" className="btn primary" disabled={busy || (!url.trim() && !token.trim())}>
              {busy ? "更新中…" : "更新并刷新"}
            </button>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => fileRef.current?.click()}>
              选择 HAR 文件
            </button>
            {fileName && <span className="muted">{fileName}</span>}
          </div>
        </form>
      )}

      <input
        ref={fileRef}
        type="file"
        accept=".har,application/json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          setFileName(file.name);
          void file.text().then(submitHar);
        }}
      />
      {error && <div className="alert alert-danger">{error}</div>}
      {lines.length > 0 && (
        <ul className="quick-auth-result">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
