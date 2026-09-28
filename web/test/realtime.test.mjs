// Run with: node --test test/  (no browser needed; uses a fake WebSocket and fake timers)
import { test, mock } from "node:test";
import assert from "node:assert/strict";

class FakeSocket {
  static OPEN = 1; static all = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeSocket.all.push(this); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; this.onclose?.(); }
  // test helpers
  open() { this.readyState = 1; this.onopen?.(); }
  recv(m) { this.onmessage?.({ data: JSON.stringify(m) }); }
  drop() { this.readyState = 3; this.onclose?.(); }
}
globalThis.WebSocket = FakeSocket;
globalThis.window = { addEventListener() {} };
globalThis.document = { addEventListener() {}, visibilityState: "visible" };

const { createLive } = await import("../src/realtime.js");
const tick = () => new Promise((r) => setImmediate(r));

test("subscribes, coalesces notices, catches up after a reconnect, switches teams, and stops when denied", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const changes = [], statuses = [], denied = [];
  const live = createLive({
    url: "wss://x/live", getToken: async () => "tok",
    onChange: (t, c) => changes.push([t, c.sort()]), onStatus: (s) => statuses.push(s), onDenied: (t) => denied.push(t)
  });

  live.watch("ta"); await tick();
  const s1 = FakeSocket.all.at(-1);
  assert.equal(s1.url, "wss://x/live?token=tok");
  s1.open();
  assert.deepEqual(s1.sent[0], { action: "subscribe", teamId: "ta" });
  s1.recv({ type: "subscribed", teamId: "ta" });
  assert.equal(live.status, "live");
  assert.equal(changes.length, 0, "first subscribe needs no refetch");

  s1.recv({ type: "changed", teamId: "ta", collections: ["members"] });
  s1.recv({ type: "changed", teamId: "ta", collections: ["events", "members"] });
  s1.recv({ type: "changed", teamId: "tb", collections: ["players"] });
  mock.timers.tick(300);
  assert.deepEqual(changes, [["ta", ["events", "members"]]]);

  mock.timers.tick(5 * 60 * 1000);
  assert.deepEqual(s1.sent.at(-1), { action: "ping" });

  s1.drop();
  assert.equal(live.status, "reconnecting");
  mock.timers.tick(1000); await tick();
  const s2 = FakeSocket.all.at(-1);
  assert.notEqual(s2, s1);
  s2.open(); s2.recv({ type: "subscribed", teamId: "ta" });
  mock.timers.tick(300);
  assert.deepEqual(changes.at(-1), ["ta", ["*"]], "refetch everything after a reconnect");

  s2.recv({ type: "error", action: "subscribe", code: "reconnect" });
  mock.timers.tick(1000); await tick();
  const s3 = FakeSocket.all.at(-1);
  assert.notEqual(s3, s2, "server-forgotten socket is replaced");
  s3.open(); s3.recv({ type: "subscribed", teamId: "ta" });

  live.watch("tb");
  assert.equal(FakeSocket.all.at(-1), s3, "switching teams reuses the socket");
  assert.deepEqual(s3.sent.at(-1), { action: "subscribe", teamId: "tb" });
  s3.recv({ type: "error", action: "subscribe", teamId: "tb", message: "Not a member" });
  assert.deepEqual(denied, ["tb"]);
  assert.equal(live.status, "off");
  assert.equal(s3.readyState, 3);

  const before = FakeSocket.all.length;
  mock.timers.tick(60_000); await tick();
  assert.equal(FakeSocket.all.length, before, "no reconnect after stop");
  mock.timers.reset();
});

test("backs off up to 30 seconds and forces a token refresh after repeated failures", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const forced = [];
  const live = createLive({ url: "wss://x/live", getToken: async (f) => { forced.push(f); return "tok"; }, onChange() {} });
  live.watch("ta"); await tick();
  for (let i = 0; i < 8; i++) { FakeSocket.all.at(-1).drop(); mock.timers.tick(30_000); await tick(); }
  assert.equal(forced[0], false);
  assert.ok(forced.slice(2).every(Boolean), "later attempts force a fresh token");
  live.stop();
  mock.timers.reset();
});
