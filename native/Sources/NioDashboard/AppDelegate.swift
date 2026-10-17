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
    private var globalClickMonitor: Any?
    private var localClickMonitor: Any?
    private var panelAnimationGeneration = 0
    private var panelIsCollapsing = false
    private static let panelScaleAnimationKey = "nio.panel.scale"

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
            configurePanelDismissal()
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
        if let globalClickMonitor { NSEvent.removeMonitor(globalClickMonitor) }
        if let localClickMonitor { NSEvent.removeMonitor(localClickMonitor) }
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
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 660),
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
        panel.animationBehavior = .none
        let compactSurface = WebSurface(
            entry: "tray",
            bundleRoot: root,
            backend: backend,
            commandHandler: self
        )
        let container = NSView(frame: panel.contentView?.bounds ?? .zero)
        container.wantsLayer = true
        compactSurface.webView.autoresizingMask = [.width, .height]
        compactSurface.webView.frame = container.bounds
        compactSurface.webView.wantsLayer = true
        compactSurface.webView.layer?.cornerRadius = 28
        compactSurface.webView.layer?.masksToBounds = true
        container.addSubview(compactSurface.webView)
        panel.contentView = container
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

    private func configurePanelDismissal() {
        globalClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            Task { @MainActor in
                self?.dismissCompactPanelWhenClickingOutside()
            }
        }
        localClickMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] event in
            Task { @MainActor in
                self?.dismissCompactPanelWhenClickingOutside()
            }
            return event
        }
    }

    private func dismissCompactPanelWhenClickingOutside() {
        guard compactPanel?.isVisible == true, !mouseIsInsideStatusItemOrPanel() else { return }
        dismissCompactPanel()
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
            dismissCompactPanel()
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
        guard let panel = compactPanel else { return }
        let collapsed = !panel.isVisible || panelIsCollapsing
        panelAnimationGeneration += 1
        panelIsCollapsing = false
        if !panel.isVisible {
            positionCompactPanel()
        }
        panel.orderFrontRegardless()
        guard collapsed else { return }
        resetPanelAppearance()
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }
        panel.alphaValue = 0
        animatePanelContent(appearing: true, duration: 0.2)
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.16
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            panel.animator().alphaValue = 1
        }
    }

    /// 收起时把面板缩回状态栏图标，而不是直接消失。
    private func dismissCompactPanel() {
        panelPinnedByClick = false
        hoverDismissTask?.cancel()
        guard let panel = compactPanel, panel.isVisible, !panelIsCollapsing else { return }
        panelAnimationGeneration += 1
        let generation = panelAnimationGeneration
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else {
            panel.orderOut(nil)
            return
        }
        panelIsCollapsing = true
        animatePanelContent(appearing: false, duration: 0.22)
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.22
            context.timingFunction = CAMediaTimingFunction(name: .easeIn)
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            MainActor.assumeIsolated {
                guard let self, generation == self.panelAnimationGeneration else { return }
                self.panelIsCollapsing = false
                self.compactPanel?.orderOut(nil)
                self.resetPanelAppearance()
            }
        })
    }

    private func animatePanelContent(appearing: Bool, duration: CFTimeInterval) {
        guard let panel = compactPanel, let layer = panel.contentView?.layer else { return }
        let bounds = layer.bounds
        let anchorX = statusItemCenterX(in: panel) ?? bounds.midX
        let scale: CGFloat = 0.2
        // 以状态栏图标正下方的面板顶边为缩放中心（容器视图坐标 y 轴向上）。
        var collapsed = CATransform3DMakeTranslation(anchorX * (1 - scale), bounds.height * (1 - scale), 0)
        collapsed = CATransform3DScale(collapsed, scale, scale, 1)
        let animation = CABasicAnimation(keyPath: "transform")
        animation.fromValue = appearing ? collapsed : CATransform3DIdentity
        animation.toValue = appearing ? CATransform3DIdentity : collapsed
        animation.duration = duration
        animation.timingFunction = CAMediaTimingFunction(name: appearing ? .easeOut : .easeIn)
        animation.fillMode = .forwards
        animation.isRemovedOnCompletion = appearing
        layer.add(animation, forKey: Self.panelScaleAnimationKey)
    }

    private func resetPanelAppearance() {
        compactPanel?.contentView?.layer?.removeAnimation(forKey: Self.panelScaleAnimationKey)
        compactPanel?.alphaValue = 1
    }

    private func statusItemCenterX(in panel: NSWindow) -> CGFloat? {
        guard let button = statusItem?.button, let window = button.window else { return nil }
        let frame = window.convertToScreen(button.convert(button.bounds, to: nil))
        return min(max(frame.midX - panel.frame.minX, 0), panel.frame.width)
    }

    private func scheduleHoverDismiss() {
        hoverDismissTask?.cancel()
        hoverDismissTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(350))
            guard let self, !Task.isCancelled, !panelPinnedByClick else { return }
            if !mouseIsInsideStatusItemOrPanel() {
                dismissCompactPanel()
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
        dismissCompactPanel()
        guard let window = dashboardWindow else { return }
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        if let route {
            dashboardSurface?.navigate(route: route)
        }
    }

    func hideCompactPanel() {
        dismissCompactPanel()
    }

    func resizeCompactPanel(height: Double) {
        guard let panel = compactPanel else { return }
        let screen = statusItem?.button?.window?.screen ?? panel.screen ?? NSScreen.main
        let maxHeight = (screen?.visibleFrame.height ?? 900) - 16
        let target = min(max(CGFloat(height.rounded(.up)), 360), maxHeight)
        guard abs(panel.frame.height - target) >= 1 else { return }
        var frame = panel.frame
        frame.origin.y += frame.height - target
        frame.size.height = target
        panel.setFrame(frame, display: true)
        if panel.isVisible {
            positionCompactPanel()
        }
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
