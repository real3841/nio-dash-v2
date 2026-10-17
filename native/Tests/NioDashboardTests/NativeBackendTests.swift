import Foundation
import Testing
@testable import NioDashboard

@Test func environmentParserHandlesCommentsQuotesAndEquals() {
    let file = EnvironmentFile(contents: """
    # comment
    A=one
    B="two words"
    C='x=y'
    """)

    #expect(file.values["A"] == "one")
    #expect(file.values["B"] == "two words")
    #expect(file.values["C"] == "x=y")
    #expect(file.rendered(replacing: ["A": "changed"]).contains("A=changed"))
}

@Test func logRedactionRemovesSensitiveValues() {
    let fakeBearer = ["not", "a", "real", "token", "value"].joined(separator: "-")
    let source = "Authorization: Bearer \(fakeBearer) token=privatevalue 13800138000"
    let redacted = RedactedLog.redact(source)

    #expect(!redacted.contains(fakeBearer))
    #expect(!redacted.contains("privatevalue"))
    #expect(!redacted.contains("13800138000"))
}

@Test func storageRejectsTraversalAndWritesJSONAtomically() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let storage = try AppStorage(rootURL: root)

    await #expect(throws: NativeError.self) {
        try await storage.writeData(Data(), relativePath: "../outside")
    }

    try await storage.writeJSON(.object(["ok": .bool(true)]), relativePath: "sample.json")
    #expect(try await storage.readJSON(relativePath: "sample.json") == .object(["ok": .bool(true)]))
}

@Test func localConfigStoresSecretsPrivatelyAndHidesThemFromPublicReads() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let storage = try AppStorage(rootURL: root)
    try await storage.bootstrapConfig()
    let placeholder = "local-test-value"

    try await storage.updateEnvironment(["NIO_VEHICLE_ACCESS_TOKEN": placeholder])

    #expect(try await storage.environment()["NIO_VEHICLE_ACCESS_TOKEN"] == nil)
    #expect(try await storage.environment(includingSecrets: true)["NIO_VEHICLE_ACCESS_TOKEN"] == placeholder)
    let configURL = await storage.configURL
    let attributes = try FileManager.default.attributesOfItem(atPath: configURL.path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
}

private final class FakeLegacySecretStore: LegacySecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String]
    private let denied: Set<String>
    private(set) var reads: [String] = []

    init(values: [String: String], denied: Set<String>) {
        self.values = values
        self.denied = denied
    }

    func read(_ account: String) throws -> String? {
        lock.lock(); defer { lock.unlock() }
        reads.append(account)
        if denied.contains(account) { throw NativeError.storage("denied") }
        return values[account]
    }

    func delete(_ account: String) throws {
        lock.lock(); defer { lock.unlock() }
        values.removeValue(forKey: account)
    }

    func value(_ account: String) -> String? {
        lock.lock(); defer { lock.unlock() }
        return values[account]
    }
}

@Test func keychainRestoreSkipsDeniedItemsAndRunsOnce() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let storage = try AppStorage(rootURL: root)
    let configURL = await storage.configURL
    try Data("NIO_VEHICLE_API_URL=https://example.invalid\n".utf8).write(to: configURL)
    let keychain = FakeLegacySecretStore(
        values: ["NIO_VEHICLE_ACCESS_TOKEN": "restored-value", "NIO_CHANGE_ACCESS_TOKEN": "denied-value"],
        denied: ["NIO_CHANGE_ACCESS_TOKEN"]
    )

    let restored = try await storage.restoreSecretsFromKeychain(keychain)

    #expect(restored == ["NIO_VEHICLE_ACCESS_TOKEN"])
    let env = try await storage.environment(includingSecrets: true)
    #expect(env["NIO_VEHICLE_ACCESS_TOKEN"] == "restored-value")
    #expect(env["NIO_CHANGE_ACCESS_TOKEN"] == nil)
    #expect(env["NIO_SECRET_STORAGE"] == "file")
    #expect(keychain.value("NIO_VEHICLE_ACCESS_TOKEN") == nil)

    let readsAfterFirstLaunch = keychain.reads.count
    #expect(try await storage.restoreSecretsFromKeychain(keychain).isEmpty)
    #expect(keychain.reads.count == readsAfterFirstLaunch)
}

