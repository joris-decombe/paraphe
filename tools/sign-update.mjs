// Signs dist/update.json (written by `npm run build:app`) for the updater.
//
//   node tools/sign-update.mjs [private-key-path]
//
// Writes dist/update.json.sig: base64 of an ECDSA P-256 / SHA-256 signature
// (r || s, 64 bytes) over update.json's exact bytes. Checks it against
// app/update-public-key.txt, so a release can't go out signed by a key the
// app won't accept.
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keyPath = path.resolve(process.argv[2] || path.join(homedir(), ".paraphe", "release-signing-key.pem"));
const manifestPath = path.join(root, "dist", "update.json");

const manifest = readFileSync(manifestPath);
const key = createPrivateKey(readFileSync(keyPath));
const signature = sign("sha256", manifest, { key, dsaEncoding: "ieee-p1363" });

const xy = Buffer.from(readFileSync(path.join(root, "app", "update-public-key.txt"), "utf8").trim(), "base64");
const pub = createPublicKey({
  key: { kty: "EC", crv: "P-256", x: xy.subarray(0, 32).toString("base64url"), y: xy.subarray(32).toString("base64url") },
  format: "jwk",
});
if (!verify("sha256", manifest, { key: pub, dsaEncoding: "ieee-p1363" }, signature)) {
  throw new Error("This key doesn't match app/update-public-key.txt: the app would refuse the update.");
}
writeFileSync(manifestPath + ".sig", signature.toString("base64") + "\n");
console.log(`Signed ${path.relative(root, manifestPath)} (${JSON.parse(manifest).version})`);
