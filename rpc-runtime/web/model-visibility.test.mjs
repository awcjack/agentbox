import test from "node:test";
import assert from "node:assert/strict";
import { modelKey, readHiddenModels, saveHiddenModels, visibleModels } from "./model-visibility.mjs";

const personal = { provider: "openai-codex", id: "gpt-6-sol" };
const work = { ...personal, provider: "codex-work" };
const other = { provider: "openai-codex", id: "other" };
test("hiding is account-specific and preserves the current model", () => {
  const hidden = new Set([modelKey(personal)]);
  assert.deepEqual(visibleModels([personal, work, other], hidden, other), [work, other]);
  assert.deepEqual(visibleModels([personal, work], hidden, personal), [personal, work]);
  assert.deepEqual(visibleModels([personal], hidden), []);
  hidden.clear();
  assert.deepEqual(visibleModels([personal, work], hidden), [personal, work]);
});
test("preferences persist across reloads and preserve absent model entries", () => {
  let value;
  const storage = { getItem: () => value, setItem: (_key, next) => { value = next; } };
  const hidden = new Set([modelKey(personal), modelKey(other)]);
  assert.equal(saveHiddenModels(storage, hidden), true);
  assert.deepEqual(readHiddenModels(storage), hidden);
  assert.deepEqual(visibleModels([work], readHiddenModels(storage)), [work]);
});
test("malformed and unavailable browser storage are safe", () => {
  for (const value of [null, "invalid", "{}", "42"]) {
    assert.deepEqual(readHiddenModels({ getItem: () => value }), new Set());
  }
  const broken = { getItem() { throw Error("blocked"); }, setItem() { throw Error("quota"); } };
  assert.deepEqual(readHiddenModels(broken), new Set());
  assert.equal(saveHiddenModels(broken, new Set()), false);
  assert.deepEqual(readHiddenModels(undefined), new Set());
  const value = JSON.stringify([null, 42, "invalid", "[]", modelKey(work)]);
  assert.deepEqual(readHiddenModels({ getItem: () => value }), new Set([modelKey(work)]));
});
