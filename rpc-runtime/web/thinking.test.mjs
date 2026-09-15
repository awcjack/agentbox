import assert from "node:assert/strict";
import test from "node:test";
import { thinkingLevels, thinkingModelKey } from "./thinking.mjs";

test("thinking choices use only the model-reported levels, including xhigh and max", () => {
  assert.deepEqual(thinkingLevels(["high", "off", "max", "high", "xhigh"]), ["off", "high", "xhigh", "max"]);
  assert.deepEqual(thinkingLevels(["off"]), ["off"]);
  assert.deepEqual(thinkingLevels(["minimal", "low", "medium", "high"]), ["minimal", "low", "medium", "high"]);
  assert.deepEqual(thinkingLevels(["unsupported", null, {}, 5]), []);
  assert.deepEqual(thinkingLevels(undefined), []);
  assert.deepEqual(thinkingLevels("high"), []);
});

test("thinking discovery is keyed by native conversation and provider/model", () => {
  const key = (native = "a", provider = "p", id = "model") => thinkingModelKey({ nativeSessionId: native }, { model: { provider, id } });
  assert.equal(key(), key());
  assert.notEqual(key(), key("b"));
  assert.notEqual(key(), key("a", "other"));
  assert.notEqual(key(), key("a", "p", "other"));
  assert.equal(thinkingModelKey(null, {}), null);
  assert.equal(thinkingModelKey({ nativeSessionId: "a" }, { model: null }), null);
});
