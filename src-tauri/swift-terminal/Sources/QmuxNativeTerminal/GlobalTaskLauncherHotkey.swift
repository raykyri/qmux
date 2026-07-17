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
        timer.setEventHandler { @MainActor [weak self] in
            self?.sampleModifiers()
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
