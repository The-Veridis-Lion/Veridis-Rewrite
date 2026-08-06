import { buildSimpleWildcardPattern, compileRegexTarget } from './utils.js';

const maxCandidateCount = 10;

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
    let score = 0;

    for (const target of targets) {
        const value = normalizeText(target);
        if (!value) continue;
        if (deletedText && value === deletedText) {
            score = Math.max(score, 100);
            addReason(reasons, '查找词与删除文本相同');
        } else if (clickedText && value === clickedText) {
            score = Math.max(score, 92);
            addReason(reasons, '查找词与点击文本相同');
        } else if (deletedText && deletedText.includes(value)) {
            score = Math.max(score, 82);
            addReason(reasons, '查找词包含在删除文本中');
        } else if (deletedText && value.includes(deletedText)) {
            score = Math.max(score, 72);
            addReason(reasons, '删除文本包含在查找词中');
        } else if (oldContext.includes(value)) {
            score = Math.max(score, 52);
            addReason(reasons, '查找词出现在前后文');
        }
    }

    return score;
}

function scoreSimpleRule(targets = [], change = {}, reasons = []) {
    const deletedText = normalizeText(change.deletedText || change.beforeText || '');
    const clickedText = normalizeText(change.clickedText || '');
    const oldContext = String(change.oldContext || '');
    let score = 0;

    for (const target of targets) {
        const regex = compileSimpleTarget(target);
        if (!regex) continue;
        if (deletedText && safeRegexTest(regex, deletedText)) {
            score = Math.max(score, 88);
            addReason(reasons, '简易规则命中删除文本');
        } else if (clickedText && safeRegexTest(regex, clickedText)) {
            score = Math.max(score, 80);
            addReason(reasons, '简易规则命中点击文本');
        } else if (oldContext && safeRegexTest(regex, oldContext)) {
            score = Math.max(score, 62);
            addReason(reasons, '简易规则命中前后文');
        }
    }

    return score;
}

function scoreRegexRule(targets = [], change = {}, reasons = []) {
    const deletedText = normalizeText(change.deletedText || change.beforeText || '');
    const clickedText = normalizeText(change.clickedText || '');
    const oldContext = String(change.oldContext || '');
    let score = 0;

    for (const target of targets) {
        const compiled = compileRegexTarget(target);
        if (!compiled.ok) continue;
        const regex = compiled.value.regex;
        if (oldContext && safeRegexTest(regex, oldContext)) {
            score = Math.max(score, 92);
            addReason(reasons, '正则命中前后文');
        } else if (deletedText && safeRegexTest(regex, deletedText)) {
            score = Math.max(score, 74);
            addReason(reasons, '正则命中删除文本');
        } else if (clickedText && safeRegexTest(regex, clickedText)) {
            score = Math.max(score, 68);
            addReason(reasons, '正则命中点击文本');
        }
    }

    return score;
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
            let score = 0;

            if (mode === 'regex') score = scoreRegexRule(targets, change, reasons);
            else if (mode === 'simple') score = scoreSimpleRule(targets, change, reasons);
            else score = scoreTextRule(targets, change, reasons);

            score += scoreReplacementHit(replacements, change, reasons);
            if (score <= 0) return;
            candidates.push(makeCandidate(rule, sub, ruleIndex, subRuleIndex, score, reasons));
        });
    });

    return candidates
        .sort((a, b) => b.score - a.score || a.ruleIndex - b.ruleIndex || a.subRuleIndex - b.subRuleIndex)
        .slice(0, maxCount);
}
