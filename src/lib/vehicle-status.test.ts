import assert from "node:assert/strict";
import test from "node:test";
import { statusFlagOn, statusFlagOpen } from "./vehicle";

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
