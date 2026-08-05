import Foundation

// MARK: - Lenient decoding helpers
//
// Every field in the backend payloads may be absent or null; these helpers make
// decoding tolerant of missing keys, nulls, and (for ids) numeric-vs-string drift.

extension KeyedDecodingContainer {
    /// Decodes a value if present and well-typed, otherwise returns nil.
    func lenient<T: Decodable>(_ type: T.Type, _ key: Key) -> T? {
        (try? decodeIfPresent(T.self, forKey: key)) ?? nil
    }

    /// Decodes an array if present, otherwise returns [].
    func lenientArray<T: Decodable>(_ type: T.Type, _ key: Key) -> [T] {
        lenient([T].self, key) ?? []
    }

    /// Decodes an id that may arrive as a string or a number.
    func idString(_ key: Key) -> String {
        if let s = lenient(String.self, key) { return s }
        if let i = lenient(Int.self, key) { return String(i) }
        return UUID().uuidString
    }
}

// MARK: - Overview

struct Overview: Decodable {
    var waiting: [TaskCard] = []
    var processing: ProcessingInfo?
    var inPlay: [FollowupCard] = []
    var sent: [TaskCard] = []

    enum CodingKeys: String, CodingKey { case waiting, processing, inPlay, sent }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        waiting = c.lenientArray(TaskCard.self, .waiting)
        processing = c.lenient(ProcessingInfo.self, .processing)
        inPlay = c.lenientArray(FollowupCard.self, .inPlay)
        sent = c.lenientArray(TaskCard.self, .sent)
    }

    var processingCount: Int { processing?.count ?? 0 }
    var isEmpty: Bool { waiting.isEmpty && inPlay.isEmpty && sent.isEmpty }
}

struct ProcessingInfo: Decodable, Hashable {
    var count: Int = 0

    enum CodingKeys: String, CodingKey { case count }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        count = c.lenient(Int.self, .count) ?? 0
    }
}

// MARK: - Cards

struct TaskCard: Identifiable, Decodable, Hashable {
    let id: String
    let company: String?
    let title: String?
    let state: String?
    let priority: Int
    let priorityLabel: String?
    let dueDate: String?
    let url: String?
    let openFollowups: Int

    enum CodingKeys: String, CodingKey {
        case id, company, title, state, priority, priorityLabel, dueDate, url, openFollowups
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.idString(.id)
        company = c.lenient(String.self, .company)
        title = c.lenient(String.self, .title)
        state = c.lenient(String.self, .state)
        priority = c.lenient(Int.self, .priority) ?? 0
        priorityLabel = c.lenient(String.self, .priorityLabel)
        dueDate = c.lenient(String.self, .dueDate)
        url = c.lenient(String.self, .url)
        openFollowups = c.lenient(Int.self, .openFollowups) ?? 0
    }
}

struct FollowupCard: Identifiable, Decodable, Hashable {
    let id: String
    let taskId: String?
    let kind: String?
    let kindLabel: String?
    let title: String?
    let state: String?
    let stateLabel: String?
    let dueDate: String?
    let company: String?

    enum CodingKeys: String, CodingKey {
        case id, taskId, kind, kindLabel, title, state, stateLabel, dueDate, company
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.idString(.id)
        taskId = c.lenient(String.self, .taskId)
        kind = c.lenient(String.self, .kind)
        kindLabel = c.lenient(String.self, .kindLabel)
        title = c.lenient(String.self, .title)
        state = c.lenient(String.self, .state)
        stateLabel = c.lenient(String.self, .stateLabel)
        dueDate = c.lenient(String.self, .dueDate)
        company = c.lenient(String.self, .company)
    }
}

// MARK: - Task detail

struct TaskDetailResponse: Decodable {
    var task = TaskInfo()
    var description: String?
    var questions: [Question] = []
    var followups: [FollowupCard] = []
    var timeline: [TimelineEvent] = []

