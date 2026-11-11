import { cp, mkdir } from 'node:fs/promises';
const out = new URL('../output/release/', import.meta.url);
await mkdir(out, { recursive: true });
for (const name of ['index.html','src','assets','docs','tests','scripts','README.md','package.json','package-lock.json']) {
  await cp(new URL(`../${name}`,import.meta.url), new URL(name,out), {recursive:true});
}
console.log('Release files prepared in output/release');
