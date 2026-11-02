export interface AgentTypingUpdate {
  agentId: string;
  typing: boolean;
  document: string;
  sequence: number;
}

// Sequence is allocated before awaiting the document handshake. Concurrent IPC
// can execute in any order without reversing the order of the user's input.
export function createAgentTypingReporter<T>(
  readDocument: () => Promise<string>,
  send: (update: AgentTypingUpdate) => Promise<T>,
): (agentId: string, typing: boolean) => Promise<T> {
  let document: Promise<string> | undefined;
  let sequence = 0;
  return async (agentId, typing) => {
    const updateSequence = ++sequence;
    const requestDocument = document ??= readDocument();
    try {
      return await send({
        agentId,
        typing,
        document: await requestDocument,
        sequence: updateSequence,
      });
    } catch (error) {
      // Retry ownership on the NEXT input after a failed handshake or navigation
      // invalidation (e.g. a native reload attempt that failed). Do not replay a
      // stale update automatically. The server lease recovers a lost release.
      if (document === requestDocument) document = undefined;
      throw error;
    }
  };
}