    enum CodingKeys: String, CodingKey { case task, description, questions, followups, timeline }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        task = c.lenient(TaskInfo.self, .task) ?? TaskInfo()
        description = c.lenient(String.self, .description)
        questions = c.lenientArray(Question.self, .questions)
        followups = c.lenientArray(FollowupCard.self, .followups)
        timeline = c.lenientArray(TimelineEvent.self, .timeline)
    }
}

struct TaskInfo: Decodable, Hashable {
    var id: String = ""
    var state: String?
    var priority: Int = 0
    var priorityLabel: String?
    var dueDate: String?
    var notes: String?
    var url: String?
    var company: String?
    var title: String?
    var createdAt: String?
    var updatedAt: String?

    init() {}

    enum CodingKeys: String, CodingKey {
        case id, state, priority, priorityLabel, dueDate, notes, url, company, title, createdAt, updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.idString(.id)
        state = c.lenient(String.self, .state)
        priority = c.lenient(Int.self, .priority) ?? 0
        priorityLabel = c.lenient(String.self, .priorityLabel)
        dueDate = c.lenient(String.self, .dueDate)
        notes = c.lenient(String.self, .notes)
        url = c.lenient(String.self, .url)
        company = c.lenient(String.self, .company)
        title = c.lenient(String.self, .title)
        createdAt = c.lenient(String.self, .createdAt)
        updatedAt = c.lenient(String.self, .updatedAt)
    }
}

struct Question: Identifiable, Decodable, Hashable {
    let id: String
    let label: String?
    let type: String?
    let isRequired: Bool
    let status: String?
    let value: String?
    let source: String?

    enum CodingKeys: String, CodingKey {
        case id, label, type, status, value, source
        case isRequired = "required"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.idString(.id)
        label = c.lenient(String.self, .label)
        type = c.lenient(String.self, .type)
        isRequired = c.lenient(Bool.self, .isRequired) ?? false
        status = c.lenient(String.self, .status)
        value = c.lenient(String.self, .value)
        source = c.lenient(String.self, .source)
    }

    var isResolved: Bool { status?.lowercased() == "resolved" }
}

struct TimelineEvent: Identifiable, Decodable, Hashable {
    let id: UUID
    let type: String?
    let at: String?
    let summary: String?

    enum CodingKeys: String, CodingKey { case type, at, summary }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = UUID()
        type = c.lenient(String.self, .type)
        at = c.lenient(String.self, .at)
        summary = c.lenient(String.self, .summary)
    }
}

// MARK: - Followup detail

struct FollowupDetailResponse: Decodable {
    var followup = FollowupInfo()
    var task: TaskRef?

    enum CodingKeys: String, CodingKey { case followup, task }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        followup = c.lenient(FollowupInfo.self, .followup) ?? FollowupInfo()
        task = c.lenient(TaskRef.self, .task)
    }
}

struct FollowupInfo: Decodable, Hashable {
    var id: String = ""
    var taskId: String?
    var kind: String?
    var kindLabel: String?
    var title: String?
    var state: String?
    var stateLabel: String?
    var dueDate: String?
    var url: String?
    var notes: String?
    var sourceBody: String?

    init() {}

    enum CodingKeys: String, CodingKey {
        case id, taskId, kind, kindLabel, title, state, stateLabel, dueDate, url, notes, sourceBody
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.idString(.id)
        taskId = c.lenient(String.self, .taskId)
        kind = c.lenient(String.self, .kind)
        kindLabel = c.lenient(String.self, .kindLabel)
        title = c.lenient(String.self, .title)
        state = c.lenient(String.self, .state)
        stateLabel = c.lenient(String.self, .stateLabel)
        dueDate = c.lenient(String.self, .dueDate)
        url = c.lenient(String.self, .url)
        notes = c.lenient(String.self, .notes)
        sourceBody = c.lenient(String.self, .sourceBody)
    }
}

struct TaskRef: Decodable, Hashable {
    var id: String = ""
    var company: String?
    var title: String?

    enum CodingKeys: String, CodingKey { case id, company, title }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.idString(.id)
        company = c.lenient(String.self, .company)
        title = c.lenient(String.self, .title)
    }
}
