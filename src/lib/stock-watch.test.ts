import assert from "node:assert/strict";
import test from "node:test";
import { asStockWatchState } from "./stock-watch";

test("stock watch responses without items are rejected", () => {
  assert.equal(asStockWatchState({ ok: true }), null);
  assert.equal(asStockWatchState(null), null);
  assert.equal(asStockWatchState("x"), null);
  assert.deepEqual(asStockWatchState({ items: [], pollSec: 300 }), { items: [], pollSec: 300 });
  assert.equal(asStockWatchState({ items: [] })?.pollSec, 900);
});
