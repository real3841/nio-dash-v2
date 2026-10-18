@preconcurrency import Foundation

final class NativeBackend: @unchecked Sendable {
    let storage: AppStorage
    let keychain: KeychainStore
    let log: RedactedLog
    let sync: SyncCoordinator
    let photos: PhotoService
    let scheduler: NativeScheduler

    var onEvent: (@Sendable (String, JSONValue) -> Void)?

    init(rootURL: URL? = nil, session: URLSession? = nil) throws {
        let storage = try AppStorage(rootURL: rootURL)
        let keychain = KeychainStore()
        let log = RedactedLog(storage: storage)
        let sync = SyncCoordinator(storage: storage, keychain: keychain, log: log, session: session)
        self.storage = storage
        self.keychain = keychain
        self.log = log
        self.sync = sync
        photos = PhotoService(storage: storage)
        scheduler = NativeScheduler(storage: storage, sync: sync)
    }

    func bootstrap(enableScheduler: Bool) async throws {
        try await storage.bootstrapConfig()
        _ = try await storage.restoreSecretsFromKeychain(keychain)
        await sync.setUpdateHandler { [weak self] target in
            self?.emit("sync.completed", .object([
                "target": .string(target),
                "at": .number(Date().timeIntervalSince1970 * 1000),
            ]))
            self?.emit("dashboard.updated", .object(["target": .string(target)]))
            self?.emit("logs.updated", .object(["target": .string(target)]))
            if target == "stock" {
                self?.emit("stock.updated", .object(["target": .string(target)]))
            }
        }
        if enableScheduler {
            await scheduler.start()
        }
    }

    func handle(_ request: BridgeRequest) async -> BridgeResponse {
        guard request.version == BridgeContract.version else {
            return .failure(
                id: request.id,
                code: "unsupported_version",
                message: "前端桥接版本不兼容"
            )
        }
        guard let operation = BridgeContract.Operation(rawValue: request.operation) else {
            return .failure(id: request.id, code: "unknown_operation", message: "未知原生命令")
        }

        do {
            switch operation {
            case .ping:
                return .success(id: request.id, result: .object([
                    "version": .number(Double(BridgeContract.version)),
                    "platform": .string("macOS"),
                ]))
            case .httpRequest:
                let response = try await handleHTTP(HTTPBridgeRequest(payload: request.payload))
                return .success(id: request.id, result: response.jsonValue())
            case .refresh:
                let raw = request.payload.object?["target"]?.string ?? "all"
                guard let target = SyncCoordinator.Target(rawValue: raw) else {
                    throw NativeError.invalidInput("无效同步目标")
                }
                try await sync.refresh(target)
                return .success(id: request.id, result: .object(["target": .string(raw)]))
            case .schedulerState:
                return .success(id: request.id, result: await scheduler.snapshot())
            case .subscribe:
                return .success(id: request.id, result: .object([
                    "events": .array([
                        .string("dashboard.updated"),
                        .string("sync.completed"),
                        .string("logs.updated"),
                        .string("stock.updated"),
                    ]),
                ]))
            case .openDashboard, .hidePanel, .resizePanel, .quit:
                return .failure(id: request.id, code: "ui_operation", message: "界面命令应由应用壳处理")
            }
        } catch {
            return .failure(
                id: request.id,
                code: errorCode(error),
                message: RedactedLog.redact(error.localizedDescription)
            )
        }
    }

    func photoURL(angle: String) async -> URL? {
        await photos.fileURL(angle: angle)
    }

