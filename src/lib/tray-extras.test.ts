import assert from "node:assert/strict";
import test from "node:test";
import { changeScheduleLabel, formatPollInterval, monthPowerSummary, vehicleScheduleLabel } from "./tray-extras";
import type { PowerFile } from "./power";

test("formats poll intervals in minutes or whole hours", () => {
  assert.equal(formatPollInterval(1800), "30 分");
  assert.equal(formatPollInterval(86400), "24 时");
  assert.equal(formatPollInterval(5400), "90 分");
});

test("vehicle schedule follows driving, charging, day and night rules", () => {
  const env = { NIO_VEHICLE_POLL_DAY_SEC: "1800", NIO_VEHICLE_POLL_NIGHT_SEC: "3600", NIO_VEHICLE_POLL_DRIVING_SEC: "900" };
  assert.equal(vehicleScheduleLabel(env, 1, 12), "车况 行驶 15 分");
  assert.equal(vehicleScheduleLabel(env, 3, 22), "车况 充电 10 分");
  assert.equal(vehicleScheduleLabel(env, 2, 12), "车况 白天 30 分");
  assert.equal(vehicleScheduleLabel(env, 2, 22), "车况 夜间 1 时");
  assert.equal(vehicleScheduleLabel(undefined, null, 10), "车况 白天 30 分");
  assert.equal(changeScheduleLabel(undefined), "换电 每 24 时");
});

test("summarizes the latest power month and last session", () => {
  const power: PowerFile = {
    at: 1,
    months: {
      "2026-09": { total_charging_times: 20, total_charging_duration: 50000, total_real_charge_kwh: 100, reports: [] },
      "2026-10": { total_charging_times: 11, total_charging_duration: 27660, total_real_charge_kwh: 84.7, reports: [] },
    },
    services: [
      { order_id: "a", start_time: new Date(2026, 9, 10).getTime(), consume_power: 5 },
      { order_id: "b", start_time: new Date(2026, 9, 16).getTime(), consume_power: 8.207 },
    ],
  };
  const summary = monthPowerSummary(power, new Date(2026, 9, 17));
  assert.equal(summary?.title, "本月家充 84.7 kWh");
  assert.equal(summary?.detail, "11 次 · 7 小时 41 分 · 上次 10/16 8.2 kWh");
  assert.equal(summary?.ratio, 0.847);
  assert.equal(monthPowerSummary(null), null);
});
