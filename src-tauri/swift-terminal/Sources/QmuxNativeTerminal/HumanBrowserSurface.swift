import AppKit

/// Called only on the main actor. A hidden browser has no drawable area; a
/// retired browser is detached before Rust releases its Tauri handle.
@MainActor
func applyHumanBrowserSurface(
    _ view: NSView,
    rect: CGRect,
    visible: Bool,
    retire: Bool
) -> Bool {
    if !visible {
        view.isHidden = true
        view.setFrameSize(.zero)
        if retire {
            view.removeFromSuperview()
        }
        return view.isHidden && view.frame.size == .zero && (!retire || view.superview == nil)
    }
    guard !retire, let parent = view.superview, view.window != nil,
          rect.width >= 1, rect.height >= 1
    else { return false }
    let y = parent.isFlipped ? rect.minY : parent.bounds.height - rect.minY - rect.height
    let frame = CGRect(x: rect.minX, y: y, width: rect.width, height: rect.height)
    view.frame = frame
    view.isHidden = false
    return !view.isHidden && view.frame == frame
}
