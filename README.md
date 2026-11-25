# Paraphe

Fill and sign PDFs. One HTML file, offline, no ads, no account, no bloat.

*Paraphe* is French for the initials you write on each page of a contract.

## Use it

**Windows app.** `npm ci && npm run build:app` (needs the .NET SDK) produces
`dist/Paraphe/` and `dist/Paraphe-<version>-win-x64.zip`. Extract the zip
anywhere and run `Paraphe.exe`: no install, no admin rights. It runs on the
.NET Framework and WebView2 that come with Windows 11.

On its start screen, **Install and make Paraphe my PDF app** copies it to
`%LOCALAPPDATA%\Programs\Paraphe`, adds it to the Start menu and to
**Open with**, then opens Windows Settings where you pick it for `.pdf`
(Windows doesn't let apps make themselves the default). Uninstall from
Settings > Apps.

**macOS app (beta).** On a Mac: `npm ci && npm run build:app-macos` (needs the
Xcode command line tools) produces `dist/Paraphe.app` and
`dist/Paraphe-<version>-macos.zip`, a universal (Apple silicon + Intel) app.
Copy `Paraphe.app` anywhere (for example /Applications) and open it. The first
time, right-click it and choose **Open**: the app is only ad-hoc signed, so
macOS asks you to confirm it once. Sign with an Apple Developer ID and
notarize before distributing beyond that. To open PDFs with Paraphe by
default, click **Make Paraphe my PDF app** on its start screen, or use Finder
> Get Info > Open with > "Use this application for all documents".

**In a browser.** `npm ci && npm run build`, then open `dist/paraphe.html` in
Edge, Chrome or Firefox (double-click works).

**In a browser.** `npm ci && npm run build`, then open `dist/paraphe.html` in
Edge, Chrome or Firefox (double-click works).

Drop a PDF on the window, or press **Ctrl+O** (⌘O on macOS).

| To | Do |
|---|---|
| Fill a form | Click its fields and type, as usual |
| Write anywhere | **Text** tool, click, type. Double-click to edit later |
| Tick a box | **✓** or **✗** tool, click each box, **Esc** when done |
| Add today's date | **Date** tool, click |
| Change date or number style | The region button next to **Date** (e.g. `FR`): region, and short, long or ISO dates. It starts from your browser's language |
| Fill an amount | Type it any way (`1234,5`, `1,234.50`). Fields the form marks as amounts or percentages are rewritten in your region's style, e.g. `1 234,50 €` |
| Sign | **Sign**: draw, type or import a photo of your signature, then click where it goes. Signatures are kept in this browser for next time |
| Move or resize | Drag an item, or its corner handle. Arrow keys nudge |
| Undo / delete | **Ctrl+Z** / **Del** |
| Save | **Ctrl+S** (⌘S on macOS) writes a copy named `… (signed).pdf`, in your region's language (`… (signé).pdf`) |

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

`app/` is the Windows host (C#, WinForms + WebView2, .NET Framework 4.8): it
shows `web/paraphe.html` from a private `https://app.paraphe/` origin, passes
files opened from Explorer to the page, saves through the native dialog, uses
Windows' regional format for dates and amounts, and keeps its data in
`%LOCALAPPDATA%\Paraphe`. `app/package.mjs` builds the folder and the zip.

`app-macos/` is the macOS counterpart (Swift, AppKit + WKWebView, macOS 13+):
same page over a private `app-paraphe://` origin, file open/save/print and the
system's regional format through web messages. Printing goes through the host
because WKWebView has no `window.print()`.
