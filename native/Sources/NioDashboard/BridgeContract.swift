import Foundation

enum BridgeContract {
    static let version = 1

    enum Operation: String, CaseIterable, Sendable {
        case ping = "bridge.ping"
        case httpRequest = "http.request"
        case openDashboard = "app.openDashboard"
        case hidePanel = "app.hidePanel"
        case resizePanel = "app.resizePanel"
        case quit = "app.quit"
        case refresh = "sync.refresh"
        case schedulerState = "scheduler.state"
        case subscribe = "events.subscribe"
    }
}

enum JSONValue: Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(_ value: Any?) {
        switch value {
        case nil, is NSNull:
            self = .null
        case let value as NSNumber where CFGetTypeID(value) == CFBooleanGetTypeID():
            self = .bool(value.boolValue)
        case let value as NSNumber:
            self = .number(value.doubleValue)
        case let value as Bool:
            self = .bool(value)
        case let value as String:
            self = .string(value)
        case let value as [Any]:
            self = .array(value.map(JSONValue.init))
        case let value as [String: Any]:
            self = .object(value.mapValues(JSONValue.init))
        default:
            self = .string(String(describing: value))
        }
    }

    var foundationValue: Any {
        switch self {
        case .null:
            return NSNull()
        case let .bool(value):
            return value
        case let .number(value):
            return value
        case let .string(value):
            return value
        case let .array(values):
            return values.map(\.foundationValue)
        case let .object(values):
            return values.mapValues(\.foundationValue)
        }
    }

    var object: [String: JSONValue]? {
        guard case let .object(value) = self else { return nil }
        return value
    }

    var string: String? {
        guard case let .string(value) = self else { return nil }
        return value
    }

    var bool: Bool? {
        guard case let .bool(value) = self else { return nil }
        return value
    }

    var number: Double? {
        guard case let .number(value) = self else { return nil }
        return value
    }

    var arrayCount: Int {
        guard case let .array(value) = self else { return 0 }
        return value.count
    }
}

struct BridgeRequest: Sendable {
    let id: String
    let operation: String
    let version: Int
    let payload: JSONValue

    init?(body: Any) {
        guard
            let object = body as? [String: Any],
            let id = object["id"] as? String,
            let operation = object["operation"] as? String
        else {
            return nil
        }

        self.id = id
        self.operation = operation
        self.version = object["version"] as? Int ?? 0
        self.payload = JSONValue(object["payload"])
    }
}

struct BridgeResponse: Sendable {
    let id: String
    let ok: Bool
    let result: JSONValue?
    let errorCode: String?
    let errorMessage: String?

    static func success(id: String, result: JSONValue = .null) -> BridgeResponse {
        BridgeResponse(id: id, ok: true, result: result, errorCode: nil, errorMessage: nil)
    }

    static func failure(id: String, code: String, message: String) -> BridgeResponse {
        BridgeResponse(id: id, ok: false, result: nil, errorCode: code, errorMessage: message)
    }

    var foundationValue: [String: Any] {
        var value: [String: Any] = ["id": id, "ok": ok]
        if let result {
            value["result"] = result.foundationValue
        }
        if let errorCode {
            value["error"] = ["code": errorCode, "message": errorMessage ?? ""]
        }
        return value
    }
}
