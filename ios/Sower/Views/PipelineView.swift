import SwiftUI

struct PipelineView: View {
    @Environment(SettingsStore.self) private var settings
    @State private var model = PipelineViewModel()
    let openSettings: () -> Void

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Pipeline")
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .task(let id):
                        TaskDetailView(taskID: id)
                    case .followup(let id):
                        FollowupDetailView(followupID: id)
                    }
                }
        }
        .task(id: settings.configFingerprint) {
            await model.load(settings: settings)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .idle, .loading:
            ProgressView("Loading\u{2026}")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .notConfigured:
            ContentUnavailableView {
                Label("Not configured", systemImage: "gearshape")
            } description: {
                Text("Add your Sower base URL and API key to get started.")
            } actions: {
                Button("Open Settings", action: openSettings)
                    .buttonStyle(.borderedProminent)
            }
        case .failed(let error):
            ContentUnavailableView {
                Label("Couldn't load", systemImage: "wifi.exclamationmark")
            } description: {
                Text(error.errorDescription ?? "Something went wrong.")
            } actions: {
                Button("Retry") {
                    Task { await model.load(settings: settings) }
                }
                .buttonStyle(.borderedProminent)
                if case .unauthorized = error {
                    Button("Open Settings", action: openSettings)
                }
            }
        case .loaded(let overview):
            overviewList(overview)
        }
    }

    @ViewBuilder
    private func overviewList(_ overview: Overview) -> some View {
        List {
            if !overview.waiting.isEmpty {
                Section("Waiting on you") {
                    ForEach(overview.waiting) { card in
                        NavigationLink(value: Route.task(card.id)) {
                            WaitingTaskRow(card: card)
                        }
                    }
                }
            }
            if !overview.inPlay.isEmpty {
                Section("In play") {
                    ForEach(overview.inPlay) { card in
                        NavigationLink(value: Route.followup(card.id)) {
                            FollowupRow(card: card)
                        }
                    }
                }
            }
            if !overview.sent.isEmpty {
                Section("Sent") {
                    ForEach(overview.sent) { card in
                        NavigationLink(value: Route.task(card.id)) {
                            SentTaskRow(card: card)
                        }
                    }
                }
            }
            if overview.processingCount > 0 {
                Section {
                    EmptyView()
                } footer: {
                    Text("\(overview.processingCount) application\(overview.processingCount == 1 ? "" : "s") processing")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                        .multilineTextAlignment(.center)
                }
            }
        }
        .refreshable {
            await model.load(settings: settings, isRefresh: true)
        }
        .overlay {
            if overview.isEmpty {
                ContentUnavailableView {
                    Label("All clear", systemImage: "tray")
                } description: {
                    Text(
                        overview.processingCount > 0
                        ? "Nothing needs you right now. \(overview.processingCount) application\(overview.processingCount == 1 ? "" : "s") processing."
                        : "Nothing needs you right now. Pull to refresh."
                    )
                }
            }
        }
    }
}
