import { isNativeApp } from "./transport";
import type { NativeEvent, NativeEventName } from "./transport-contract";

type Listener<T = unknown> = (payload: T) => void;
const listeners = new Map<NativeEventName, Set<Listener>>();

window.addEventListener("nio:native-event", (event) => {
  const detail = (event as CustomEvent<NativeEvent>).detail;
  if (!detail?.name) return;
  for (const listener of listeners.get(detail.name) ?? []) listener(detail.payload);
});

export function subscribeNativeEvent<T = unknown>(
  name: NativeEventName,
  listener: Listener<T>,
): () => void {
  const group = listeners.get(name) ?? new Set<Listener>();
  group.add(listener as Listener);
  listeners.set(name, group);
  return () => {
    group.delete(listener as Listener);
    if (group.size === 0) listeners.delete(name);
  };
}

export function useNativeEventsInsteadOfPolling(): boolean {
  return isNativeApp();
}
