export const NATIVE_BRIDGE_VERSION = 1 as const;

export type SyncTarget = "vehicle" | "change" | "checkin" | "power" | "stock" | "all";

export interface NativeOperationMap {
  "bridge.ping": {
    request: Record<string, never>;
    response: { version: number; platform: string };
  };
  "http.request": {
    request: {
      path: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
      bodyBase64?: string;
    };
    response: {
      status: number;
      headers: Record<string, string>;
      bodyBase64: string;
    };
  };
  "app.openDashboard": {
    request: { route?: NativeRoute };
    response: null;
  };
  "app.hidePanel": {
    request: Record<string, never>;
    response: null;
  };
  "app.resizePanel": {
    request: { height: number };
    response: null;
  };
  "app.quit": {
    request: Record<string, never>;
    response: null;
  };
  "sync.refresh": {
    request: { target: SyncTarget };
    response: { target: SyncTarget };
  };
  "scheduler.state": {
    request: Record<string, never>;
    response: {
      running: boolean;
      nextVehicleAt: number | null;
      nextChangeAt: number | null;
      nextCheckinAt: number | null;
    };
  };
  "events.subscribe": {
    request: Record<string, never>;
    response: { events: NativeEventName[] };
  };
}

export type NativeOperation = keyof NativeOperationMap;
export type NativeRoute = "dashboard" | "settings/token" | "settings/log";
export type NativeEventName =
  | "dashboard.updated"
  | "sync.completed"
  | "logs.updated"
  | "stock.updated";

export interface NativeEvent<T = unknown> {
  name: NativeEventName;
  payload: T;
}

export interface BridgeEnvelope<K extends NativeOperation = NativeOperation> {
  id: string;
  version: typeof NATIVE_BRIDGE_VERSION;
  operation: K;
  payload: NativeOperationMap[K]["request"];
}

export interface BridgeSuccess<K extends NativeOperation = NativeOperation> {
  id: string;
  ok: true;
  result: NativeOperationMap[K]["response"];
}

export interface BridgeFailure {
  id: string;
  ok: false;
  error: { code: string; message: string };
}
