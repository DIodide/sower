import SwiftUI

struct FollowupDetailView: View {
    let followupID: String
    @Environment(SettingsStore.self) private var settings
    @State private var loader = DetailLoader<FollowupDetailResponse>()
    @State private var sourceExpanded = false

    var body: some View {
        Group {
            switch loader.phase {
            case .idle, .loading:
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .notConfigured:
                ContentUnavailableView("Not configured", systemImage: "gearshape")
            case .failed(let error):
                ContentUnavailableView {
                    Label("Couldn't load", systemImage: "wifi.exclamationmark")
                } description: {
                    Text(error.errorDescription ?? "Something went wrong.")
                } actions: {
                    Button("Retry") { Task { await load() } }
                        .buttonStyle(.borderedProminent)
                }
            case .loaded(let detail):
                content(detail)
            }
        }
        .navigationTitle("Follow-up")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: followupID + settings.configFingerprint) {
            await load()
        }
    }

    private func load() async {
        await loader.load(settings: settings) { client in
            try await client.followupDetail(id: followupID)
        }
    }

    @ViewBuilder
    private func content(_ detail: FollowupDetailResponse) -> some View {
        let followup = detail.followup
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(followup.title ?? followup.kindLabel ?? "Follow-up")
                        .font(.title3.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    if let taskLine = taskLine(detail.task) {
                        Text(taskLine)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    HStack(spacing: 6) {
                        if let kind = followup.kindLabel ?? followup.kind, !kind.isEmpty {
                            Chip(text: kind, color: .teal)
                        }
                        if let state = followup.stateLabel ?? followup.state, !state.isEmpty {
                            Chip(text: state, color: .indigo)
                        }
                        DueChip(dueDate: followup.dueDate)
                    }
                    if let due = ISODate.shortDateTime(followup.dueDate) {
                        Text("Due \(due)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                if let urlString = followup.url,
                   let url = URL(string: urlString), url.scheme != nil {
                    Link(destination: url) {
                        Label("Open link", systemImage: "arrow.up.right.square")
                            .font(.subheadline.weight(.medium))
                    }
                }

                if let notes = followup.notes, !notes.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        SectionHeader(title: "Notes")
                        Text(notes)
                            .font(.subheadline)
                            .textSelection(.enabled)
                    }
                }

                if let sourceBody = followup.sourceBody, !sourceBody.isEmpty {
                    DisclosureGroup(isExpanded: $sourceExpanded) {
                        Text(sourceBody)
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(10)
                            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
                            .padding(.top, 6)
                    } label: {
                        Label("Source email", systemImage: "envelope")
                            .font(.subheadline.weight(.medium))
                    }
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func taskLine(_ task: TaskRef?) -> String? {
        guard let task else { return nil }
        let company = task.company?.trimmingCharacters(in: .whitespaces) ?? ""
        let title = task.title?.trimmingCharacters(in: .whitespaces) ?? ""
        switch (company.isEmpty, title.isEmpty) {
        case (false, false): return "\(company) \u{2014} \(title)"
        case (false, true): return company
        case (true, false): return title
        case (true, true): return nil
        }
    }
}
