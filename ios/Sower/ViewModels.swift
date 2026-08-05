import Foundation
import Observation

enum LoadPhase<Value> {
    case idle
    case loading
    case notConfigured
    case loaded(Value)
    case failed(APIError)
}

@MainActor
@Observable
final class PipelineViewModel {
    var phase: LoadPhase<Overview> = .idle

    func load(settings: SettingsStore, isRefresh: Bool = false) async {
        guard settings.isConfigured else {
            phase = .notConfigured
            return
        }
        if !isRefresh {
            if case .loaded = phase {} else { phase = .loading }
        }
        do {
            let client = try settings.makeClient()
            let overview = try await client.overview()
            phase = .loaded(overview)
        } catch let error as APIError {
            if case .notConfigured = error {
                phase = .notConfigured
            } else {
                phase = .failed(error)
            }
        } catch {
            phase = .failed(.network(error.localizedDescription))
        }
    }
}

/// Shared loader for detail screens (task detail, follow-up detail).
@MainActor
@Observable
final class DetailLoader<Value> {
    var phase: LoadPhase<Value> = .idle

    func load(settings: SettingsStore, fetch: (APIClient) async throws -> Value) async {
        guard settings.isConfigured else {
            phase = .notConfigured
            return
        }
        if case .loaded = phase {} else { phase = .loading }
        do {
            let client = try settings.makeClient()
            let value = try await fetch(client)
            phase = .loaded(value)
        } catch let error as APIError {
            if case .notConfigured = error {
                phase = .notConfigured
            } else {
                phase = .failed(error)
            }
        } catch {
            phase = .failed(.network(error.localizedDescription))
        }
    }
}
