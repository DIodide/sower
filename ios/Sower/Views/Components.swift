import SwiftUI

/// Navigation destinations pushed from anywhere inside the Pipeline stack.
enum Route: Hashable {
    case task(String)
    case followup(String)
}

// MARK: - Chips & badges

struct Chip: View {
    let text: String
    var color: Color = .secondary

    var body: some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .lineLimit(1)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(color.opacity(0.14), in: Capsule())
            .foregroundStyle(color)
    }
}

func priorityColor(_ label: String?) -> Color {
    switch label?.lowercased() {
    case "highest": return .red
    case "high": return .orange
    case "normal": return .blue
    case "low": return .gray
    default: return .blue
    }
}

/// Due-date chip; red when overdue or due within 2 days.
struct DueChip: View {
    let dueDate: String?

    var body: some View {
        if let date = ISODate.parse(dueDate) {
            let urgent = ISODate.isUrgent(date)
            let overdue = ISODate.daysUntil(date) < 0
            Chip(
                text: (overdue ? "Overdue " : "Due ") + date.formatted(.dateTime.month(.abbreviated).day()),
                color: urgent ? .red : .secondary
            )
        }
    }
}

// MARK: - List rows

struct WaitingTaskRow: View {
    let card: TaskCard

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(card.company ?? "Unknown company")
                .font(.subheadline.weight(.semibold))
            if let title = card.title, !title.isEmpty {
                Text(title)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            HStack(spacing: 6) {
                if let label = card.priorityLabel, !label.isEmpty {
                    Chip(text: label, color: priorityColor(label))
                }
                DueChip(dueDate: card.dueDate)
            }
        }
        .padding(.vertical, 2)
    }
}

struct SentTaskRow: View {
    let card: TaskCard

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(card.company ?? "Unknown company")
                .font(.subheadline.weight(.semibold))
            if let title = card.title, !title.isEmpty {
                Text(title)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            HStack(spacing: 6) {
                if let state = card.state, !state.isEmpty {
                    Chip(text: state.capitalized, color: .indigo)
                }
                if card.openFollowups > 0 {
                    Text("\(card.openFollowups) open follow-up\(card.openFollowups == 1 ? "" : "s")")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

struct FollowupRow: View {
    let card: FollowupCard

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(card.title ?? card.kindLabel ?? "Follow-up")
                .font(.subheadline.weight(.semibold))
                .lineLimit(2)
            if let company = card.company, !company.isEmpty {
                Text(company)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            HStack(spacing: 6) {
                if let kind = card.kindLabel ?? card.kind, !kind.isEmpty {
                    Chip(text: kind, color: .teal)
                }
                if let state = card.stateLabel ?? card.state, !state.isEmpty {
                    Chip(text: state, color: .indigo)
                }
                DueChip(dueDate: card.dueDate)
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Detail helpers

struct SectionHeader: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.secondary)
            .textCase(.uppercase)
    }
}
