/// Semantic ABI shared with Rust's web_pointer_claim_mode. The frontend knows
/// whether a claim covers one drag or a mounted overlay; ambient mouse buttons
/// cannot distinguish a menu opened during a press from the drag itself.
enum TerminalWebPointerClaim: Int32 {
    case released = 0
    case gesture = 1
    case overlay = 2

    mutating func retireGesture() {
        if self == .gesture { self = .released }
    }

    /// The terminating release still belongs to the web gesture, even though
    /// subsequent events should return to normal hit-testing. Overlays survive
    /// every pointer-up until their DOM owner explicitly releases them.
    mutating func routeToWeb(isPointerUp: Bool) -> Bool {
        guard self != .released else { return false }
        if isPointerUp { retireGesture() }
        return true
    }
}