    private func handleHTTP(_ request: HTTPBridgeRequest) async throws -> HTTPBridgeResponse {
        let components = URLComponents(string: "https://native.invalid\(request.path)")
        let path = components?.path ?? request.path

        if path.hasPrefix("/data/"), request.method == "GET" {
            let name = String(path.dropFirst("/data/".count))
            do {
                let data = try await storage.readData(relativePath: name)
                return HTTPBridgeResponse(
                    status: 200,
                    headers: ["content-type": mimeType(name)],
                    body: data
                )
            } catch {
                return try .json(.object(["ok": .bool(false), "error": .string("not_found")]), status: 404)
            }
        }

        switch (path, request.method) {
        case ("/health", "GET"):
            return try .json(.object([
                "ok": .bool(true),
                "at": .number(Date().timeIntervalSince1970 * 1000),
                "scheduler": await scheduler.snapshot(),
            ]))
        case ("/api/config", "GET"):
            return try await configResponse()
        case let (value, "PUT") where value.hasPrefix("/api/config/"):
            return try await saveConfig(section: String(value.dropFirst("/api/config/".count)), body: request.body)
        case ("/api/card-layout", "GET"):
            let value: JSONValue
            if let data = try? await storage.readRootData(filename: "card-layout.json"),
               let object = try? JSONSerialization.jsonObject(with: data) {
                value = JSONValue(object)
            } else {
                value = .object([:])
            }
            return try .json(value)
        case ("/api/card-layout", "PUT"):
            guard let body = request.body,
                  let object = try? JSONSerialization.jsonObject(with: body),
                  object is [String: Any] else {
                return try .json(.object(["ok": .bool(false), "error": .string("invalid_body")]), status: 400)
            }
            try await storage.writeRootData(body, filename: "card-layout.json")
            return try .json(.object(["ok": .bool(true)]))
        case ("/api/tray-layout", "GET"):
            let value: JSONValue
            if let data = try? await storage.readRootData(filename: "tray-layout.json"),
               let object = try? JSONSerialization.jsonObject(with: data) {
                value = JSONValue(object)
            } else {
                value = .object([:])
            }
            return try .json(value)
        case ("/api/tray-layout", "PUT"):
            guard let body = request.body,
                  let object = try? JSONSerialization.jsonObject(with: body),
                  object is [String: Any] else {
                return try .json(.object(["ok": .bool(false), "error": .string("invalid_body")]), status: 400)
            }
            try await storage.writeRootData(body, filename: "tray-layout.json")
            return try .json(.object(["ok": .bool(true)]))
        case ("/api/fetch-log", "GET"), ("/fetch-log", "GET"):
            let entries = (try? await storage.readJSON(relativePath: "fetch-log.json")) ?? .array([])
            return try .json(.object([
                "ok": .bool(true),
                "at": .number(Date().timeIntervalSince1970 * 1000),
                "logCount": .number(Double(entries.arrayCount)),
                "logLimit": .number(500),
                "schedule": .object([
                    "vehicle": emptySchedule(),
                    "change": emptySchedule(),
                    "checkin": emptySchedule(),
                    "stock_watch": emptySchedule(),
                ]),
                "running": .object([
                    "all": .bool(false),
                    "vehicle": .bool(false),
                    "change": .bool(false),
                    "checkin": .bool(false),
                    "stock_watch": .bool(false),
                ]),
                "logs": entries,
            ]))
        case ("/api/storage-files", "GET"):
            return try await storageFilesResponse()
        case ("/api/auth-slots", "GET"):
            return try .json(await authSlots())
        case ("/api/auth-slots/disable", "POST"):
            return try await disableAuthSlot(body: request.body)
        case ("/api/quick-auth", "POST"):
            return try await quickAuth(body: request.body)
        case ("/api/vehicle-photos", "GET"):
            return try .json(.object(["ok": .bool(true), "photos": await photos.manifest()]))
        case let (value, method) where value.hasPrefix("/api/vehicle-photos/"):
            let angle = String(value.dropFirst("/api/vehicle-photos/".count))
            if method == "PUT", let body = request.body {
                let manifest = try await photos.save(angle: angle, data: body)
                emit("dashboard.updated", .object(["target": .string("photos")]))
                return try .json(.object(["ok": .bool(true), "photos": manifest]))
            }
            if method == "DELETE" {
                let manifest = try await photos.delete(angle: angle)
                emit("dashboard.updated", .object(["target": .string("photos")]))
                return try .json(.object(["ok": .bool(true), "photos": manifest]))
            }
            if method == "GET", let data = try? await photos.fileURL(angle: angle).flatMap({ try Data(contentsOf: $0) }) {
                return HTTPBridgeResponse(status: 200, headers: ["content-type": "image/*"], body: data)
            }
            return try .json(.object(["ok": .bool(false), "error": .string("not_found")]), status: 404)
        case ("/api/stock-watch", "GET"):
            return try await stockWatchResponse()
        case ("/api/tracks/status", "GET"):
            return try .json(await sync.trackStatus())
        case ("/api/tracks/sync", "POST"):
            let body = (try? decodeObject(request.body)) ?? [:]
            let months = max(1, min(120, (body["months"] as? NSNumber)?.intValue ?? 12))
            let refresh = (body["refreshCurrent"] as? NSNumber)?.boolValue ?? true
            return try .json(await sync.startTrackSync(monthsBack: months, refreshCurrent: refresh))
        case ("/api/stock-watch/check", "POST"):
            do {
                try await sync.refresh(.stock)
                return try await stockWatchResponse()
            } catch {
                return try .json(.object([
                    "ok": .bool(false),
                    "error": .string(RedactedLog.redact(error.localizedDescription)),
                ]), status: 500)
            }
        case ("/api/stock-watch/auth", "PUT"):
            return try await saveStockAuth(body: request.body)
        case ("/api/stock-watch/poll-sec", "PUT"):
            return try await saveStockPoll(body: request.body)
        case ("/api/stock-watch/ack-alert", "POST"):
            return try .json(.object(["ok": .bool(true)]))
        case ("/api/geocode/reverse", "GET"):
            return try await reverseGeocode(components)
        case ("/api/fetch-now", "POST"), ("/trigger", "POST"):
            return try await runSync(.all)
        case ("/api/fetch-vehicle", "POST"), ("/trigger/vehicle", "POST"):
            return try await runSync(.vehicle)
        case ("/api/fetch-change", "POST"), ("/trigger/change", "POST"):
            return try await runSync(.change)
        case ("/api/fetch-checkin", "POST"), ("/trigger/checkin", "POST"):
            return try await runSync(.checkin)
        default:
            return try .json(.object([
                "ok": .bool(false),
                "error": .string("not_found"),
            ]), status: 404)
        }
    }

