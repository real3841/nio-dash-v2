import Foundation

enum PowerHARImporter {
    static func importPower(from text: String, existing: JSONValue?) -> JSONValue? {
        guard
            let data = text.data(using: .utf8),
            let har = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let log = har["log"] as? [String: Any],
            let entries = log["entries"] as? [[String: Any]]
        else {
            return nil
        }

        var power = existing?.object ?? [:]
        var services = existingServices(power["services"])
        var months = power["months"]?.object ?? [:]
        var latest: Double = 0
        var imported = false

        for (index, entry) in entries.enumerated() {
            guard
                let request = entry["request"] as? [String: Any],
                let rawURL = request["url"] as? String,
                let url = URL(string: rawURL),
                url.scheme == "https",
                url.host?.hasSuffix("nio.com") == true,
                let path = powerPath(url.path),
                let response = entry["response"] as? [String: Any],
                (response["status"] as? NSNumber)?.intValue == 200,
                let content = response["content"] as? [String: Any],
                let responseData = decodedContent(content),
                let body = try? JSONSerialization.jsonObject(with: responseData) as? [String: Any],
                body["result_code"] as? String == "success",
                let payload = body["data"] as? [String: Any]
            else {
                continue
            }

            let startedAt = ISO8601DateFormatter().date(from: entry["startedDateTime"] as? String ?? "")?
                .timeIntervalSince1970 ?? Date().timeIntervalSince1970
            let at = startedAt * 1000
            latest = max(latest, at)

            if path == "entrance",
               let spots = payload["spots"] as? [[String: Any]],
               let spot = spots.first {
                power["spot"] = .object(selected(
                    spot,
                    stringKeys: ["model", "resource_type", "work_state", "reservation_starttime", "reservation_endtime", "share_state", "software_version", "hardware_version"],
                    numberKeys: ["charging_mode", "battery_care", "quiet_mode"],
                    boolKeys: ["is_online", "mobile_network_state", "reservation_state"],
                    at: at
                ))
                imported = true
            } else if path == "realtime/status" {
                power["realtime"] = .object(selected(
                    payload,
                    stringKeys: ["effective_state", "effective_state_desc"],
                    numberKeys: [],
                    boolKeys: [],
                    at: at
                ))
                imported = true
            } else if path == "{spot}/charge/services",
                      let incoming = payload["services"] as? [[String: Any]] {
                for (serviceIndex, service) in incoming.enumerated() {
                    let start = number(service["start_time"]) ?? at
                    let end = number(service["end_time"]) ?? 0
                    let localID = "service-\(String(format: "%.0f", start))-\(String(format: "%.0f", end))-\(serviceIndex + index)"
                    services[localID] = .object([
                        "order_id": .string(localID),
                        "consume_power": jsonNumber(number(service["display_consume_power"]) ?? number(service["consume_power"])),
                        "start_time": jsonNumber(number(service["start_time"])),
                        "end_time": jsonNumber(number(service["end_time"])),
                        "charge_duration": jsonNumber(number(service["charge_duration"])),
                        "status": jsonString(service["status"] as? String),
                    ])
                }
                imported = true
            } else if path == "{spot}/statistics/daily",
                      let summary = payload["statistic_summary"] as? [String: Any],
                      let start = number(summary["start_time"]) {
                let month = monthKey(milliseconds: normalizeEpoch(start))
                let reports = (payload["reports"] as? [[String: Any]] ?? []).map { report in
                    JSONValue.object([
                        "date": jsonString(report["date"] as? String),
                        "charging_times": jsonNumber(number(report["charging_times"])),
                        "charging_duration": jsonNumber(number(report["charging_duration"])),
                        "real_charge_kwh": jsonNumber(number(report["real_charge_kwh"])),
                    ])
                }
                months[month] = .object([
                    "total_charging_times": jsonNumber(number(summary["charging_times"])),
                    "total_charging_duration": jsonNumber(number(summary["charging_duration"])),
                    "total_real_charge_kwh": jsonNumber(number(summary["real_charge_kwh"])),
                    "last_update_time": jsonNumber(number(summary["last_update_time"])),
                    "reports": .array(reports),
                    "at": .number(at),
                ])
                imported = true
            }
        }

        guard imported else { return nil }
        power["services"] = .array(
            services.values
                .sorted { ($0.object?["start_time"]?.number ?? 0) > ($1.object?["start_time"]?.number ?? 0) }
                .prefix(500)
                .map { $0 }
        )
        power["months"] = .object(months)
        power["capturedAt"] = .number(latest)
        power["at"] = .number(Date().timeIntervalSince1970 * 1000)
        return .object(power)
    }

    private static func decodedContent(_ content: [String: Any]) -> Data? {
        guard let text = content["text"] as? String else { return nil }
        if content["encoding"] as? String == "base64" {
            return Data(base64Encoded: text)
        }
        return text.data(using: .utf8)
    }

    private static func powerPath(_ path: String) -> String? {
        guard let range = path.range(of: "/powerhome/") else { return nil }
        let suffix = String(path[range.upperBound...])
        let components = suffix.split(separator: "/").map(String.init)
        guard !components.isEmpty else { return nil }
        if components[0].hasPrefix("NPC-") {
            return (["{spot}"] + components.dropFirst()).joined(separator: "/")
        }
        return suffix
    }

    private static func existingServices(_ value: JSONValue?) -> [String: JSONValue] {
        guard case let .array(items) = value else { return [:] }
        return Dictionary(uniqueKeysWithValues: items.compactMap { item in
            item.object?["order_id"]?.string.map { ($0, item) }
        })
    }

    private static func selected(
        _ object: [String: Any],
        stringKeys: [String],
        numberKeys: [String],
        boolKeys: [String],
        at: Double
    ) -> [String: JSONValue] {
        var result: [String: JSONValue] = ["at": .number(at)]
        for key in stringKeys {
            result[key] = jsonString(object[key] as? String)
        }
        for key in numberKeys {
            result[key] = jsonNumber(number(object[key]))
        }
        for key in boolKeys {
            result[key] = (object[key] as? Bool).map(JSONValue.bool) ?? .null
        }
        return result
    }

    private static func number(_ value: Any?) -> Double? {
        if let value = value as? NSNumber { return value.doubleValue }
        if let value = value as? String { return Double(value) }
        return nil
    }

    private static func jsonNumber(_ value: Double?) -> JSONValue {
        value.map(JSONValue.number) ?? .null
    }

    private static func jsonString(_ value: String?) -> JSONValue {
        value.map(JSONValue.string) ?? .null
    }

    private static func normalizeEpoch(_ value: Double) -> Double {
        value < 10_000_000_000 ? value * 1_000 : value
    }

    private static func monthKey(milliseconds: Double) -> String {
        let date = Date(timeIntervalSince1970: milliseconds / 1000)
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM"
        return formatter.string(from: date)
    }
}
