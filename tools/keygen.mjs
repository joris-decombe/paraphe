// Creates the release signing key (ECDSA P-256). Run once.
//
//   node tools/keygen.mjs [private-key-path]
//
// The private key goes OUTSIDE this repository (default:
// %USERPROFILE%\.paraphe\release-signing-key.pem); keep a backup somewhere
// offline. Whoever has it can ship updates to every installed Paraphe.
// The public half is written to app/update-public-key.txt and built into the
// app, which refuses updates signed by any other key.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keyPath = path.resolve(process.argv[2] || path.join(homedir(), ".paraphe", "release-signing-key.pem"));
if (keyPath.startsWith(root + path.sep)) throw new Error("Keep the private key outside the repository.");
if (existsSync(keyPath)) throw new Error(`${keyPath} already exists; not overwriting it.`);

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
mkdirSync(path.dirname(keyPath), { recursive: true });
writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });

const jwk = publicKey.export({ format: "jwk" });
const xy = Buffer.concat([Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
writeFileSync(path.join(root, "app", "update-public-key.txt"), xy.toString("base64") + "\n");
console.log(`Private key: ${keyPath} (back it up offline)`);
console.log("Public key:  app/update-public-key.txt (commit it)");