    private func runSync(_ target: SyncCoordinator.Target) async throws -> HTTPBridgeResponse {
        do {
            try await sync.refresh(target)
            return try .json(.object([
                "ok": .bool(true),
                "target": .string(target.rawValue),
                "at": .number(Date().timeIntervalSince1970 * 1000),
            ]))
        } catch {
            return try .json(.object([
                "ok": .bool(false),
                "target": .string(target.rawValue),
                "error": .string(RedactedLog.redact(error.localizedDescription)),
            ]), status: 500)
        }
    }

    private func configResponse() async throws -> HTTPBridgeResponse {
        let env = try await storage.environment(includingSecrets: true)
        let configured = await storage.secretConfigurationState()
        let vehicleKeys = [
            "NIO_VEHICLE_API_URL", "NIO_VEHICLE_USER_AGENT", "NIO_VEHICLE_API_METHOD",
            "NIO_VEHICLE_POLL_DRIVING_SEC", "NIO_VEHICLE_POLL_CHARGING_SEC",
            "NIO_VEHICLE_POLL_DAY_SEC", "NIO_VEHICLE_POLL_NIGHT_SEC",
            "NIO_CHECKIN_API_URL", "NIO_VEHICLE_STATUS_URL", "NIO_JOURNEY_API_URL", "NIO_DAILY_API_URL",
        ]
        let changeKeys = [
            "NIO_CHANGE_API_URL", "NIO_CHANGE_USER_AGENT", "NIO_CHANGE_MOBILEINFO",
            "NIO_CHANGE_API_METHOD", "NIO_CHANGE_API_BODY", "NIO_CHANGE_API_MODE", "NIO_CHANGE_POLL_INTERVAL",
        ]
        let generalKeys = ["NIO_POLL_INTERVAL", "WEB_PORT", "NIO_TRAY_DISPLAY"]
        let mapKeys: [String] = []
        func section(_ keys: [String]) -> JSONValue {
            .object(Dictionary(uniqueKeysWithValues: keys.map { key in
                let raw = env[key] ?? ""
                let safe = raw.contains("sign=") || raw.contains("token=") ? "" : raw
                return (key, .string(safe))
            }))
        }
        var vehicle = section(vehicleKeys).object ?? [:]
        vehicle["NIO_VEHICLE_ACCESS_TOKEN"] = .string("")
        vehicle["NIO_CHECKIN_ACCESS_TOKEN"] = .string("")
        var change = section(changeKeys).object ?? [:]
        change["NIO_CHANGE_ACCESS_TOKEN"] = .string("")
        // JS API 的 Key 与安全密钥天生暴露在客户端（否则高德 SDK 无法工作），
        // 可以下发给前端；Web 服务 Key 是服务端凭据，必须继续抹掉。
        let map = Dictionary(uniqueKeysWithValues: [
            ("NIO_AMAP_WEB_SERVICE_KEY", JSONValue.string("")),
            ("NIO_AMAP_JS_KEY", JSONValue.string(env["NIO_AMAP_JS_KEY"] ?? "")),
            ("NIO_AMAP_JS_SECURITY_CODE", JSONValue.string(env["NIO_AMAP_JS_SECURITY_CODE"] ?? "")),
        ])

        return try .json(.object([
            "ok": .bool(true),
            "vehicle": .object(vehicle),
            "change": .object(change),
            "general": section(generalKeys),
            "map": .object(map.merging(section(mapKeys).object ?? [:]) { _, new in new }),
            "configured": .object(configured.mapValues(JSONValue.bool)),
        ]))
    }

