import type { NativeRoute } from "./transport-contract";

const ROUTES: ReadonlySet<string> = new Set(["dashboard", "settings/token", "settings/log"]);

export function parseNativeRoute(value: string | null | undefined): NativeRoute | null {
  return value && ROUTES.has(value) ? (value as NativeRoute) : null;
}

export function initialNativeRoute(): NativeRoute | null {
  return parseNativeRoute(new URLSearchParams(window.location.search).get("route"));
}

export function onNativeNavigate(listener: (route: NativeRoute) => void): () => void {
  const handler = (event: Event) => {
    const route = parseNativeRoute((event as CustomEvent<{ route?: string }>).detail?.route);
    if (route) listener(route);
  };
  window.addEventListener("nio:navigate", handler);
  return () => window.removeEventListener("nio:navigate", handler);
}
