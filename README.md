# Paraphe

Fill and sign PDFs. One HTML file, offline, no ads, no account, no bloat.

*Paraphe* is French for the initials you write on each page of a contract.

## Use it

1. `npm ci && npm run build`
2. Open `dist/paraphe.html` in Edge, Chrome or Firefox (double-click works).
3. Drop a PDF on the window, or press **Ctrl+O**.

| To | Do |
|---|---|
| Fill a form | Click its fields and type, as usual |
| Write anywhere | **Text** tool, click, type. Double-click to edit later |
| Tick a box | **✓** or **✗** tool, click each box, **Esc** when done |
| Add today's date | **Date** tool, click |
| Sign | **Sign**: draw, type or import a photo of your signature, then click where it goes. Signatures are kept in this browser for next time |
| Move or resize | Drag an item, or its corner handle. Arrow keys nudge |
| Undo / delete | **Ctrl+Z** / **Del** |
| Save | **Ctrl+S** writes a copy named `… (signed).pdf` |

## Privacy

The page has a Content-Security-Policy that forbids every network request, so
your documents and signatures cannot leave the computer. Saved signatures live
in the browser's local storage only.

## How it works

- [pdf.js](https://github.com/mozilla/pdf.js) renders pages and form fields and
  writes the result, the same engine Firefox uses to fill and save PDFs.
- Text, marks and signatures are saved as standard PDF annotations (FreeText
  and Stamp) with appearance streams, so every viewer shows and prints them.
  pdf.js writes them as an incremental update, which also works on
  password-protected and owner-encrypted PDFs (common for government forms).
- `build.mjs` bundles everything with esbuild into a single file, including
  pdf.js's standard fonts and image decoders, so nothing is fetched at runtime.

## Limits

- Form scripts (auto-calculated totals, formatting) don't run.
- XFA-only forms and CJK text in added text boxes aren't supported.
- This is a visual signature, not a cryptographic digital signature.

## Develop

`src/app.js` (viewer, tools, saving), `src/signature.js` (signature dialog),
`src/app.css`, `src/index.html`. `npm run build -- --test` also writes
`dist/paraphe.test.html`, which may fetch fixtures from a local server.