    private func saveConfig(section: String, body: Data?) async throws -> HTTPBridgeResponse {
        guard let object = try decodeObject(body) else {
            return try .json(.object(["ok": .bool(false), "error": .string("invalid_body")]), status: 400)
        }
        let current = try await storage.environment(includingSecrets: true)
        var changes: [String: String] = [:]
        for (key, value) in object {
            guard let text = value as? String else { continue }
            let hiddenFromForm = current[key].map { $0.contains("sign=") || $0.contains("token=") } ?? false
            if text.isEmpty && hiddenFromForm { continue }
            if !AppStorage.secretKeys.contains(key) || !text.isEmpty {
                changes[key] = text
            }
        }
        try await storage.updateEnvironment(changes)
        if section == "vehicle" || section == "change" {
            await scheduler.wake()
        }
        emit("dashboard.updated", .object(["target": .string("config")]))
        return try .json(.object(["ok": .bool(true)]))
    }

    private func quickAuth(body: Data?) async throws -> HTTPBridgeResponse {
        guard let object = try decodeObject(body) else {
            return try .json(.object(["ok": .bool(false), "error": .string("请求格式不对")]), status: 400)
        }
        let text = (object["text"] as? String) ?? ""
        let directURL = (object["url"] as? String) ?? ""
        let directToken = (object["token"] as? String) ?? ""
        let combined = [text, directURL, directToken].joined(separator: "\n")

        var token: String?
        let tokenPattern = #"(?i)(?:bearer\s+|authorization\s*[:=]\s*)([A-Za-z0-9._~+/\-=]{20,})"#
        if let regex = try? NSRegularExpression(pattern: tokenPattern),
           let match = regex.firstMatch(in: combined, range: NSRange(combined.startIndex..., in: combined)),
           let range = Range(match.range(at: 1), in: combined) {
            token = String(combined[range])
        } else if !directToken.contains(where: \.isWhitespace), directToken.count >= 20 {
            token = directToken.replacingOccurrences(of: "Bearer ", with: "", options: .caseInsensitive)
        }

        var urlUpdates: [String: String] = [:]
        let urls = extractHTTPSURLs(combined)
        for raw in urls {
            guard let url = URL(string: raw), url.host?.hasSuffix("nio.com") == true else { continue }
            let path = url.path
            if path.hasSuffix("/icar/v2/widget/info") { urlUpdates["NIO_VEHICLE_API_URL"] = raw }
            if path.contains("/rvs/vehicle/") && path.hasSuffix("/status") { urlUpdates["NIO_VEHICLE_STATUS_URL"] = raw }
            if path.hasSuffix("/vehicle/journey_merge/status") { urlUpdates["NIO_JOURNEY_API_URL"] = raw }
            if path.hasSuffix("/vehicle/journeys/daily_data") { urlUpdates["NIO_DAILY_API_URL"] = raw }
            if path.hasSuffix("/serviceOrder/getTabOrder") { urlUpdates["NIO_CHANGE_API_URL"] = raw }
            if path.hasSuffix("/award_cn/checkin") { urlUpdates["NIO_CHECKIN_API_URL"] = raw }
        }
        if let token {
            for key in ["NIO_VEHICLE_ACCESS_TOKEN", "NIO_CHANGE_ACCESS_TOKEN", "NIO_VEHICLE_EXTRA_TOKEN"] {
                urlUpdates[key] = token
            }
        }
        try await storage.updateEnvironment(urlUpdates)
        let currentPower = try? await storage.readJSON(relativePath: "power.json")
        let importedPower = PowerHARImporter.importPower(from: text, existing: currentPower)
        if let importedPower {
            try await storage.writeJSON(importedPower, relativePath: "power.json")
        }
        let ok = token != nil || !urlUpdates.isEmpty || importedPower != nil
        var runs: [String: JSONValue] = [:]
        let updatedKeys = Set(urlUpdates.keys)
        let refreshTargets: [(SyncCoordinator.Target, Set<String>)] = [
            (.vehicle, ["NIO_VEHICLE_API_URL", "NIO_VEHICLE_STATUS_URL", "NIO_JOURNEY_API_URL", "NIO_DAILY_API_URL",
                        "NIO_VEHICLE_ACCESS_TOKEN"]),
            (.change, ["NIO_CHANGE_API_URL", "NIO_CHANGE_ACCESS_TOKEN"]),
            (.checkin, ["NIO_CHECKIN_API_URL"]),
        ]
        for (target, keys) in refreshTargets where !updatedKeys.isDisjoint(with: keys) {
            do {
                try await sync.refresh(target)
                runs[target.rawValue] = .string("ok")
            } catch {
                runs[target.rawValue] = .string(error.localizedDescription)
            }
        }
        let result: JSONValue = .object([
            "ok": .bool(ok),
            "tokenUpdated": .bool(token != nil),
            "updated": .array(urlUpdates.keys.sorted().map(JSONValue.string)),
            "power": importedPower == nil ? .null : .string("家充数据已导入"),
            "warnings": .array(ok ? [] : [.string("没有找到可用的完整 URL 或 Bearer Token")]),
        ])
        return try .json(.object(["ok": .bool(ok), "result": result, "runs": .object(runs)]), status: ok ? 200 : 400)
    }

