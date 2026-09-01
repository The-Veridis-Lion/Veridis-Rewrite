import { buildSimpleWildcardPattern, compileRegexTarget } from '../rules/regex.js';

const maxCandidateCount = 10;

// Ranking is intentionally tiered: a match at the selected source range is
// evidence of the change, while a context hit is only a discovery fallback.
const evidenceStrength = Object.freeze({
    context: 10,
    clicked: 30,
    deleted: 40,
    local: 60,
    exactClicked: 70,
    exactDeleted: 80,
});

function normalizeText(value = '') {
    return String(value ?? '').trim();
}

function addReason(reasons, reason) {
    if (reason && !reasons.includes(reason)) reasons.push(reason);
}

function safeRegexTest(regex, text = '') {
    if (!regex || !text) return false;
    try {
        regex.lastIndex = 0;
        const matched = regex.test(text);
        regex.lastIndex = 0;
        return matched;
    } catch (_err) {
        return false;
    }
}

function safeRegexFullMatch(regex, text = '') {
    if (!regex || !text) return false;
    try {
        const flags = regex.flags.replace(/[gmy]/g, '');
        const fullRegex = new RegExp(`^(?:${regex.source})$`, flags);
        const match = fullRegex.exec(text);
        return Boolean(match && match[0].length === text.length);
    } catch (_err) {
        return false;
    }
}

function getSelectedOldRange(change = {}) {
    const source = change.oldSourceText || change.sourceText || change.oldText;
    const start = Number(change.oldStart);
    const end = Number(change.oldEnd);
    if (typeof source !== 'string' || !Number.isFinite(start) || !Number.isFinite(end)) return null;
    return {
        source,
        start: Math.max(0, Math.min(source.length, start)),
        end: Math.max(0, Math.min(source.length, Math.max(start, end))),
    };
}

function regexOverlapsSelectedOldRange(regex, change = {}) {
    const selected = getSelectedOldRange(change);
    if (!selected) return false;
    try {
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(selected.source)) !== null) {
            const matchStart = match.index;
            const matchEnd = match.index + match[0].length;
            const overlaps = selected.start === selected.end
                ? matchStart <= selected.start && matchEnd >= selected.start
                : matchStart < selected.end && matchEnd > selected.start;
            if (overlaps) {
                regex.lastIndex = 0;
                return true;
            }
            if (match[0].length === 0) regex.lastIndex++;
        }
    } catch (_err) {
        // Invalid or otherwise unsafe candidates are simply not local evidence.
    }
    regex.lastIndex = 0;
    return false;
}

function scoreEvidence(strength, score, reasons) {
    return { strength, score, reasons };
}

function chooseStrongerEvidence(current, candidate) {
    if (candidate.strength > current.strength
        || (candidate.strength === current.strength && candidate.score > current.score)) {
        return candidate;
    }
    return current;
}

function compileSimpleTarget(target = '') {
    try {
        let escaped = String(target).replace(/[.+^$()[\]\\]/g, '\\$&');
        escaped = escaped.replace(/\{([^}]+)\}/g, (_match, group) => {
            return '(?:' + group.split(',').map(s => s.trim()).join('|') + ')';
        });
        escaped = escaped.replace(/\*/g, buildSimpleWildcardPattern());
        const regex = new RegExp(escaped, 'gmu');
        if (regex.test('')) return null;
        regex.lastIndex = 0;
        return regex;
    } catch (_err) {
        return null;
    }
}

function getModeLabel(mode = 'text') {
    if (mode === 'regex') return '正则';
    if (mode === 'simple') return '简易';
    return '普通';
}

