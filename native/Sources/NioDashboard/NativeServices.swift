@preconcurrency import Foundation
import ImageIO
import UniformTypeIdentifiers
import UserNotifications

struct HTTPBridgeRequest: Sendable {
    let path: String
    let method: String
    let headers: [String: String]
    let body: Data?

    init(payload: JSONValue) throws {
        guard let object = payload.object, let path = object["path"]?.string else {
            throw NativeError.invalidInput("请求缺少 path")
        }
        self.path = path
        method = object["method"]?.string?.uppercased() ?? "GET"
        if case let .object(headerValues) = object["headers"] {
            headers = headerValues.compactMapValues(\.string)
        } else {
            headers = [:]
        }
        if let base64 = object["bodyBase64"]?.string {
            body = Data(base64Encoded: base64)
        } else if let text = object["body"]?.string {
            body = Data(text.utf8)
        } else {
            body = nil
        }
    }
}

struct HTTPBridgeResponse: Sendable {
    let status: Int
    let headers: [String: String]
    let body: Data

    func jsonValue() -> JSONValue {
        .object([
            "status": .number(Double(status)),
            "headers": .object(headers.mapValues(JSONValue.string)),
            "bodyBase64": .string(body.base64EncodedString()),
        ])
    }

    static func json(_ value: JSONValue, status: Int = 200) throws -> HTTPBridgeResponse {
        let data = try JSONSerialization.data(withJSONObject: value.foundationValue)
        return HTTPBridgeResponse(
            status: status,
            headers: ["content-type": "application/json; charset=utf-8"],
            body: data
        )
    }
}

