import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { compileRegexTarget } from '../src/utils.js';
import { findRelatedRulesForDiffChange } from '../src/relatedRules.js';

const actualRiskGroups = JSON.parse(fs.readFileSync(
    new URL('./fixtures/actual-risk-regex-groups.json', import.meta.url),
    'utf8',
));

function makeRule(name, mode, target) {
    return {
        name,
        enabled: true,
        subRules: [{
            enabled: true,
            mode,
            targets: [target],
            replacements: [],
        }],
    };
}

test('bare regex is global and unicode without implicit multiline', () => {
    const compiled = compileRegexTarget('^[，,。 ]');
    assert.equal(compiled.ok, true);
    assert.equal(compiled.value.flags, 'gu');
});

test('literal regex preserves explicit multiline and adds global once', () => {
    const compiled = compileRegexTarget('/^[，,。 ]/m');
    assert.equal(compiled.ok, true);
    assert.equal(compiled.value.flags, 'mg');
});

test('bare anchored regex does not strip indentation from later HTML lines', () => {
    const compiled = compileRegexTarget('^[，,。 ]');
    assert.equal(compiled.ok, true);
    const html = '<section>\n  <p>中文</p>\n</section>';
    const output = html.replace(compiled.value.regex, '');
    assert.equal(output, html);
});

test('explicit multiline regex still applies at every line start', () => {
    const compiled = compileRegexTarget('/^[，,。 ]/gm');
    assert.equal(compiled.ok, true);
    const output = '，甲\n 乙'.replace(compiled.value.regex, '');
    assert.equal(output, '甲\n乙');
});

test('Markdown fenced code, preformatted HTML and CRLF indentation remain stable', () => {
    const compiled = compileRegexTarget('^[，,。 ]');
    const values = [
        '```html\n  <section>\n    中文\n  </section>\n```',
        '<pre>\n  中文\n</pre>',
        '<section>\r\n  <p>中文</p>\r\n</section>',
    ];
    for (const value of values) {
        const once = value.replace(compiled.value.regex, '');
        let repeated = once;
        for (let count = 0; count < 4; count++) repeated = repeated.replace(compiled.value.regex, '');
        assert.equal(once, value);
        assert.equal(repeated, once);
    }
});

test('bare anchored rule still handles ordinary Chinese message start', () => {
    const compiled = compileRegexTarget('^[，,。 ]');
    assert.equal('，中文正文'.replace(compiled.value.regex, ''), '中文正文');
});

const actualStructuralRuleDefinitions = [
    {
        name: '段首或单独成段的情况',
        target: actualRiskGroups[0].subRules[5].targets[0],
        raw: '开场\n……\n正文',
        replacement: '',
    },
    {
        name: '顺序① 段尾标点变逗号+跨行合并',
        target: actualRiskGroups[1].subRules[0].targets[0],
        raw: `${'甲'.repeat(21)}。\n短句。\n下一段`,
        replacement: '，',
    },
    {
        name: '顺序② 30字以内的段落与下段合并',
        target: actualRiskGroups[1].subRules[1].targets[0],
        raw: `${'甲'.repeat(31)}\n短段\n下一段`,
        replacement: '',
    },
    {
        name: '分割较长段落',
        target: actualRiskGroups[2].subRules[0].targets[0],
        raw: `前言\n${'甲'.repeat(150)}。乙`,
        replacement: '$1\n\n$2',
    },
];

for (const fixture of actualStructuralRuleDefinitions) {
    test(`actual structural rule keeps bare gu flags and does not gain implicit multiline semantics: ${fixture.name}`, () => {
        const compiled = compileRegexTarget(fixture.target);
        const explicitMultiline = compileRegexTarget(`/${fixture.target}/m`);

        assert.equal(compiled.ok, true);
        assert.equal(compiled.value.flags, 'gu');
        assert.equal(explicitMultiline.ok, true);
        assert.equal(explicitMultiline.value.flags, 'mg');
        assert.equal(fixture.raw.replace(compiled.value.regex, fixture.replacement), fixture.raw);
        assert.notEqual(fixture.raw.replace(explicitMultiline.value.regex, fixture.replacement), fixture.raw);
    });
}

test('exact simple alternative outranks a regex context hit', () => {
    const change = {
        deletedText: '僵硬的',
        clickedText: '僵硬的',
        oldContext: '它那僵硬的肌肉在听到这句话的瞬间绷紧。',
    };
    const rules = [
        makeRule('正则上下文', 'regex', '僵硬的'),
        makeRule('直接词组', 'simple', '{诡媚,僵硬的,麻木}'),
    ];

    const candidates = findRelatedRulesForDiffChange(change, rules);

    assert.equal(candidates[0].groupName, '直接词组');
    assert.equal(candidates[0].score, 100);
    assert.deepEqual(candidates[0].reasons, ['简易规则精确命中删除文本']);
    assert.equal(candidates[1].score, 92);
});

test('partial simple match retains the lower confidence score', () => {
    const change = {
        deletedText: '非常僵硬的动作',
        clickedText: '非常僵硬的动作',
        oldContext: '这是非常僵硬的动作。',
    };
    const rules = [makeRule('局部词组', 'simple', '{诡媚,僵硬的,麻木}')];

    const [candidate] = findRelatedRulesForDiffChange(change, rules);

    assert.equal(candidate.score, 88);
    assert.deepEqual(candidate.reasons, ['简易规则命中删除文本']);
});

test('exact simple wildcard match counts as a full deletion match', () => {
    const change = {
        deletedText: '僵硬而迟缓的',
        clickedText: '僵硬而迟缓的',
        oldContext: '它以僵硬而迟缓的动作转身。',
    };
    const rules = [makeRule('通配词组', 'simple', '僵硬*的')];

    const [candidate] = findRelatedRulesForDiffChange(change, rules);

    assert.equal(candidate.score, 100);
    assert.deepEqual(candidate.reasons, ['简易规则精确命中删除文本']);
});