function makeCandidate(rule, sub, ruleIndex, subRuleIndex, score, reasons) {
    return {
        ruleIndex,
        subRuleIndex,
        score,
        reasons,
        groupName: String(rule?.name || `合集 ${ruleIndex + 1}`),
        mode: String(sub?.mode || 'text'),
        modeLabel: getModeLabel(sub?.mode || 'text'),
        remark: String(sub?.remark || ''),
        targets: Array.isArray(sub?.targets) ? sub.targets.slice(0, 3).map(v => String(v)) : [],
        replacements: Array.isArray(sub?.replacements) ? sub.replacements.slice(0, 3).map(v => String(v)) : [],
    };
}

function scoreReplacementHit(replacements = [], change = {}, reasons = []) {
    const insertedText = normalizeText(change.insertedText || change.afterText || '');
    const newContext = String(change.newContext || '');
    let score = 0;
    for (const replacement of replacements) {
        const value = normalizeText(replacement);
        if (!value) continue;
        if (insertedText && value === insertedText) {
            score = Math.max(score, 34);
            addReason(reasons, '替换结果精确命中');
        } else if (insertedText && (insertedText.includes(value) || value.includes(insertedText))) {
            score = Math.max(score, 24);
            addReason(reasons, '替换结果相近');
        } else if (newContext.includes(value)) {
            score = Math.max(score, 14);
            addReason(reasons, '替换结果出现在上下文');
        }
    }
    return score;
}

function scoreTextRule(targets = [], change = {}, reasons = []) {
    const deletedText = normalizeText(change.deletedText || change.beforeText || '');
    const clickedText = normalizeText(change.clickedText || '');
    const oldContext = String(change.oldContext || '');
    let best = scoreEvidence(0, 0, reasons);

    for (const target of targets) {
        const value = normalizeText(target);
        if (!value) continue;
        if (deletedText && value === deletedText) {
            best = chooseStrongerEvidence(best, scoreEvidence(evidenceStrength.exactDeleted, 100, reasons));
            addReason(reasons, '查找词与删除文本相同');
        } else if (clickedText && value === clickedText) {
            best = chooseStrongerEvidence(best, scoreEvidence(evidenceStrength.exactClicked, 92, reasons));
            addReason(reasons, '查找词与点击文本相同');
        } else if (deletedText && deletedText.includes(value)) {
            best = chooseStrongerEvidence(best, scoreEvidence(evidenceStrength.deleted, 82, reasons));
            addReason(reasons, '查找词包含在删除文本中');
        } else if (deletedText && value.includes(deletedText)) {
            best = chooseStrongerEvidence(best, scoreEvidence(evidenceStrength.deleted, 72, reasons));
            addReason(reasons, '删除文本包含在查找词中');
        } else if (oldContext.includes(value)) {
            best = chooseStrongerEvidence(best, scoreEvidence(evidenceStrength.context, 20, reasons));
            addReason(reasons, '查找词出现在前后文');
        }
    }

    return best;
}

function scoreSimpleRule(targets = [], change = {}, reasons = []) {
    const deletedText = normalizeText(change.deletedText || change.beforeText || '');
    const clickedText = normalizeText(change.clickedText || '');
    const oldContext = String(change.oldContext || '');
    let best = scoreEvidence(0, 0, reasons);

    for (const target of targets) {
        const regex = compileSimpleTarget(target);
        if (!regex) continue;
        if (regexOverlapsSelectedOldRange(regex, change)) {
            best = chooseStrongerEvidence(best, scoreEvidence(evidenceStrength.local, 96, reasons));
            addReason(reasons, '简易规则命中选中差异范围');
        } else if (deletedText && safeRegexFullMatch(regex, deletedText)) {
            best = chooseStrongerEvidence(best, scoreEvidence(evidenceStrength.exactDeleted, 100, reasons));
            addReason(reasons, '简易规则精确命中删除文本');
        } else if (clickedText && safeRegexFullMatch(regex, clickedText)) {
            best = chooseStrongerEvidence(best, scoreEvidence(evidenceStrength.exactClicked, 92, reasons));
            addReason(reasons, '简易规则精确命中点击文本');
        } else if (deletedText && safeRegexTest(regex, deletedText)) {
            best = chooseStrongerEvidence(best, scoreEvidence(evidenceStrength.deleted, 88, reasons));
            addReason(reasons, '简易规则命中删除文本');
        } else if (clickedText && safeRegexTest(regex, clickedText)) {
            best = chooseStrongerEvidence(best, scoreEvidence(evidenceStrength.clicked, 80, reasons));
            addReason(reasons, '简易规则命中点击文本');
        } else if (oldContext && safeRegexTest(regex, oldContext)) {
            best = chooseStrongerEvidence(best, scoreEvidence(evidenceStrength.context, 20, reasons));
            addReason(reasons, '简易规则命中前后文');
        }
    }

    return best;
}

