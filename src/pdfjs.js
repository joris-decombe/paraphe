// Load pdf.js, with its parser in a background worker.
//
// The app is a single HTML file, possibly opened from disk (file://), where a
// worker can't be loaded from a separate script file. So the build embeds the
// worker's code as a string, and we start it from a blob: URL. If the browser
// refuses that, pdf.js falls back to importing the same blob on the main
// thread (slower on big files, but it works).
//
// pdf_viewer.mjs reads `globalThis.pdfjsLib` when it is evaluated, so this
// module must be imported before it.
import * as pdfjsLib from "pdfjs-dist";
import workerSource from "virtual:pdf-worker-source";

globalThis.pdfjsLib = pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(
  new Blob([workerSource], { type: "text/javascript" }),
);

export { pdfjsLib };
