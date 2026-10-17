import Foundation
import Security

enum NativeError: LocalizedError, Sendable {
    case invalidInput(String)
    case notFound(String)
    case network(String)
    case storage(String)
    case unsupported(String)

    var errorDescription: String? {
        switch self {
        case let .invalidInput(message),
             let .notFound(message),
             let .network(message),
             let .storage(message),
             let .unsupported(message):
            return message
        }
    }
}

struct EnvironmentFile: Sendable {
    private(set) var values: [String: String]
    private let lines: [Line]

    private enum Line: Sendable {
        case entry(key: String, value: String)
        case raw(String)
    }

    init(contents: String) {
        var parsed: [String: String] = [:]
        var sourceLines: [Line] = []

        for sourceLine in contents.components(separatedBy: .newlines) {
            let trimmed = sourceLine.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty, !trimmed.hasPrefix("#"), let equals = trimmed.firstIndex(of: "=") else {
                sourceLines.append(.raw(sourceLine))
                continue
            }

            let key = String(trimmed[..<equals]).trimmingCharacters(in: .whitespaces)
            var value = String(trimmed[trimmed.index(after: equals)...]).trimmingCharacters(in: .whitespaces)
            if value.count >= 2,
               (value.hasPrefix("\"") && value.hasSuffix("\"")) ||
               (value.hasPrefix("'") && value.hasSuffix("'")) {
                value.removeFirst()
                value.removeLast()
            }
            if !key.isEmpty {
                parsed[key] = value
                sourceLines.append(.entry(key: key, value: value))
            } else {
                sourceLines.append(.raw(sourceLine))
            }
        }

        values = parsed
        lines = sourceLines
    }

    func rendered(replacing replacements: [String: String]) -> String {
        var seen = Set<String>()
        var output = lines.map { line -> String in
            switch line {
            case let .raw(value):
                return value
            case let .entry(key, oldValue):
                seen.insert(key)
                let value = replacements[key] ?? oldValue
                return "\(key)=\(quoteIfNeeded(value))"
            }
        }

        for key in replacements.keys.sorted() where !seen.contains(key) {
            output.append("\(key)=\(quoteIfNeeded(replacements[key] ?? ""))")
        }
        return output.joined(separator: "\n")
    }

    private func quoteIfNeeded(_ value: String) -> String {
        guard value.contains(where: { $0.isWhitespace || $0 == "#" || $0 == "\"" }) else { return value }
        return "\"\(value.replacingOccurrences(of: "\"", with: "\\\""))\""
    }
}

