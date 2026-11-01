import test from "node:test";
import assert from "node:assert/strict";
import {
  STORAGE_KEY,
  isRememberableToken,
  readRememberedToken,
  saveRememberedToken,
  clearRememberedToken,
} from "./auth-storage.mjs";

test("only non-empty printable tokens without whitespace are rememberable", () => {
  assert.equal(isRememberableToken("secret"), true);
  assert.equal(isRememberableToken("a".repeat(128)), true);
  for (const value of ["", " has space", "tab\there", "line\n", null, undefined, 42, "café"]) {
    assert.equal(isRememberableToken(value), false);
  }
});

test("remembered tokens round-trip through browser storage", () => {
  const store = new Map();
  const storage = {
    getItem: (key) => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
  };
  assert.equal(readRememberedToken(storage), "");
  assert.equal(saveRememberedToken(storage, "memory-only"), true);
  assert.equal(store.get(STORAGE_KEY), "memory-only");
  assert.equal(readRememberedToken(storage), "memory-only");
  assert.equal(clearRememberedToken(storage), true);
  assert.equal(store.has(STORAGE_KEY), false);
  assert.equal(readRememberedToken(storage), "");
});

test("malformed, unsafe, and unavailable storage stay empty", () => {
  for (const value of [null, "", "has space", "café", 42]) {
    assert.equal(readRememberedToken({ getItem: () => value }), "");
  }
  assert.equal(saveRememberedToken({ setItem() {} }, "has space"), false);
  assert.equal(saveRememberedToken({
    setItem() { throw Error("quota"); },
  }, "secret"), false);
  assert.equal(readRememberedToken({
    getItem() { throw Error("blocked"); },
  }), "");
  assert.equal(readRememberedToken(undefined), "");
  assert.equal(clearRememberedToken(undefined), true);
  assert.equal(clearRememberedToken({
    removeItem() { throw Error("blocked"); },
  }), false);
});
