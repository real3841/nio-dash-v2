import assert from "node:assert/strict";
import test from "node:test";
import { chargeStateLabel, pollVehicleState, statusFlagOn, statusFlagOpen, type VehicleResponse } from "./vehicle";

type Status = VehicleResponse["data"]["status"];
const status = (vehicleState: number, chargeState: number | boolean) =>
  ({ exterior_status: { vehicle_state: vehicleState }, soc_status: { charge_state: chargeState } }) as unknown as Status;

test("charging while parked polls as vehicle_state 3, driving wins", () => {
  assert.equal(pollVehicleState(status(2, 1)), 3);
  assert.equal(pollVehicleState(status(2, true)), 3);
  assert.equal(pollVehicleState(status(2, 0)), 2);
  assert.equal(pollVehicleState(status(2, false)), 2);
  assert.equal(pollVehicleState(status(1, 1)), 1);
  assert.equal(pollVehicleState(null), null);
});

test("charge state label accepts legacy boolean values", () => {
  assert.equal(chargeStateLabel(false), "未充电");
  assert.equal(chargeStateLabel(true), "充电中");
  assert.equal(chargeStateLabel(2), "充电完成");
});

test("lock status supports boolean and numeric RVS values", () => {
  assert.equal(statusFlagOn(true), true);
  assert.equal(statusFlagOn(1), true);
  assert.equal(statusFlagOn(false), false);
  assert.equal(statusFlagOn(0), false);
});

test("door status treats true/1 as closed and false/0 as open", () => {
  assert.equal(statusFlagOpen(true), false);
  assert.equal(statusFlagOpen(1), false);
  assert.equal(statusFlagOpen(false), true);
  assert.equal(statusFlagOpen(0), true);
  assert.equal(statusFlagOpen(undefined), false);
});
