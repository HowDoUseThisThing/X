import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(root, "真3A大作_V1.html");
const outputPath = resolve(root, "tmp", "rea-target");
const sourceBytes = await readFile(sourcePath);
const html = sourceBytes.toString("utf8");
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
const styles = [...html.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi)];
if (scripts.length !== 1 || scripts[0][2].trim().length === 0) throw new Error(`Expected exactly one non-empty inline script; got ${scripts.length}`);
if (styles.length !== 1 || styles[0][2].trim().length === 0) throw new Error(`Expected exactly one non-empty inline style; got ${styles.length}`);
const script = scripts[0];
const style = styles[0];
if (/\bsrc\s*=/.test(script[1])) throw new Error("Expected an inline script, not an external script");
const js = script[2];
const css = style[2];
let shell = html.replace(script[0], '<script src="bundle0.js"></script>').replace(style[0], '<link rel="stylesheet" href="style0.css">');
await mkdir(outputPath, { recursive: true });
await Promise.all([
  writeFile(resolve(outputPath, "index.html"), shell, "utf8"),
  writeFile(resolve(outputPath, "bundle0.js"), js, "utf8"),
  writeFile(resolve(outputPath, "style0.css"), css, "utf8"),
]);
const sha256 = value => createHash("sha256").update(value).digest("hex");
const manifest = {
  operation: "inert-inline-extraction-for-REA",
  execution: "none",
  source: "真3A大作_V1.html",
  source_sha256: sha256(sourceBytes),
  extracted: [
    { path: "index.html", bytes: Buffer.byteLength(shell), sha256: sha256(shell) },
    { path: "bundle0.js", bytes: Buffer.byteLength(js), sha256: sha256(js), characters: js.length },
    { path: "style0.css", bytes: Buffer.byteLength(css), sha256: sha256(css), characters: css.length },
  ],
};
await writeFile(resolve(outputPath, "extraction-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output: outputPath, ...manifest }, null, 2));
