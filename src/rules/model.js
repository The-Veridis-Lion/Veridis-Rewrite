// Rule/input semantics only; no execution or persistence.

export function normalizeRuleActivationWarning(value = '') {
    return String(value ?? '').trim();
}

export function getRuleActivationWarning(rule) {
    return normalizeRuleActivationWarning(rule?.activationWarning);
}

export function isRuleActivationWarningEnabled(rule) {
    return getRuleActivationWarning(rule) !== '' && rule?.activationWarningEnabled === true;
}

export function normalizeRuleActivationSafety(rule, options = {}) {
    const next = rule && typeof rule === 'object' && !Array.isArray(rule)
        ? { ...rule }
        : {};
    const activationWarning = getRuleActivationWarning(next);
    const activationWarningEnabled = activationWarning !== '' && next.activationWarningEnabled === true;

    if (activationWarning) {
        next.activationWarning = activationWarning;
        next.activationWarningEnabled = activationWarningEnabled;
        if (activationWarningEnabled && (options.resetRiskyEnabled === true || next.enabled === undefined)) {
            next.enabled = false;
        } else if (next.enabled === undefined) {
            next.enabled = true;
        }
    } else {
        delete next.activationWarning;
        delete next.activationWarningEnabled;
        if (next.enabled === undefined) next.enabled = true;
    }

    return next;
}

export function buildRuleActivationConfirmMessage(rules) {
    return [...new Set(
        (Array.isArray(rules) ? rules : [rules])
            .filter(isRuleActivationWarningEnabled)
            .map(getRuleActivationWarning)
            .filter(Boolean)
    )].join('\n\n');
}

export function parseInputToWords(text, mode = 'text', options = {}) {
    if (!text) return [];
    const isTarget = options.isTarget !== false;
    if (mode === 'regex' || mode === 'simple') {
        const words = text.split('\n').map(w => w.trim());
        return isTarget ? words.filter(w => w) : words;
    }
    const noQuotes = text.replace(/['\"‘’”“”]/g, ' ');
    const textWords = isTarget
        ? noQuotes.split(/[\s,，、\n]+/)
        : noQuotes.split(/[,\n，、]/);
    const words = textWords.map(w => w.trim());
    return isTarget ? words.filter(w => w) : words;
}
