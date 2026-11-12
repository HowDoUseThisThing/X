import { cp, mkdir } from 'node:fs/promises';
const out = new URL('../output/release/', import.meta.url);
await mkdir(out, { recursive: true });
for (const name of ['index.html','src','assets','docs','tests','scripts','README.md','package.json','package-lock.json']) {
  await cp(new URL(`../${name}`,import.meta.url), new URL(name,out), {recursive:true});
}
const validation = new URL('validation/', out);
await mkdir(validation, { recursive: true });
for (const name of ['unit-validation.txt','browser-validation-chrome.json','browser-validation-edge.json','strategy-browser-validation-chrome.json','strategy-browser-validation-edge.json','title-browser-validation-chrome.json','title-browser-validation-edge.json','touch-target-validation.json','performance-validation.json','frame-performance-validation.json','release-validation.json','release-validation-chrome.json','release-validation-edge.json']) {
  try { await cp(new URL(`../output/${name}`,import.meta.url), new URL(name, validation)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
console.log('Release files prepared in output/release');
