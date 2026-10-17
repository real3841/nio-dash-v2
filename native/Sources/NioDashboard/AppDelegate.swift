@preconcurrency import AppKit
@preconcurrency import WebKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NativeUICommandHandling {
    private var statusItem: NSStatusItem?
    private var compactPanel: NSPanel?
    private var dashboardWindow: NSWindow?
    private var compactSurface: WebSurface?
    private var dashboardSurface: WebSurface?
    private var backend: NativeBackend?
    private var isTerminating = false
    private var panelPinnedByClick = false
    private var hoverDismissTask: Task<Void, Never>?

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let environment = ProcessInfo.processInfo.environment
            let rootOverride = environment["NIO_APP_SUPPORT_ROOT"].flatMap {
                $0.isEmpty ? nil : URL(fileURLWithPath: $0, isDirectory: true)
            }
            let backend = try NativeBackend(rootURL: rootOverride)
            self.backend = backend
            backend.onEvent = { [weak self] name, payload in
                Task { @MainActor in
                    self?.compactSurface?.emit(name: name, payload: payload)
                    self?.dashboardSurface?.emit(name: name, payload: payload)
                }
            }
            configureStatusItem()
            configureWindows(backend: backend)
            if environment["NIO_E2E_SHOW_PANEL"] == "1" {
                compactPanel?.center()
                compactPanel?.orderFrontRegardless()
            }
            if environment["NIO_E2E_SHOW_DASHBOARD"] == "1" {
                openDashboard(route: nil)
            }
            captureSnapshotIfRequested(environment)
            NSWorkspace.shared.notificationCenter.addObserver(
                self,
                selector: #selector(systemDidWake),
                name: NSWorkspace.didWakeNotification,
                object: nil
            )
            Task {
                do {
                    try await backend.bootstrap(enableScheduler: environment["NIO_DISABLE_SCHEDULER"] != "1")
                } catch {
                    await MainActor.run {
                        self.presentStartupError(error)
                    }
                }
            }
        } catch {
            presentStartupError(error)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        isTerminating = true
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        if let backend {
            Task { await backend.scheduler.stop() }
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openDashboard(route: nil)
        return true
    }

    private func configureStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            button.image = NSImage(systemSymbolName: "car.side.fill", accessibilityDescription: "蔚来车辆看板")
            button.imagePosition = .imageOnly
            button.toolTip = "蔚来车辆看板"
            button.target = self
            button.action = #selector(toggleCompactPanel)
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
            button.addTrackingArea(NSTrackingArea(
                rect: .zero,
                options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                owner: self,
                userInfo: nil
            ))
        }
        statusItem = item
    }

    private func configureWindows(backend: NativeBackend) {
        let root = resolveWebRoot()

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 390, height: 620),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.animationBehavior = .utilityWindow
        let compactSurface = WebSurface(
            entry: "tray",
            bundleRoot: root,
            backend: backend,
            commandHandler: self
        )
        compactSurface.webView.autoresizingMask = [.width, .height]
        compactSurface.webView.frame = panel.contentView?.bounds ?? .zero
        compactSurface.webView.wantsLayer = true
        compactSurface.webView.layer?.cornerRadius = 24
        compactSurface.webView.layer?.masksToBounds = true
        panel.contentView = compactSurface.webView
        compactSurface.webView.addTrackingArea(NSTrackingArea(
            rect: .zero,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self,
            userInfo: nil
        ))
        compactSurface.load()
        compactPanel = panel
        self.compactSurface = compactSurface

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "蔚来车辆看板"
        window.minSize = NSSize(width: 960, height: 640)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        let dashboardSurface = WebSurface(
            entry: "dashboard",
            bundleRoot: root,
            backend: backend,
            commandHandler: self
        )
        window.contentView = dashboardSurface.webView
        dashboardSurface.load()
        dashboardWindow = window
        self.dashboardSurface = dashboardSurface
    }

    private func resolveWebRoot() -> URL {
        if let override = ProcessInfo.processInfo.environment["NIO_WEB_ROOT"], !override.isEmpty {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        if let resources = Bundle.main.resourceURL {
            let bundled = resources.appendingPathComponent("web", isDirectory: true)
            if FileManager.default.fileExists(atPath: bundled.appendingPathComponent("index.html").path) {
                return bundled
            }
        }
        let current = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
        for candidate in [
            current.appendingPathComponent("dist", isDirectory: true),
            current.deletingLastPathComponent().appendingPathComponent("dist", isDirectory: true),
        ] where FileManager.default.fileExists(atPath: candidate.appendingPathComponent("index.html").path) {
            return candidate
        }
        return current.appendingPathComponent("dist", isDirectory: true)
    }

    @objc private func toggleCompactPanel() {
        guard let panel = compactPanel else { return }
        hoverDismissTask?.cancel()
        if panel.isVisible, panelPinnedByClick {
            panelPinnedByClick = false
            panel.orderOut(nil)
        } else {
            panelPinnedByClick = true
            showCompactPanel()
        }
    }

    @objc func mouseEntered(with event: NSEvent) {
        hoverDismissTask?.cancel()
        if !panelPinnedByClick {
            showCompactPanel()
        }
    }

    @objc func mouseExited(with event: NSEvent) {
        scheduleHoverDismiss()
    }

    private func showCompactPanel() {
        positionCompactPanel()
        compactPanel?.orderFrontRegardless()
    }

    private func scheduleHoverDismiss() {
        hoverDismissTask?.cancel()
        hoverDismissTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(350))
            guard let self, !Task.isCancelled, !panelPinnedByClick else { return }
            if !mouseIsInsideStatusItemOrPanel() {
                compactPanel?.orderOut(nil)
            }
        }
    }

    private func mouseIsInsideStatusItemOrPanel() -> Bool {
        let location = NSEvent.mouseLocation
        if let panel = compactPanel, panel.isVisible, panel.frame.contains(location) {
            return true
        }
        guard let button = statusItem?.button, let window = button.window else { return false }
        let windowRect = button.convert(button.bounds, to: nil)
        return window.convertToScreen(windowRect).contains(location)
    }

    private func positionCompactPanel() {
        guard let panel = compactPanel, let button = statusItem?.button, let buttonWindow = button.window else { return }
        let buttonFrame = buttonWindow.convertToScreen(button.convert(button.bounds, to: nil))
        let visible = buttonWindow.screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? .zero
        var x = buttonFrame.midX - panel.frame.width / 2
        x = min(max(x, visible.minX + 8), visible.maxX - panel.frame.width - 8)
        let y = buttonFrame.minY - panel.frame.height - 6
        panel.setFrameOrigin(NSPoint(x: x, y: max(y, visible.minY + 8)))
    }

    func openDashboard(route: String?) {
        panelPinnedByClick = false
        compactPanel?.orderOut(nil)
        guard let window = dashboardWindow else { return }
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        if let route {
            dashboardSurface?.navigate(route: route)
        }
    }

    func hideCompactPanel() {
        panelPinnedByClick = false
        compactPanel?.orderOut(nil)
    }

    func terminateApplication() {
        isTerminating = true
        NSApplication.shared.terminate(nil)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if sender === dashboardWindow, !isTerminating {
            sender.orderOut(nil)
            return false
        }
        return true
    }

    @objc private func systemDidWake() {
        guard let backend else { return }
        Task {
            await backend.scheduler.wake()
            await MainActor.run {
                compactSurface?.emit(name: "dashboard.updated", payload: .object(["target": .string("wake")]))
                dashboardSurface?.emit(name: "dashboard.updated", payload: .object(["target": .string("wake")]))
            }
        }
    }

    private func presentStartupError(_ error: any Error) {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "蔚来车辆看板无法启动"
        alert.informativeText = RedactedLog.redact(error.localizedDescription)
        alert.addButton(withTitle: "退出")
        alert.runModal()
        NSApplication.shared.terminate(nil)
    }

    private func captureSnapshotIfRequested(_ environment: [String: String]) {
        #if DEBUG
        guard let path = environment["NIO_E2E_SNAPSHOT_PATH"], !path.isEmpty else { return }
        Task {
            try? await Task.sleep(for: .seconds(2))
            guard
                let image = try? await compactSurface?.webView.takeSnapshot(configuration: nil),
                let tiff = image.tiffRepresentation,
                let bitmap = NSBitmapImageRep(data: tiff),
                let png = bitmap.representation(using: .png, properties: [:])
            else {
                return
            }
            try? png.write(to: URL(fileURLWithPath: path), options: .atomic)
            NSApplication.shared.terminate(nil)
        }
        #endif
    }
}
