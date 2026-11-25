// Paraphe for macOS.
//
// A thin native host, the counterpart of the Windows app in app/: it shows the
// same single HTML page in a WKWebView, served from the private
// app-paraphe:// origin, and talks to it through web messages. Build and
// package with `npm run build:app-macos` (needs macOS).

import AppKit
import CoreServices
import UniformTypeIdentifiers
import WebKit

let scheme = "app-paraphe"

// ---------------------------------------------------------------------------
// Serving the page from a private origin
// ---------------------------------------------------------------------------

/// Serves the app's one HTML page under app-paraphe://start, and PDFs that the
/// user opened under app-paraphe://start/open/<token>. Files live on the same
/// origin as the page, so its fetch() needs no CORS. Tokens are random and
/// work once, so a compromised page cannot read arbitrary files from disk.
final class SchemeHandler: NSObject, WKURLSchemeHandler {
    private let html: Data
    private var files: [String: URL] = [:]
    private let queue = DispatchQueue(label: "app.paraphe.scheme")

    init(html: Data) {
        self.html = html
        super.init()
    }

    func token(for file: URL) -> String {
        let token = UUID().uuidString
        queue.sync { files[token] = file }
        return token
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, url.scheme == scheme else {
            return deny(task, 403)
        }
        guard url.host == "start" else { return deny(task, 404) }
        if url.path == "/paraphe.html" {
            send(task, url: url, data: html, mime: "text/html", encoding: "utf-8")
        } else if url.path.hasPrefix("/open/") {
            let token = String(url.path.dropFirst("/open/".count))
            // One use per token: forget the file once it has been handed over.
            let file = queue.sync { files.removeValue(forKey: token) }
            guard let file, file.isFileURL,
                  let data = try? Data(contentsOf: file, options: .mappedIfSafe) else {
                return deny(task, 404)
            }
            send(task, url: url, data: data, mime: "application/pdf", encoding: nil)
        } else {
            deny(task, 404)
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    private func send(_ task: WKURLSchemeTask, url: URL, data: Data, mime: String, encoding: String?) {
        let response = URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: encoding)
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    private func deny(_ task: WKURLSchemeTask, _ status: Int) {
        guard let url = task.request.url else { return }
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)
        if let response {
            task.didReceive(response)
            task.didFinish()
        }
    }
}

// ---------------------------------------------------------------------------
// Messages from the page
// ---------------------------------------------------------------------------

final class MessageHandler: NSObject, WKScriptMessageHandler {
    private weak var app: AppDelegate?

