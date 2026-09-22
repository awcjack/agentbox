import test from "node:test";
import assert from "node:assert/strict";
import { ApiError, retryCatalogRead } from "./transport.mjs";

test("catalog transient failures retry with a bound, success (including empty) stops", async () => {
  const signal = new AbortController().signal;
  let calls = 0;
  assert.deepEqual(await retryCatalogRead(async () => {
    if (++calls < 3) throw new ApiError("starting", 503);
    return { models: [] };
  }, signal, [0, 0]), { models: [] });
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(retryCatalogRead(async () => {
    calls++; throw new ApiError("offline");
  }, signal, [0, 0]));
  assert.equal(calls, 3);
  calls = 0;
  await retryCatalogRead(async () => { calls++; return { models: [{ provider: "any", id: "one" }] }; }, signal);
  assert.equal(calls, 1);
});

test("catalog auth, command denial and non-transient errors never retry", async () => {
  for (const status of [401, 403, 404, 409, 413, 200]) {
    let calls = 0;
    await assert.rejects(retryCatalogRead(async () => {
      calls++; throw new ApiError("denied", status, "rpc_error");
    }, new AbortController().signal, [0, 0]));
    assert.equal(calls, 1);
  }
});

test("selection/replacement cancellation stops delayed retries and late read responses", async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = retryCatalogRead(async () => { calls++; throw new ApiError("timeout", 0, "timeout"); }, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(calls, 1);
  const next = new AbortController();
  let release;
  const late = retryCatalogRead(() => new Promise((resolve) => { release = resolve; }), next.signal);
  next.abort(); release({ models: ["stale"] });
  await assert.rejects(late, { name: "AbortError" });
});
