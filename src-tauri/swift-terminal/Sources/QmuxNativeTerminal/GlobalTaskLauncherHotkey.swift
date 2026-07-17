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
        timer.schedule(deadline: .now(), repeating: .milliseconds(20), leeway: .milliseconds(4))
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
            return
        }
        guard !isDown && targetDown else { return }
        targetDown = false
        guard !contaminated && otherFlags.isEmpty else {
            resetTap()
            return
        }

        let now = ProcessInfo.processInfo.systemUptime
        if let lastTapAt, now - lastTapAt <= 0.36 {
            resetTap()
            globalTaskLauncherDidTrigger()
        } else {
            lastTapAt = now
            contaminated = false
        }
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
