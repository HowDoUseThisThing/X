import puppeteer from "puppeteer-core";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// Edge may hand its fresh test profile to a child process, then exit its launcher.
// Read only the DevTools endpoint belonging to the profile created by this call.
export async function launchTestBrowser(executablePath) {
  if (process.env.BROWSER_WS_ENDPOINT) {
    const browser = await puppeteer.connect({ browserWSEndpoint: process.env.BROWSER_WS_ENDPOINT });
    return { browser, mode: "explicit-connection", close: async () => browser.disconnect() };
  }
  const profile = await mkdtemp(join(tmpdir(), "moonlit-browser-check-"));
  const removeProfile = async () => {
    assert.equal(dirname(resolve(profile)), resolve(tmpdir()));
    assert.ok(basename(profile).startsWith("moonlit-browser-check-"));
    await rm(profile, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
  };
  let browser, mode = "launched";
  try {
    try { browser = await puppeteer.launch({ executablePath, headless: true, userDataDir: profile }); }
    catch (launchError) {
      for (let attempt = 0; attempt < 30 && !browser; attempt++) {
        try {
          const [port, path] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/);
          if (!/^\d+$/.test(port) || !/^\/devtools\/browser\/[a-f\d-]+$/i.test(path)) throw Error("Invalid test endpoint");
          browser = await puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${port}${path}` });
          mode = "child-process-connection";
        } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
      }
      if (!browser) throw launchError;
    }
  } catch (error) {
    await removeProfile(); throw error;
  }
  return { browser, mode, close: async () => {
    try { await browser.close(); }
    finally { await removeProfile(); }
  } };
}
