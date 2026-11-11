import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
let server, base;

before(async () => {
  const port = 43000 + Math.floor(Math.random() * 1000);
  server = spawn(process.execPath, ["scripts/serve.mjs"], { cwd: new URL("..", import.meta.url), env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(base); if (r.ok) return; } catch {}
    await delay(50);
  }
  throw new Error("server did not start");
});
after(() => server?.kill());

test("serves the game shell and module graph over HTTP", async () => {
  for (const [path, type] of [["/", "text/html"], ["/src/main.js", "text/javascript"], ["/src/game/game.js", "text/javascript"], ["/src/ui/style.css", "text/css"]]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.ok(response.headers.get("content-type").includes(type));
    assert.ok((await response.text()).length > 100);
  }
});

test("prevents path traversal and rejects unsupported methods", async () => {
  assert.equal((await fetch(base + "/%2e%2e%2fpackage.json")).status, 403);
  assert.equal((await fetch(base, { method: "POST" })).status, 405);
  assert.equal((await fetch(base + "/not-here")).status, 404);
});