actor RedactedLog {
    private let storage: AppStorage
    private let maximumEntries = 500

    init(storage: AppStorage) {
        self.storage = storage
    }

    func append(category: String, level: String, message: String) async {
        let item: JSONValue = .object([
            "id": .string(UUID().uuidString),
            "at": .number(Date().timeIntervalSince1970 * 1000),
            "slot": .string(category == "stock" ? "stock_watch" : category),
            "level": .string(level),
            "message": .string(Self.redact(message)),
            "detail": .null,
        ])
        var entries: [JSONValue] = []
        if let current = try? await storage.readJSON(relativePath: "fetch-log.json"),
           case let .array(values) = current {
            entries = values
        }
        entries.append(item)
        if entries.count > maximumEntries {
            entries.removeFirst(entries.count - maximumEntries)
        }
        try? await storage.writeJSON(.array(entries), relativePath: "fetch-log.json")
    }

    static func redact(_ input: String) -> String {
        var output = input
        let rules: [(String, String)] = [
            (#"(?i)(authorization|cookie|token|sign|secret|key)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+"#, "$1=[已隐藏]"),
            (#"(?i)bearer\s+[A-Za-z0-9._~+/=-]+"#, "Bearer [已隐藏]"),
            (#"\b1[3-9]\d{9}\b"#, "[手机号已隐藏]"),
            (#"(?i)\bL[A-HJ-NPR-Z0-9]{16}\b"#, "[VIN已隐藏]"),
            (#"([?&](?:sign|token|access_token|timestamp)=)[^&\s]+"#, "$1[已隐藏]"),
        ]
        for (pattern, replacement) in rules {
            output = output.replacingOccurrences(
                of: pattern,
                with: replacement,
                options: .regularExpression
            )
        }
        return output
    }
}

struct NioAPIError: LocalizedError, Sendable {
    enum Kind: String, Sendable {
        case sign
        case auth
        case generic
    }

    let kind: Kind
    let message: String

    var errorDescription: String? { message }
}

actor SyncCoordinator {
    enum Target: String, Sendable {
        case vehicle
        case change
        case checkin
        case power
        case stock
        case all
    }

    private let storage: AppStorage
    private let keychain: KeychainStore
    private let log: RedactedLog
    private let session: URLSession
    private var running = Set<Target>()
    var onUpdated: (@Sendable (String) -> Void)?

    init(storage: AppStorage, keychain: KeychainStore, log: RedactedLog, session: URLSession? = nil) {
        self.storage = storage
        self.keychain = keychain
        self.log = log
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 30
            configuration.timeoutIntervalForResource = 60
            configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
            self.session = URLSession(configuration: configuration)
        }
    }

    func setUpdateHandler(_ handler: @escaping @Sendable (String) -> Void) {
        onUpdated = handler
    }

    func refresh(_ target: Target) async throws {
        guard !running.contains(target) else { return }
        running.insert(target)
        defer { running.remove(target) }

        if target == .all {
            var errors: [String] = []
            for child in [Target.vehicle, .change, .checkin, .power, .stock] {
                do {
                    try await refresh(child)
                } catch {
                    errors.append(error.localizedDescription)
                }
            }
            if !errors.isEmpty {
                throw NativeError.network(errors.joined(separator: "；"))
            }
            return
        }

        do {
            switch target {
            case .vehicle: try await refreshVehicle()
            case .change: try await refreshChange()
            case .checkin: try await refreshCheckin()
            case .power: try await refreshSimple(
                urlKey: "NIO_POWER_API_URL",
                tokenKeys: ["NIO_POWER_ACCESS_TOKEN", "NIO_VEHICLE_ACCESS_TOKEN"],
                output: "power.json",
                meta: "last-fetch-power.json"
            )
            case .stock: try await refreshStock()
            case .all: break
            }
            await log.append(category: target.rawValue, level: "success", message: "同步完成")
            onUpdated?(target.rawValue)
        } catch {
            await log.append(category: target.rawValue, level: "error", message: error.localizedDescription)
            if let meta = Self.metaFile(for: target) {
                try? await writeMeta(meta, ok: false, error: error.localizedDescription, errorKind: Self.failureKind(error))
                onUpdated?(target.rawValue)
            }
            throw error
        }
    }

    private static func metaFile(for target: Target) -> String? {
        switch target {
        case .vehicle: "last-fetch.json"
        case .change: "last-fetch-change.json"
        case .checkin: "last-fetch-checkin.json"
        case .power: "last-fetch-power.json"
        case .stock: "last-fetch-stock.json"
        case .all: nil
        }
    }

    private func refreshVehicle() async throws {
        let env = try await storage.environment(includingSecrets: true, keychain: keychain)
        let headers = ["User-Agent": first(env, ["NIO_VEHICLE_USER_AGENT", "NIO_USER_AGENT"])
            ?? "VehicleWidgetExtension/6.5.3 (com.nio.app; build:6050300; iOS 18.0.0)"]
        let extraToken = first(env, ["NIO_VEHICLE_EXTRA_TOKEN", "NIO_VEHICLE_ACCESS_TOKEN"])

        var widgetPayload: JSONValue?
        var widgetError: (any Error)?
        do {
            if let url = try Self.vehicleWidgetURL(env) {
                let payload = try await requestJSON(
                    url,
                    method: first(env, ["NIO_VEHICLE_API_METHOD", "NIO_API_METHOD"]) ?? "GET",
                    token: first(env, ["NIO_VEHICLE_ACCESS_TOKEN", "NIO_ACCESS_TOKEN"]),
                    body: nil,
                    extraHeaders: headers
                )
                try Self.requireSuccess(payload, accepted: ["success"])
                widgetPayload = payload
                await recordSlot("widget", nil)
            }
        } catch {
            widgetError = error
            await recordSlot("widget", error)
        }

        var statusPayload: JSONValue?
        if let url = env["NIO_VEHICLE_STATUS_URL"], !url.isEmpty {
            do {
                let payload = try await requestJSON(url, method: "GET", token: extraToken, body: nil, extraHeaders: headers)
                try Self.requireSuccess(payload, accepted: ["success"])
                statusPayload = payload
                await recordSlot("status", nil)
            } catch {
                await recordSlot("status", error)
                await log.append(category: "vehicle", level: "warning", message: "车况整包同步失败：\(error.localizedDescription)")
            }
        }

        guard let payload = Self.mergedVehiclePayload(widget: widgetPayload, status: statusPayload) else {
            if let widgetError { throw widgetError }
            if await storage.fileExists(relativePath: "vehicle.json") { return }
            throw NativeError.invalidInput("请配置车辆完整请求 URL")
        }
        if let widgetError {
            await log.append(category: "vehicle", level: "warning", message: "车辆状态失败，已改用车况整包：\(widgetError.localizedDescription)")
        }
        try await storage.writeJSON(payload, relativePath: "vehicle.json")
        try await appendVehicleHistory(payload)
        try await writeMeta("last-fetch.json", ok: true)

        for (slot, urlKey, output) in [
            ("journey", "NIO_JOURNEY_API_URL", "journey.json"),
            ("daily", "NIO_DAILY_API_URL", "daily.json"),
        ] {
            guard let url = env[urlKey], !url.isEmpty else { continue }
            do {
                let extra = try await requestJSON(
                    url,
                    method: "GET",
                    token: first(env, ["NIO_VEHICLE_EXTRA_TOKEN", "NIO_VEHICLE_ACCESS_TOKEN"]),
                    body: nil
                )
                await recordSlot(slot, nil)
                let envelope = extraFileEnvelope(output: output, payload: extra)
                try await storage.writeJSON(envelope, relativePath: output)
                try await persistExtraHistory(output: output, envelope: envelope)
            } catch {
                await recordSlot(slot, error)
                await log.append(category: "vehicle", level: "warning", message: "\(output) 补充同步失败：\(error.localizedDescription)")
            }
        }
    }

    /// nil 表示没配车辆状态接口；抛错表示配了但拼不出可用的请求
    static func vehicleWidgetURL(_ env: [String: String]) throws -> String? {
        func value(_ name: String) -> String? {
            [env["NIO_VEHICLE_\(name)"], env["NIO_\(name)"]].compactMap { $0 }.first { !$0.isEmpty }
        }
        let widgetMode = value("API_MODE") == "widget"
        let raw = value("API_URL") ?? ""
        if raw.hasPrefix("https://"), !widgetMode || raw.contains("sign=") { return raw }

        if widgetMode, let sign = value("API_SIGN"), let timestamp = value("API_TIMESTAMP"),
           let vehicleID = value("ID"), let deviceID = value("DEVICE_ID") {
            var components = URLComponents(string: "https://app.nio.com/app/api/icar/v2/widget/info")!
            components.queryItems = [
                ("region", value("REGION") ?? "cn"),
                ("app_id", value("APP_ID") ?? "10002"),
                ("timestamp", timestamp),
                ("lang", value("LANG") ?? "zh-CN"),
                ("vehicle_id", vehicleID),
                ("app_ver", value("APP_VER") ?? "6.5.3"),
                ("device_id", deviceID),
                ("widget_functions", value("WIDGET_FUNCTIONS")
                    ?? "rvs_run_frequent_appointment,rvs_set_defender_mode,rvs_rpa_out,rvs_exe_findme"),
                ("widget_size", value("WIDGET_SIZE") ?? "medium"),
                ("sign", sign),
            ].map { URLQueryItem(name: $0.0, value: $0.1) }
            return components.url?.absoluteString
        }
        if widgetMode {
            throw NativeError.unsupported("2.0 不再生成旧 Widget MD5 签名，请粘贴抓包得到的完整 URL")
        }
        if raw.isEmpty { return nil }
        throw NativeError.invalidInput("车辆状态地址无效，请粘贴抓包得到的完整 URL")
    }

    static func mergedVehiclePayload(widget: JSONValue?, status: JSONValue?) -> JSONValue? {
        guard let widget else { return status }
        guard let extra = status?.object?["data"]?.object?["status"]?.object,
              var root = widget.object else { return widget }
        var data = root["data"]?.object ?? [:]
        var merged = data["status"]?.object ?? [:]
        for (key, value) in extra where value.object != nil {
            merged[key] = value
        }
        data["status"] = .object(merged)
        root["data"] = .object(data)
        return .object(root)
    }

    static func requireSuccess(_ payload: JSONValue, accepted: Set<String>) throws {
        let code = resultCode(payload)
        guard !code.isEmpty, !accepted.contains(code) else { return }
        let object = payload.object ?? [:]
        let message = ["display_msg", "message", "resultMsg", "result_desc", "debug_msg"]
            .compactMap { object[$0]?.string }
            .first { !$0.isEmpty }
        throw NioAPIError(kind: .generic, message: "接口返回 \(code)\(message.map { "：\($0)" } ?? "")")
    }

    private func extraFileEnvelope(output: String, payload: JSONValue) -> JSONValue {
        let root = payload.object ?? [:]
        let data = root["data"]?.object ?? root
        var envelope: [String: JSONValue] = [
            "ok": .bool(true),
            "at": .number(Date().timeIntervalSince1970 * 1000),
            "error": .null,
        ]
        if output == "journey.json" {
            let report = data["ai_month_report"]?.object
            envelope["month"] = report?["month"] ?? .null
            envelope["journey"] = data["journey"] ?? .null
        } else {
            for key in ["daily_mileage", "mileage", "activate_days"] {
                envelope[key] = data[key] ?? .null
            }
        }
        return .object(envelope)
    }

    private func persistExtraHistory(output: String, envelope: JSONValue) async throws {
        guard let object = envelope.object else { return }
        if output == "daily.json", let daily = object["daily_mileage"]?.number {
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyy-MM-dd"
            var history: [String: JSONValue] = [:]
            if let existing = try? await storage.readJSON(relativePath: "daily-history.json"),
               case let .object(values) = existing {
                history = values
            }
            history[formatter.string(from: Date())] = .object([
                "daily_mileage": .number(daily),
                "mileage": object["mileage"] ?? .null,
                "at": .number(Date().timeIntervalSince1970 * 1000),
            ])
            try await storage.writeJSON(.object(history), relativePath: "daily-history.json")
        }

        guard output == "journey.json",
              let journey = object["journey"]?.object,
              let idValue = journey["trip_id"] ?? journey["journey_id"] else { return }
        let id = idValue.string ?? idValue.number.map { String(format: "%.0f", $0) }
        guard let id,
              let start = journeyPoint(journey["start_location"]),
              let end = journeyPoint(journey["end_location"]),
              let startTime = journey["start_time"]?.number,
              let endTime = journey["end_time"]?.number else { return }
        var history: [JSONValue] = []
        if let existing = try? await storage.readJSON(relativePath: "journey-history.json"),
           case let .array(values) = existing {
            history = values.filter { $0.object?["trip_id"]?.string != id }
        }
        history.append(.object([
            "trip_id": .string(id),
            "start_time": .number(normalizeEpoch(startTime)),
            "end_time": .number(normalizeEpoch(endTime)),
            "trip_odometer": journey["trip_odometer"] ?? .null,
            "start": start,
            "end": end,
        ]))
        history.sort { ($0.object?["start_time"]?.number ?? 0) < ($1.object?["start_time"]?.number ?? 0) }
        if history.count > 1_000 { history.removeFirst(history.count - 1_000) }
        try await storage.writeJSON(.array(history), relativePath: "journey-history.json")
    }

    private func journeyPoint(_ value: JSONValue?) -> JSONValue? {
        guard let object = value?.object,
              let lat = object["poi_latitude"]?.number,
              let lng = object["poi_longitude"]?.number,
              abs(lat) >= 0.01, abs(lng) >= 0.01 else { return nil }
        let labels = ["poi", "district", "road_name"].compactMap { object[$0]?.string }.filter { !$0.isEmpty }
        return .object([
            "lat": .number(lat),
            "lng": .number(lng),
            "label": labels.isEmpty ? .null : .string(labels.joined(separator: " · ")),
        ])
    }

    private func normalizeEpoch(_ value: Double) -> Double {
        value < 10_000_000_000 ? value * 1_000 : value
    }

    private func appendVehicleHistory(_ payload: JSONValue) async throws {
        let snapshot = extractSnapshot(payload)
        guard snapshot != nil else { return }
        var history: [JSONValue] = []
        if let existing = try? await storage.readJSON(relativePath: "history.json"),
           case let .array(items) = existing {
            history = items
        }
        history.append(snapshot!)
        if history.count > 2_000 {
            history.removeFirst(history.count - 2_000)
        }
        try await storage.writeJSON(.array(history), relativePath: "history.json")
    }

    private func extractSnapshot(_ payload: JSONValue) -> JSONValue? {
        func number(_ keys: [String], in value: JSONValue) -> Double? {
            guard case let .object(object) = value else { return nil }
            for key in keys {
                if case let .number(result) = object[key] { return result }
            }
            for nested in object.values {
                if let result = number(keys, in: nested) { return result }
            }
            return nil
        }
        guard let soc = number(["soc", "soc_status"], in: payload) else { return nil }
        return .object([
            "ts": .number(Date().timeIntervalSince1970 * 1000),
            "soc": .number(soc),
            "range": .number(number(["range", "remaining_range"], in: payload) ?? 0),
            "actualRange": .number(number(["actual_range"], in: payload) ?? 0),
            "mileage": .number(number(["mileage", "odometer"], in: payload) ?? 0),
        ])
    }

    private func refreshChange() async throws {
        let env = try await storage.environment(includingSecrets: true, keychain: keychain)
        guard let baseURL = env["NIO_CHANGE_API_URL"], !baseURL.isEmpty else {
            if await storage.fileExists(relativePath: "change.json") { return }
            throw NativeError.invalidInput("请配置换电订单完整请求 URL")
        }
        do {
            try await fetchChange(env: env, baseURL: baseURL)
            await recordSlot("change", nil)
        } catch {
            await recordSlot("change", error)
            throw error
        }
    }

    private func fetchChange(env: [String: String], baseURL: String) async throws {
        let method = (env["NIO_CHANGE_API_METHOD"] ?? "POST").uppercased()
        let body = method == "GET" ? nil : Data((env["NIO_CHANGE_API_BODY"] ?? "{}").utf8)
        let token = first(env, ["NIO_CHANGE_ACCESS_TOKEN", "NIO_VEHICLE_ACCESS_TOKEN"])
        let headers = Self.changeHeaders(env)
        let cursorMode = env["NIO_CHANGE_API_MODE"] == "cursor"
        var nextURL = cursorMode ? try cursorPageURL(baseURL, offset: 0, time: nil, id: nil) : baseURL
        var offset = 0
        var ledger = await loadOrderLedger()
        var latestPayload: JSONValue = .object([:])
        var reachedEnd = false

        for _ in 0..<(cursorMode ? 20 : 1) {
            latestPayload = try await requestJSON(
                nextURL,
                method: method,
                token: token,
                body: body,
                extraHeaders: headers
            )
            try Self.requireSuccess(latestPayload, accepted: ["0000", "success"])
            let pageOrders = extractOrders(latestPayload)
            ledger = mergedOrderLedger(ledger, pageOrders)
            let cursor = extractCursor(latestPayload)
            guard cursorMode, cursor.hasMore, !pageOrders.isEmpty,
                  let cursorTime = cursor.time, let cursorID = cursor.id else {
                reachedEnd = true
                break
            }
            offset += pageOrders.count
            nextURL = try cursorPageURL(baseURL, offset: offset, time: cursorTime, id: cursorID)
            try? await Task.sleep(for: .milliseconds(800))
        }

        if cursorMode || !ledger.isEmpty {
            try await persistOrderLedger(ledger, reachedEnd: reachedEnd)
            try await storage.writeJSON(orderLedgerResponse(ledger), relativePath: "change.json")
        } else {
            try await storage.writeJSON(latestPayload, relativePath: "change.json")
        }
        try await writeMeta("last-fetch-change.json", ok: true)
    }

    private func extractOrders(_ value: JSONValue) -> [JSONValue] {
        guard case let .object(object) = value else { return [] }
        for key in ["data", "orders", "list", "orderList"] {
            if case let .array(values) = object[key] { return values }
            if let nested = object[key] {
                let values = extractOrders(nested)
                if !values.isEmpty { return values }
            }
        }
        for nested in object.values {
            let values = extractOrders(nested)
            if !values.isEmpty { return values }
        }
        return []
    }

    private func loadOrderLedger() async -> [String: JSONValue] {
        var ledger: [String: JSONValue] = [:]
        if let current = try? await storage.readJSON(relativePath: "change-ledger.json"),
           case let .object(values) = current {
            ledger = values
        }
        return ledger
    }

    private func mergedOrderLedger(
        _ current: [String: JSONValue],
        _ incoming: [JSONValue]
    ) -> [String: JSONValue] {
        var ledger = current
        for (index, order) in incoming.enumerated() {
            guard case let .object(object) = order else { continue }
            let id = ["id", "order_id", "orderId", "orderNo", "service_order_id"]
                .compactMap { key -> String? in
                    if let value = object[key]?.string { return value }
                    if let value = object[key]?.number { return String(format: "%.0f", value) }
                    return nil
                }
                .first ?? stableAnonymousOrderID(order, index: index)
            ledger[id] = order
        }
        return ledger
    }

    private func persistOrderLedger(_ ledger: [String: JSONValue], reachedEnd: Bool) async throws {
        try await storage.writeJSON(.object(ledger), relativePath: "change-ledger.json")
        try await storage.writeJSON(
            .object([
                "backfillComplete": .bool(reachedEnd),
                "backfillOffset": .number(0),
                "lastBackfillAt": .number(Date().timeIntervalSince1970 * 1000),
            ]),
            relativePath: "change-ledger-state.json"
        )
    }

    private func orderLedgerResponse(_ ledger: [String: JSONValue]) -> JSONValue {
        let orders = ledger.values.sorted { orderTimestamp($0) > orderTimestamp($1) }
        return .object([
            "resultCode": .string("success"),
            "resultData": .object([
                "data": .array(orders),
                "hasMore": .bool(false),
                "total": .number(Double(orders.count)),
            ]),
        ])
    }

    private func extractCursor(_ value: JSONValue) -> (hasMore: Bool, time: String?, id: String?) {
        guard case let .object(object) = value else { return (false, nil, nil) }
        func text(_ keys: [String]) -> String? {
            for key in keys {
                if let value = object[key]?.string, !value.isEmpty { return value }
                if let value = object[key]?.number { return String(format: "%.0f", value) }
            }
            return nil
        }
        let hasMore = object["hasMore"]?.bool ?? object["has_more"]?.bool
        let time = text(["lastCursorCreateTime", "cursorTime", "last_cursor_create_time"])
        let id = text(["lastCursorId", "cursorId", "last_cursor_id"])
        if hasMore != nil || time != nil || id != nil {
            return (hasMore ?? false, time, id)
        }
        for nested in object.values {
            let found = extractCursor(nested)
            if found.hasMore || found.time != nil || found.id != nil { return found }
        }
        return (false, nil, nil)
    }

    private static func changeHeaders(_ env: [String: String]) -> [String: String] {
        var headers = [
            "User-Agent": "NextevCar/6.3.0 (com.do1.WeiLaiApp; build:2586; iOS 26.2.1)",
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh-Hans;q=0.9",
        ]
        let mapping = [
            "NIO_CHANGE_USER_AGENT": "User-Agent",
            "NIO_CHANGE_ACCEPT": "Accept",
            "NIO_CHANGE_ACCEPT_LANGUAGE": "Accept-Language",
            "NIO_CHANGE_ORIGIN": "Origin",
            "NIO_CHANGE_MOBILEINFO": "mobileinfo",
            "NIO_CHANGE_COOKIE": "Cookie",
        ]
        for (key, header) in mapping {
            if let value = env[key], !value.isEmpty { headers[header] = value }
        }
        return headers
    }

    private func cursorPageURL(_ raw: String, offset: Int, time: String?, id: String?) throws -> String {
        guard var components = URLComponents(string: raw) else {
            throw NativeError.invalidInput("换电请求 URL 无效")
        }
        let pagingKeys: Set = ["offset", "limit", "lastCursorCreateTime", "lastCursorId"]
        var items = (components.queryItems ?? []).filter { !pagingKeys.contains($0.name) }
        items.append(URLQueryItem(name: "offset", value: String(offset)))
        items.append(URLQueryItem(name: "limit", value: "10"))
        if let time, let id {
            items.append(URLQueryItem(name: "lastCursorCreateTime", value: time))
            items.append(URLQueryItem(name: "lastCursorId", value: id))
        }
        components.queryItems = items
        guard let result = components.url?.absoluteString else {
            throw NativeError.invalidInput("无法生成换电分页 URL")
        }
        return result
    }

    private func stableAnonymousOrderID(_ value: JSONValue, index: Int) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: value.foundationValue, options: [.sortedKeys])) ?? Data()
        var hash: UInt64 = 1_469_598_103_934_665_603
        for byte in data {
            hash ^= UInt64(byte)
            hash &*= 1_099_511_628_211
        }
        return "anonymous-\(String(hash, radix: 16))-\(index)"
    }

    private func orderTimestamp(_ value: JSONValue) -> Double {
        guard case let .object(object) = value else { return 0 }
        for key in ["createTime", "create_time", "orderTime", "timestamp"] {
            if let result = object[key]?.number { return result }
            if let raw = object[key]?.string, let result = Double(raw) { return result }
        }
        return 0
    }

    private func refreshCheckin() async throws {
        let env = try await storage.environment(includingSecrets: true, keychain: keychain)
        guard let url = env["NIO_CHECKIN_API_URL"], !url.isEmpty else {
            if await storage.fileExists(relativePath: "checkin.json") { return }
            throw NativeError.invalidInput("请配置签到请求 URL")
        }
        let payload: JSONValue
        do {
            payload = try await requestJSON(
                url,
                method: "GET",
                token: first(env, ["NIO_CHECKIN_ACCESS_TOKEN", "NIO_VEHICLE_ACCESS_TOKEN"]),
                body: nil
            )
            await recordSlot("checkin", nil)
        } catch {
            await recordSlot("checkin", error)
            throw error
        }
        try await storage.writeJSON(payload, relativePath: "checkin.json")
        try await writeMeta("last-fetch-checkin.json", ok: true)
    }

    private func refreshSimple(
        urlKey: String,
        tokenKeys: [String],
        output: String,
        meta: String
    ) async throws {
        let env = try await storage.environment(includingSecrets: true, keychain: keychain)
        guard let url = env[urlKey], !url.isEmpty else {
            if await storage.fileExists(relativePath: output) { return }
            throw NativeError.invalidInput("未配置 \(urlKey)")
        }
        let payload = try await requestJSON(url, method: "GET", token: first(env, tokenKeys), body: nil)
        try await storage.writeJSON(payload, relativePath: output)
        try await writeMeta(meta, ok: true)
    }

    private func refreshStock() async throws {
        let env = try await storage.environment(includingSecrets: true, keychain: keychain)
        guard let url = env["NIO_STOCK_API_URL"], !url.isEmpty else {
            if await storage.fileExists(relativePath: "stock-watch.json") { return }
            throw NativeError.invalidInput("未配置库存监控 URL")
        }
        let payload = try await requestJSON(
            url,
            method: "GET",
            token: nil,
            body: nil,
            extraHeaders: first(env, ["NIO_STOCK_COOKIE", "NIO_STOCK_WATCH_COOKIE"])
                .map { ["Cookie": $0] } ?? [:]
        )
        try await storage.writeJSON(payload, relativePath: "stock-watch-state.json")
        try await writeMeta("last-fetch-stock.json", ok: true)
        await notifyStockAlerts(in: payload)
    }

    private func requestJSON(
        _ rawURL: String,
        method: String,
        token: String?,
        body: Data?,
        extraHeaders: [String: String] = [:]
    ) async throws -> JSONValue {
        guard let url = URL(string: rawURL), url.scheme?.lowercased() == "https" else {
            throw NativeError.invalidInput("仅允许 HTTPS 请求 URL")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method.uppercased()
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let token, !token.isEmpty {
            request.setValue(token.lowercased().hasPrefix("bearer ") ? token : "Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        for (name, value) in extraHeaders where !value.isEmpty {
            request.setValue(value, forHTTPHeaderField: name)
        }

        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw NativeError.network("服务未返回 HTTP 响应")
        }
        let payload = (try? JSONSerialization.jsonObject(with: data)).map(JSONValue.init)
        let signed = url.query?.contains("sign=") == true
        guard (200..<300).contains(response.statusCode) else {
            throw Self.apiFailure(payload, status: response.statusCode, signed: signed)
        }
        guard !data.isEmpty else { throw NativeError.network("服务返回空内容") }
        guard let payload else { throw NativeError.network("服务返回的不是 JSON") }
        if let failure = Self.businessFailure(payload) { throw failure }
        return payload
    }

    static func apiFailure(_ payload: JSONValue?, status: Int, signed: Bool) -> NioAPIError {
        let code = resultCode(payload)
        let blob = code.lowercased()
        if blob.contains("sign") || (status == 403 && signed && code.isEmpty) {
            return NioAPIError(kind: .sign, message: "签名失效（HTTP \(status)\(code.isEmpty ? "" : " · \(code)")）")
        }
        if status == 401 || status == 403 || ["auth", "token", "login", "unauthor"].contains(where: blob.contains) {
            return NioAPIError(kind: .auth, message: "Token 失效（HTTP \(status)\(code.isEmpty ? "" : " · \(code)")）")
        }
        return NioAPIError(kind: .generic, message: "服务请求失败（HTTP \(status)\(code.isEmpty ? "" : " · \(code)")）")
    }

    static func businessFailure(_ payload: JSONValue) -> NioAPIError? {
        let code = resultCode(payload)
        let blob = code.lowercased()
        if blob.contains("sign") { return NioAPIError(kind: .sign, message: "签名失效（\(code)）") }
        if ["auth", "token", "login", "unauthor"].contains(where: blob.contains) {
            return NioAPIError(kind: .auth, message: "Token 失效（\(code)）")
        }
        return nil
    }

    private static func resultCode(_ payload: JSONValue?) -> String {
        guard let object = payload?.object else { return "" }
        let value = object["result_code"] ?? object["resultCode"]
        return value?.string ?? value?.number.map { String(format: "%.0f", $0) } ?? ""
    }

    static func failureKind(_ error: any Error) -> String {
        if let error = error as? NioAPIError { return error.kind.rawValue }
        if case .unsupported = error as? NativeError { return NioAPIError.Kind.sign.rawValue }
        return NioAPIError.Kind.generic.rawValue
    }

    private func recordSlot(_ id: String, _ error: (any Error)?) async {
        var slots = (try? await storage.readJSON(relativePath: "auth-slots.json"))?.object ?? [:]
        slots[id] = .object([
            "ok": .bool(error == nil),
            "kind": error.map { .string(Self.failureKind($0)) } ?? .null,
            "error": error.map { .string($0.localizedDescription) } ?? .null,
            "at": .number(Date().timeIntervalSince1970 * 1000),
        ])
        try? await storage.writeJSON(.object(slots), relativePath: "auth-slots.json")
    }

    private func writeMeta(_ name: String, ok: Bool, error: String? = nil, errorKind: String? = nil) async throws {
        try await storage.writeJSON(
            .object([
                "ok": .bool(ok),
                "at": .number(Date().timeIntervalSince1970 * 1000),
                "error": error.map(JSONValue.string) ?? .null,
                "errorKind": errorKind.map(JSONValue.string) ?? .null,
            ]),
            relativePath: name
        )
    }

    private func first(_ values: [String: String], _ keys: [String]) -> String? {
        keys.compactMap { values[$0] }.first { !$0.isEmpty }
    }

    private func notifyStockAlerts(in value: JSONValue) async {
        func containsAlert(_ value: JSONValue) -> Bool {
            switch value {
            case let .object(object):
                if object["alert"]?.bool == true || object["inStock"]?.bool == true || object["in_stock"]?.bool == true {
                    return true
                }
                return object.values.contains(where: containsAlert)
            case let .array(values):
                return values.contains(where: containsAlert)
            default:
                return false
            }
        }
        guard containsAlert(value) else { return }
        let center = UNUserNotificationCenter.current()
        let authorized = (try? await center.requestAuthorization(options: [.alert, .sound])) == true
        guard authorized else { return }
        let content = UNMutableNotificationContent()
        content.title = "蔚来车辆看板"
        content.body = "监控的商品状态已更新，请打开看板查看。"
        content.sound = .default
        try? await center.add(UNNotificationRequest(
            identifier: "stock-\(UUID().uuidString)",
            content: content,
            trigger: nil
        ))
    }
}

actor PhotoService {
    static let angles = ["side", "front45", "rear45", "front", "rear"]
    static let maximumBytes = 12 * 1024 * 1024

    private let storage: AppStorage

    init(storage: AppStorage) {
        self.storage = storage
    }

    func manifest() async -> JSONValue {
        var values: [String: JSONValue] = [:]
        for angle in Self.angles {
            let name = await existingFilename(angle)
            if let name,
               let url = try? await storage.dataFileURL(relativePath: "vehicle-photos/\(name)"),
               let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
               let modified = attributes[.modificationDate] as? Date {
                values[angle] = .number(modified.timeIntervalSince1970 * 1000)
            } else {
                values[angle] = .null
            }
        }
        return .object(values)
    }

    func save(angle: String, data: Data) async throws -> JSONValue {
        guard Self.angles.contains(angle) else { throw NativeError.invalidInput("无效照片角度") }
        guard !data.isEmpty, data.count <= Self.maximumBytes else {
            throw NativeError.invalidInput("照片不得超过 12 MB")
        }
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetCount(source) > 0,
              let type = CGImageSourceGetType(source) as String? else {
            throw NativeError.invalidInput("无法识别图片格式")
        }
        let extensionName: String
        switch type {
        case UTType.jpeg.identifier: extensionName = "jpg"
        case UTType.png.identifier: extensionName = "png"
        case UTType.heic.identifier, UTType.heif.identifier: extensionName = "heic"
        case UTType.webP.identifier: extensionName = "webp"
        default: throw NativeError.invalidInput("仅支持 JPEG、PNG、HEIC 或 WebP")
        }
        try await delete(angle: angle)
        try await storage.writeData(data, relativePath: "vehicle-photos/\(angle).\(extensionName)")
        return await manifest()
    }

    @discardableResult
    func delete(angle: String) async throws -> JSONValue {
        guard Self.angles.contains(angle) else { throw NativeError.invalidInput("无效照片角度") }
        for ext in ["jpg", "jpeg", "png", "heic", "webp"] {
            try? await storage.remove(relativePath: "vehicle-photos/\(angle).\(ext)")
        }
        return await manifest()
    }

    func fileURL(angle: String) async -> URL? {
        guard Self.angles.contains(angle), let name = await existingFilename(angle) else { return nil }
        return try? await storage.dataFileURL(relativePath: "vehicle-photos/\(name)")
    }

    private func existingFilename(_ angle: String) async -> String? {
        let names = (try? await storage.list(relativeDirectory: "vehicle-photos")) ?? []
        return names.first { $0.split(separator: ".").first == Substring(angle) }
    }
}

actor NativeScheduler {
    struct State: Sendable {
        var running = false
        var nextVehicleAt: Date?
        var nextChangeAt: Date?
        var nextCheckinAt: Date?
    }

    private let storage: AppStorage
    private let sync: SyncCoordinator
    private var state = State()
    private var task: Task<Void, Never>?

    init(storage: AppStorage, sync: SyncCoordinator) {
        self.storage = storage
        self.sync = sync
    }

    func start() {
        guard task == nil else { return }
        state.running = true
        recalculate()
        task = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                await self?.tick()
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
        state.running = false
    }

    func wake() {
        recalculate()
        Task { await tick() }
    }

    func snapshot() -> JSONValue {
        .object([
            "running": .bool(state.running),
            "nextVehicleAt": state.nextVehicleAt.map { .number($0.timeIntervalSince1970 * 1000) } ?? .null,
            "nextChangeAt": state.nextChangeAt.map { .number($0.timeIntervalSince1970 * 1000) } ?? .null,
            "nextCheckinAt": state.nextCheckinAt.map { .number($0.timeIntervalSince1970 * 1000) } ?? .null,
        ])
    }

    private func tick() async {
        let now = Date()
        if let due = state.nextVehicleAt, due <= now {
            try? await sync.refresh(.vehicle)
            state.nextVehicleAt = now.addingTimeInterval(await vehicleInterval())
        }
        if let due = state.nextChangeAt, due <= now {
            try? await sync.refresh(.change)
            state.nextChangeAt = now.addingTimeInterval(await changeInterval())
        }
        if let due = state.nextCheckinAt, due <= now {
            do {
                try await sync.refresh(.checkin)
                state.nextCheckinAt = await checkinComplete() ? nextNineAM(after: now) : now.addingTimeInterval(300)
            } catch {
                state.nextCheckinAt = now.addingTimeInterval(300)
            }
        }
    }

    private func recalculate() {
        let now = Date()
        state.nextVehicleAt = now.addingTimeInterval(10)
        state.nextChangeAt = now.addingTimeInterval(20)
        state.nextCheckinAt = nextNineAM(after: now.addingTimeInterval(-1))
    }

    private func vehicleInterval() async -> TimeInterval {
        let env = (try? await storage.environment()) ?? [:]
        if let vehicle = try? await storage.readJSON(relativePath: "vehicle.json") {
            let vehicleState = recursiveNumber(["vehicle_state"], in: vehicle)
            let fotaStatus = recursiveNumber(["fota_status"], in: vehicle)
            if fotaStatus != nil, fotaStatus != 0 { return 300 }
            if vehicleState == 1 {
                return max(60, TimeInterval(env["NIO_VEHICLE_POLL_DRIVING_SEC"] ?? "") ?? 900)
            }
            if vehicleState == 3 || Self.isCharging(vehicle) {
                return max(60, TimeInterval(env["NIO_VEHICLE_POLL_CHARGING_SEC"] ?? "") ?? 600)
            }
        }
        let hour = Calendar.current.component(.hour, from: Date())
        let key = (9...17).contains(hour) ? "NIO_VEHICLE_POLL_DAY_SEC" : "NIO_VEHICLE_POLL_NIGHT_SEC"
        return max(60, TimeInterval(env[key] ?? "") ?? ((9...17).contains(hour) ? 1800 : 3600))
    }

    private func changeInterval() async -> TimeInterval {
        let env = (try? await storage.environment()) ?? [:]
        return max(300, TimeInterval(env["NIO_CHANGE_POLL_INTERVAL"] ?? "") ?? 86400)
    }

    private func nextNineAM(after date: Date) -> Date {
        let calendar = Calendar.current
        var components = calendar.dateComponents([.year, .month, .day], from: date)
        components.hour = 9
        components.minute = 0
        components.second = 0
        let today = calendar.date(from: components) ?? date
        return today > date ? today : calendar.date(byAdding: .day, value: 1, to: today) ?? date.addingTimeInterval(86400)
    }

    private func checkinComplete() async -> Bool {
        guard let value = try? await storage.readJSON(relativePath: "checkin.json") else { return false }
        return recursiveBool(["checked_in", "checkedIn"], in: value) == true
    }

    private func recursiveNumber(_ keys: Set<String>, in value: JSONValue) -> Double? {
        guard case let .object(object) = value else { return nil }
        for key in keys {
            if let result = object[key]?.number { return result }
        }
        for nested in object.values {
            if let result = recursiveNumber(keys, in: nested) { return result }
        }
        return nil
    }

    /// 2.1.1 及更早版本会把 0/1 存成 false/true，因此两种写法都要识别。
    static func isCharging(_ value: JSONValue) -> Bool {
        guard case let .object(object) = value else { return false }
        switch object["charge_state"] {
        case let .number(state)?: return state == 1
        case let .bool(state)?: return state
        default: return object.values.contains { isCharging($0) }
        }
    }

    private func recursiveBool(_ keys: Set<String>, in value: JSONValue) -> Bool? {
        guard case let .object(object) = value else { return nil }
        for key in keys {
            if let result = object[key]?.bool { return result }
        }
        for nested in object.values {
            if let result = recursiveBool(keys, in: nested) { return result }
        }
        return nil
    }
}
