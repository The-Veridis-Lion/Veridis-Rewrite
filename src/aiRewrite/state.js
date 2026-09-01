// Owns the in-memory AI Rewrite task/debug/application runtime state; it does not own generation or apply behavior.
export const aiRewriteState = {
    activeController: null,
    activeTask: null,
    statusToast: null,
    statusTask: null,
    statusDismissedTask: null,
    debugEvents: [],
    criticalDebugEvents: [],
    runningTask: null,
    finalCleanseSequence: 0,
    finalCleanseByMessageKey: new Map(),
    pendingApply: null,
};
