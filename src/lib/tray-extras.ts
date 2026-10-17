import { formatDurationSec, sortedMonthKeys, type PowerFile } from "./power";

type VehiclePollEnv = {
  NIO_VEHICLE_POLL_DAY_SEC?: string;
  NIO_VEHICLE_POLL_NIGHT_SEC?: string;
  NIO_VEHICLE_POLL_DRIVING_SEC?: string;
} | undefined;

type ChangePollEnv = { NIO_CHANGE_POLL_INTERVAL?: string } | undefined;

export function formatPollInterval(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600} 时`;
  return `${Math.max(1, Math.round(seconds / 60))} 分`;
}

function seconds(value: string | undefined, fallback: number, minimum: number): number {
  const parsed = Number(value);
  return Math.max(minimum, Number.isFinite(parsed) && parsed > 0 ? parsed : fallback);
}

/** 与原生 NativeScheduler.vehicleInterval 的规则保持一致。 */
export function vehicleScheduleLabel(vehicle: VehiclePollEnv, vehicleState: number | null, hour: number): string {
  if (vehicleState === 1) {
    return `车况 行驶 ${formatPollInterval(seconds(vehicle?.NIO_VEHICLE_POLL_DRIVING_SEC, 900, 60))}`;
  }
  const day = hour >= 9 && hour <= 17;
  const value = day
    ? seconds(vehicle?.NIO_VEHICLE_POLL_DAY_SEC, 1800, 60)
    : seconds(vehicle?.NIO_VEHICLE_POLL_NIGHT_SEC, 3600, 60);
  return `车况 ${day ? "白天" : "夜间"} ${formatPollInterval(value)}`;
}

export function changeScheduleLabel(change: ChangePollEnv): string {
  return `换电 每 ${formatPollInterval(seconds(change?.NIO_CHANGE_POLL_INTERVAL, 86400, 300))}`;
}

export interface MonthPowerSummary {
  title: string;
  detail: string;
  /** 0–1，本月电量相对历史最高月份 */
  ratio: number;
}

export function monthPowerSummary(power: PowerFile | null, now = new Date()): MonthPowerSummary | null {
  const key = power ? sortedMonthKeys(power)[0] : undefined;
  const month = key ? power?.months?.[key] : undefined;
  if (!power || !key || !month) return null;

  const currentKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const label = key === currentKey ? "本月" : `${Number(key.slice(5))} 月`;
  const kwh = month.total_real_charge_kwh;
  const peak = Math.max(kwh, ...Object.values(power.months ?? {}).map((m) => m.total_real_charge_kwh));

  const parts = [`${month.total_charging_times} 次`, formatDurationSec(month.total_charging_duration)];
  const last = [...(power.services ?? [])]
    .filter((service) => service.start_time && service.consume_power != null)
    .sort((a, b) => (b.start_time ?? 0) - (a.start_time ?? 0))[0];
  if (last?.start_time) {
    const date = new Date(last.start_time);
    parts.push(`上次 ${date.getMonth() + 1}/${date.getDate()} ${Number(last.consume_power).toFixed(1)} kWh`);
  }

  return {
    title: `${label}家充 ${kwh.toFixed(1)} kWh`,
    detail: parts.join(" · "),
    ratio: peak > 0 ? Math.min(1, kwh / peak) : 0,
  };
}
