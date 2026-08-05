import Foundation

/// Parses backend ISO 8601 date strings, tolerating fractional seconds.
enum ISODate {
    private static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func parse(_ string: String?) -> Date? {
        guard let string, !string.isEmpty else { return nil }
        return fractional.date(from: string) ?? plain.date(from: string)
    }

    /// e.g. "Aug 6"
    static func shortDay(_ string: String?) -> String? {
        parse(string)?.formatted(.dateTime.month(.abbreviated).day())
    }

    /// e.g. "Aug 6, 3:12 PM"
    static func shortDateTime(_ string: String?) -> String? {
        parse(string)?.formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }

    /// Whole calendar days from today until the given date (negative = past).
    static func daysUntil(_ date: Date) -> Int {
        let cal = Calendar.current
        let start = cal.startOfDay(for: Date())
        let target = cal.startOfDay(for: date)
        return cal.dateComponents([.day], from: start, to: target).day ?? 0
    }

    /// True when a due date is past or within the next 2 days.
    static func isUrgent(_ date: Date) -> Bool {
        daysUntil(date) <= 2
    }
}
