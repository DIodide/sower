import SwiftUI

struct SettingsView: View {
    @Environment(SettingsStore.self) private var settings

    private enum TestState: Equatable {
        case idle
        case testing
        case success(String)
        case failure(String)
    }

    @State private var testState: TestState = .idle

    var body: some View {
        @Bindable var settings = settings
        NavigationStack {
            Form {
                Section {
                    TextField("https://sower-api-\u{2026}.run.app", text: $settings.baseURLString)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    SecureField("API key", text: $settings.apiKey)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                } header: {
                    Text("Server")
                } footer: {
                    Text("The API key is stored in the iOS Keychain. The base URL is stored in app preferences.")
                }

                Section {
                    Button {
                        Task { await testConnection() }
                    } label: {
                        if testState == .testing {
                            HStack(spacing: 8) {
                                ProgressView()
                                Text("Testing\u{2026}")
                            }
                        } else {
                            Text("Test connection")
                        }
                    }
                    .disabled(!settings.isConfigured || testState == .testing)

                    switch testState {
                    case .success(let message):
                        Label {
                            Text(message)
                        } icon: {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                        }
                        .font(.footnote)
                    case .failure(let message):
                        Label {
                            Text(message)
                        } icon: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(.red)
                        }
                        .font(.footnote)
                    case .idle, .testing:
                        EmptyView()
                    }
                }

                Section {
                } footer: {
                    Text("Sower is read-only in this version. Use the desktop tools to act on tasks.")
                }
            }
            .navigationTitle("Settings")
        }
    }

    @MainActor
    private func testConnection() async {
        testState = .testing
        do {
            let client = try settings.makeClient()
            let overview = try await client.overview()
            let waiting = overview.waiting.count
            let inPlay = overview.inPlay.count
            testState = .success("Connected \u{2014} \(waiting) waiting, \(inPlay) in play.")
        } catch let error as APIError {
            testState = .failure(error.errorDescription ?? "Connection failed.")
        } catch {
            testState = .failure(error.localizedDescription)
        }
    }
}
