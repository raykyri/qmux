import AppKit

@MainActor
protocol ApplicationActivationClient {
    var isActive: Bool { get }
    var bundleURL: URL? { get }
    func requestActivation() -> Bool
    func reopenApplication(at url: URL, completion: @escaping @MainActor (String?) -> Void)
}

@MainActor
final class ApplicationActivation {
    static let shared = ApplicationActivation(client: WorkspaceApplicationActivationClient())

    private let client: any ApplicationActivationClient
    private var reopenPending = false

    init(client: any ApplicationActivationClient) {
        self.client = client
    }

    /// Returns whether activation was accepted or recovery was scheduled.
    /// Neither result guarantees that activation has completed yet.
    func activate() -> Bool {
        if client.isActive || reopenPending {
            return true
        }

        // AppKit can reuse an old hotkey event's timestamp when activating.
        // WindowServer then rejects every attempt as an expired request, even
        // after normal input resumes. NSApp.activate() shares that event path.
        // Reopen the current bundle through Launch Services to recover without
        // touching AppKit's private event state or restarting terminal sessions.
        // Use this path for every explicit restore of an inactive bundled app:
        // an activation API's success result need not mean it gained focus.
        guard let url = client.bundleURL, url.pathExtension == "app" else {
            // A cargo-run development executable is not a launchable app bundle.
            return client.requestActivation()
        }
        reopenPending = true
        client.reopenApplication(at: url) { [weak self] error in
            self?.reopenPending = false
            if let error {
                NSLog("qmux: failed to recover application activation: %@", error)
            }
        }
        return true
    }
}

@MainActor
private struct WorkspaceApplicationActivationClient: ApplicationActivationClient {
    var isActive: Bool { NSApp.isActive }
    var bundleURL: URL? { NSRunningApplication.current.bundleURL }

    func requestActivation() -> Bool {
        NSRunningApplication.current.activate(options: [])
    }

    func reopenApplication(at url: URL, completion: @escaping @MainActor (String?) -> Void) {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        configuration.createsNewApplicationInstance = false
        configuration.allowsRunningApplicationSubstitution = false
        configuration.addsToRecentItems = false
        configuration.promptsUserIfNeeded = false
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, error in
            let message = error?.localizedDescription
            Task { @MainActor in completion(message) }
        }
    }
}
