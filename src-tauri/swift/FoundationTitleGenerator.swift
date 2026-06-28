import Darwin
import Dispatch
import Foundation
import FoundationModels

private let maxSourceCharacters = 4_000
private let maxTitleCharacters = 80
private let titleGenerationTimeout: DispatchTimeInterval = .milliseconds(7_500)

private struct TitleResponse: Encodable {
    let title: String?
    let error: String?
}

private enum TitleGenerationError: Error, LocalizedError {
    case unavailable(String)
    case emptyTitle
    case missingResult
    case timedOut

    var errorDescription: String? {
        switch self {
        case .unavailable(let reason):
            return "Apple Foundation Models unavailable: \(reason)"
        case .emptyTitle:
            return "Apple Foundation Models returned an empty title"
        case .missingResult:
            return "Apple Foundation Models task finished without a result"
        case .timedOut:
            return "Apple Foundation Models title generation timed out after 7.5 seconds"
        }
    }
}

private final class TitleResultBox: @unchecked Sendable {
    private let lock = NSLock()
    private var storedResult: Result<String, Error>?

    func set(_ result: Result<String, Error>) {
        lock.lock()
        storedResult = result
        lock.unlock()
    }

    func get() -> Result<String, Error>? {
        lock.lock()
        defer { lock.unlock() }
        return storedResult
    }
}

@_cdecl("qmux_generate_foundation_title")
public func qmuxGenerateFoundationTitle(
    _ messagePointer: UnsafePointer<CChar>?
) -> UnsafeMutablePointer<CChar>? {
    guard let messagePointer else {
        return makeResponse(error: "missing message")
    }

    let message = String(cString: messagePointer)
    if #available(macOS 26.0, *) {
        switch generateTitleSynchronously(message) {
        case .success(let title):
            return makeResponse(title: title)
        case .failure(let error):
            return makeResponse(error: describeError(error))
        }
    } else {
        return makeResponse(error: "Apple Foundation Models require macOS 26.0 or newer")
    }
}

@_cdecl("qmux_free_foundation_title")
public func qmuxFreeFoundationTitle(_ pointer: UnsafeMutablePointer<CChar>?) {
    if let pointer {
        free(pointer)
    }
}

@available(macOS 26.0, *)
private func generateTitleSynchronously(_ message: String) -> Result<String, Error> {
    let semaphore = DispatchSemaphore(value: 0)
    let resultBox = TitleResultBox()

    let task = Task.detached {
        do {
            let title = try await generateTitle(message)
            resultBox.set(.success(title))
        } catch {
            resultBox.set(.failure(error))
        }
        semaphore.signal()
    }

    if semaphore.wait(timeout: .now() + titleGenerationTimeout) == .timedOut {
        task.cancel()
        return .failure(TitleGenerationError.timedOut)
    }
    return resultBox.get() ?? .failure(TitleGenerationError.missingResult)
}

@available(macOS 26.0, *)
private func generateTitle(_ message: String) async throws -> String {
    let model = SystemLanguageModel.default
    guard model.isAvailable else {
        throw TitleGenerationError.unavailable(String(describing: model.availability))
    }

    let session = LanguageModelSession(
        model: model,
        instructions: """
        Create concise QMUX terminal tab titles from first user messages.
        Output only the title.
        Use 4-8 words.
        Remove filler words.
        Capture the main technical intent.
        Do not answer the message.
        """
    )
    let source = String(message.prefix(maxSourceCharacters))
    let response = try await session.respond(
        to: """
        User message:
        "\(source)"
        """,
        options: GenerationOptions(maximumResponseTokens: 48)
    )

    guard let title = sanitizeTitle(response.content) else {
        throw TitleGenerationError.emptyTitle
    }
    return title
}

private func sanitizeTitle(_ rawTitle: String) -> String? {
    let squashed = rawTitle
        .replacingOccurrences(
            of: #"\s+"#,
            with: " ",
            options: .regularExpression
        )
        .trimmingCharacters(in: .whitespacesAndNewlines)
    let withoutLabel = squashed.replacingOccurrences(
        of: #"(?i)^title:\s*"#,
        with: "",
        options: .regularExpression
    )
    let unquoted = withoutLabel.trimmingCharacters(
        in: CharacterSet(charactersIn: "\"'` .")
    )
    guard !unquoted.isEmpty else {
        return nil
    }
    if unquoted.count <= maxTitleCharacters {
        return unquoted
    }
    let end = unquoted.index(unquoted.startIndex, offsetBy: maxTitleCharacters - 3)
    return String(unquoted[..<end]).trimmingCharacters(in: .whitespacesAndNewlines) + "..."
}

private func describeError(_ error: Error) -> String {
    var descriptions: [String] = []
    collectErrorDescriptions(error as NSError, into: &descriptions)
    return descriptions.isEmpty ? error.localizedDescription : descriptions.joined(separator: " | ")
}

private func collectErrorDescriptions(_ error: NSError, into descriptions: inout [String]) {
    let description = describeNSError(error)
    if !descriptions.contains(description) {
        descriptions.append(description)
    }

    if let underlyingError = error.userInfo[NSUnderlyingErrorKey] as? NSError {
        collectErrorDescriptions(underlyingError, into: &descriptions)
    }
    if let underlyingErrors = error.userInfo[NSMultipleUnderlyingErrorsKey] as? [NSError] {
        for underlyingError in underlyingErrors {
            collectErrorDescriptions(underlyingError, into: &descriptions)
        }
    }
}

private func describeNSError(_ error: NSError) -> String {
    var parts = ["\(error.domain) code \(error.code)"]
    let description = error.localizedDescription
    if !description.isEmpty {
        parts.append(description)
    }
    if let failureReason = error.localizedFailureReason, !failureReason.isEmpty {
        parts.append(failureReason)
    }
    if let recoverySuggestion = error.localizedRecoverySuggestion, !recoverySuggestion.isEmpty {
        parts.append(recoverySuggestion)
    }
    return parts.joined(separator: ": ")
}

private func makeResponse(title: String? = nil, error: String? = nil) -> UnsafeMutablePointer<CChar>? {
    let response = TitleResponse(title: title, error: error)
    guard
        let data = try? JSONEncoder().encode(response),
        let json = String(data: data, encoding: .utf8)
    else {
        return strdup(#"{"title":null,"error":"failed to encode title response"}"#)
    }
    return strdup(json)
}
