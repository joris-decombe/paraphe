// Builds dist/paraphe.html: one self-contained file with every script, style,
// font and decoder inlined, so it opens from disk and works offline.
import * as esbuild from "esbuild";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const pdfjsDir = path.join(root, "node_modules", "pdfjs-dist");

// Data pdf.js would otherwise fetch at runtime: standard fonts (for PDFs that
// don't embed their fonts) and WebAssembly decoders for JPEG 2000, JBIG2 and
// colour profiles. CJK cMaps and the JavaScript sandbox are left out on purpose.
const WASM = ["openjpeg.wasm", "jbig2.wasm", "qcms_bg.wasm"];

async function listAssets() {
  const fontDir = path.join(pdfjsDir, "standard_fonts");
  const fonts = (await readdir(fontDir)).filter((f) => /\.(pfb|ttf)$/.test(f)).map((f) => path.join(fontDir, f));
  return [...fonts, ...WASM.map((f) => path.join(pdfjsDir, "wasm", f))];
}

const pdfAssets = {
  name: "pdf-assets",
  setup(b) {
    b.onResolve({ filter: /^virtual:pdf-assets$/ }, (a) => ({ path: a.path, namespace: "pdf-assets" }));
    b.onLoad({ filter: /.*/, namespace: "pdf-assets" }, async () => {
      const files = await listAssets();
      const imports = files.map((f, i) => `import a${i} from ${JSON.stringify(f)};`).join("\n");
      const map = files.map((f, i) => `${JSON.stringify(path.basename(f))}: a${i}`).join(",\n");
      return { contents: `${imports}\nexport default {\n${map}\n};`, resolveDir: root, loader: "js" };
    });
  },
};

// The pdf.js worker, built on its own and embedded as a string (see src/pdfjs.js).
const target = ["chrome120", "firefox128", "safari17"];
const worker = await esbuild.build({
  entryPoints: [path.join(pdfjsDir, "build", "pdf.worker.mjs")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target,
  minify: true,
  legalComments: "eof",
  write: false,
  logLevel: "warning",
});
const workerSource = {
  name: "pdf-worker-source",
  setup(b) {
    b.onResolve({ filter: /^virtual:pdf-worker-source$/ }, (a) => ({ path: a.path, namespace: "pdf-worker-source" }));
    b.onLoad({ filter: /.*/, namespace: "pdf-worker-source" }, () => ({
      contents: `export default ${JSON.stringify(worker.outputFiles[0].text)};`,
      loader: "js",
    }));
  },
};

const result = await esbuild.build({
  entryPoints: [path.join(root, "src", "app.js")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target,
  minify: true,
  legalComments: "eof",
  write: false,
  outdir: path.join(root, "dist"),
  loader: { ".pfb": "binary", ".ttf": "binary", ".wasm": "binary", ".svg": "dataurl", ".gif": "dataurl", ".png": "dataurl" },
  plugins: [pdfAssets, workerSource],
  logLevel: "warning",
});

const js = result.outputFiles.find((f) => f.path.endsWith(".js")).text;
const css = result.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "";
const template = await readFile(path.join(root, "src", "index.html"), "utf8");

// Inline safely: a literal "</script" or "</style" would end the element early.
const safeJs = js.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
const safeCss = css.replace(/<\/style/gi, "<\\/style");
const html = template.replace("/*CSS*/", () => safeCss).replace("/*JS*/", () => safeJs);

await mkdir(path.join(root, "dist"), { recursive: true });
const out = path.join(root, "dist", "paraphe.html");
await writeFile(out, html);
console.log(`Built ${path.relative(root, out)} (${(html.length / 1024 / 1024).toFixed(1)} MB)`);

// Licenses of everything inlined above, taken from the files pdfjs-dist ships,
// so they match the versions bundled. The app packages add their own parts.
const { version: pdfjsVersion } = JSON.parse(await readFile(path.join(pdfjsDir, "package.json"), "utf8"));
const notices = [
  [`pdf.js ${pdfjsVersion} (Mozilla), https://github.com/mozilla/pdf.js`, ["LICENSE"]],
  ["Foxit standard fonts (PDFium)", ["standard_fonts/LICENSE_FOXIT"]],
  ["Liberation Sans fonts (Red Hat), unmodified; source: https://github.com/liberationfonts/liberation-fonts",
    ["standard_fonts/LICENSE_LIBERATION"]],
  ["OpenJPEG decoder (JPEG 2000), as compiled to WebAssembly by pdf.js",
    ["wasm/LICENSE_OPENJPEG", "wasm/LICENSE_PDFJS_OPENJPEG"]],
  ["JBIG2 decoder (PDFium), as compiled to WebAssembly by pdf.js", ["wasm/LICENSE_JBIG2", "wasm/LICENSE_PDFJS_JBIG2"]],
  ["qcms colour management, as compiled to WebAssembly by pdf.js", ["wasm/LICENSE_QCMS", "wasm/LICENSE_PDFJS_QCMS"]],
];
let noticeText = `Paraphe includes the following third-party software.\n`;
for (const [name, files] of notices) {
  noticeText += `\n${"=".repeat(78)}\n${name}\n${"=".repeat(78)}\n`;
  for (const f of files) noticeText += `\n${(await readFile(path.join(pdfjsDir, f), "utf8")).trim()}\n`;
}
await writeFile(path.join(root, "dist", "THIRD-PARTY-NOTICES.txt"), noticeText);

// Test build: same page, but allowed to fetch fixtures from the local test server.
if (process.argv.includes("--test")) {
  const testOut = path.join(root, "dist", "paraphe.test.html");
  await writeFile(testOut, html.replace("connect-src data: blob:", "connect-src data: blob: 'self'"));
  console.log(`Built ${path.relative(root, testOut)}`);
}
