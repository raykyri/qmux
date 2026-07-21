// Cross-component channel for moving the transcript to a specific message.
// TurnPaneHeader is created in App.tsx and handed to TurnOverlay as an opaque
// `header` prop, so the menu that requests a jump has no path to the scroll
// container that performs it. A window event bridges them the same way
// `qmux:composer-insert` bridges the prompt library to the composer.

const SCROLL_TO_MESSAGE_EVENT = "qmux:scroll-to-message";

interface ScrollToMessageDetail {
  agentId: string;
  messageKey: string;
}

/** Asks the transcript bound to `agentId` to bring `messageKey` into view. */
export function requestScrollToMessage(agentId: string, messageKey: string) {
  window.dispatchEvent(
    new CustomEvent<ScrollToMessageDetail>(SCROLL_TO_MESSAGE_EVENT, {
      detail: { agentId, messageKey },
    }),
  );
}

/** Subscribes a transcript to jump requests; returns the unsubscribe function. */
export function listenToScrollToMessage(
  agentId: string,
  onScroll: (messageKey: string) => void,
): () => void {
  const handler = (event: Event) => {
    const { detail } = event as CustomEvent<ScrollToMessageDetail>;
    if (detail?.agentId === agentId && typeof detail.messageKey === "string") {
      onScroll(detail.messageKey);
    }
  };
  window.addEventListener(SCROLL_TO_MESSAGE_EVENT, handler);
  return () => window.removeEventListener(SCROLL_TO_MESSAGE_EVENT, handler);
}
