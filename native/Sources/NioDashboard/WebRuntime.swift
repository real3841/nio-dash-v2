@preconcurrency import AppKit
@preconcurrency import WebKit

@MainActor
protocol NativeUICommandHandling: AnyObject {
    func openDashboard(route: String?)
    func hideCompactPanel()
    func resizeCompactPanel(height: Double)
    func terminateApplication()
}

final class ReadOnlySchemeHandler: NSObject, WKURLSchemeHandler, @unchecked Sendable {
    private let bundleRoot: URL
    private let backend: NativeBackend

    init(bundleRoot: URL, backend: NativeBackend) {
        self.bundleRoot = bundleRoot.standardizedFileURL
        self.backend = backend
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            fail(urlSchemeTask, code: 400)
            return
        }

        Task {
            let fileURL: URL?
            if url.host == "bundle" {
                let requested = url.path == "/" ? "index.html" : String(url.path.dropFirst())
                let candidate = bundleRoot.appendingPathComponent(requested).standardizedFileURL
                fileURL = candidate.path.hasPrefix(bundleRoot.path + "/") || candidate == bundleRoot ? candidate : nil
            } else if url.host == "media" {
                let angle = url.pathComponents.last ?? ""
                fileURL = await backend.photoURL(angle: angle)
            } else {
                fileURL = nil
            }

            guard let fileURL, let data = try? Data(contentsOf: fileURL) else {
                fail(urlSchemeTask, code: 404)
                return
            }
            let response = URLResponse(
                url: url,
                mimeType: mimeType(fileURL.pathExtension),
                expectedContentLength: data.count,
                textEncodingName: isText(fileURL.pathExtension) ? "utf-8" : nil
            )
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didReceive(data)
            urlSchemeTask.didFinish()
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {}

    private func fail(_ task: any WKURLSchemeTask, code: Int) {
        task.didFailWithError(NSError(
            domain: "NioDashboardScheme",
            code: code,
            userInfo: [NSLocalizedDescriptionKey: "资源不可用"]
        ))
    }

    private func mimeType(_ ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html"
        case "js": return "text/javascript"
        case "css": return "text/css"
        case "json": return "application/json"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "heic": return "image/heic"
        case "woff2": return "font/woff2"
        default: return "application/octet-stream"
        }
    }

    private func isText(_ ext: String) -> Bool {
        ["html", "js", "css", "json", "svg"].contains(ext.lowercased())
    }
}

@MainActor
final class BridgeMessageHandler: NSObject, WKScriptMessageHandlerWithReply {
    private let backend: NativeBackend
    weak var commandHandler: (any NativeUICommandHandling)?

    init(backend: NativeBackend, commandHandler: (any NativeUICommandHandling)?) {
        self.backend = backend
        self.commandHandler = commandHandler
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) async -> (Any?, String?) {
        guard let request = BridgeRequest(body: message.body) else {
            return (nil, "invalid_request")
        }

        if request.version == BridgeContract.version,
           let operation = BridgeContract.Operation(rawValue: request.operation) {
            switch operation {
            case .openDashboard:
                commandHandler?.openDashboard(route: request.payload.object?["route"]?.string)
                return (BridgeResponse.success(id: request.id).foundationValue, nil)
            case .hidePanel:
                commandHandler?.hideCompactPanel()
                return (BridgeResponse.success(id: request.id).foundationValue, nil)
            case .resizePanel:
                guard let height = request.payload.object?["height"]?.number, height.isFinite else {
                    return (BridgeResponse.failure(id: request.id, code: "invalid_payload", message: "height 无效").foundationValue, nil)
                }
                commandHandler?.resizeCompactPanel(height: height)
                return (BridgeResponse.success(id: request.id).foundationValue, nil)
            case .quit:
                commandHandler?.terminateApplication()
                return (BridgeResponse.success(id: request.id).foundationValue, nil)
            default:
                break
            }
        }

        let response = await backend.handle(request)
        return (response.foundationValue, nil)
    }
}

@MainActor
final class WebSurface: NSObject, WKNavigationDelegate {
    let webView: WKWebView
    private let bridge: BridgeMessageHandler
    private let entry: String

    init(
        entry: String,
        bundleRoot: URL,
        backend: NativeBackend,
        commandHandler: any NativeUICommandHandling
    ) {
        self.entry = entry
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.preferences.isElementFullscreenEnabled = false
        let schemeHandler = ReadOnlySchemeHandler(bundleRoot: bundleRoot, backend: backend)
        configuration.setURLSchemeHandler(schemeHandler, forURLScheme: "nioapp")

        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(
            source: """
            Object.defineProperty(window, "__NIO_NATIVE__", {
              value: Object.freeze({ version: \(BridgeContract.version), surface: "\(entry)" }),
              writable: false,
              configurable: false
            });
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        bridge = BridgeMessageHandler(backend: backend, commandHandler: commandHandler)
        controller.addScriptMessageHandler(bridge, contentWorld: .page, name: "nioBridge")
        configuration.userContentController = controller

        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
    }

    func load(route: String? = nil) {
        var components = URLComponents()
        components.scheme = "nioapp"
        components.host = "bundle"
        components.path = entry == "tray" ? "/tray.html" : "/index.html"
        components.queryItems = [
            URLQueryItem(name: "native", value: "1"),
            URLQueryItem(name: "surface", value: entry),
        ]
        if let route {
            components.queryItems?.append(URLQueryItem(name: "route", value: route))
        }
        if let url = components.url {
            webView.load(URLRequest(url: url))
        }
    }

    func navigate(route: String) {
        let script = """
        window.dispatchEvent(new CustomEvent("nio:navigate", { detail: { route } }));
        """
        Task {
            _ = try? await webView.callAsyncJavaScript(
                script,
                arguments: ["route": route],
                in: nil,
                contentWorld: .page
            )
        }
    }

    func emit(name: String, payload: JSONValue) {
        let script = """
        window.dispatchEvent(new CustomEvent("nio:native-event", { detail: { name, payload } }));
        """
        Task {
            _ = try? await webView.callAsyncJavaScript(
                script,
                arguments: ["name": name, "payload": payload.foundationValue],
                in: nil,
                contentWorld: .page
            )
        }
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction
    ) async -> WKNavigationActionPolicy {
        guard let url = navigationAction.request.url else {
            return .cancel
        }
        if navigationAction.navigationType == .linkActivated, url.scheme == "https" || url.scheme == "http" {
            NSWorkspace.shared.open(url)
            return .cancel
        }
        return url.scheme == "nioapp" ? .allow : .cancel
    }
}
