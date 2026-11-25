// Builds dist/site/, the whole of paraphe.dx2-66.com: the showcase pages
// (English at /, French at /fr/) and the web app at /app/.
// Run `npm run build:app` first: the pages quote the Windows zip's size.
import { cp, mkdir, readFile, readdir, rm, stat, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const out = path.join(dist, "site");
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

const zip = path.join(dist, `Paraphe-${version}-win-x64.zip`);
const bytes = (await stat(zip).catch(() => {
  throw new Error(`${path.relative(root, zip)} is missing: run npm run build:app first`);
})).size;
const mb = (bytes / 1e6).toFixed(1);

// Empty the folder rather than delete it: a local server may be watching it.
await mkdir(out, { recursive: true });
for (const f of await readdir(out)) await rm(path.join(out, f), { recursive: true, force: true });
await cp(path.join(root, "site"), out, { recursive: true, filter: (f) => !f.endsWith("build.mjs") });
await mkdir(path.join(out, "app"), { recursive: true });
await copyFile(path.join(dist, "paraphe.html"), path.join(out, "app", "index.html"));

for (const page of ["index.html", "fr/index.html"]) {
  const file = path.join(out, page);
  const html = (await readFile(file, "utf8"))
    .replaceAll("__VERSION__", version)
    .replaceAll("__SIZE__", `${mb} MB`)
    .replaceAll("__SIZE_FR__", `${mb.replace(".", ",")} Mo`);
  if (html.includes("__")) throw new Error(`${page}: a placeholder is left`);
  await writeFile(file, html);
}
console.log(`Built ${path.relative(root, out)} (Paraphe ${version}, zip ${mb} MB)`);
