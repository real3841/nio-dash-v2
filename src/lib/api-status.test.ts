import assert from "node:assert/strict";
import test from "node:test";
import { apiStatusDetail, resolveApiStatus } from "./api-status";

test("successful fetch with a failed sub-endpoint is partial", () => {
  const meta = { ok: true, at: 1, error: null, warning: "车辆状态失效，其余数据正常" };
  assert.equal(resolveApiStatus(meta, true), "partial");
  assert.match(apiStatusDetail("partial", meta), /车辆状态失效/);
  assert.equal(resolveApiStatus({ ok: true, at: 1, error: null }, true), "ok");
  assert.equal(resolveApiStatus({ ok: false, at: 1, error: "x" }, true), "error");
});
