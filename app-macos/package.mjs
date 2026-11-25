// Packages the macOS app:
//   dist/Paraphe.app                    ready-to-run bundle (universal: arm64 + x86_64)
//   dist/Paraphe-<version>-macos.zip   the same bundle, zipped
// Run `node build.mjs` first so dist/paraphe.html is current. Needs macOS:
// the Swift toolchain (Xcode command line tools) and ditto/codesign.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const dist = path.join(root, "dist");
const app = path.join(dist, "Paraphe.app");
const zip = path.join(dist, `Paraphe-${version}-macos.zip`);
const pkgDir = path.join(root, "app-macos");

if (process.platform !== "darwin") {
  throw new Error("Packaging the macOS app needs macOS (swift, codesign, ditto). On Windows, use npm run build:app.");
}

await rm(app, { recursive: true, force: true });
await execFile("swift", ["build", "-c", "release", "--arch", "arm64", "--arch", "x86_64", "--package-path", pkgDir]);

// A universal build lands in .build/apple/Products/Release; single-arch builds in .build/release.
const candidates = [
  path.join(pkgDir, ".build", "apple", "Products", "Release", "Paraphe"),
  path.join(pkgDir, ".build", "release", "Paraphe"),
];
const bin = candidates.find((p) => existsSync(p));
if (!bin) throw new Error(`swift build produced no executable (looked in ${candidates.join(", ")})`);

const contents = path.join(app, "Contents");
await mkdir(path.join(contents, "MacOS"), { recursive: true });
await mkdir(path.join(contents, "Resources"), { recursive: true });
await copyFile(bin, path.join(contents, "MacOS", "Paraphe"));
await copyFile(path.join(pkgDir, "paraphe.icns"), path.join(contents, "Resources", "paraphe.icns"));
await copyFile(path.join(dist, "paraphe.html"), path.join(contents, "Resources", "paraphe.html"));
await copyFile(path.join(dist, "THIRD-PARTY-NOTICES.txt"), path.join(contents, "Resources", "THIRD-PARTY-NOTICES.txt"));
await copyFile(path.join(root, "LICENSE"), path.join(contents, "Resources", "LICENSE.txt"));
const plist = (await readFile(path.join(pkgDir, "Info.plist"), "utf8")).replaceAll("__VERSION__", version);
await writeFile(path.join(contents, "Info.plist"), plist);
await execFile("codesign", ["--force", "--deep", "-s", "-", app]);

// ditto archives one source, so stage the app and its README in one folder.
const stage = path.join(dist, `Paraphe-${version}-macos`);
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await execFile("ditto", [app, path.join(stage, "Paraphe.app")]);
await writeFile(path.join(stage, "README.txt"), `Paraphe ${version}: fill and sign PDFs

Copy Paraphe.app anywhere (for example /Applications) and open it. The first
time, right-click it and choose Open: the app isn't signed with an Apple
developer certificate, so macOS asks you to confirm it once.

Paraphe makes no network connections. Signatures you save are kept on this
computer only.

Needs macOS 13 or newer (Apple silicon or Intel).
`);

await rm(zip, { force: true });
await execFile("ditto", ["-c", "-k", "--keepParent", stage, zip]);
await rm(stage, { recursive: true, force: true });

console.log(`Packaged ${path.relative(root, app)}`);
console.log(`Zipped  ${path.relative(root, zip)}`);

function execFile(cmd, args) {
  execFileSync(cmd, args, { stdio: "inherit" });
}