actor AppStorage {
    private static let secretStorageKey = "NIO_SECRET_STORAGE"
    static let secretKeys: Set<String> = [
        "NIO_VEHICLE_ACCESS_TOKEN",
        "NIO_ACCESS_TOKEN",
        "NIO_CHANGE_ACCESS_TOKEN",
        "NIO_CHANGE_COOKIE",
        "NIO_CHECKIN_ACCESS_TOKEN",
        "NIO_VEHICLE_EXTRA_TOKEN",
        "NIO_AMAP_WEB_SERVICE_KEY",
        "NIO_AMAP_JS_KEY",
        "NIO_AMAP_JS_SECURITY_CODE",
        "NIO_STOCK_COOKIE",
        "NIO_STOCK_TOKEN",
        "NIO_STOCK_WATCH_COOKIE",
        "NIO_STOCK_WATCH_TOKEN",
        "NIO_POWER_ACCESS_TOKEN",
    ]

    let rootURL: URL
    let dataURL: URL
    let configURL: URL
    private let fileManager: FileManager

    init(rootURL: URL? = nil, fileManager: FileManager = .default) throws {
        self.fileManager = fileManager
        if let rootURL {
            self.rootURL = rootURL
        } else {
            let support = try fileManager.url(
                for: .applicationSupportDirectory,
                in: .userDomainMask,
                appropriateFor: nil,
                create: true
            )
            self.rootURL = support.appendingPathComponent("蔚来车辆看板", isDirectory: true)
        }
        dataURL = self.rootURL.appendingPathComponent("data", isDirectory: true)
        configURL = self.rootURL.appendingPathComponent("config.env")

        try fileManager.createDirectory(at: self.rootURL, withIntermediateDirectories: true)
        try fileManager.createDirectory(at: dataURL, withIntermediateDirectories: true)
        try fileManager.createDirectory(
            at: dataURL.appendingPathComponent("vehicle-photos", isDirectory: true),
            withIntermediateDirectories: true
        )
    }

    func bootstrapConfig(exampleURL: URL? = nil) throws {
        guard !fileManager.fileExists(atPath: configURL.path) else { return }
        if let exampleURL, fileManager.fileExists(atPath: exampleURL.path) {
            let data = try Data(contentsOf: exampleURL)
            try atomicWrite(data, to: configURL)
            return
        }
        let defaults = """
        # 蔚来看板 Mac 原生版配置
        NIO_SECRET_STORAGE=file
        NIO_VEHICLE_API_URL=
        NIO_CHANGE_API_URL=
        NIO_CHECKIN_API_URL=
        NIO_VEHICLE_POLL_DRIVING_SEC=900
        NIO_VEHICLE_POLL_DAY_SEC=1800
        NIO_VEHICLE_POLL_NIGHT_SEC=3600
        NIO_CHANGE_POLL_INTERVAL=86400
        NIO_TRAY_DISPLAY=soc,range
        """
        try atomicWrite(Data(defaults.utf8), to: configURL)
    }

    func environment(includingSecrets: Bool = false, keychain: KeychainStore? = nil) throws -> [String: String] {
        let contents = (try? String(contentsOf: configURL, encoding: .utf8)) ?? ""
        var values = EnvironmentFile(contents: contents).values
        guard includingSecrets else {
            for key in Self.secretKeys {
                values.removeValue(forKey: key)
            }
            return values
        }
        return values
    }

    func updateEnvironment(_ changes: [String: String]) throws {
        let contents = (try? String(contentsOf: configURL, encoding: .utf8)) ?? ""
        let next = EnvironmentFile(contents: contents).rendered(replacing: changes)
        try atomicWrite(Data(next.utf8), to: configURL)
    }

    /// 2.0 早期版本曾将本机配置迁入钥匙串。用户选择恢复 config.env 后，
    /// 仅首次读取旧值并写回权限为 0600 的本机配置文件。
    func restoreSecretsFromKeychain(_ keychain: KeychainStore) throws -> [String] {
        let contents = (try? String(contentsOf: configURL, encoding: .utf8)) ?? ""
        let environment = EnvironmentFile(contents: contents)
        guard environment.values[Self.secretStorageKey] != "file" else { return [] }
        var restored: [String: String] = [Self.secretStorageKey: "file"]
        for key in Self.secretKeys {
            if let existing = environment.values[key], !existing.isEmpty {
                continue
            }
            if let value = try keychain.read(key), !value.isEmpty {
                restored[key] = value
            }
        }
        try atomicWrite(Data(environment.rendered(replacing: restored).utf8), to: configURL)
        return restored.keys.filter { Self.secretKeys.contains($0) }.sorted()
    }

    func secretConfigurationState() -> [String: Bool] {
        let values = (try? environment(includingSecrets: true)) ?? [:]
        return Dictionary(uniqueKeysWithValues: Self.secretKeys.map { key in
            (key, values[key]?.isEmpty == false)
        })
    }

    func readData(relativePath: String) throws -> Data {
        try Data(contentsOf: safeDataURL(relativePath))
    }

    func readJSON(relativePath: String) throws -> JSONValue {
        let object = try JSONSerialization.jsonObject(with: readData(relativePath: relativePath))
        return JSONValue(object)
    }

    func writeData(_ data: Data, relativePath: String) throws {
        try atomicWrite(data, to: safeDataURL(relativePath))
    }

    func writeJSON(_ value: JSONValue, relativePath: String) throws {
        let data = try JSONSerialization.data(
            withJSONObject: value.foundationValue,
            options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        )
        try writeData(data, relativePath: relativePath)
    }

    func fileExists(relativePath: String) -> Bool {
        (try? safeDataURL(relativePath)).map { fileManager.fileExists(atPath: $0.path) } ?? false
    }

    func remove(relativePath: String) throws {
        let url = try safeDataURL(relativePath)
        if fileManager.fileExists(atPath: url.path) {
            try fileManager.removeItem(at: url)
        }
    }

    func list(relativeDirectory: String) throws -> [String] {
        let directory = try safeDataURL(relativeDirectory)
        return try fileManager.contentsOfDirectory(atPath: directory.path).sorted()
    }

    func dataFileURL(relativePath: String) throws -> URL {
        try safeDataURL(relativePath)
    }

    func readRootData(filename: String) throws -> Data {
        try Data(contentsOf: safeRootURL(filename))
    }

    func writeRootData(_ data: Data, filename: String) throws {
        try atomicWrite(data, to: safeRootURL(filename))
    }

    func rootFileURL(filename: String) throws -> URL {
        try safeRootURL(filename)
    }

    private func safeDataURL(_ relativePath: String) throws -> URL {
        guard !relativePath.hasPrefix("/"), !relativePath.components(separatedBy: "/").contains("..") else {
            throw NativeError.invalidInput("无效的数据路径")
        }
        let result = dataURL.appendingPathComponent(relativePath).standardizedFileURL
        guard result.path == dataURL.path || result.path.hasPrefix(dataURL.path + "/") else {
            throw NativeError.invalidInput("数据路径越界")
        }
        return result
    }

    private func safeRootURL(_ filename: String) throws -> URL {
        guard !filename.isEmpty, !filename.contains("/"), filename != ".", filename != ".." else {
            throw NativeError.invalidInput("无效的文件名")
        }
        return rootURL.appendingPathComponent(filename)
    }

    private func atomicWrite(_ data: Data, to destination: URL) throws {
        try fileManager.createDirectory(
            at: destination.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let temporary = destination.deletingLastPathComponent()
            .appendingPathComponent(".\(destination.lastPathComponent).\(UUID().uuidString).tmp")
        do {
            try data.write(to: temporary, options: [.atomic])
            if fileManager.fileExists(atPath: destination.path) {
                _ = try fileManager.replaceItemAt(destination, withItemAt: temporary)
            } else {
                try fileManager.moveItem(at: temporary, to: destination)
            }
            try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
        } catch {
            try? fileManager.removeItem(at: temporary)
            throw NativeError.storage("无法写入 \(destination.lastPathComponent)：\(error.localizedDescription)")
        }
    }
}

final class KeychainStore: @unchecked Sendable {
    private let service: String

    init(service: String = "com.nio.vehicle-dashboard.native") {
        self.service = service
    }

    func write(_ value: String, for account: String) throws {
        let data = Data(value.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attributes: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var add = query
            add[kSecValueData as String] = data
            let addStatus = SecItemAdd(add as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw NativeError.storage("无法保存安全配置（\(addStatus)）")
            }
        } else if status != errSecSuccess {
            throw NativeError.storage("无法更新安全配置（\(status)）")
        }
    }

    func read(_ account: String) throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw NativeError.storage("无法读取安全配置（\(status)）")
        }
        return String(data: data, encoding: .utf8)
    }

    func delete(_ account: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw NativeError.storage("无法删除安全配置（\(status)）")
        }
    }
}
