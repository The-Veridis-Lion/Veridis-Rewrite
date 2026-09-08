// Host pre-finalization gate, written only by lifecycleEvents.js; not token activity or AI task lifetime.
// Opens on a tracked generation start or host stream token; closes on accepted finalization or host end/stop.
// Frame data belongs to generationLifecycle.js.
export const streamingRuntimeState = {
    isStreamingGeneration: false,
};
