import SwiftUI

struct TaskDetailView: View {
    let taskID: String
    @Environment(SettingsStore.self) private var settings
    @State private var loader = DetailLoader<TaskDetailResponse>()

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
        .navigationTitle(navigationTitleText)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: taskID + settings.configFingerprint) {
            await load()
        }
    }

    private var navigationTitleText: String {
        if case .loaded(let detail) = loader.phase, let company = detail.task.company, !company.isEmpty {
            return company
        }
        return "Task"
    }

    private func load() async {
        await loader.load(settings: settings) { client in
            try await client.taskDetail(id: taskID)
        }
    }

    // MARK: - Content

    @ViewBuilder
    private func content(_ detail: TaskDetailResponse) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 22) {
                header(detail.task)

                if let urlString = detail.task.url,
                   let url = URL(string: urlString), url.scheme != nil {
                    Link(destination: url) {
                        Label("Open posting", systemImage: "arrow.up.right.square")
                            .font(.subheadline.weight(.medium))
                    }
                }

                if let notes = detail.task.notes, !notes.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        SectionHeader(title: "Notes")
                        Text(notes)
                            .font(.subheadline)
                            .textSelection(.enabled)
                    }
                }

                if let description = detail.description, !description.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        SectionHeader(title: "Description")
                        MarkdownView(source: description)
                    }
                }

                if !detail.questions.isEmpty {
                    questionsSection(detail.questions)
                }

                if !detail.followups.isEmpty {
                    followupsSection(detail.followups)
                }

                if !detail.timeline.isEmpty {
                    timelineSection(detail.timeline)
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private func header(_ task: TaskInfo) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(headerTitle(task))
                .font(.title3.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 6) {
                if let state = task.state, !state.isEmpty {
                    Chip(text: state.capitalized, color: .indigo)
                }
                if let label = task.priorityLabel, !label.isEmpty {
                    Chip(text: label, color: priorityColor(label))
                }
                DueChip(dueDate: task.dueDate)
            }
            if let due = ISODate.shortDateTime(task.dueDate) {
                Text("Due \(due)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func headerTitle(_ task: TaskInfo) -> String {
        let company = task.company?.trimmingCharacters(in: .whitespaces) ?? ""
        let title = task.title?.trimmingCharacters(in: .whitespaces) ?? ""
        switch (company.isEmpty, title.isEmpty) {
        case (false, false): return "\(company) \u{2014} \(title)"
        case (false, true): return company
        case (true, false): return title
        case (true, true): return "Untitled task"
        }
    }

    @ViewBuilder
    private func questionsSection(_ questions: [Question]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: "Questions")
            ForEach(questions) { question in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline, spacing: 2) {
                        Text(question.label ?? "Question")
                            .font(.subheadline.weight(.medium))
                            .fixedSize(horizontal: false, vertical: true)
                        if question.isRequired {
                            Text("*")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.red)
                        }
                    }
                    if question.isResolved {
                        HStack(alignment: .firstTextBaseline, spacing: 5) {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.caption)
                                .foregroundStyle(.green)
                            Text(question.value?.isEmpty == false ? question.value! : "Answered")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                    } else {
                        Text("No answer yet")
                            .font(.subheadline)
                            .italic()
                            .foregroundStyle(.tertiary)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func followupsSection(_ followups: [FollowupCard]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Follow-ups")
            ForEach(followups) { card in
                NavigationLink(value: Route.followup(card.id)) {
                    HStack {
                        FollowupRow(card: card)
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if card.id != followups.last?.id {
                    Divider()
                }
            }
        }
    }

    @ViewBuilder
    private func timelineSection(_ timeline: [TimelineEvent]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: "Timeline")
            ForEach(timeline) { event in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Circle()
                        .fill(Color.secondary.opacity(0.5))
                        .frame(width: 5, height: 5)
                        .offset(y: -2)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(event.summary ?? event.type ?? "Event")
                            .font(.footnote)
                            .fixedSize(horizontal: false, vertical: true)
                        if let at = ISODate.shortDateTime(event.at) {
                            Text(at)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
    }
}
