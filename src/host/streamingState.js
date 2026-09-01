// Owns the shared runtime identity of the active streaming generation and its committed-message source cache.
export const streamingRuntimeState = {
    isStreamingGeneration: false,
    streamingCommittedMessageCache: new Map(),
};
