// Releases the version in package.json, in one go:
//
//   npm run release [-- notes.md]
//
// 1. Checks that main is clean and pushed, and that the version isn't released yet.
// 2. Builds the Windows app (dist/Paraphe-<version>-win-x64.zip) and the site
//    (dist/site/, packed as dist/paraphe-site.tar.gz).
// 3. Writes the site's hash into dist/update.json and signs it with the release
//    key (tools/sign-update.mjs): one signature covers the app and the site.
// 4. Creates the GitHub release with all of it (notes from the file given, or
//    GitHub's generated ones).
// 5. Waits for the "macOS app" workflow (.github/workflows/macos.yml), which
//    builds the Mac app on a Mac runner and attaches it to the release.
// 6. Starts the Paraphe workflow in joris-decombe/dx2-66, which downloads the
//    release, checks the signature and the site's hash, and deploys
//    https://paraphe.dx2-66.com.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const SITE_REPO = "joris-decombe/dx2-66";
const SITE_WORKFLOW = "paraphe.yml";
const MAC_WORKFLOW = "macos.yml";

/** Runs a command and returns its output; `show` lets it print instead. */
const run = (cmd, args, { show = false, quiet = false } = {}) =>
  (execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: show ? "inherit" : quiet ? "pipe" : ["ignore", "pipe", "inherit"] }) ?? "").trim();
// Windows' own tar (bsdtar): Git's tar would read "C:" as a remote host.
const tar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
const step = (text) => console.log(`\n== ${text}`);

const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const tag = `v${version}`;
const notes = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (notes) await readFile(notes); // fail now, not after the build

step(`Checking ${tag}`);
if (run("git", ["branch", "--show-current"]) !== "main") throw new Error("Release from main.");
if (run("git", ["status", "--porcelain"])) throw new Error("The working tree has changes: commit or stash them first.");
run("git", ["fetch", "--quiet", "origin", "main"]);
const head = run("git", ["rev-parse", "HEAD"]);
if (head !== run("git", ["rev-parse", "origin/main"])) throw new Error("main isn't the same as origin/main: pull or push first.");
let exists = true;
try {
  run("gh", ["release", "view", tag], { quiet: true });
} catch {
  exists = false;
}
if (exists) throw new Error(`${tag} is already released: raise "version" in package.json.`);

step("Building the app and the site");
run(process.execPath, ["build.mjs"], { show: true });
run(process.execPath, ["app/package.mjs"], { show: true });
run(process.execPath, ["site/build.mjs"], { show: true });

step("Packing the site");
const siteFile = "paraphe-site.tar.gz";
const sitePath = path.join(dist, siteFile);
await rm(sitePath, { force: true });
run(tar, ["-czf", sitePath, "-C", path.join(dist, "site"), "."]);
const siteBytes = await readFile(sitePath);

step("Signing");
const manifestPath = path.join(dist, "update.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.version !== version) throw new Error(`dist/update.json is for ${manifest.version}, not ${version}.`);
manifest.site = { file: siteFile, size: siteBytes.length, sha256: createHash("sha256").update(siteBytes).digest("hex") };
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
run(process.execPath, ["tools/sign-update.mjs"], { show: true });

step(`Creating the release ${tag}`);
const assets = [manifest.file, "Paraphe-win-x64.zip", siteFile, "update.json", "update.json.sig"].map((f) => path.join(dist, f));
const url = run("gh", [
  "release", "create", tag, ...assets,
  "--target", head, "--title", `Paraphe ${version}`, "--latest",
  ...(notes ? ["--notes-file", notes] : ["--generate-notes"]),
]);
console.log(url);

// The site links to the Mac zip, which the "macOS app" workflow builds and
// attaches once the release is out: deploy only after it's there.
step("Waiting for the macOS app");
let macRun = null;
for (let i = 0; i < 30 && !macRun; i++) {
  if (i) await new Promise((r) => setTimeout(r, 5000));
  const runs = JSON.parse(run("gh", ["run", "list", "--workflow", MAC_WORKFLOW, "--event", "release", "--limit", "10", "--json", "databaseId,headSha"]));
  macRun = runs.find((r) => r.headSha === head)?.databaseId;
}
const deployByHand = `gh workflow run ${SITE_WORKFLOW} --repo ${SITE_REPO} -f tag=${tag}`;
if (!macRun) {
  throw new Error(`The ${MAC_WORKFLOW} workflow didn't start. Start it with: gh workflow run ${MAC_WORKFLOW} -f tag=${tag}\nWhen it's done, deploy the site with: ${deployByHand}`);
}
try {
  run("gh", ["run", "watch", String(macRun), "--exit-status", "--interval", "15"], { show: true });
} catch {
  throw new Error(`Building the macOS app failed: gh run view ${macRun} --log-failed\nOnce it's fixed (gh run rerun ${macRun}), deploy the site with: ${deployByHand}`);
}

step("Deploying paraphe.dx2-66.com");
try {
  run("gh", ["workflow", "run", SITE_WORKFLOW, "--repo", SITE_REPO, "-f", `tag=${tag}`]);
  console.log(`Started. Follow it with: gh run list --repo ${SITE_REPO} --workflow ${SITE_WORKFLOW}`);
} catch {
  console.log(`Couldn't start it. Run it by hand: gh workflow run ${SITE_WORKFLOW} --repo ${SITE_REPO} -f tag=${tag}`);
}
