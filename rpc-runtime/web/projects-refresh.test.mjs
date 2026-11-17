import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./app.mjs", import.meta.url), "utf8");
function harness(request) {
  const filter = {
    value: "old", children: [],
    replaceChildren(...children) { this.children = children; this.value = children[0].value; },
    append(child) { this.children.push(child); },
  };
  const h = {
    profiles: ["old"], profileRoots: new Map([["old", "/old"]]),
    epoch: 1, listVersion: 0, auth: new AbortController(), sessions: [], history: [],
    current: { record: { draft: { text: "unsent", images: ["image"] } } },
    calls: [], notices: [], errors: [], renders: 0, folders: 0,
    api: { request: async (path, options) => { h.calls.push(path); return request(path, options); } },
    $: () => filter,
    element: (_tag, _class, text) => ({ textContent: text, value: text }),
    updateControls() {}, renderSessions() { h.renders++; },
    refreshFolders() { h.folders++; },
    showNotice(message) { h.notices.push(message); },
    report(error) { h.errors.push(error); if (error.status === 401) h.epoch++; },
  };
  vm.createContext(h);
  vm.runInContext(source.slice(source.indexOf("async function refreshProjects("), source.indexOf("function renderModels(")), h);
  return { h, filter };
}
const catalog = (path) => {
  if (path === "/v1/profiles") return { profiles: ["old", "new", "new"] };
  if (path === "/v1/folders") return { roots: [{ profile: "new", path: "/workspace/new" }, { profile: "bad", path: "relative" }] };
  if (path === "/v1/sessions") return { sessions: [{ id: "live", profile: "old" }] };
  return { sessions: [{ id: "saved", profile: "new" }] };
};

test("explicit refresh reads profiles then roots, preserves filter/draft, replaces options and loads history", async () => {
  const { h, filter } = harness(catalog);
  const current = h.current, draft = current.record.draft;
  await h.refreshSessions({ refreshProjects: true });
  assert.deepEqual(h.calls.slice(0, 3), ["/v1/profiles", "/v1/folders", "/v1/sessions"]);
  assert.equal(filter.value, "old");
  assert.deepEqual(filter.children.map((option) => option.value), ["", "old", "new"]);
  assert.equal(h.profileRoots.get("new"), "/workspace/new");
  assert.equal(h.profileRoots.has("old"), false);
  assert.equal(h.profileRoots.has("bad"), false);
  assert.equal(h.current, current);
  assert.equal(h.current.record.draft, draft);
  assert.equal(draft.text, "unsent");
  assert.deepEqual(draft.images, ["image"]);
  await h.refreshSessions({ refreshProjects: true });
  assert.equal(filter.children.length, 3, "repeated refresh must not append duplicates");
  filter.value = "removed";
  h.calls.length = 0;
  await h.refreshSessions({ refreshProjects: true });
  assert.equal(filter.value, "");
  assert.ok(h.calls.includes("/v1/history?profile=new&includeArchived=true"));
  assert.ok(h.folders > 0);
});

test("initial catalog helper works with no prior profiles; ordinary session refresh never reads projects", async () => {
  const { h, filter } = harness(catalog);
  h.profiles = []; h.profileRoots.clear(); filter.value = "";
  await h.refreshProjects(() => true);
  assert.equal(h.profiles.length, 2);
  h.calls.length = 0;
  await h.refreshSessions();
  assert.equal(h.calls[0], "/v1/sessions");
  assert.ok(!h.calls.includes("/v1/profiles") && !h.calls.includes("/v1/folders"));
});

test("profile denial and root failure retain prior data and still refresh sessions without rejecting", async () => {
  for (const failedPath of ["/v1/profiles", "/v1/folders"]) {
    const { h, filter } = harness((path) => {
      if (path === failedPath) throw Object.assign(new Error("unavailable"), { status: 403 });
      return catalog(path);
    });
    await h.refreshSessions({ refreshProjects: true });
    assert.equal(h.profiles[0], "old");
    assert.equal(h.profiles.length, 1);
    assert.equal(h.profileRoots.get("old"), "/old");
    assert.equal(filter.value, "old");
    assert.equal(h.notices.length, 1);
    assert.equal(h.errors.length, 0);
    assert.equal(h.sessions[0].id, "live");
  }
});

test("401 uses existing auth handling and stops the list refresh", async () => {
  const { h } = harness(() => { throw Object.assign(new Error("rejected"), { status: 401 }); });
  await h.refreshSessions({ refreshProjects: true });
  assert.equal(h.errors[0].status, 401);
  assert.deepEqual(h.calls, ["/v1/profiles"]);
});

test("login catalog 401 logs out before persisting credentials or marking the UI connected", async () => {
  for (const failedPath of ["/v1/profiles", "/v1/folders"]) {
    const { h, filter } = harness((path) => {
      if (path === failedPath) throw Object.assign(new Error("rejected"), { status: 401 });
      return catalog(path);
    });
    let saves = 0, connected = 0, closed = 0, logouts = 0;
    h.preferenceStorage = {};
    h.saveRememberedToken = () => saves++;
    h.clearRememberedToken = () => {};
    h.setNetwork = () => connected++;
    h.logout = () => { logouts++; h.epoch++; h.token = ""; };
    h.report = (error) => { if (error.status === 401) h.logout(); };
    filter.close = () => closed++;
    vm.runInContext(source.slice(source.indexOf("async function connectWithToken("), source.indexOf('$("login-form").addEventListener')), h);
    await h.connectWithToken("rejected-token", { remember: true });
    assert.equal(logouts, 1);
    assert.equal(saves, 0);
    assert.equal(connected, 0);
    assert.equal(closed, 0);
    assert.equal(h.token, "");
  }
});

test("epoch/listVersion changes discard late project success and failure at either read", async () => {
  for (const guard of ["epoch", "listVersion"]) {
    for (const delayedPath of ["/v1/profiles", "/v1/folders"]) {
      for (const fail of [false, true]) {
        let release;
        const { h, filter } = harness((path) => path === delayedPath
          ? new Promise((resolve, reject) => { release = () => fail ? reject(new Error("late")) : resolve(catalog(path)); })
          : catalog(path));
        const pending = h.refreshSessions({ refreshProjects: true });
        while (!release) await Promise.resolve();
        h[guard]++; release(); await pending;
        assert.equal(h.profiles.length, 1);
        assert.equal(h.profileRoots.get("old"), "/old");
        assert.equal(filter.value, "old");
        assert.equal(h.notices.length, 0);
        assert.ok(!h.calls.includes("/v1/sessions"));
      }
    }
  }
});

test("app wiring uses helper on login and explicit Refresh, never the 1.5s poll", () => {
  const login = source.slice(source.indexOf("async function connectWithToken("), source.indexOf('$("login-form").addEventListener'));
  assert.match(login, /await refreshProjects\(/);
  const click = source.slice(source.indexOf('$("refresh-sessions").addEventListener'), source.indexOf('$("profile-filter").addEventListener'));
  assert.match(click, /refreshSessions\(\{ refreshProjects: true \}\)/);
  const poll = source.slice(source.indexOf("function scheduleSessionPoll("), source.indexOf("async function refreshProjects("));
  assert.doesNotMatch(poll, /api\.request\("\/v1\/(profiles|folders)"/);
});
