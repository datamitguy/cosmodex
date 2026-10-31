// Cosmodex Office — the Dock app that starts the local server and opens the page.
//
// Why a compiled app rather than a shell script inside an .app bundle: the
// first version was exactly that, and macOS ended the server two seconds after
// the script finished. An app that a user launches from the Dock owns what it
// starts, and when it exits those go with it — nohup does not help, and
// neither does moving the server into its own session. So the app stays open
// for as long as Cosmodex is running, which is also what a Mac app is supposed
// to do: a dot under the Dock icon while it runs, a click on it to bring the
// page back, and Quit to stop it. A script cannot answer those last two — they
// arrive as Apple Events — so it has to be a real AppKit app.
//
// It is built on the Mac that will run it, by make-mac-launcher.command, and no
// binary is kept in the repository. A downloaded app is what a managed laptop
// is most likely to refuse; one compiled on the machine from source it can
// read is the version with the best chance of being allowed.
//
// Nothing machine-specific is compiled in. The folder and the Python to use are
// read from Info.plist (CosmodexDir, CosmodexPython), which the same script
// writes. CosmodexOpenPage = false starts the server without opening the
// browser; it exists so the launcher can be tested without opening tabs.

import AppKit

let port = 8765
let pageURL = URL(string: "http://localhost:\(port)/")!

final class Launcher: NSObject, NSApplicationDelegate {
    private var server: Process?
    private var quitting = false
    private let info = Bundle.main.infoDictionary ?? [:]
    private lazy var dir = info["CosmodexDir"] as? String ?? ""
    private lazy var logURL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/Cosmodex Office.log")

    // ── Lifecycle ──────────────────────────────────────────────────────────

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        switch probe() {
        case .ours:
            // Already up — most likely started from start-cosmodex.command in
            // Terminal. Use it. It is not ours to stop, so we keep no handle.
            openPage()
        case .foreign:
            fail("Something other than Cosmodex is using port \(port). If a Cosmodex Terminal window is open, close it and try again.")
        case .free:
            guard FileManager.default.fileExists(atPath: dir + "/cosmodex-server.py") else {
                fail("The Cosmodex folder is not where it was:\n\(dir)\n\nIf you moved it, double-click make-mac-launcher.command in its new place to rebuild this app.")
                return
            }
            guard startServer() else { return }
            waitThenOpen()
        }
    }

    // A click on the Dock icon while we are running brings the page back —
    // the usual reason to click it is that the tab was closed.
    func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows: Bool) -> Bool {
        openPage()
        return false
    }

    func applicationWillTerminate(_ note: Notification) {
        quitting = true
        guard let s = server, s.isRunning else { return }
        s.terminate()                       // SIGTERM: the server closes its database cleanly
        let deadline = Date().addingTimeInterval(3)
        while s.isRunning && Date() < deadline { usleep(50_000) }
        if s.isRunning { kill(s.processIdentifier, SIGKILL) }
    }

    func applicationDockMenu(_ app: NSApplication) -> NSMenu? {
        let m = NSMenu()
        m.addItem(withTitle: "Open Cosmodex", action: #selector(openAction), keyEquivalent: "")
        return m
    }

    @objc private func openAction() { openPage() }

    // ── Server ─────────────────────────────────────────────────────────────

    private func python() -> String? {
        let candidates = [info["CosmodexPython"] as? String,
                          "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]
        return candidates.compactMap { $0 }.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    private func startServer() -> Bool {
        guard let py = python() else {
            fail("Python 3 was not found. Open Terminal and run:  python3 --version  — and accept if macOS offers to install developer tools.")
            return false
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: py)
        p.arguments = ["cosmodex-server.py"]
        p.currentDirectoryURL = URL(fileURLWithPath: dir)
        var env = ProcessInfo.processInfo.environment
        env["COSMODEX_PORT"] = String(port)
        p.environment = env
        if let log = openLog() {
            log.write("--- \(stamp()) starting\n".data(using: .utf8)!)
            p.standardOutput = log
            p.standardError = log
        }
        // If the server dies on its own, say so rather than leave a running
        // app that opens a dead page.
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self = self, !self.quitting else { return }
                self.fail("Cosmodex stopped unexpectedly (exit \(proc.terminationStatus)). The details are in ~/Library/Logs/Cosmodex Office.log")
            }
        }
        do { try p.run() } catch {
            fail("Cosmodex could not start: \(error.localizedDescription)")
            return false
        }
        server = p
        return true
    }

    private func waitThenOpen() {
        DispatchQueue.global().async {
            for _ in 0..<50 {                                     // up to ~10 s
                if self.probe() == .ours { DispatchQueue.main.async { self.openPage() }; return }
                usleep(200_000)
            }
            DispatchQueue.main.async {
                self.fail("Cosmodex did not answer within 10 seconds. The details are in ~/Library/Logs/Cosmodex Office.log")
            }
        }
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    private enum Port { case free, ours, foreign }

    // Is anything answering on the port, and is it Cosmodex? Something else
    // may hold 8765, and opening that would look like Cosmodex had broken.
    private func probe() -> Port {
        var req = URLRequest(url: pageURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 1)
        req.httpMethod = "GET"
        let done = DispatchSemaphore(value: 0)
        var result = Port.free
        URLSession.shared.dataTask(with: req) { data, resp, err in
            if err == nil, resp != nil {
                let body = String(data: data ?? Data(), encoding: .utf8) ?? ""
                result = body.contains("Cosmodex") ? .ours : .foreign
            }
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 2)
        return result
    }

    private func openPage() {
        if (info["CosmodexOpenPage"] as? Bool) == false { return }
        NSWorkspace.shared.open(pageURL)
    }

    private func openLog() -> FileHandle? {
        let fm = FileManager.default
        try? fm.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !fm.fileExists(atPath: logURL.path) { fm.createFile(atPath: logURL.path, contents: nil) }
        let h = try? FileHandle(forWritingTo: logURL)
        h?.seekToEndOfFile()
        return h
    }

    private func stamp() -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HH:mm:ss"; return f.string(from: Date())
    }

    private func fail(_ message: String) {
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert()
        a.messageText = "Cosmodex Office"
        a.informativeText = message
        a.alertStyle = .warning
        a.runModal()
        NSApp.terminate(nil)
    }

    // Without a main menu, ⌘Q does nothing.
    private func buildMenu() {
        let main = NSMenu()
        let item = NSMenuItem()
        main.addItem(item)
        let app = NSMenu()
        app.addItem(withTitle: "Open Cosmodex", action: #selector(openAction), keyEquivalent: "o")
        app.addItem(.separator())
        app.addItem(withTitle: "Quit Cosmodex Office", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.submenu = app
        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = Launcher()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
