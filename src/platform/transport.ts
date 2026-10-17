import {
  NATIVE_BRIDGE_VERSION,
  type BridgeEnvelope,
  type BridgeFailure,
  type BridgeSuccess,
  type NativeOperation,
  type NativeOperationMap,
} from "./transport-contract";

export interface AppTransport {
  readonly kind: "http" | "wkwebview";
  call<K extends NativeOperation>(
    operation: K,
    payload: NativeOperationMap[K]["request"],
  ): Promise<NativeOperationMap[K]["response"]>;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

class HttpTransport implements AppTransport {
  readonly kind = "http" as const;

  async call<K extends NativeOperation>(
    operation: K,
    payload: NativeOperationMap[K]["request"],
  ): Promise<NativeOperationMap[K]["response"]> {
    if (operation === "sync.refresh") {
      const target = (payload as NativeOperationMap["sync.refresh"]["request"]).target;
      const path =
        target === "vehicle"
          ? "/api/fetch-vehicle"
          : target === "change"
            ? "/api/fetch-change"
            : target === "checkin"
              ? "/api/fetch-checkin"
              : "/api/fetch-now";
      const response = await originalFetch(path, { method: "POST" });
      if (!response.ok) throw new Error(`刷新失败 (${response.status})`);
      return { target } as NativeOperationMap[K]["response"];
    }
    throw new Error(`HTTP 模式不支持原生命令：${operation}`);
  }

  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return originalFetch(input, init);
  }
}

class WKTransport implements AppTransport {
  readonly kind = "wkwebview" as const;

  async call<K extends NativeOperation>(
    operation: K,
    payload: NativeOperationMap[K]["request"],
  ): Promise<NativeOperationMap[K]["response"]> {
    const handler = window.webkit?.messageHandlers?.nioBridge;
    if (!handler) throw new Error("原生桥接不可用");
    const envelope: BridgeEnvelope<K> = {
      id: crypto.randomUUID(),
      version: NATIVE_BRIDGE_VERSION,
      operation,
      payload,
    };
    const raw = (await handler.postMessage(envelope)) as BridgeSuccess<K> | BridgeFailure;
    if (!raw || typeof raw !== "object") throw new Error("原生桥接返回格式错误");
    if (!raw.ok) throw new Error(raw.error?.message || "原生命令失败");
    return raw.result;
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const url = new URL(request.url, window.location.href);
    if (!isBridgePath(url)) return originalFetch(request);

    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    const result = await this.call("http.request", {
      path: `${url.pathname}${url.search}`,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      ...(body && body.byteLength > 0 ? { bodyBase64: arrayBufferToBase64(body) } : {}),
    });
    const responseBody = base64ToArrayBuffer(result.bodyBase64);
    return new Response(responseBody.byteLength > 0 ? responseBody : null, {
      status: result.status,
      headers: result.headers,
    });
  }
}

const originalFetch = window.fetch.bind(window);

function isBridgePath(url: URL): boolean {
  if (url.origin !== window.location.origin && url.protocol !== "nioapp:") return false;
  return ["/api/", "/data/", "/trigger", "/fetch-log", "/health"].some(
    (prefix) => url.pathname === prefix || url.pathname.startsWith(prefix),
  );
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  if (!value) return new ArrayBuffer(0);
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer as ArrayBuffer;
}

export const appTransport: AppTransport = window.__NIO_NATIVE__ ? new WKTransport() : new HttpTransport();

export function isNativeApp(): boolean {
  return appTransport.kind === "wkwebview";
}

export function installNativeFetchBridge(): void {
  if (!isNativeApp()) return;
  window.fetch = appTransport.fetch.bind(appTransport);
}

export function appFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return appTransport.fetch(input, init);
}