    init(app: AppDelegate) {
        self.app = app
        super.init()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String,
              let webView = message.webView else { return }
        switch type {
        case "ready":
            app?.pageDidSendReady(webView: webView)
        case "save":
            app?.saveRequested(name: body["name"] as? String, data: body["data"] as? String, webView: webView)
        case "make-default":
            app?.makeDefault()
        case "print":
            app?.printRequested(webView: webView)
        default:
            break
        }
    }
}

// ---------------------------------------------------------------------------
// The app: a window, a web view, native open/save/print
// ---------------------------------------------------------------------------

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private var web: WKWebView?
    private var handler: SchemeHandler?
    private var pageReady = false
    private var pendingFile: URL?
    private var currentDir: URL?
    private var forceClose = false

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.regular)

        guard let htmlURL = Bundle.main.url(forResource: "paraphe", withExtension: "html"),
              let html = try? Data(contentsOf: htmlURL) else {
            return fail("The file Resources/paraphe.html is missing from the app bundle. Extract the zip again.")
        }
        handler = SchemeHandler(html: html)

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(handler, forURLScheme: scheme)
        config.userContentController.add(MessageHandler(app: self), name: "paraphe")

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        self.web = web

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 980),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Paraphe"
        window.minSize = NSSize(width: 640, height: 480)
        window.contentView = web
        window.setFrameAutosaveName("Paraphe")
        window.center()
        window.delegate = self
        window.makeKeyAndOrderFront(nil)
        self.window = window

        buildMenu()
        if ProcessInfo.processInfo.arguments.contains("--devtools"), #available(macOS 13.3, *) {
            web.isInspectable = true
        }

        if let start = URL(string: "\(scheme)://start/paraphe.html") {
            web.load(URLRequest(url: start))
        }
    }

    // PDFs opened from Finder or drag onto the Dock icon.
    func application(_ application: NSApplication, open urls: [URL]) {
        guard let file = urls.last(where: {
            $0.pathExtension.lowercased() == "pdf" && (try? $0.checkResourceIsReachable()) == true
        }) else {
            return
        }
        currentDir = file.deletingLastPathComponent()
        pendingFile = file
        flushPendingFile()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    fileprivate func pageDidSendReady(webView: WKWebView) {
        pageReady = true
        let version = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? ""
        let locale = Locale.current.identifier.replacingOccurrences(of: "_", with: "-")
        toPage(webView, ["type": "host", "version": version, "installed": true, "locale": locale])
        flushPendingFile()
    }

    private func flushPendingFile() {
        guard pageReady, let file = pendingFile, let web else { return }
        pendingFile = nil
        let token = handler?.token(for: file) ?? UUID().uuidString
        toPage(web, ["type": "open", "name": file.lastPathComponent, "url": "\(scheme)://start/open/\(token)"])
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    private func toPage(_ webView: WKWebView, _ message: [String: Any]) {
        guard let json = try? JSONSerialization.data(withJSONObject: message) else { return }
        webView.evaluateJavaScript("window.__parapheMessage&&window.__parapheMessage(\(String(decoding: json, as: UTF8.self)))", completionHandler: nil)
    }

    /// Native "Save as", starting next to the PDF that was opened.
    fileprivate func saveRequested(name: String?, data: String?, webView: WKWebView) {
        guard let base64 = data, let bytes = Data(base64Encoded: base64) else {
            return toPage(webView, ["type": "save-failed", "error": "The file could not be read."])
        }
        let panel = NSSavePanel()
        panel.title = "Save the filled PDF"
        panel.allowedContentTypes = [.pdf]
        panel.nameFieldStringValue = (name?.isEmpty == false) ? name! : "document.pdf"
        panel.directoryURL = currentDir
        guard let window else { return fail("Paraphe has no window.") }
        panel.beginSheetModal(for: window) { response in
            switch response {
            case .OK:
                guard let url = panel.url else {
                    self.toPage(webView, ["type": "save-failed", "error": "No destination."])
                    return
                }
                do {
                    try bytes.write(to: url, options: [.atomic])
                    self.currentDir = url.deletingLastPathComponent()
                    self.toPage(webView, ["type": "saved", "name": url.lastPathComponent])
                } catch {
                    self.toPage(webView, ["type": "save-failed", "error": error.localizedDescription])
                }
            default:
                self.toPage(webView, ["type": "save-cancelled"])
            }
        }
    }

    /// WKWebView does not implement window.print(), so the page sends its
    /// prepared print view here; when the panel closes the page is restored.
    fileprivate func printRequested(webView: WKWebView) {
        let info = (NSPrintInfo.shared.copy() as? NSPrintInfo) ?? NSPrintInfo(dictionary: [:])
        guard let window else {
            return toPage(webView, ["type": "print-done"])
        }
        let operation = webView.printOperation(with: info)
        operation.showsPrintPanel = true
        operation.showsProgressPanel = true
        operation.view?.frame = NSRect(origin: .zero, size: info.paperSize)
        let didRun = #selector(printOperationDidRun(_:success:contextInfo:))
        operation.runModal(for: window, delegate: self, didRun: didRun, contextInfo: nil)
    }

    @objc private func printOperationDidRun(_ printOperation: NSPrintOperation, success: Bool, contextInfo: UnsafeMutableRawPointer?) {
        if let web {
            toPage(web, ["type": "print-done"])
        }
    }

    /// File > Open (Cmd+O). WebKit only opens a file chooser on a real click,
    /// so the menu shows the native panel and hands the file over like Finder.
    @objc private func openPDF(_ sender: Any?) {
        guard let window else { return }
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.pdf]
        panel.directoryURL = currentDir
        panel.beginSheetModal(for: window) { [self] response in
            guard response == .OK, let file = panel.url else { return }
            currentDir = file.deletingLastPathComponent()
            pendingFile = file
            flushPendingFile()
        }
    }

    /// macOS decides default apps itself; this registers Paraphe and explains
    /// what to check if it did not take effect.
    fileprivate func makeDefault() {
        let bundleID = Bundle.main.bundleIdentifier ?? "app.paraphe"
        LSSetDefaultRoleHandlerForContentType("com.adobe.pdf" as CFString, .all, bundleID as CFString)
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = "Paraphe is registered as a PDF app."
        alert.informativeText = "If a PDF still opens somewhere else, right-click it in Finder, choose Get Info > Open with > Paraphe, then \"Use this application for all documents\"."
        if let window {
            alert.beginSheetModal(for: window, completionHandler: nil)
        } else {
            alert.runModal()
        }
    }

    /// Asks the page whether there are unsaved changes, then runs the callback.
    private func confirmIfDirty(on _window: NSWindow, then confirm: @escaping (Bool) -> Void) {
        guard let web, pageReady else {
            return confirm(true)
        }
        web.evaluateJavaScript("!!(window.parapheIsDirty && window.parapheIsDirty())") { result, _ in
            let dirty = (result as? NSNumber)?.boolValue ?? false
            guard dirty else {
                return confirm(true)
            }
            let alert = NSAlert()
            alert.alertStyle = .warning
            alert.messageText = "You have unsaved changes. Close anyway?"
            alert.addButton(withTitle: "Close")
            alert.addButton(withTitle: "Cancel")
            alert.beginSheetModal(for: _window) { response in
                confirm(response == .alertFirstButtonReturn)
            }
        }
    }

    private func fail(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "Paraphe"
        alert.informativeText = message
        alert.runModal()
        NSApp.terminate(nil)
    }

    // Menu bar --------------------------------------------------------------

    private func buildMenu() {
        let main = NSMenu()

        let appRoot = NSMenuItem()
        main.addItem(appRoot)
        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: "About Paraphe", action: #selector(showAbout(_:)), keyEquivalent: ""))
        appMenu.addItem(.separator())
        appMenu.addItem(NSMenuItem(title: "Quit Paraphe", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        appRoot.submenu = appMenu

        let fileRoot = NSMenuItem()
        main.addItem(fileRoot)
        let fileMenu = NSMenu(title: "File")
        fileMenu.addItem(item("Open…", key: "o", action: #selector(openPDF(_:))))
        fileMenu.addItem(item("Save…", key: "s", action: #selector(sendKeyS(_:))))
        fileMenu.addItem(item("Print…", key: "p", action: #selector(sendKeyP(_:))))
        fileMenu.addItem(.separator())
        fileMenu.addItem(NSMenuItem(title: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
        fileRoot.submenu = fileMenu

        let editRoot = NSMenuItem()
        main.addItem(editRoot)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(item("Undo", key: "z", action: #selector(sendUndo(_:))))
        editMenu.addItem(item("Redo", key: "z", action: #selector(sendRedo(_:)), shift: true))
        editMenu.addItem(.separator())
        editMenu.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        editMenu.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        editMenu.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        editMenu.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        editRoot.submenu = editMenu

        let windowRoot = NSMenuItem()
        main.addItem(windowRoot)
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(NSMenuItem(title: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"))
        NSApp.windowsMenu = windowMenu
        windowRoot.submenu = windowMenu

        NSApp.mainMenu = main
    }

    private func item(_ title: String, key: String, action: Selector, shift: Bool = false) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        if shift {
            item.keyEquivalentModifierMask = [.command, .shift]
        }
        return item
    }

    /// Menu shortcuts for tools that live in the page (Save, Print, Undo):
    /// forward them as Cmd keydowns so the page handles them once.
    @objc private func sendKeyS(_ sender: NSMenuItem) { sendKey("s") }
    @objc private func sendKeyP(_ sender: NSMenuItem) { sendKey("p") }
    @objc private func sendUndo(_ sender: NSMenuItem) { sendZ(shift: false) }
    @objc private func sendRedo(_ sender: NSMenuItem) { sendZ(shift: true) }

    private func sendKey(_ key: String) {
        guard let web else { return }
        web.evaluateJavaScript(
            "document.dispatchEvent(new KeyboardEvent('keydown',{key:'\(key)',metaKey:true,bubbles:true,cancelable:true}))",
            completionHandler: nil
        )
    }

    private func sendZ(shift: Bool) {
        guard let web else { return }
        let script = """
        (function (a) {
          if (a && (a.isContentEditable || /^(INPUT|TEXTAREA)$/.test(a.tagName))) {
            document.execCommand(\(shift ? "'redo'" : "'undo'"));
          } else {
            document.dispatchEvent(new KeyboardEvent('keydown',{key:'z',metaKey:true,shiftKey:\(shift ? "true" : "false"),bubbles:true,cancelable:true}));
          }
        })(document.activeElement)
        """
        web.evaluateJavaScript(script, completionHandler: nil)
    }

    @objc private func showAbout(_ sender: NSMenuItem) {
        let version = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? ""
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = "Paraphe \(version)"
        alert.informativeText = "Fill and sign PDFs. Offline, no ads, no bloat.\n\nSignatures and settings stay on this computer."
        if let window {
            alert.beginSheetModal(for: window, completionHandler: nil)
        } else {
            alert.runModal()
        }
    }
}

// ---------------------------------------------------------------------------
// Only the app page may load here; everything else goes to the browser
// ---------------------------------------------------------------------------

extension AppDelegate: WKNavigationDelegate, WKUIDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            return decisionHandler(.cancel)
        }
        if url.scheme == scheme, url.host == "start", url.path == "/paraphe.html" {
            return decisionHandler(.allow)
        }
        if navigationAction.navigationType == .linkActivated, let s = url.scheme, ["http", "https", "mailto"].contains(s) {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    /// target=_blank links from PDFs open in the default browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, let s = url.scheme, ["http", "https", "mailto"].contains(s) {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    /// The page's Open button and Cmd+O show the native open panel.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.allowedContentTypes = [.pdf]
        panel.directoryURL = currentDir
        guard let window else {
            return completionHandler(nil)
        }
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }
}

// ---------------------------------------------------------------------------
// Closing with unsaved changes
// ---------------------------------------------------------------------------

extension AppDelegate: NSWindowDelegate {
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if forceClose {
            return true
        }
        confirmIfDirty(on: sender) { [self] ok in
            if ok {
                forceClose = true
                sender.close()
            }
        }
        return false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let window, !forceClose else {
            return .terminateNow
        }
        confirmIfDirty(on: window) { ok in
            sender.reply(toApplicationShouldTerminate: ok)
        }
        return .terminateLater
    }
}

// ---------------------------------------------------------------------------

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
