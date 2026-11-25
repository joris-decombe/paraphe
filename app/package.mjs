// Packages the Windows app:
//   dist/Paraphe/                       ready-to-run folder (Paraphe.exe + web/paraphe.html)
//   dist/Paraphe-<version>-win-x64.zip  the same folder, zipped
// Run `node build.mjs` first so dist/paraphe.html is current.
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const dist = path.join(root, "dist");
const out = path.join(dist, "Paraphe");
const zip = path.join(dist, `Paraphe-${version}-win-x64.zip`);

await rm(out, { recursive: true, force: true });
execFileSync("dotnet", [
  "publish", path.join(root, "app", "Paraphe.csproj"),
  "-c", "Release", "-o", out, "--nologo", "-v", "quiet", `-p:Version=${version}`,
], { stdio: "inherit" });

// Keep only what the app needs at runtime.
for (const f of await readdir(out)) {
  if (/\.(xml|pdb|config)$/i.test(f) && f !== "Paraphe.exe.config") await rm(path.join(out, f));
  if (/WebView2\.Wpf\.dll$/i.test(f)) await rm(path.join(out, f));
}
// .NET Framework loads WebView2Loader.dll from the app folder; this copy is unused.
await rm(path.join(out, "runtimes"), { recursive: true, force: true });

await mkdir(path.join(out, "web"), { recursive: true });
await copyFile(path.join(dist, "paraphe.html"), path.join(out, "web", "paraphe.html"));
await writeFile(path.join(out, "README.txt"), `Paraphe ${version}: fill and sign PDFs

Run Paraphe.exe. Nothing needs installing: it works from this folder.

To make it your PDF app, click "Install and make Paraphe my PDF app" on its
start screen. That copies it to %LOCALAPPDATA%\\Programs\\Paraphe, adds it to
the Start menu, and opens Windows Settings so you can choose it for .pdf.
Remove it later from Settings > Apps.

Paraphe makes no network connections. Signatures you save are kept in
%LOCALAPPDATA%\\Paraphe on this computer only.

Needs Windows 10 or 11 with the Microsoft Edge WebView2 Runtime (built into
Windows 11).
`.replace(/\n/g, "\r\n"));

await rm(zip, { force: true });
execFileSync("powershell.exe", [
  "-NoProfile", "-Command",
  `Compress-Archive -Path '${out}' -DestinationPath '${zip}' -CompressionLevel Optimal`,
], { stdio: "inherit" });

const files = (await readdir(out, { recursive: true })).sort();
console.log(`Packaged ${path.relative(root, out)}:\n  ${files.join("\n  ")}`);
console.log(`Zipped  ${path.relative(root, zip)}`);
