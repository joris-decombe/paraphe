// Load pdf.js and its worker into the page itself.
//
// The app is a single HTML file opened from disk (file://), where browsers
// refuse to start a Web Worker from a separate script. Importing the worker
// module here makes it register `globalThis.pdfjsWorker`, and pdf.js then runs
// its parser on the main thread instead of spawning a worker.
//
// pdf_viewer.mjs reads `globalThis.pdfjsLib` when it is evaluated, so this
// module must be imported before it.
import * as pdfjsLib from "pdfjs-dist";
import "pdfjs-dist/build/pdf.worker.mjs";

globalThis.pdfjsLib = pdfjsLib;

export { pdfjsLib };
