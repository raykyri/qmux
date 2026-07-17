@preconcurrency import AppKit
import CoreGraphics

@_silgen_name("qmux_global_task_launcher_did_trigger")
private func globalTaskLauncherDidTrigger()

@MainActor
private final class GlobalTaskLauncherHotkeyMonitor {
    static let shared = GlobalTaskLauncherHotkeyMonitor()

    private var localMonitor: Any?
    private var globalMonitor: Any?
    private var modifierTimer: DispatchSourceTimer?
    private var target: NSEvent.ModifierFlags = []
    private var targetDown = false
    private var contaminated = false
    private var lastTapAt: TimeInterval?
    // System-wide keyDown counters sampled at the start of the current hold and
    // when the first tap was registered. Comparing them at release detects a
    // key pressed during the modifier hold (Option+arrow word navigation, an
    // Option dead-key accent) or typing between the two taps — the false
    // triggers the keyDown monitors miss without Accessibility permission,
    // since those counters are readable without it.
    private var keyPressesAtHoldStart: UInt32 = 0
    private var keyPressesAtLastTap: UInt32 = 0

    private init() {}

    func configure(modifier: Int32) -> Bool {
        removeMonitors()
        target = switch modifier {
        case 1: .control
        case 2: .option
        case 3: .command
        default: []
        }
        resetTap()
        guard !target.isEmpty else { return true }

        localMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) {
            @MainActor [weak self] event in
            self?.noteKeyDown()
            return event
        }
        // Key-down monitoring improves contamination detection when Accessibility
        // access is available, but the modifier taps themselves are polled below
        // and therefore do not require that permission.
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { _ in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    GlobalTaskLauncherHotkeyMonitor.shared.noteKeyDown()
                }
            }
        }
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now(), repeating: .milliseconds(50), leeway: .milliseconds(4))
        // DispatchSource's Swift overlay still expects a plain block at runtime.
        // An explicitly @MainActor handler uses Swift 6's isolated-closure ABI;
        // libswiftDispatch then mistakes its function pointer for that block and
        // crashes in _Block_copy. This source is pinned to the main queue, so
        // enter the actor explicitly from a nonisolated handler instead.
        timer.setEventHandler { [weak self] in
            MainActor.assumeIsolated {
                self?.sampleModifiers()
            }
        }
        modifierTimer = timer
        timer.resume()
        return localMonitor != nil
    }

    private func removeMonitors() {
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
        if let globalMonitor { NSEvent.removeMonitor(globalMonitor) }
        modifierTimer?.cancel()
        localMonitor = nil
        globalMonitor = nil
        modifierTimer = nil
    }

    private func noteKeyDown() {
        contaminated = true
        lastTapAt = nil
    }

    private func sampleModifiers() {
        let cgFlags = CGEventSource.flagsState(.combinedSessionState)
        var deviceFlags: NSEvent.ModifierFlags = []
        if cgFlags.contains(.maskControl) { deviceFlags.insert(.control) }
        if cgFlags.contains(.maskAlternate) { deviceFlags.insert(.option) }
        if cgFlags.contains(.maskCommand) { deviceFlags.insert(.command) }
        if cgFlags.contains(.maskShift) { deviceFlags.insert(.shift) }
        let isDown = deviceFlags.contains(target)
        let otherFlags = deviceFlags.subtracting(target)
        if isDown && !targetDown {
            targetDown = true
            contaminated = !otherFlags.isEmpty
            keyPressesAtHoldStart = systemKeyDownCount()
            return
        }
        guard !isDown && targetDown else { return }
        targetDown = false
        let keyPresses = systemKeyDownCount()
        // Any key pressed while the modifier was held means this was a chord in
        // another app, not a bare tap.
        if keyPresses != keyPressesAtHoldStart {
            contaminated = true
        }
        guard !contaminated && otherFlags.isEmpty else {
            resetTap()
            return
        }

        let now = ProcessInfo.processInfo.systemUptime
        // A genuine double-tap is two bare taps in quick succession with nothing
        // typed in between; a key pressed between the taps rules it out.
        if let lastTapAt, now - lastTapAt <= 0.36, keyPresses == keyPressesAtLastTap {
            resetTap()
            globalTaskLauncherDidTrigger()
        } else {
            lastTapAt = now
            keyPressesAtLastTap = keyPresses
            contaminated = false
        }
    }

    private func systemKeyDownCount() -> UInt32 {
        CGEventSource.counterForEventType(.combinedSessionState, eventType: .keyDown)
    }

    private func resetTap() {
        targetDown = false
        contaminated = false
        lastTapAt = nil
    }
}

// Records the app that was frontmost when the launcher is summoned so it can be
// reactivated on dismissal. A "launch from anywhere" overlay that hides itself
// with the app still activated would otherwise strand the user in qmux's main
// window instead of the app they came from.
@MainActor
private final class GlobalTaskLauncherPreviousApp {
    static let shared = GlobalTaskLauncherPreviousApp()
    private var previous: NSRunningApplication?

    private init() {}

    func capture() {
        let frontmost = NSWorkspace.shared.frontmostApplication
        // If qmux is already frontmost there is nothing to hand focus back to.
        if let frontmost,
            frontmost.processIdentifier != ProcessInfo.processInfo.processIdentifier
        {
            previous = frontmost
        } else {
            previous = nil
        }
    }

    func restore() {
        let target = previous
        previous = nil
        guard let target, !target.isTerminated else { return }
        target.activate(options: [.activateIgnoringOtherApps])
    }
}

private func runOnMain(_ body: @MainActor @escaping () -> Void) {
    if Thread.isMainThread {
        MainActor.assumeIsolated(body)
    } else {
        DispatchQueue.main.sync { MainActor.assumeIsolated(body) }
    }
}

@_cdecl("qmux_global_task_launcher_capture_previous_app")
public func qmuxGlobalTaskLauncherCapturePreviousApp() {
    runOnMain { GlobalTaskLauncherPreviousApp.shared.capture() }
}

@_cdecl("qmux_global_task_launcher_restore_previous_app")
public func qmuxGlobalTaskLauncherRestorePreviousApp() {
    runOnMain { GlobalTaskLauncherPreviousApp.shared.restore() }
}

@_cdecl("qmux_global_task_launcher_set_double_modifier")
public func qmuxGlobalTaskLauncherSetDoubleModifier(_ modifier: Int32) -> Int32 {
    if Thread.isMainThread {
        return MainActor.assumeIsolated {
            GlobalTaskLauncherHotkeyMonitor.shared.configure(modifier: modifier) ? 1 : 0
        }
    }
    return DispatchQueue.main.sync {
        MainActor.assumeIsolated {
            GlobalTaskLauncherHotkeyMonitor.shared.configure(modifier: modifier) ? 1 : 0
        }
    }
}
