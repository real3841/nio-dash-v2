import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TRAY_LAYOUT, moveTrayCard, normalizeTrayLayout, wideCards } from "./tray-layout";

test("normalizes incomplete tray layouts and rejects unknown ids", () => {
  const layout = normalizeTrayLayout({
    title: "  我的 ES6  ",
    cardOrder: ["tyre", "unknown", "battery"],
    hiddenCards: ["charger", "unknown"],
    hiddenActions: ["log", "bad"],
    hiddenExtras: ["schedule", "bad"],
  });

  assert.equal(layout.title, "我的 ES6");
  assert.deepEqual(layout.cardOrder, ["tyre", "battery", "lock", "temperature", "charger", "monthPower"]);
  assert.deepEqual(layout.hiddenCards, ["charger"]);
  assert.deepEqual(layout.hiddenActions, ["log"]);
  assert.deepEqual(layout.hiddenExtras, ["schedule"]);
});

test("uses safe defaults and reorders cards", () => {
  assert.deepEqual(normalizeTrayLayout(null), DEFAULT_TRAY_LAYOUT);
  assert.deepEqual(
    moveTrayCard(DEFAULT_TRAY_LAYOUT.cardOrder, "tyre", "battery"),
    ["tyre", "battery", "lock", "temperature", "charger", "monthPower"],
  );
});

test("stretches a half-width card left alone in its row", () => {
  assert.deepEqual([...wideCards(["battery", "lock", "temperature", "tyre"])], ["battery", "tyre"]);
  assert.deepEqual([...wideCards(["charger", "monthPower"])], ["charger", "monthPower"]);
  assert.deepEqual([...wideCards(["lock", "temperature"])], []);
});
