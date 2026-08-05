import Foundation
import Observation

/// Holds the user-supplied backend configuration.
/// Base URL persists to UserDefaults; the API key persists to the Keychain.
@Observable
final class SettingsStore {
    private static let baseURLDefaultsKey = "sower.baseURL"
    private static let apiKeyAccount = "api-key"

    var baseURLString: String {
        didSet {
            UserDefaults.standard.set(baseURLString, forKey: Self.baseURLDefaultsKey)
        }
    }

    var apiKey: String {
        didSet {
            if apiKey.isEmpty {
                KeychainHelper.delete(account: Self.apiKeyAccount)
            } else {
                KeychainHelper.save(apiKey, account: Self.apiKeyAccount)
            }
        }
    }

    init() {
        baseURLString = UserDefaults.standard.string(forKey: Self.baseURLDefaultsKey) ?? ""
        apiKey = KeychainHelper.read(account: Self.apiKeyAccount) ?? ""
    }

    var isConfigured: Bool {
        !baseURLString.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// A value that changes whenever the connection configuration changes.
    var configFingerprint: String { baseURLString + "\u{1F}" + apiKey }

    func makeClient() throws -> APIClient {
        try APIClient(baseURLString: baseURLString, apiKey: apiKey)
    }
}
