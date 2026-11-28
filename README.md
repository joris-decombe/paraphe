# Paraphe

Fill and sign PDFs. One HTML file, offline, no ads, no account, no bloat.

*Paraphe* is French for the initials you write on each page of a contract.

## Use it

**Windows app.** `npm ci && npm run build:app` (needs the .NET SDK) produces
`dist/Paraphe/` and `dist/Paraphe-<version>-win-x64.zip`. Extract the zip
anywhere and run `Paraphe.exe`: no install, no admin rights. It runs on the
.NET Framework and WebView2 that come with Windows 11.

On its start screen, **Install** copies it to `%LOCALAPPDATA%\Programs\Paraphe`
and adds it to the Start menu and to **Open with**. **Settings** (the gear in
the toolbar) has the rest:

- **Appearance**: light, dark or follow the system, and a colour (blue, teal,
  green, orange, pink or violet), each with a light and a dark side. The
  title bar follows. Also in the web app, where Settings links to the Windows
  download.
- **Make Paraphe the default** shows Windows' own "Open with" list for PDFs:
  pick Paraphe, then **Always** (Windows doesn't let apps make themselves the
  default). The panel says which app opens your PDFs now.
- **Updates**: on first launch Paraphe asks whether to check for updates. If
  you say yes, it asks GitHub once a day for the latest release's
  `update.json`, and installs an update only if it carries Paraphe's release
  signature (ECDSA P-256, checked against the public key built into the app).
  The new version goes in when you close or restart Paraphe.
- **Uninstall** (also in Windows Settings > Apps), optionally with your saved
  signatures and settings.

**macOS app.** Each release has `Paraphe-<version>-macos.zip`, a universal
(Apple silicon + Intel) app for macOS 13 or newer; the `latest` link is
`Paraphe-macos.zip`. To build it yourself on a Mac: `npm ci && npm run
build:app-macos` (needs the Xcode command line tools) produces
`dist/Paraphe.app` and the zip. Move `Paraphe.app` to Applications and open
it. The app is only ad-hoc signed, so the first time macOS won't open it:
open System Settings > Privacy & Security and click **Open Anyway**. To open PDFs with Paraphe by
default, click **Make Paraphe my PDF app** on its start screen, or use Finder
> Get Info > Open with > "Use this application for all documents".

**In a browser.** Open https://paraphe.dx2-66.com/app/, or `npm ci && npm run build`
and open `dist/paraphe.html` in Edge, Chrome or Firefox (double-click works).
Either way the page runs entirely on your computer.

## Release

Raise `version` in `package.json`, merge to main, then on main:

```
npm run release -- notes.md
```

(`notes.md` is optional; without it GitHub writes the notes.) `tools/release.mjs`:

1. checks that main is clean and pushed, and that the version isn't released;
2. builds the Windows zip and the site (`dist/site/`: the showcase pages and
   the web app at `/app/`), and packs the site as `paraphe-site.tar.gz`;
3. writes both hashes into `dist/update.json` and signs it with the release
   key (kept outside the repo, by default
   `%USERPROFILE%\.paraphe\release-signing-key.pem`; `node tools/keygen.mjs`
   made it once);
4. creates the GitHub release with the zip (also as the version-free
   `Paraphe-win-x64.zip`, for the `latest` link), the site, `update.json` and
   `update.json.sig`. Installed copies find the update there;
5. waits for the macOS app workflow (`.github/workflows/macos.yml`), which
   builds the Mac app on a GitHub Mac runner and attaches
   `Paraphe-<version>-macos.zip` and the version-free `Paraphe-macos.zip`;
6. starts the Paraphe workflow in joris-decombe/dx2-66, which checks the
   signature and the site's hash, then deploys https://paraphe.dx2-66.com.

Drop a PDF on the window, or press **Ctrl+O** (⌘O on macOS).

| To | Do |
|---|---|
| Fill a form | Click its fields and type, as usual |
| Fill a flat PDF | Some PDFs look like forms but have no fields. The dashed-box button in the toolbar marks likely places to write (lines after a label, empty boxes, small squares). Click one to type or tick there |
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

The Windows app makes one kind of request, and only if you say yes: once a day
it fetches `update.json` and its signature from GitHub, and downloads the zip
when you choose to update. Those requests carry your IP address and a generic
`Paraphe-Updater` user agent, nothing about your documents.

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

- Form scripts (auto-calculated totals, formatting) don't run. That's on
  purpose: scripts in PDFs are a common way to attack PDF readers.
- Finding places to fill in on flat PDFs is a best guess from the page's text and lines: it can miss a spot or suggest an extra one, and it doesn't read scanned pages.
- XFA-only forms and CJK text in added text boxes aren't supported.
- This is a visual signature, not a cryptographic digital signature.

## License

MIT, see [LICENSE](LICENSE). The build bundles pdf.js (Apache-2.0), its
standard fonts and image decoders, and on Windows the WebView2 SDK; their
licenses are collected in `THIRD-PARTY-NOTICES.txt`, which `npm run build`
writes to `dist/` and the app packages include.

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
