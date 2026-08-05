import SwiftUI

/// Lightweight line-oriented markdown renderer for job descriptions.
/// Handles #/##/### headings and -/* bullets per line; inline **bold**,
/// *italic*, `code`, and [links](url) via AttributedString's inline parser.
struct MarkdownBlock: Identifiable {
    enum Kind {
        case heading1, heading2, heading3, bullet, paragraph, blank
    }

    let id: Int
    let kind: Kind
    let text: String
}

enum MarkdownParser {
    static func blocks(from source: String) -> [MarkdownBlock] {
        var result: [MarkdownBlock] = []
        var lastWasBlank = true
        for (index, rawLine) in source.components(separatedBy: .newlines).enumerated() {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty {
                if !lastWasBlank {
                    result.append(MarkdownBlock(id: index, kind: .blank, text: ""))
                }
                lastWasBlank = true
                continue
            }
            lastWasBlank = false
            if line.hasPrefix("### ") {
                result.append(MarkdownBlock(id: index, kind: .heading3, text: String(line.dropFirst(4))))
            } else if line.hasPrefix("## ") {
                result.append(MarkdownBlock(id: index, kind: .heading2, text: String(line.dropFirst(3))))
            } else if line.hasPrefix("# ") {
                result.append(MarkdownBlock(id: index, kind: .heading1, text: String(line.dropFirst(2))))
            } else if line.hasPrefix("- ") || line.hasPrefix("* ") {
                result.append(MarkdownBlock(id: index, kind: .bullet, text: String(line.dropFirst(2))))
            } else {
                result.append(MarkdownBlock(id: index, kind: .paragraph, text: line))
            }
        }
        return result
    }

    static func inline(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}

struct MarkdownView: View {
    private let blocks: [MarkdownBlock]

    init(source: String) {
        self.blocks = MarkdownParser.blocks(from: source)
    }

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 6) {
            ForEach(blocks) { block in
                blockView(block)
            }
        }
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock) -> some View {
        switch block.kind {
        case .blank:
            Color.clear.frame(height: 2)
        case .heading1:
            Text(MarkdownParser.inline(block.text))
                .font(.title3.bold())
                .padding(.top, 6)
        case .heading2:
            Text(MarkdownParser.inline(block.text))
                .font(.headline)
                .padding(.top, 4)
        case .heading3:
            Text(MarkdownParser.inline(block.text))
                .font(.subheadline.weight(.semibold))
                .padding(.top, 2)
        case .bullet:
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("\u{2022}")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Text(MarkdownParser.inline(block.text))
                    .font(.subheadline)
            }
        case .paragraph:
            Text(MarkdownParser.inline(block.text))
                .font(.subheadline)
        }
    }
}
