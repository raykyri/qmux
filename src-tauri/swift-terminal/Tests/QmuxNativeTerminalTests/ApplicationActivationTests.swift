import Foundation
import Testing
@testable import QmuxNativeTerminal

@MainActor
struct ApplicationActivationTests {
    @Test
    func `an unbundled development app uses direct activation`() {
        let client = FakeActivationClient()
        client.bundleURL = nil
        let activation = ApplicationActivation(client: client)
        #expect(activation.activate())
        #expect(client.requests == 1)
        #expect(client.reopenedURLs.isEmpty)
    }

    @Test
    func `an active app needs no activation request`() {
        let client = FakeActivationClient()
        client.isActive = true
        #expect(ApplicationActivation(client: client).activate())
        #expect(client.requests == 0)
        #expect(client.reopenedURLs.isEmpty)
    }

    @Test
    func `an inactive bundled app reopens once without using stale event activation`() {
        let client = FakeActivationClient()
        let activation = ApplicationActivation(client: client)
        #expect(activation.activate())
        #expect(activation.activate())
        #expect(client.requests == 0)
        #expect(client.reopenedURLs == [client.bundleURL!])

        client.isActive = true
        client.completion?(nil)
        #expect(activation.activate())
        #expect(client.requests == 0)
    }

    @Test
    func `a failed reopen allows a later user request to retry`() {
        let client = FakeActivationClient()
        client.acceptsActivation = false
        let activation = ApplicationActivation(client: client)
        #expect(activation.activate())
        client.completion?("Launch Services refused the request")
        #expect(activation.activate())
        #expect(client.requests == 0)
        #expect(client.reopenedURLs.count == 2)
    }

    @Test(arguments: [nil, URL(fileURLWithPath: "/tmp/qmux/target/debug")])
    func `an unbundled executable is not reopened`(url: URL?) {
        let client = FakeActivationClient()
        client.acceptsActivation = false
        client.bundleURL = url
        #expect(!ApplicationActivation(client: client).activate())
        #expect(client.reopenedURLs.isEmpty)
    }
}

@MainActor
private final class FakeActivationClient: ApplicationActivationClient {
    var isActive = false
    var bundleURL: URL? = URL(fileURLWithPath: "/Applications/qmux.app")
    var acceptsActivation = true
    var requests = 0
    var reopenedURLs: [URL] = []
    var completion: (@MainActor (String?) -> Void)?

    func requestActivation() -> Bool {
        requests += 1
        return acceptsActivation
    }

    func reopenApplication(at url: URL, completion: @escaping @MainActor (String?) -> Void) {
        reopenedURLs.append(url)
        self.completion = completion
    }
}
