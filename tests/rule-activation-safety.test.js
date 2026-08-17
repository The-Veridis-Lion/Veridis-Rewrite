import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
    buildRuleActivationConfirmMessage,
    getRuleActivationWarning,
    isRuleActivationWarningEnabled,
    normalizeRuleActivationSafety,
} from '../src/utils.js';

test('risk warning text is normalized while its independent switch defaults off', () => {
    const normalized = normalizeRuleActivationSafety({
        activationWarning: '  可能改写前端代码  ',
    });

    assert.equal(normalized.activationWarning, '可能改写前端代码');
    assert.equal(normalized.activationWarningEnabled, false);
    assert.equal(normalized.enabled, true);
    assert.equal(getRuleActivationWarning(normalized), '可能改写前端代码');
    assert.equal(isRuleActivationWarningEnabled(normalized), false);
});

test('import safety reset disables an explicitly enabled risky group', () => {
    const normalized = normalizeRuleActivationSafety({
        activationWarning: '可能改变交互逻辑',
        activationWarningEnabled: true,
        enabled: true,
    }, {
        resetRiskyEnabled: true,
    });

    assert.equal(normalized.enabled, false);
});

test('existing acknowledged group state is preserved outside import normalization', () => {
    const normalized = normalizeRuleActivationSafety({
        activationWarning: '可能改变美化样式',
        activationWarningEnabled: true,
        enabled: true,
    });

    assert.equal(normalized.enabled, true);
});

test('group activation confirmation contains only the editable warning text', () => {
    const message = buildRuleActivationConfirmMessage([
        { activationWarning: '可能改写 JavaScript 的 !!、?? 或 ~~ 运算符', activationWarningEnabled: true },
        { activationWarning: '可能改写 HTML class 或 CSS 选择器', activationWarningEnabled: true },
    ]);

    assert.equal(
        message,
        '可能改写 JavaScript 的 !!、?? 或 ~~ 运算符\n\n可能改写 HTML class 或 CSS 选择器'
    );
});

test('group risk state uses a bare clickable icon beside Open and opens a read-only risk layer', () => {
    const uiSource = fs.readFileSync(new URL('../src/ui.js', import.meta.url), 'utf8');
    const eventsSource = [
        fs.readFileSync(new URL('../src/events.js', import.meta.url), 'utf8'),
        fs.readFileSync(new URL('../src/events/hostLifecycle.js', import.meta.url), 'utf8'),
    ].join('\n');
    const styleSource = [
        '01-foundation.css',
        '02-shell-and-lists.css',
        '03-dialogs-and-diff.css',
        '04-legacy-responsive.css',
        '05-current-shell.css',
        '05-home-page.css',
        '06-current-responsive.css',
        '07-cascade-seal.css',
    ].map((name) => fs.readFileSync(new URL(`../styles/${name}`, import.meta.url), 'utf8')).join('');
    const templateSource = fs.readFileSync(new URL('../templates/purifier.html', import.meta.url), 'utf8');

    assert.doesNotMatch(uiSource, /id="blai-edit-activation-warning"/);
    assert.doesNotMatch(uiSource, /id="blai-modal-sub-activation-warning"/);
    assert.doesNotMatch(uiSource, /id="blai-rule-risk-modal"/);
    assert.match(templateSource, /id="blai-risk-confirm-modal"/);
    assert.match(templateSource, /id="blai-risk-info-modal"/);
    assert.match(templateSource, /id="blai-risk-info-close"[\s\S]*?>知道了<\/button>/);
    assert.doesNotMatch(uiSource, /blai-rule-risk-edit/);
    assert.match(uiSource, /const riskIndicatorHtml = isRuleActivationWarningEnabled\(r\)/);
    assert.match(uiSource, /\$\{riskIndicatorHtml\}[\s\S]*?<button class="[^"]*\bblai-rule-edit\b/);
    assert.match(uiSource, /<i class="[^"]*\bfa-circle-exclamation\b[^"]*\bblai-rule-risk-indicator\b/);
    assert.doesNotMatch(uiSource, /blai-rule-risk-toggle/);
    assert.doesNotMatch(uiSource, /blai-rule-risk-switch/);
    assert.match(uiSource, /<span class="blai-home-enabled-indicator"/);
    assert.doesNotMatch(eventsSource, /blai-edit-activation-warning/);
    assert.match(eventsSource, /enabled:\s*activationWarningEnabled \? false : isEnabled/);
    assert.match(eventsSource, /click keydown', '\.blai-rule-risk-indicator'/);
    const riskIndicatorHandler = eventsSource.match(
        /click keydown', '\.blai-rule-risk-indicator'[\s\S]*?\n    \}\);/
    )?.[0] || '';
    assert.match(riskIndicatorHandler, /showRiskInfoModal\(warning\)/);
    assert.doesNotMatch(riskIndicatorHandler, /showRiskConfirmModal/);
    assert.doesNotMatch(riskIndicatorHandler, /activationWarningEnabled\s*=/);
    assert.doesNotMatch(riskIndicatorHandler, /performGlobalCleanse/);
    assert.match(eventsSource, /function renderTagsPreserveBatchSelection\(\)[\s\S]*?shell\.scrollTop = 0/);
    assert.match(eventsSource, /activeElement\.blur\(\)/);
    assert.match(eventsSource, /buildRuleActivationConfirmMessage\(\s*riskyRules/);
    assert.match(eventsSource, /await showRiskConfirmModal\(buildRuleActivationConfirmMessage/);
    assert.doesNotMatch(eventsSource, /confirm\(buildRuleActivationConfirmMessage/);
    assert.doesNotMatch(eventsSource, /请先点“打开”填写启用风险提示/);
    assert.match(eventsSource, /\$\(this\)\.prop\('checked', false\)/);
    assert.doesNotMatch(eventsSource, /buildRuleActivationConfirmMessage\(\s*subRule/);
    assert.match(styleSource, /\.blai-home-card-risk[\s\S]*?color:\s*var\(--status-danger\)/);
    assert.match(styleSource, /\.blai-home-card-risk[\s\S]*?background:\s*transparent/);
    assert.match(styleSource, /\.blai-home-card-risk[\s\S]*?border:\s*0/);
    assert.doesNotMatch(styleSource, /blai-rule-risk-toggle/);
    assert.doesNotMatch(styleSource, /blai-rule-risk-switch/);
    assert.doesNotMatch(styleSource, /blai-risk-checkbox/);
});

test('merged preset contains one disabled risk group with ten normal subrules', () => {
    const preset = JSON.parse(fs.readFileSync(
        new URL('./fixtures/risk-group-preset.json', import.meta.url),
        'utf8'
    ));
    const mergedGroups = preset.rules.filter((rule) => rule.name === '处理—…及多种增殖[选开]');

    assert.equal(mergedGroups.length, 1);
    assert.equal(preset.rules.some((rule) => rule.name === '处理—…增殖[选开]'), false);
    assert.equal(preset.rules.some((rule) => rule.name === '处理多种增殖[选开]'), false);
    assert.equal(mergedGroups[0].enabled, false);
    assert.notEqual(getRuleActivationWarning(mergedGroups[0]), '');
    assert.equal(isRuleActivationWarningEnabled(mergedGroups[0]), true);
    assert.equal(mergedGroups[0].subRules.length, 10);
    assert.equal(mergedGroups[0].subRules.every((subRule) => (
        subRule.enabled !== false
        && !('activationWarning' in subRule)
        && !('activationWarningEnabled' in subRule)
    )), true);
});