function scoreRegexRule(targets = [], change = {}, reasons = []) {
    const deletedText = normalizeText(change.deletedText || change.beforeText || '');
    const clickedText = normalizeText(change.clickedText || '');
    const oldContext = String(change.oldContext || '');
    let best = scoreEvidence(0, 0, reasons);

    for (const target of targets) {
        const compiled = compileRegexTarget(target);
        if (!compiled.ok) continue;
        const regex = compiled.value.regex;
        if (regexOverlapsSelectedOldRange(regex, change)) {
            best = chooseStrongerEvidence(best, scoreEvidence(evidenceStrength.local, 96, reasons));
            addReason(reasons, '正则命中选中差异范围');
        } else if (deletedText && safeRegexTest(regex, deletedText)) {
            best = chooseStrongerEvidence(best, scoreEvidence(evidenceStrength.deleted, 74, reasons));
            addReason(reasons, '正则命中删除文本');
        } else if (clickedText && safeRegexTest(regex, clickedText)) {
            best = chooseStrongerEvidence(best, scoreEvidence(evidenceStrength.clicked, 68, reasons));
            addReason(reasons, '正则命中点击文本');
        } else if (oldContext && safeRegexTest(regex, oldContext)) {
            best = chooseStrongerEvidence(best, scoreEvidence(evidenceStrength.context, 20, reasons));
            addReason(reasons, '正则命中前后文');
        }
    }

    return best;
}

export function findRelatedRulesForDiffChange(change = {}, rules = [], options = {}) {
    const maxCount = Number.isFinite(Number(options.maxCount)) ? Math.max(1, Number(options.maxCount)) : maxCandidateCount;
    const candidates = [];

    (Array.isArray(rules) ? rules : []).forEach((rule, ruleIndex) => {
        if (!rule || rule.enabled === false) return;
        const subRules = Array.isArray(rule.subRules) ? rule.subRules : [];
        subRules.forEach((sub, subRuleIndex) => {
            if (!sub || sub.enabled === false) return;
            const targets = Array.isArray(sub.targets) ? sub.targets : [];
            const replacements = Array.isArray(sub.replacements) ? sub.replacements : [];
            const reasons = [];
            const mode = sub.mode || 'text';
            let evidence = scoreEvidence(0, 0, reasons);

            if (mode === 'regex') evidence = scoreRegexRule(targets, change, reasons);
            else if (mode === 'simple') evidence = scoreSimpleRule(targets, change, reasons);
            else evidence = scoreTextRule(targets, change, reasons);

            const replacementScore = scoreReplacementHit(replacements, change, reasons);
            if (evidence.strength <= 0 && replacementScore <= 0) return;
            candidates.push({
                ...makeCandidate(rule, sub, ruleIndex, subRuleIndex, evidence.score + replacementScore, reasons),
                evidenceStrength: evidence.strength,
                replacementScore,
            });
        });
    });

    return candidates
        .sort((a, b) => b.evidenceStrength - a.evidenceStrength
            || b.replacementScore - a.replacementScore
            || b.score - a.score
            || a.ruleIndex - b.ruleIndex
            || a.subRuleIndex - b.subRuleIndex)
        .slice(0, maxCount);
}