@Test func photoServiceRejectsOversizedInput() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let service = PhotoService(storage: try AppStorage(rootURL: root))

    do {
        _ = try await service.save(angle: "side", data: Data(count: PhotoService.maximumBytes + 1))
        Issue.record("Oversized photo should fail")
    } catch {
        #expect(error.localizedDescription.contains("12 MB"))
    }
}

@Test func bridgeRejectsUnknownVersion() async throws {
    let body: [String: Any] = [
        "id": "test",
        "version": 99,
        "operation": "bridge.ping",
        "payload": [:],
    ]
    let request = try #require(BridgeRequest(body: body))
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let backend = try NativeBackend(rootURL: root)

    let response = await backend.handle(request)
    #expect(!response.ok)
    #expect(response.errorCode == "unsupported_version")
}

@Test func coreSyncSlicesPersistCompatibleFiles() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let storage = try AppStorage(rootURL: root)
    try await storage.bootstrapConfig()
    try await storage.updateEnvironment([
        "NIO_VEHICLE_API_URL": "https://unit.test/vehicle",
        "NIO_CHANGE_API_URL": "https://unit.test/change",
        "NIO_CHANGE_API_METHOD": "POST",
        "NIO_CHECKIN_API_URL": "https://unit.test/checkin",
    ])

    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [MockURLProtocol.self]
    let session = URLSession(configuration: configuration)
    MockURLProtocol.handler = { request in
        let body: [String: Any]
        switch request.url?.path {
        case "/vehicle":
            body = [
                "result_code": "success",
                "data": ["status": ["soc_status": ["soc": 80, "remaining_range": 300]]],
            ]
        case "/change":
            body = [
                "resultCode": "success",
                "resultData": [
                    "data": [["orderNo": "test-order", "createTime": 1]],
                    "hasMore": false,
                ],
            ]
        case "/checkin":
            body = ["checked_in": true, "continuous_days": 3]
        default:
            body = ["ok": true]
        }
        let data = try JSONSerialization.data(withJSONObject: body)
        return (200, data)
    }

    let log = RedactedLog(storage: storage)
    let sync = SyncCoordinator(
        storage: storage,
        keychain: KeychainStore(service: "test.\(UUID().uuidString)"),
        log: log,
        session: session
    )
    try await sync.refresh(.vehicle)
    try await sync.refresh(.change)
    try await sync.refresh(.checkin)

    #expect(await storage.fileExists(relativePath: "vehicle.json"))
    #expect(await storage.fileExists(relativePath: "history.json"))
    #expect(await storage.fileExists(relativePath: "change.json"))
    #expect(await storage.fileExists(relativePath: "change-ledger.json"))
    #expect(await storage.fileExists(relativePath: "checkin.json"))
}

@Test func powerHARImportKeepsOnlyDashboardFields() throws {
    let response = try JSONSerialization.data(withJSONObject: [
        "result_code": "success",
        "data": [
            "effective_state": "idle",
            "effective_state_desc": "待机",
            "charger_identifier": "must-not-be-persisted",
            "longitude": 120.1,
            "latitude": 30.2,
        ],
    ])
    let har: [String: Any] = [
        "log": [
            "entries": [[
                "startedDateTime": "2026-01-01T00:00:00Z",
                "request": ["url": "https://example.nio.com/powerhome/realtime/status"],
                "response": [
                    "status": 200,
                    "content": ["text": String(decoding: response, as: UTF8.self)],
                ],
            ]],
        ],
    ]
    let data = try JSONSerialization.data(withJSONObject: har)
    let imported = try #require(PowerHARImporter.importPower(from: String(decoding: data, as: UTF8.self), existing: nil))
    let rendered = String(decoding: try JSONSerialization.data(withJSONObject: imported.foundationValue), as: UTF8.self)

    #expect(rendered.contains("effective_state"))
    #expect(!rendered.contains("must-not-be-persisted"))
    #expect(!rendered.contains("longitude"))
    #expect(!rendered.contains("latitude"))
}

private final class MockURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (Int, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else {
                throw NativeError.network("Missing test handler")
            }
            let (status, data) = try handler(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
