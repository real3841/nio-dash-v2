import { isNativeApp } from "./transport";

export function vehiclePhotoMediaURL(angle: string, version: number): string {
  if (isNativeApp()) {
    return `nioapp://media/${encodeURIComponent(angle)}?v=${version}`;
  }
  return `/api/vehicle-photos/${encodeURIComponent(angle)}?v=${version}`;
}