    private func storageFilesResponse() async throws -> HTTPBridgeResponse {
        let labels: [String: String] = [
            "vehicle.json": "最新车况",
            "history.json": "位置历史",
            "last-fetch.json": "车辆拉取记录",
            "change.json": "换电订单",
            "change-ledger.json": "换电台账",
            "checkin.json": "签到数据",
            "fetch-log.json": "运行日志",
        ]
        let names = ((try? await storage.list(relativeDirectory: "")) ?? []).filter { $0.hasSuffix(".json") }
        var files: [JSONValue] = []
        for name in names {
            guard let url = try? await storage.dataFileURL(relativePath: name),
                  let attributes = try? FileManager.default.attributesOfItem(atPath: url.path) else { continue }
            files.append(.object([
                "id": .string(name),
                "label": .string(labels[name] ?? "其他数据"),
                "path": .string(url.path),
                "kind": .string("data"),
                "exists": .bool(true),
                "sizeBytes": .number(Double((attributes[.size] as? NSNumber)?.intValue ?? 0)),
                "modifiedAt": .number(((attributes[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0) * 1000),
            ]))
        }
        return try .json(.object([
            "ok": .bool(true),
            "dataDir": .string(storage.dataURL.path),
            "userDataDir": .string(storage.rootURL.path),
            "envFile": .string(storage.configURL.path),
            "files": .array(files),
        ]))
    }

    private func saveStockAuth(body: Data?) async throws -> HTTPBridgeResponse {
        guard let object = try decodeObject(body) else {
            return try .json(.object(["ok": .bool(false)]), status: 400)
        }
        var changes: [String: String] = [:]
        if let value = object["cookie"] as? String, !value.isEmpty { changes["NIO_STOCK_COOKIE"] = value }
        if let value = object["token"] as? String, !value.isEmpty { changes["NIO_STOCK_TOKEN"] = value }
        try await storage.updateEnvironment(changes)
        return try .json(.object(["ok": .bool(true)]))
    }

    private func saveStockPoll(body: Data?) async throws -> HTTPBridgeResponse {
        guard let object = try decodeObject(body),
              let value = object["pollSec"] as? NSNumber else {
            return try .json(.object(["ok": .bool(false)]), status: 400)
        }
        let seconds = max(60, value.intValue)
        try await storage.updateEnvironment(["NIO_STOCK_POLL_SEC": String(seconds)])
        return try .json(.object(["ok": .bool(true), "pollSec": .number(Double(seconds))]))
    }

    private func reverseGeocode(_ components: URLComponents?) async throws -> HTTPBridgeResponse {
        let parameters = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        guard let lat = Double(parameters["lat"] ?? ""), let lng = Double(parameters["lng"] ?? "") else {
            return try .json(.object(["ok": .bool(false), "error": .string("invalid_lat_lng")]), status: 400)
        }
        let env = try await storage.environment(includingSecrets: true)
        guard let key = env["NIO_AMAP_WEB_SERVICE_KEY"], !key.isEmpty else {
            return try .json(.object(["ok": .bool(false), "error": .string("amap_not_configured")]), status: 404)
        }
        var target = URLComponents(string: "https://restapi.amap.com/v3/geocode/regeo")!
        target.queryItems = [
            URLQueryItem(name: "location", value: "\(lng),\(lat)"),
            URLQueryItem(name: "key", value: key),
            URLQueryItem(name: "extensions", value: "base"),
        ]
        let (data, response) = try await URLSession.shared.data(from: target.url!)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let regeocode = object["regeocode"] as? [String: Any],
              let address = regeocode["formatted_address"] as? String,
              !address.isEmpty else {
            return try .json(.object(["ok": .bool(false), "error": .string("amap_geocode_failed")]), status: 502)
        }
        return try .json(.object(["ok": .bool(true), "provider": .string("amap"), "address": .string(address)]))
    }

    private func jsonFileResponse(_ name: String, fallback: JSONValue) async throws -> HTTPBridgeResponse {
        return try .json((try? await storage.readJSON(relativePath: name)) ?? fallback)
    }

    private func stockWatchResponse() async throws -> HTTPBridgeResponse {
        try await jsonFileResponse("stock-watch.json", fallback: .object([
            "ok": .bool(true),
            "items": .array([]),
            "pollSec": .number(900),
        ]))
    }

    private static let optionalSlotKeys: [String: [String]] = [
        "status": ["NIO_VEHICLE_STATUS_URL"],
    ]

    private static func slotEnabled(_ id: String, env: [String: String]) -> Bool {
        let hasVehicleID = env["NIO_VEHICLE_ID"]?.isEmpty == false
        switch id {
        case "widget":
            return (hasVehicleID && env["NIO_VEHICLE_DEVICE_ID"]?.isEmpty == false)
                || (try? SyncCoordinator.vehicleWidgetURL(env)) != nil
        case "journey":
            return hasVehicleID || env["NIO_JOURNEY_API_URL"]?.isEmpty == false
        case "daily":
            return hasVehicleID || env["NIO_DAILY_API_URL"]?.isEmpty == false
        default:
            guard let keys = optionalSlotKeys[id] else { return true }
            return keys.contains { env[$0]?.isEmpty == false }
        }
    }

    private func disableAuthSlot(body: Data?) async throws -> HTTPBridgeResponse {
        guard let id = try decodeObject(body)?["slot"] as? String, let keys = Self.optionalSlotKeys[id] else {
            return try .json(.object(["ok": .bool(false), "error": .string("这条接口不能停用")]), status: 400)
        }
        let env = try await storage.environment(includingSecrets: true)
        let recorded = (try? await storage.readJSON(relativePath: "auth-slots.json"))?.object ?? [:]
        if let partner = ["widget": "status", "status": "widget"][id] {
            let partnerOK = Self.slotEnabled(partner, env: env) && recorded[partner]?.object?["ok"] == .bool(true)
            if !partnerOK {
                let name = partner == "status" ? "车况整包" : "车辆状态"
                return try .json(.object([
                    "ok": .bool(false),
                    "error": .string("\(name)目前也不可用，两条都停用后车况将不再更新。请先让\(name)拉取成功"),
                ]), status: 409)
            }
        }
        try await storage.updateEnvironment(Dictionary(uniqueKeysWithValues: keys.map { ($0, "") }))
        var slots = recorded
        slots[id] = nil
        try await storage.writeJSON(.object(slots), relativePath: "auth-slots.json")
        try? await sync.refresh(.vehicle)
        emit("dashboard.updated", .object(["target": .string("config")]))
        return try .json(.object(["ok": .bool(true)]))
    }

    private func authSlots() async -> JSONValue {
        let env = (try? await storage.environment(includingSecrets: true)) ?? [:]
        let secretState = await storage.secretConfigurationState()
        let recorded = (try? await storage.readJSON(relativePath: "auth-slots.json"))?.object ?? [:]
        let definitions: [(id: String, label: String, method: String, address: String, needsURL: Bool, urlKey: String, tokenKey: String)] = [
            ("widget", "车辆状态", "GET", "https://gateway-front-external.nio.com/moat/10086/app/api/icar/v2/widget/info",
             false, "NIO_VEHICLE_ID", "NIO_VEHICLE_ACCESS_TOKEN"),
            ("status", "车况整包", "GET", "https://icar.nio.com/api/2/rvs/vehicle/{vehicle_id}/status", true,
             "NIO_VEHICLE_STATUS_URL", "NIO_VEHICLE_EXTRA_TOKEN"),
            ("journey", "最近行程", "GET",
             "https://gateway-front-external.nio.com/moat/1100461/api/1/vehicle/journey_merge/status", false,
             "NIO_VEHICLE_ID", "NIO_VEHICLE_EXTRA_TOKEN"),
            ("daily", "当日里程", "GET",
             "https://gateway-front-external.nio.com/moat/1100461/api/1/vehicle/{vehicle_id}/journey_merge/timing_journeys",
             false, "NIO_VEHICLE_ID", "NIO_VEHICLE_EXTRA_TOKEN"),
            ("change", "换电订单", "POST",
             "https://gateway-front-external.nio.com/moat/1100367/api/v1/otd/car/ext/general/serviceOrder/getTabOrder",
             false, "NIO_CHANGE_API_URL", "NIO_CHANGE_ACCESS_TOKEN"),
            ("checkin", "签到", "GET", "https://gateway-front-external.nio.com/moat/10086/c/award_cn/checkin", false,
             "NIO_CHECKIN_API_URL", "NIO_CHECKIN_ACCESS_TOKEN"),
        ]
        return .object([
            "ok": .bool(true),
            "slots": .array(definitions.map { slot in
                let enabled = Self.slotEnabled(slot.id, env: env)
                let status = enabled ? recorded[slot.id]?.object ?? [:] : [:]
                return .object([
                    "id": .string(slot.id),
                    "label": .string(slot.label),
                    "method": .string(slot.method),
                    "address": .string(slot.address),
                    "needsUrl": .bool(slot.needsURL),
                    "enabled": .bool(enabled),
                    "optional": .bool(Self.optionalSlotKeys[slot.id] != nil),
                    "configured": .bool(env[slot.urlKey]?.isEmpty == false && secretState[slot.tokenKey] == true),
                    "ok": status["ok"] ?? .null,
                    "kind": status["kind"] ?? .null,
                    "error": status["error"] ?? .null,
                    "at": status["at"] ?? .null,
                ])
            }),
        ])
    }

    private func decodeObject(_ data: Data?) throws -> [String: Any]? {
        guard let data, !data.isEmpty else { return [:] }
        return try JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private func extractHTTPSURLs(_ text: String) -> [String] {
        guard let regex = try? NSRegularExpression(pattern: #"https://[^\s"'<>]+"#) else { return [] }
        return regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap {
            Range($0.range, in: text).map { String(text[$0]) }
        }
    }

    private func mimeType(_ name: String) -> String {
        switch URL(fileURLWithPath: name).pathExtension.lowercased() {
        case "json": return "application/json; charset=utf-8"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "svg": return "image/svg+xml"
        default: return "application/octet-stream"
        }
    }

    private func emptySchedule() -> JSONValue {
        .object([
            "nextAt": .null,
            "intervalSec": .null,
            "detail": .null,
        ])
    }

    private func emit(_ name: String, _ payload: JSONValue) {
        onEvent?(name, payload)
    }

    private func errorCode(_ error: any Error) -> String {
        switch error {
        case is NativeError: return "native_error"
        default: return "internal_error"
        }
    }
}
