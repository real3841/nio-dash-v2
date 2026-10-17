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
  };
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
  if (slot.ok !== false) return null;
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

  const selected = slots.find((slot) => slot.id === selectedId) ?? slots[0];
  const failed = failureLabel(selected);

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
      <p className="muted">点中失效的那条。上面是要找的地址，下面填 Bearer Token。</p>
      <div className="auth-slot-list" role="tablist" aria-label="要更新的接口">
        {slots.map((slot) => {
          const mark = failureLabel(slot);
          const active = slot.id === selected?.id;
          return (
            <button
              key={slot.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`auth-slot-chip${active ? " active" : ""}${mark ? " failed" : ""}`}
              onClick={() => {
                picked.current = true;
                setSelectedId(slot.id);
                setUrl("");
                setError(null);
              }}
            >
              {slot.label}
              {mark ? <span className="auth-slot-mark">{mark}</span> : null}
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
          <p className="auth-slot-prompt">
            {failed ? `${selected.label} · ${failed}` : selected.label}
          </p>
          <p className={`auth-slot-status${failed ? " failed" : ""}`}>
            {selected.ok == null
              ? "还没有拉取记录"
              : `${formatCheckedAt(selected.at) ?? "最近"} ${selected.ok ? "拉取成功" : `失败：${selected.error ?? failed}`}`}
          </p>
          <p className="auth-slot-address">
            <span>{selected.method}</span>
            <code>{selected.address}</code>
          </p>
          <label className="auth-slot-field">
            <span>完整地址</span>
            <textarea
              rows={3}
              value={url}
              disabled={busy}
              placeholder={
                selected.needsUrl
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
