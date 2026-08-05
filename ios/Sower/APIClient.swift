import Foundation

enum APIError: Error, LocalizedError {
    case notConfigured
    case unauthorized
    case network(String)
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "Set a base URL and API key in Settings."
        case .unauthorized:
            return "The server rejected the API key. Check it in Settings."
        case .network(let message):
            return message
        case .decoding(let message):
            return "Unexpected response from the server. \(message)"
        }
    }
}

struct APIClient {
    let baseURL: URL
    let apiKey: String

    init(baseURLString: String, apiKey: String) throws {
        let trimmedURL = baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedURL.isEmpty, !trimmedKey.isEmpty else { throw APIError.notConfigured }

        var normalized = trimmedURL
        while normalized.hasSuffix("/") { normalized.removeLast() }
        if !normalized.lowercased().hasPrefix("http://") && !normalized.lowercased().hasPrefix("https://") {
            normalized = "https://" + normalized
        }
        guard let url = URL(string: normalized), url.host != nil else { throw APIError.notConfigured }

        self.baseURL = url
        self.apiKey = trimmedKey
    }

    func overview() async throws -> Overview {
        try await get("/mobile/overview")
    }

    func taskDetail(id: String) async throws -> TaskDetailResponse {
        try await get("/mobile/tasks/\(escape(id))")
    }

    func followupDetail(id: String) async throws -> FollowupDetailResponse {
        try await get("/mobile/followups/\(escape(id))")
    }

    // MARK: - Internals

    private func escape(_ component: String) -> String {
        component.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? component
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        guard let url = URL(string: baseURL.absoluteString + path) else {
            throw APIError.network("Invalid request URL.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.setValue("application/json", forHTTPHeaderField: "accept")
        request.timeoutInterval = 20

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw APIError.network(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw APIError.network("Invalid response from server.")
        }
        switch http.statusCode {
        case 200...299:
            break
        case 401, 403:
            throw APIError.unauthorized
        default:
            throw APIError.network("Server returned HTTP \(http.statusCode).")
        }

        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }
}
