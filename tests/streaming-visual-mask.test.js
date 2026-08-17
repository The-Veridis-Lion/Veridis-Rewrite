import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import {
    applyStreamingVisualMask,
    purifyDOM,
    renderStreamingVisualMask,
    replayStreamingVisualMask,
    resolveSingleNodeStreamingProjection,
} from '../src/dom.js';
import { applyVisualMask } from '../src/replacementEngine.js';
import { extensionName, initAppContext, runtimeState } from '../src/state.js';

const actualRiskGroups = JSON.parse(fs.readFileSync(
    new URL('./fixtures/actual-risk-regex-groups.json', import.meta.url),
    'utf8',
));

class FakeText {
    constructor(value) {
        this.nodeType = 3;
        this.nodeValue = String(value);
        this.parentNode = null;
        this.parentElement = null;
    }
}

function splitSelectorList(selector) {
    return String(selector || '').split(',').map((part) => part.trim()).filter(Boolean);
}

function matchesSimpleSelector(element, selector) {
    let source = String(selector || '').trim();
    if (!source || source.includes(' ')) return false;
    const notSelectors = [];
    source = source.replace(/:not\(([^)]+)\)/g, (_match, inner) => {
        notSelectors.push(inner);
        return '';
    });
    const tag = source.match(/^[A-Za-z][\w-]*/)?.[0];
    if (tag && element.tagName !== tag.toUpperCase()) return false;
    for (const id of source.matchAll(/#([\w-]+)/g)) {
        if (element.id !== id[1]) return false;
    }
    for (const classMatch of source.matchAll(/\.([\w-]+)/g)) {
        if (!element.classList.has(classMatch[1])) return false;
    }
    for (const attributeMatch of source.matchAll(/\[([^\]=*]+)(\*=|=)?["']?([^\]"']*)["']?\]/g)) {
        const [, name, operator, expected] = attributeMatch;
        const actual = element.getAttribute(name);
        if (!operator && actual === null) return false;
        if (operator === '=' && actual !== expected) return false;
        if (operator === '*=' && !String(actual || '').includes(expected)) return false;
    }
    return notSelectors.every((inner) => !matchesSimpleSelector(element, inner));
}

function matchesSelectorPath(element, selector) {
    const parts = String(selector || '').trim().split(/\s+/);
    let current = element;
    if (!matchesSimpleSelector(current, parts.pop())) return false;
    while (parts.length > 0) {
        const expected = parts.pop();
        current = current.parentElement;
        while (current && !matchesSimpleSelector(current, expected)) current = current.parentElement;
        if (!current) return false;
    }
    return true;
}

class FakeElement {
    constructor(tagName = 'div', options = {}) {
        this.nodeType = 1;
        this.tagName = tagName.toUpperCase();
        this.parentNode = null;
        this.parentElement = null;
        this.childNodes = [];
        this.attributes = Object.create(null);
        this.classList = new Set();
        this.dataset = Object.create(null);
        if (options.id) this.setAttribute('id', options.id);
        if (options.className) options.className.split(/\s+/).filter(Boolean).forEach((name) => this.classList.add(name));
        Object.entries(options.attributes || {}).forEach(([name, value]) => this.setAttribute(name, value));
    }

    get id() {
        return this.getAttribute('id') || '';
    }

    get className() {
        return [...this.classList].join(' ');
    }

    append(...children) {
        children.forEach((child) => {
            child.parentNode = this;
            child.parentElement = this;
            this.childNodes.push(child);
        });
        return this;
    }

    setAttribute(name, value) {
        this.attributes[name] = String(value);
        if (name === 'class') this.classList = new Set(String(value).split(/\s+/).filter(Boolean));
        if (name.startsWith('data-')) {
            const key = name.slice(5).replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
            this.dataset[key] = String(value);
        }
    }

    getAttribute(name) {
        if (name === 'class') return this.className || null;
        return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
    }

    matches(selector) {
        return splitSelectorList(selector).some((part) => matchesSelectorPath(this, part));
    }

    closest(selector) {
        let current = this;
        while (current?.nodeType === 1) {
            if (current.matches(selector)) return current;
            current = current.parentElement;
        }
        return null;
    }

    contains(node) {
        let current = node;
        while (current) {
            if (current === this) return true;
            current = current.parentNode;
        }
        return false;
    }

    querySelectorAll(selector) {
        const output = [];
        const visit = (node) => {
            if (node?.nodeType !== 1) return;
            if (node.matches(selector)) output.push(node);
            node.childNodes.forEach(visit);
        };
        this.childNodes.forEach(visit);
        return output;
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }

    getRootNode() {
        let current = this;
        while (current.parentNode) current = current.parentNode;
        return current;
    }
}

class FakeDocument extends FakeElement {
    constructor() {
        super('document');
        this.nodeType = 9;
        this.activeElement = null;
    }

    getElementById(id) {
        return this.querySelector(`#${id}`);
    }

    createTreeWalker(root) {
        const nodes = [];
        const visit = (node) => {
            Array.from(node?.childNodes || []).forEach((child) => {
                if (child?.nodeType === 3) nodes.push(child);
                else visit(child);
            });
        };
        visit(root);
        let index = 0;
        return { nextNode: () => nodes[index++] || null };
    }
}

function element(tagName, className = '', ...children) {
    return new FakeElement(tagName, { className }).append(...children);
}

function text(value) {
    return new FakeText(value);
}

function countNodeValueWrites(node) {
    let currentValue = node.nodeValue;
    let writeCount = 0;
    Object.defineProperty(node, 'nodeValue', {
        configurable: true,
        get: () => currentValue,
        set: (value) => {
            writeCount++;
            currentValue = String(value);
        },
    });
    return () => writeCount;
}

function installDom(messages) {
    globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
    globalThis.NodeFilter = { SHOW_TEXT: 4 };
    const document = new FakeDocument();
    const chat = new FakeElement('div', { id: 'chat' });
    document.append(chat);
    messages.forEach((message, index) => {
        message.setAttribute('mesid', index);
        message.classList.add('mes');
        chat.append(message);
    });
    globalThis.document = document;
    return { document, chat };
}

function createMessage(surfaceChildren, helperChildren = null) {
    const message = new FakeElement('div', { className: 'mes', attributes: { is_user: 'false' } });
    const hostSurface = element('div', 'mes_text', ...surfaceChildren);
    message.append(hostSurface);
    let helperSurface = null;
    if (helperChildren) {
        helperSurface = element('div', 'TH-streaming', ...helperChildren);
        message.append(helperSurface);
    }
    return { message, hostSurface, helperSurface };
}

function subRule(mode, target, replacements) {
    return { enabled: true, rewriteMode: 'program', mode, targets: [target], replacements };
}

const sameLineDashRule = () => subRule(
    'regex',
    '/(?<=[\\u4e00-\\u9fff])—+(?=[\\u4e00-\\u9fff])/gu',
    ['，'],
);

const crossParagraphDashRule = () => subRule(
    'regex',
    '/(?<=[\\u4e00-\\u9fff])—+\\n+(?:—+)?(?=[\\u4e00-\\u9fff])/gu',
    ['，'],
);

function installRules(subRules, chat = [], overrides = {}) {
    initAppContext({
        extension_settings: {
            [extensionName]: {
                rules: [{ enabled: true, name: 'streaming behavior', subRules }],
                scopeTags: [],
                scopeTagBuiltinDismissed: [],
                scopeTagMode: 'protect',
                skipUserMessages: false,
                protectPersonaDescription: false,
                ...overrides,
            },
        },
        chat,
    });
    runtimeState.isRegexDirty = true;
    runtimeState.isStreamingGeneration = true;
    runtimeState.streamingCommittedMessageCache.clear();
}

function installActualRiskSubRule(groupIndex, subRuleIndex, chat = []) {
    const group = structuredClone(actualRiskGroups[groupIndex]);
    group.enabled = true;
    group.subRules.forEach((rule, index) => {
        rule.enabled = index === subRuleIndex;
    });
    initAppContext({
        extension_settings: {
            [extensionName]: {
                rules: [group],
                scopeTags: [],
                scopeTagBuiltinDismissed: [],
                scopeTagMode: 'protect',
                skipUserMessages: false,
                protectPersonaDescription: false,
            },
        },
        chat,
    });
    runtimeState.isRegexDirty = true;
    runtimeState.isStreamingGeneration = true;
    runtimeState.streamingCommittedMessageCache.clear();
}

function buildActualRiskSurface(layout, parts) {
    const values = layout === 'single' ? [parts.join('')] : parts;
    const nodes = values.map((value) => text(value));
    const children = layout === 'single'
        ? nodes
        : layout === 'segments'
            ? nodes.map((node) => element('span', 'text_segment', node))
            : nodes.map((node, index) => element(['span', 'em', 'strong', 'i'][index % 4], '', node));
    return { nodes, surface: element('div', 'mes_text', ...children) };
}

const values = (nodes) => nodes.map((node) => node.nodeValue);

const actualInlineRiskCases = [
    {
        subRuleIndex: 0,
        remark: '形式：对话引号+——或……',
        raw: '她说：“——别走。”又答："……等等。"',
        parts: ['她说：', '“', '——', '别走。”又答："', '……', '等等。"'],
    },
    {
        subRuleIndex: 1,
        remark: '形式：——+对话引号',
        raw: '“我知道——”他说“好—"',
        parts: ['“我知道', '——', '”他说“好', '—', '"'],
    },
    {
        subRuleIndex: 2,
        remark: '形式：—…与其他符号相邻',
        raw: '迟疑……，然后回答！——继续。',
        parts: ['迟疑', '……', '，然后回答！', '——', '继续。'],
    },
    {
        subRuleIndex: 3,
        remark: '中文间破折号变逗号',
        raw: '山河——依旧',
        parts: ['山河', '——', '依旧'],
    },
    {
        subRuleIndex: 6,
        remark: '连续相同符号去重',
        raw: '真的！！！好吗？？………又听见———回声。',
        parts: ['真的', '！！！', '好吗', '？？', '……', '…', '又听见', '——', '—', '回声。'],
    },
    {
        subRuleIndex: 7,
        remark: '删中文间的连字符',
        raw: '山 -- 河',
        parts: ['山', ' -- ', '河'],
    },
    {
        subRuleIndex: 8,
        remark: 'AA的、BB的、CC的→AA的',
        raw: '他以冷静的、克制的、谨慎的目光，以及快速地、果断地行动。',
        parts: ['他以冷静的', '、克制的', '、谨慎的目光，以及快速地', '、果断地', '行动。'],
    },
    {
        subRuleIndex: 9,
        remark: '处理多种符号增殖',
        raw: '。冷静，克制、迅速~行动',
        parts: ['。冷静', '，', '克制', '、', '迅速', '~', '行动'],
    },
];

for (const fixture of actualInlineRiskCases) {
    test(`actual inline risk rule matches whole-message output in all text-run layouts: ${fixture.remark}`, () => {
        for (const layout of ['single', 'inline', 'segments']) {
            const built = buildActualRiskSurface(layout, fixture.parts);
            const message = new FakeElement('div', { className: 'mes' }).append(built.surface);
            installDom([message]);
            const chat = [{
                mes: fixture.raw,
                swipe_id: 0,
                swipes: [fixture.raw],
                swipe_info: [{ extra: { native: true } }],
                extra: { persistent: 'unchanged' },
            }];
            installActualRiskSubRule(0, fixture.subRuleIndex, chat);
            const expected = applyVisualMask(fixture.raw);
            const before = structuredClone(chat[0]);

            assert.notEqual(expected, fixture.raw, `${layout} fixture must exercise the exact target`);
            assert.equal(applyStreamingVisualMask(built.surface, fixture.raw, expected), true, layout);
            assert.equal(built.nodes.map((node) => node.nodeValue).join(''), expected, layout);
            assert.deepEqual(chat[0], before, layout);
        }
    });
}

test('the actual cross-paragraph dash rule keeps final cleansing authoritative while projecting paragraph symbols', () => {
    const raw = '山河——\n——依旧';
    const paragraphNodes = [text('山河——'), text('——依旧')];
    const surface = element('div', 'mes_text',
        element('p', '', paragraphNodes[0]),
        element('p', '', paragraphNodes[1]));
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    const chat = [{ mes: raw, swipe_id: 0, swipes: [raw], swipe_info: [{ extra: { native: true } }] }];
    installActualRiskSubRule(0, 4, chat);
    const expected = applyVisualMask(raw);
    const before = structuredClone(chat[0]);

    assert.equal(expected, '山河，依旧');
    assert.equal(applyStreamingVisualMask(surface, raw, expected), true);
    assert.deepEqual(values(paragraphNodes), ['山河，', '依旧']);
    assert.deepEqual(chat[0], before);
});

test('a bare whole-message anchor does not gain start-of-string semantics in an intermediate paragraph', () => {
    const raw = '开场\n……\n正文';
    const paragraphNodes = [text('开场'), text('……'), text('正文')];
    const surface = element('div', 'mes_text',
        ...paragraphNodes.map((node) => element('p', '', node)));
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    const chat = [{
        mes: raw,
        swipe_id: 0,
        swipes: [raw],
        swipe_info: [{ extra: { native: true } }],
        extra: { blai_diff: { stable: true } },
    }];
    installActualRiskSubRule(0, 5, chat);
    const expected = applyVisualMask(raw);
    const before = structuredClone(chat[0]);

    assert.equal(expected, raw);
    assert.equal(applyStreamingVisualMask(surface, raw, expected), false);
    assert.deepEqual(values(paragraphNodes), ['开场', '……', '正文']);
    assert.deepEqual(chat[0], before);
});

test('a start anchor stays final-only after excluded code when there is one eligible run', () => {
    const eligibleNode = text('……');
    const surface = element('div', 'mes_text',
        element('pre', '', text('code')),
        element('p', '', eligibleNode));
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    installRules([subRule('regex', '/^[—…]+/gu', [''])], [{ mes: 'code\n……' }]);
    const raw = 'code\n……';
    const expected = applyVisualMask(raw);

    assert.equal(expected, raw);
    assert.equal(applyStreamingVisualMask(surface, raw, expected), false);
    assert.equal(eligibleNode.nodeValue, '……');
});

test('an end anchor stays final-only before excluded code when there is one eligible run', () => {
    const eligibleNode = text('……');
    const surface = element('div', 'mes_text',
        element('p', '', eligibleNode),
        element('pre', '', text('code')));
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    installRules([subRule('regex', '/[—…]+$/gu', [''])], [{ mes: '……\ncode' }]);
    const raw = '……\ncode';
    const expected = applyVisualMask(raw);

    assert.equal(expected, raw);
    assert.equal(applyStreamingVisualMask(surface, raw, expected), false);
    assert.equal(eligibleNode.nodeValue, '……');
});

test('a start anchor stays final-only after an empty structural block', () => {
    const eligibleNode = text('……');
    const surface = element('div', 'mes_text',
        element('p'),
        element('p', '', eligibleNode));
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    installRules([subRule('regex', '/^[—…]+/gu', [''])], [{ mes: '\n……' }]);
    const raw = '\n……';
    const expected = applyVisualMask(raw);

    assert.equal(expected, raw);
    assert.equal(applyStreamingVisualMask(surface, raw, expected), false);
    assert.equal(eligibleNode.nodeValue, '……');
});

test('a start anchor remains realtime when one eligible run is the complete visible raw source', () => {
    const eligibleNode = text('……正文');
    const surface = element('div', 'mes_text', eligibleNode);
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    installRules([subRule('regex', '/^[—…]+/gu', [''])], [{ mes: '……正文' }]);
    const expected = applyVisualMask('……正文');

    assert.equal(expected, '正文');
    assert.equal(applyStreamingVisualMask(surface, '……正文', expected), true);
    assert.equal(eligibleNode.nodeValue, '正文');
});

test('escaped anchors and anchor characters inside classes remain realtime inline rules', () => {
    const paragraphNodes = [text('^A$'), text('$^')];
    const surface = element('div', 'mes_text',
        ...paragraphNodes.map((node) => element('p', '', node)));
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    installRules([
        subRule('regex', '/\\^A\\$/gu', ['literal']),
        subRule('regex', '/[$^]+/gu', ['symbols']),
    ], [{ mes: '^A$\n$^' }]);

    assert.equal(applyStreamingVisualMask(surface, '^A$\n$^', 'literal\nsymbols'), true);
    assert.deepEqual(values(paragraphNodes), ['literal', 'symbols']);
});

for (const fixture of [
    {
        subRuleIndex: 0,
        raw: '短句。\n下一段',
        expected: '短句，下一段',
        paragraphs: ['短句。', '下一段'],
    },
    {
        subRuleIndex: 1,
        raw: '短段\n下一段',
        expected: '短段\n下一段',
        paragraphs: ['短段', '下一段'],
    },
]) {
    test(`actual short-paragraph merge rule stays out of streaming runs: ${fixture.subRuleIndex + 1}`, () => {
        const paragraphNodes = fixture.paragraphs.map((value) => text(value));
        const surface = element('div', 'mes_text',
            ...paragraphNodes.map((node) => element('p', '', node)));
        installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
        installActualRiskSubRule(1, fixture.subRuleIndex);
        const expected = applyVisualMask(fixture.raw);

        assert.equal(expected, fixture.expected);
        assert.equal(applyStreamingVisualMask(surface, fixture.raw, expected), false);
        assert.deepEqual(values(paragraphNodes), fixture.paragraphs);
    });
}

test('the actual long-paragraph split rule cannot insert line breaks into one streaming text run', () => {
    const raw = `${'甲'.repeat(150)}。乙`;
    const textNode = text(raw);
    const surface = element('div', 'mes_text', textNode);
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    installActualRiskSubRule(2, 0);
    const expected = applyVisualMask(raw);

    assert.equal(expected, `${'甲'.repeat(150)}。\n\n乙`);
    assert.equal(applyStreamingVisualMask(surface, raw, expected), false);
    assert.equal(textNode.nodeValue, raw);
});

const actualStructuralWholeMessageCases = [
    {
        groupIndex: 0,
        subRuleIndex: 4,
        remark: '段尾处破折号连接下段',
        raw: '山河——\n——依旧',
        expected: '山河，依旧',
    },
    {
        groupIndex: 0,
        subRuleIndex: 5,
        remark: '段首或单独成段的情况',
        raw: '——开场\n……\n正文',
        expected: '开场\n……\n正文',
    },
    {
        groupIndex: 1,
        subRuleIndex: 0,
        remark: '顺序① 段尾标点变逗号+跨行合并',
        raw: '短句。\n下一段',
        expected: '短句，下一段',
    },
    {
        groupIndex: 1,
        subRuleIndex: 1,
        remark: '顺序② 30字以内的段落与下段合并',
        raw: '短段\n下一段',
        expected: '短段\n下一段',
    },
    {
        groupIndex: 2,
        subRuleIndex: 0,
        remark: '分割较长段落',
        raw: `${'甲'.repeat(150)}。乙`,
        expected: `${'甲'.repeat(150)}。\n\n乙`,
    },
];

for (const fixture of actualStructuralWholeMessageCases) {
    test(`actual structural rule keeps its authoritative whole-message result: ${fixture.remark}`, () => {
        installActualRiskSubRule(fixture.groupIndex, fixture.subRuleIndex);
        assert.equal(applyVisualMask(fixture.raw), fixture.expected);
    });
}

test('complete committed source masks the former Z.A split boundary with no incremental cleanser', () => {
    const raw = `${'x'.repeat(2342)}Z.A${'y'.repeat(2059)}`;
    assert.equal(raw.length, 4404);
    installRules([subRule('text', 'Z.A', ['[masked]'])]);
    assert.equal(applyVisualMask(raw), `${'x'.repeat(2342)}[masked]${'y'.repeat(2059)}`);
    assert.equal(fs.existsSync(new URL('../src/streamingSourceCleanser.js', import.meta.url)), false);
});

test('the next frame uses current rule settings without a cached cleaned prefix', () => {
    const node = text('SECRET');
    const built = createMessage([node]);
    installDom([built.message]);
    const chat = [{ mes: 'SECRET', swipes: ['SECRET'], swipe_id: 0, swipe_info: [{}] }];
    installRules([subRule('text', 'SECRET', ['old'])], chat);
    assert.equal(renderStreamingVisualMask(0, 'SECRET'), true);
    assert.equal(node.nodeValue, 'old');
    node.nodeValue = 'SECRET';
    installRules([subRule('text', 'SECRET', ['new'])], chat);
    assert.equal(renderStreamingVisualMask(0, 'SECRET'), true);
    assert.equal(node.nodeValue, 'new');
});

test('clean zero-processor streaming masks return before traversing one text node', () => {
    const raw = 'UNCHANGED';
    const node = text(raw);
    const surface = element('div', 'mes_text', node);
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    installRules([], [{ mes: raw }]);
    assert.equal(applyVisualMask(raw), raw);
    assert.equal(runtimeState.isRegexDirty, false);
    assert.equal(runtimeState.activeVisualProcessors.length, 0);

    const children = surface.childNodes;
    let childNodeReads = 0;
    Object.defineProperty(surface, 'childNodes', {
        configurable: true,
        get: () => {
            childNodeReads++;
            return children;
        },
    });

    assert.equal(applyStreamingVisualMask(surface, raw, raw), false);
    assert.equal(node.nodeValue, raw);
    assert.equal(childNodeReads, 0);
});

test('clean zero-processor streaming masks return before traversing multiple text nodes', () => {
    const raw = 'UNCHANGED';
    const nodes = [text('UN'), text('CHANGED')];
    const surface = element('div', 'mes_text', ...nodes.map((node) => element('span', '', node)));
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    installRules([], [{ mes: raw }]);
    assert.equal(applyVisualMask(raw), raw);
    assert.equal(runtimeState.isRegexDirty, false);
    assert.equal(runtimeState.activeVisualProcessors.length, 0);

    const children = surface.childNodes;
    let childNodeReads = 0;
    Object.defineProperty(surface, 'childNodes', {
        configurable: true,
        get: () => {
            childNodeReads++;
            return children;
        },
    });

    assert.equal(applyStreamingVisualMask(surface, raw, raw), false);
    assert.deepEqual(values(nodes), ['UN', 'CHANGED']);
    assert.equal(childNodeReads, 0);
});

test('clean zero-processor streaming masks still project a differing clean source', () => {
    const node = text('RAW');
    const surface = element('div', 'mes_text', node);
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    installRules([], [{ mes: 'RAW' }]);
    assert.equal(applyVisualMask('RAW'), 'RAW');
    assert.equal(runtimeState.isRegexDirty, false);
    assert.equal(runtimeState.activeVisualProcessors.length, 0);

    assert.equal(applyStreamingVisualMask(surface, 'RAW', 'CLEAN'), true);
    assert.equal(node.nodeValue, 'CLEAN');
});

test('dirty processor state rebuilds before applying a streaming mask', () => {
    const raw = 'SECRET';
    const node = text(raw);
    const surface = element('div', 'mes_text', node);
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    installRules([subRule('text', 'SECRET', ['MASKED'])], [{ mes: raw }]);
    runtimeState.activeProcessors = [];
    runtimeState.activeVisualProcessors = [];
    assert.equal(runtimeState.isRegexDirty, true);
    assert.equal(runtimeState.activeVisualProcessors.length, 0);

    assert.equal(applyStreamingVisualMask(surface, raw, raw), true);
    assert.equal(node.nodeValue, 'MASKED');
    assert.equal(runtimeState.isRegexDirty, false);
    assert.equal(runtimeState.activeVisualProcessors.length, 1);
});

test('clean zero-processor streaming masks preserve wrapper-rendered correspondence', () => {
    const wrapped = '<content>UNCHANGED</content>';
    const node = text('UNCHANGED');
    const surface = element('div', 'mes_text', node);
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    installRules([], [{ mes: wrapped }]);
    assert.equal(applyVisualMask(wrapped), wrapped);
    assert.equal(runtimeState.isRegexDirty, false);
    assert.equal(runtimeState.activeVisualProcessors.length, 0);

    assert.equal(applyStreamingVisualMask(surface, wrapped, wrapped, { requireSourceCorrespondence: true }), false);
    assert.equal(node.nodeValue, 'UNCHANGED');
});

test('single-node projection supports exact and wrapper-stripped snapshots', () => {
    assert.equal(resolveSingleNodeStreamingProjection('SECRET', '[hidden]', 'SECRET'), '[hidden]');
    assert.equal(resolveSingleNodeStreamingProjection('<content>SECRET</content>', '<content>[hidden]</content>', 'SECRET'), '[hidden]');
});

test('single-node unscoped projection writes once for many changed matches in one processor', () => {
    const raw = 'A A A Q';
    const node = text(raw);
    const getWriteCount = countNodeValueWrites(node);
    const surface = element('div', 'mes_text', node);
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    installRules([
        subRule('regex', '/A/gu', ['X']),
        subRule('regex', '/Q/gu', ['\\n']),
    ], [{ mes: raw }]);

    const clean = applyVisualMask(raw);
    assert.equal(clean, 'X X X \n');
    assert.equal(applyStreamingVisualMask(surface, raw, clean), true);
    assert.equal(node.nodeValue, 'X X X Q');
    assert.equal(getWriteCount(), 1);
});

test('single-node unscoped projection preserves captures, deterministic choices, zero-width insertions, and processor order', () => {
    const raw = 'AB AB Q';
    const safeRules = [
        subRule('regex', '/(?<left>A)(B)/gu', ['$2-$1']),
        subRule('regex', '/B-A/gu', ['X', 'LONG']),
        subRule('regex', '/(?= Q)/gu', ['!']),
    ];
    installRules(safeRules, [{ mes: raw }]);
    const safeExpected = applyVisualMask(raw);
    const deterministicChoice = safeExpected.split(' ')[0];
    assert.ok(deterministicChoice === 'X' || deterministicChoice === 'LONG');
    assert.equal(safeExpected, `${deterministicChoice} ${deterministicChoice}! Q`);

    const node = text(raw);
    const surface = element('div', 'mes_text', node);
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    installRules([
        ...safeRules,
        subRule('regex', '/Q/gu', ['\\n']),
    ], [{ mes: raw }]);

    const clean = applyVisualMask(raw);
    assert.equal(clean, `${deterministicChoice} ${deterministicChoice}! \n`);
    assert.equal(applyStreamingVisualMask(surface, raw, clean), true);
    assert.equal(node.nodeValue, safeExpected);
});

test('single-node unscoped projection ignores match-equivalent replacements without a false change', () => {
    const raw = 'A Q';
    const node = text(raw);
    const getWriteCount = countNodeValueWrites(node);
    const surface = element('div', 'mes_text', node);
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    installRules([
        subRule('regex', '/A/gu', ['A']),
        subRule('regex', '/Q/gu', ['\\n']),
    ], [{ mes: raw }]);

    assert.equal(applyStreamingVisualMask(surface, raw, applyVisualMask(raw)), false);
    assert.equal(node.nodeValue, raw);
    assert.equal(getWriteCount(), 0);
});

test('single-node unscoped projection remains changed when later processors restore the original text', () => {
    const raw = 'A Q';
    const node = text(raw);
    const getWriteCount = countNodeValueWrites(node);
    const surface = element('div', 'mes_text', node);
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    installRules([
        subRule('regex', '/A/gu', ['B']),
        subRule('regex', '/B/gu', ['A']),
        subRule('regex', '/Q/gu', ['\\n']),
    ], [{ mes: raw }]);

    assert.equal(applyStreamingVisualMask(surface, raw, applyVisualMask(raw)), true);
    assert.equal(node.nodeValue, raw);
    assert.equal(getWriteCount(), 2);
});

test('positive and negative lookbehind use adjacent inline-node context', () => {
    const positiveNodes = [text('foo'), text('bar')];
    const positive = element('div', 'mes_text', element('span', '', positiveNodes[0]), element('em', '', positiveNodes[1]));
    installDom([new FakeElement('div', { className: 'mes' }).append(positive)]);
    installRules([subRule('regex', '/(?<=foo)bar/gu', ['X'])], [{ mes: 'foobar' }]);
    assert.equal(applyStreamingVisualMask(positive, 'foobar', 'fooX'), true);
    assert.deepEqual(values(positiveNodes), ['foo', 'X']);

    const negativeNodes = [text('foo'), text('bar')];
    const negative = element('div', 'mes_text', element('span', '', negativeNodes[0]), element('em', '', negativeNodes[1]));
    installDom([new FakeElement('div', { className: 'mes' }).append(negative)]);
    installRules([subRule('regex', '/(?<!foo)bar/gu', ['X'])], [{ mes: 'foobar' }]);
    assert.equal(applyStreamingVisualMask(negative, 'foobar', 'foobar'), false);
    assert.deepEqual(values(negativeNodes), ['foo', 'bar']);
});

test('literal and simple targets replace across ordinary inline wrappers', () => {
    const literalNodes = [text('LIT'), text('ERAL')];
    const literalSurface = element('div', 'mes_text', element('strong', '', literalNodes[0]), element('u', '', literalNodes[1]));
    installDom([new FakeElement('div', { className: 'mes' }).append(literalSurface)]);
    installRules([subRule('text', 'LITERAL', ['T'])], [{ mes: 'LITERAL' }]);
    applyStreamingVisualMask(literalSurface, 'LITERAL', 'T');
    assert.deepEqual(values(literalNodes), ['T', '']);

    const simpleNodes = [text('SIM'), text('PLE')];
    const simpleSurface = element('div', 'mes_text', element('i', '', simpleNodes[0]), element('font', '', simpleNodes[1]));
    installDom([new FakeElement('div', { className: 'mes' }).append(simpleSurface)]);
    installRules([subRule('simple', 'SIMPLE', ['S'])], [{ mes: 'SIMPLE' }]);
    applyStreamingVisualMask(simpleSurface, 'SIMPLE', 'S');
    assert.deepEqual(values(simpleNodes), ['S', '']);
});

test('multi-node projection commits each final changed node at most once per processor', () => {
    const raw = 'A_A_A untouched';
    const nodes = [text('A_A_A'), text(' untouched')];
    const getWriteCounts = nodes.map(countNodeValueWrites);
    const surface = element('div', 'mes_text', ...nodes.map((node) => element('span', '', node)));
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    installRules([subRule('regex', '/A/gu', ['X'])], [{ mes: raw }]);

    assert.equal(applyStreamingVisualMask(surface, raw, applyVisualMask(raw)), true);
    assert.deepEqual(values(nodes), ['X_X_X', ' untouched']);
    assert.equal(values(nodes).join(''), 'X_X_X untouched');
    assert.deepEqual(getWriteCounts.map((getCount) => getCount()), [1, 0]);
});

test('multi-node projection preserves cross-node ownership for empty, shorter, and longer replacements', () => {
    const cases = [
        { parts: ['aaSEC', 'RETbb'], replacement: '', expected: ['aa', 'bb'] },
        { parts: ['aaS', 'EC', 'RET', 'bb'], replacement: 'Q', expected: ['aaQ', '', '', 'bb'] },
        { parts: ['aaS', 'E', 'C', 'RET', 'bb'], replacement: 'LONGER', expected: ['aaLONGER', '', '', '', 'bb'] },
    ];

    for (const { parts, replacement, expected } of cases) {
        const raw = parts.join('');
        const nodes = parts.map(text);
        const wrappers = nodes.map((node) => element('span', 'text_segment', node));
        const textIdentities = [...nodes];
        const wrapperIdentities = [...wrappers];
        const getWriteCounts = nodes.map(countNodeValueWrites);
        const surface = element('div', 'mes_text', ...wrappers);
        installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
        installRules([subRule('text', 'SECRET', [replacement])], [{ mes: raw }]);

        assert.equal(applyStreamingVisualMask(surface, raw, applyVisualMask(raw)), true);
        assert.deepEqual(values(nodes), expected);
        assert.equal(values(nodes).join(''), expected.join(''));
        assert.deepEqual(surface.childNodes, wrapperIdentities);
        wrappers.forEach((wrapper, index) => assert.equal(wrapper.childNodes[0], textIdentities[index]));
        getWriteCounts.forEach((getCount) => assert.ok(getCount() <= 1));
    }
});

test('reverse multi-node matches sharing a node commit only the final per-node values', () => {
    const raw = 'aSECRETSECRETb';
    const nodes = [text('aS'), text('ECRETS'), text('ECRETb')];
    const getWriteCounts = nodes.map(countNodeValueWrites);
    const surface = element('div', 'mes_text', ...nodes.map((node) => element('span', '', node)));
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    installRules([subRule('regex', '/SECRET/gu', ['X'])], [{ mes: raw }]);

    assert.equal(applyStreamingVisualMask(surface, raw, applyVisualMask(raw)), true);
    assert.deepEqual(values(nodes), ['aX', 'X', 'b']);
    assert.deepEqual(getWriteCounts.map((getCount) => getCount()), [1, 1, 1]);
});

test('multi-node zero-width insertions preserve run and node-boundary ownership', () => {
    const cases = [
        { pattern: '/(?=A)/gu', expected: ['-A', 'B'] },
        { pattern: '/(?<=A)(?=B)/gu', expected: ['A', '-B'] },
        { pattern: '/(?<=B)$/gu', expected: ['A', 'B-'] },
    ];

    for (const { pattern, expected } of cases) {
        const raw = 'AB';
        const nodes = [text('A'), text('B')];
        const getWriteCounts = nodes.map(countNodeValueWrites);
        const surface = element('div', 'mes_text', ...nodes.map((node) => element('span', '', node)));
        installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
        installRules([subRule('regex', pattern, ['-'])], [{ mes: raw }]);

        assert.equal(applyStreamingVisualMask(surface, raw, applyVisualMask(raw)), true);
        assert.deepEqual(values(nodes), expected);
        getWriteCounts.forEach((getCount) => assert.ok(getCount() <= 1));
    }
});

test('multi-node processing preserves ordinary processor order', () => {
    const nodes = [text('A'), text('B')];
    const getWriteCounts = nodes.map(countNodeValueWrites);
    const surface = element('div', 'mes_text', element('span', '', nodes[0]), element('span', '', nodes[1]));
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    installRules([subRule('regex', '/(?<=A)B/gu', ['C']), subRule('regex', '/C/gu', ['D'])], [{ mes: 'AB' }]);
    assert.equal(applyStreamingVisualMask(surface, 'AB', applyVisualMask('AB')), true);
    assert.equal(nodes.map((node) => node.nodeValue).join(''), applyVisualMask('AB'));
    assert.deepEqual(values(nodes), ['A', 'D']);
    assert.deepEqual(getWriteCounts.map((getCount) => getCount()), [0, 2]);
});

test('multi-node projection remains changed when one processor restores its initial node vector', () => {
    const raw = 'ABZ';
    const nodes = [text('AB'), text('Z')];
    const getWriteCounts = nodes.map(countNodeValueWrites);
    const surface = element('div', 'mes_text', ...nodes.map((node) => element('span', '', node)));
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    installRules([
        subRule('text', 'A', ['AB']),
        subRule('text', 'B', ['']),
    ], [{ mes: raw }]);

    assert.equal(applyVisualMask(raw), raw);
    assert.equal(applyStreamingVisualMask(surface, raw, raw), true);
    assert.deepEqual(values(nodes), ['AB', 'Z']);
    assert.deepEqual(getWriteCounts.map((getCount) => getCount()), [0, 0]);
});

test('range edits preserve captures, deterministic choices, and zero-width insertions', () => {
    const captureNodes = [text('A'), text('B')];
    const captureSurface = element('div', 'mes_text', element('span', '', captureNodes[0]), element('em', '', captureNodes[1]));
    installDom([new FakeElement('div', { className: 'mes' }).append(captureSurface)]);
    installRules([subRule('regex', '/(A)(B)/gu', ['$2-$1'])], [{ mes: 'AB' }]);
    applyStreamingVisualMask(captureSurface, 'AB', applyVisualMask('AB'));
    assert.deepEqual(values(captureNodes), ['B-A', '']);

    const namedCaptureNodes = [text('A'), text('B')];
    const namedCaptureSurface = element('div', 'mes_text', element('span', '', namedCaptureNodes[0]), element('em', '', namedCaptureNodes[1]));
    installDom([new FakeElement('div', { className: 'mes' }).append(namedCaptureSurface)]);
    installRules([subRule('regex', '/(?<left>A)(?<right>B)/gu', ['$2-$1'])], [{ mes: 'AB' }]);
    applyStreamingVisualMask(namedCaptureSurface, 'AB', applyVisualMask('AB'));
    assert.deepEqual(values(namedCaptureNodes), ['B-A', '']);

    const deterministicNodes = [text('A'), text('B')];
    const deterministicSurface = element('div', 'mes_text', element('span', '', deterministicNodes[0]), element('span', '', deterministicNodes[1]));
    installDom([new FakeElement('div', { className: 'mes' }).append(deterministicSurface)]);
    installRules([subRule('text', 'AB', ['X', 'Y'])], [{ mes: 'AB' }]);
    applyStreamingVisualMask(deterministicSurface, 'AB', applyVisualMask('AB'));
    assert.equal(deterministicNodes.map((node) => node.nodeValue).join(''), applyVisualMask('AB'));

    const boundaryNodes = [text('A'), text('B')];
    const boundarySurface = element('div', 'mes_text', element('span', '', boundaryNodes[0]), element('span', '', boundaryNodes[1]));
    installDom([new FakeElement('div', { className: 'mes' }).append(boundarySurface)]);
    installRules([subRule('regex', '/(?<=A)(?=B)/gu', ['-'])], [{ mes: 'AB' }]);
    applyStreamingVisualMask(boundarySurface, 'AB', applyVisualMask('AB'));
    assert.deepEqual(values(boundaryNodes), ['A', '-B']);

    const endNodes = [text('A'), text('B')];
    const endSurface = element('div', 'mes_text', element('span', '', endNodes[0]), element('span', '', endNodes[1]));
    installDom([new FakeElement('div', { className: 'mes' }).append(endSurface)]);
    installRules([subRule('regex', '/(?<=B)$/gu', ['!'])], [{ mes: 'AB' }]);
    applyStreamingVisualMask(endSurface, 'AB', applyVisualMask('AB'));
    assert.deepEqual(values(endNodes), ['A', 'B!']);
});

test('length-changing cross-node edits preserve unmatched node ownership and element identity', () => {
    const nodes = [text('A'), text('B'), text('C'), text('D'), text('E')];
    const wrappers = nodes.map((node) => element('span', 'text_segment', node));
    const surface = element('div', 'mes_text', ...wrappers);
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    installRules([subRule('text', 'BCD', ['LONG'])], [{ mes: 'ABCDE' }]);
    const identities = [...wrappers];
    applyStreamingVisualMask(surface, 'ABCDE', applyVisualMask('ABCDE'));
    assert.deepEqual(values(nodes), ['A', 'LONG', '', '', 'E']);
    assert.deepEqual(surface.childNodes, identities);
    assert.equal(surface.childNodes.length, 5);
});

test('matches do not cross paragraphs, br elements, or excluded subtrees', () => {
    const paragraphNodes = [text('A'), text('B')];
    const breakNodes = [text('A'), text('B')];
    const excludedNodes = [text('A'), text('X'), text('B')];
    const surface = element('section', 'mes_text',
        element('p', '', paragraphNodes[0]), element('p', '', paragraphNodes[1]),
        element('div', '', breakNodes[0], element('br'), breakNodes[1]),
        element('div', '', excludedNodes[0], element('code', '', excludedNodes[1]), excludedNodes[2]));
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    installRules([subRule('text', 'AB', ['NO']), subRule('text', 'AXB', ['NO'])], [{ mes: 'ABABAXB' }]);
    assert.equal(applyStreamingVisualMask(surface, 'ABABAXB', applyVisualMask('ABABAXB')), false);
    assert.deepEqual(values([...paragraphNodes, ...breakNodes, ...excludedNodes]), ['A', 'B', 'A', 'B', 'A', 'X', 'B']);
});

test('code, pre, collapse controls, reasoning, and active editable content remain untouched', () => {
    const protectedNodes = [text('CODE'), text('PRE'), text('CONTROL'), text('REASON'), text('EDIT')];
    const editable = element('span', '', protectedNodes[4]);
    editable.setAttribute('contenteditable', 'true');
    const surface = element('div', 'mes_text', element('code', '', protectedNodes[0]), element('pre', '', protectedNodes[1]),
        element('button', 'TH-collapse-code-block-button', protectedNodes[2]), element('span', 'mes_reasoning', protectedNodes[3]), editable);
    const { document } = installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    document.activeElement = editable;
    installRules(protectedNodes.map((node) => subRule('text', node.nodeValue, ['X'])), [{ mes: 'CODEPREREASONEDIT' }]);
    assert.equal(applyStreamingVisualMask(surface, '', ''), false);
    assert.deepEqual(values(protectedNodes), ['CODE', 'PRE', 'CONTROL', 'REASON', 'EDIT']);
});

test('surface selection is message-local, prefers the last helper surface, and falls back locally', () => {
    const hostNode = text('SECRET');
    const firstHelperNode = text('SECRET');
    const lastHelperNode = text('SECRET');
    const otherHelperNode = text('SECRET');
    const first = createMessage([hostNode], [firstHelperNode]);
    first.message.append(element('div', 'TH-streaming', lastHelperNode));
    const second = createMessage([text('other')], [otherHelperNode]);
    installDom([first.message, second.message]);
    installRules([subRule('text', 'SECRET', ['X'])], [{ mes: 'SECRET' }, { mes: 'other' }]);
    renderStreamingVisualMask(0, 'SECRET');
    assert.deepEqual([hostNode.nodeValue, firstHelperNode.nodeValue, lastHelperNode.nodeValue, otherHelperNode.nodeValue], ['SECRET', 'SECRET', 'X', 'SECRET']);

    const fallbackNode = text('SECRET');
    const fallback = createMessage([fallbackNode]);
    const unrelated = createMessage([text('other')], [text('SECRET')]);
    installDom([fallback.message, unrelated.message]);
    installRules([subRule('text', 'SECRET', ['X'])], [{ mes: 'SECRET' }, { mes: 'other' }]);
    renderStreamingVisualMask(0, 'SECRET');
    assert.equal(fallbackNode.nodeValue, 'X');
    assert.equal(unrelated.helperSurface.childNodes[0].nodeValue, 'SECRET');
});

test('helper replay reads the authoritative committed cache and never mutates message data', () => {
    const helperNode = text('SECRET');
    const built = createMessage([text('SECRET')], [helperNode]);
    installDom([built.message]);
    const chat = [{ mes: 'SECRET', swipes: ['SECRET'], swipe_id: 0, swipe_info: [{ extra: { stable: true } }] }];
    installRules([subRule('text', 'SECRET', ['current'])], chat);
    runtimeState.streamingCommittedMessageCache.set(0, 'SECRET');
    const before = structuredClone(chat[0]);
    assert.equal(replayStreamingVisualMask(0), true);
    assert.equal(helperNode.nodeValue, 'current');
    assert.deepEqual(chat[0], before);
});

test('direct render and replay preserve chat, Swipe, swipe_info, and metadata byte-for-byte', () => {
    const helperNode = text('A');
    const built = createMessage([text('A')], [helperNode]);
    installDom([built.message]);
    const chat = [{
        mes: 'A',
        swipes: ['A'],
        swipe_id: 0,
        swipe_info: [{ extra: { token_count: 7, nested: { stable: true } } }],
        extra: { display_text: 'A', persistent: 'unchanged' },
    }];
    installRules([subRule('text', 'A', ['AA'])], chat);
    runtimeState.streamingCommittedMessageCache.set(0, 'A');
    const before = structuredClone(chat[0]);

    assert.equal(renderStreamingVisualMask(0, 'A'), true);
    helperNode.nodeValue = 'A';
    assert.equal(replayStreamingVisualMask(0), true);
    assert.deepEqual(chat[0], before);
});

test('repeated helper replay does not remask an already masked surface', () => {
    const helperNode = text('A');
    const built = createMessage([text('A')], [helperNode]);
    installDom([built.message]);
    installRules([subRule('text', 'A', ['AA'])], [{ mes: 'A' }]);
    runtimeState.streamingCommittedMessageCache.set(0, 'A');

    assert.equal(replayStreamingVisualMask(0), true);
    assert.equal(helperNode.nodeValue, 'AA');
    assert.equal(replayStreamingVisualMask(0), false);
    assert.equal(helperNode.nodeValue, 'AA');
});

test('a fresh helper-owned raw rerender can be masked exactly once again', () => {
    const helperNode = text('A');
    const built = createMessage([text('A')], [helperNode]);
    installDom([built.message]);
    installRules([subRule('text', 'A', ['AA'])], [{ mes: 'A' }]);
    runtimeState.streamingCommittedMessageCache.set(0, 'A');

    replayStreamingVisualMask(0);
    helperNode.nodeValue = 'A';
    assert.equal(replayStreamingVisualMask(0), true);
    assert.equal(helperNode.nodeValue, 'AA');
    assert.equal(replayStreamingVisualMask(0), false);
    assert.equal(helperNode.nodeValue, 'AA');
});

test('replay correspondence prevents remasking when protected content makes the visual result partial', () => {
    const eligibleNode = text('A ');
    const protectedNode = text('A');
    const built = createMessage([text('A A')], [eligibleNode, element('code', '', protectedNode)]);
    installDom([built.message]);
    installRules([subRule('text', 'A', ['AA'])], [{ mes: 'A A' }]);
    runtimeState.streamingCommittedMessageCache.set(0, 'A A');

    assert.equal(replayStreamingVisualMask(0), true);
    assert.deepEqual(values([eligibleNode, protectedNode]), ['AA ', 'A']);
    assert.equal(replayStreamingVisualMask(0), false);
    assert.deepEqual(values([eligibleNode, protectedNode]), ['AA ', 'A']);

    eligibleNode.nodeValue = 'A ';
    assert.equal(replayStreamingVisualMask(0), true);
    assert.deepEqual(values([eligibleNode, protectedNode]), ['AA ', 'A']);
});

test('the helper observer and custom-event path terminates after the idempotent replay', () => {
    const callbacks = [];
    const observers = [];
    const pendingMutations = [];
    let visibleText = 'A';
    let eventCount = 0;
    let maskCount = 0;

    const messageNode = {
        nodeType: 1,
        dataset: {},
        isConnected: true,
        matches: (selector) => selector === '.mes',
        closest: (selector) => selector === '.mes' ? messageNode : null,
        getAttribute: (name) => name === 'mesid' ? '0' : name === 'is_user' ? 'false' : null,
    };
    const textNode = { nodeType: 3, parentElement: messageNode };
    const chatNode = {};
    const document = {
        head: null,
        styleSheets: [],
        getElementById: (id) => id === 'chat' ? chatNode : null,
        querySelectorAll: (selector) => selector === '#chat .mes' ? [messageNode] : [],
    };
    class FakeMutationObserver {
        constructor(callback) {
            this.callback = callback;
            observers.push(this);
        }
        observe() {}
        disconnect() {}
    }
    class FakeCustomEvent {
        constructor(type, options) {
            this.type = type;
            this.detail = options?.detail;
        }
    }
    const window = {
        parent: null,
        document,
        MutationObserver: FakeMutationObserver,
        CustomEvent: FakeCustomEvent,
        requestAnimationFrame(callback) {
            callbacks.push(callback);
            return callbacks.length;
        },
        cancelAnimationFrame() {},
        setTimeout() {},
        dispatchEvent(event) {
            if (event.type !== 'blai:realtime-beauty-frame') return true;
            eventCount += 1;
            if (visibleText === 'A') {
                visibleText = 'AA';
                maskCount += 1;
                pendingMutations.push({ target: textNode, addedNodes: [] });
            }
            return true;
        },
    };
    window.parent = window;

    const source = fs.readFileSync(new URL('../tools/tavern-helper/realtime-beauty-replay.js', import.meta.url), 'utf8');
    vm.runInNewContext(source, { window, Node: { ELEMENT_NODE: 1 }, console: { info() {}, warn() {} } });
    assert.equal(observers.length, 1);
    assert.equal(callbacks.length, 1);

    callbacks.shift()();
    observers[0].callback(pendingMutations.splice(0));
    assert.equal(callbacks.length, 2);
    callbacks.shift()();
    callbacks.shift()();
    callbacks.shift()();

    assert.equal(visibleText, 'AA');
    assert.equal(maskCount, 1);
    assert.equal(eventCount, 2);
    assert.equal(callbacks.length, 0);
    assert.equal(pendingMutations.length, 0);
});

test('protect mode derives ranges from committed raw source when wrapper markers are stripped', () => {
    const nodes = [text('SEC'), text('RET '), text('SECRET')];
    const surface = element('div', 'mes_text', ...nodes.map((node) => element('span', '', node)));
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    installRules([subRule('text', 'SECRET', ['X'])], [{ mes: '<keep>SECRET</keep> SECRET' }], {
        scopeTags: [{ enabled: true, startTag: '<keep>', endTag: '</keep>' }], scopeTagMode: 'protect',
    });

    applyStreamingVisualMask(surface, '<keep>SECRET</keep> SECRET', applyVisualMask('<keep>SECRET</keep> SECRET'));
    assert.deepEqual(values(nodes), ['SEC', 'RET ', 'X']);
});

test('cleanse-inside mode derives ranges from committed raw source when wrapper markers are stripped', () => {
    const nodes = [text('SEC'), text('RET '), text('OUTSIDE')];
    const surface = element('div', 'mes_text', ...nodes.map((node) => element('span', '', node)));
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    installRules([subRule('text', 'SECRET', ['X'])], [{ mes: '<keep>SECRET</keep> OUTSIDE' }], {
        scopeTags: [{ enabled: true, startTag: '<keep>', endTag: '</keep>' }], scopeTagMode: 'cleanse-inside',
    });

    applyStreamingVisualMask(surface, '<keep>SECRET</keep> OUTSIDE', applyVisualMask('<keep>SECRET</keep> OUTSIDE'));
    assert.deepEqual(values(nodes), ['X', ' ', 'OUTSIDE']);
});

test('scoped partial multi-node projection preserves outside-node ownership and bounded writes', () => {
    const raw = 'aa<keep>SECRET</keep>bb';
    const nodes = [text('aaS'), text('EC'), text('RETbb')];
    const wrappers = nodes.map((node) => element('span', '', node));
    const getWriteCounts = nodes.map(countNodeValueWrites);
    const surface = element('div', 'mes_text', ...wrappers);
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    installRules([subRule('text', 'SECRET', ['LONG'])], [{ mes: raw }], {
        scopeTags: [{ enabled: true, startTag: '<keep>', endTag: '</keep>' }], scopeTagMode: 'cleanse-inside',
    });

    assert.equal(applyStreamingVisualMask(surface, raw, applyVisualMask(raw)), true);
    assert.deepEqual(values(nodes), ['aaLONG', '', 'bb']);
    assert.equal(values(nodes).join(''), 'aaLONGbb');
    assert.deepEqual(surface.childNodes, wrappers);
    assert.deepEqual(getWriteCounts.map((getCount) => getCount()), [1, 1, 1]);
});

test('scope masking is a no-op when Markdown prevents exact raw-to-rendered correspondence', () => {
    const nodes = [text('SECRET '), text('SECRET')];
    const surface = element('div', 'mes_text', ...nodes.map((node) => element('span', '', node)));
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    installRules([subRule('text', 'SECRET', ['X'])], [{ mes: '<keep>**SECRET**</keep> SECRET' }], {
        scopeTags: [{ enabled: true, startTag: '<keep>', endTag: '</keep>' }], scopeTagMode: 'protect',
    });

    assert.equal(applyStreamingVisualMask(
        surface,
        '<keep>**SECRET**</keep> SECRET',
        applyVisualMask('<keep>**SECRET**</keep> SECRET'),
    ), false);
    assert.deepEqual(values(nodes), ['SECRET ', 'SECRET']);
});

test('trailing Chinese dash streaming preview changes only split text nodes and preserves message and wrappers', () => {
    const raw = '山河——';
    const nodes = [text('山河'), text('—'), text('—')];
    const wrappers = nodes.map((node) => element('span', 'text_segment', node));
    const writeCounts = nodes.map(countNodeValueWrites);
    const surface = element('div', 'mes_text', ...wrappers);
    const message = new FakeElement('div', { className: 'mes', attributes: { is_user: 'false' } }).append(surface);
    installDom([message]);
    const chat = [{
        mes: raw,
        swipes: [raw],
        swipe_id: 0,
        swipe_info: [{ extra: { stable: true } }],
        extra: { preserved: true },
    }];
    installRules([sameLineDashRule()], chat);
    const before = structuredClone(chat[0]);

    assert.equal(applyVisualMask(raw), raw);
    assert.equal(applyStreamingVisualMask(surface, raw, applyVisualMask(raw)), true);
    assert.equal(values(nodes).join(''), '山河，');
    assert.deepEqual(values(nodes), ['山河', '，', '']);
    assert.deepEqual(surface.childNodes, wrappers);
    wrappers.forEach((wrapper, index) => assert.equal(wrapper.childNodes[0], nodes[index]));
    assert.deepEqual(writeCounts.map((getCount) => getCount()), [0, 1, 1]);
    assert.deepEqual(chat[0], before);
});

test('trailing dash projection is idempotent and is reapplied from a fresh host frame without retained state', () => {
    const raw = '山河——';
    const node = text(raw);
    const surface = element('div', 'mes_text', element('em', '', node));
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    installRules([sameLineDashRule()], [{ mes: raw }]);

    assert.equal(applyStreamingVisualMask(surface, raw, applyVisualMask(raw)), true);
    assert.equal(node.nodeValue, '山河，');
    assert.equal(applyStreamingVisualMask(surface, raw, applyVisualMask(raw)), false);
    assert.equal(node.nodeValue, '山河，');

    node.nodeValue = raw;
    assert.equal(applyStreamingVisualMask(surface, raw, applyVisualMask(raw)), true);
    assert.equal(node.nodeValue, '山河，');
});

test('later same-line, quote, punctuation, and Latin context remain authoritative over trailing fallback', () => {
    const rules = [
        sameLineDashRule(),
        subRule('regex', '/—+(?=”)/gu', ['!']),
        subRule('regex', '/—+(?=，)/gu', ['']),
    ];
    const node = text('');
    const surface = element('div', 'mes_text', node);
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    installRules(rules, [{ mes: '' }]);

    const frames = [
        ['山河——依旧', '山河，依旧', true],
        ['山河——”', '山河!”', true],
        ['山河——，', '山河，', true],
        ['山河——ABC', '山河——ABC', false],
    ];
    for (const [raw, expected, changed] of frames) {
        node.nodeValue = raw;
        assert.equal(applyStreamingVisualMask(surface, raw, applyVisualMask(raw)), changed);
        assert.equal(node.nodeValue, expected);
    }
});

test('trailing fallback runs after an unrelated ordinary single-node visual replacement', () => {
    const raw = 'A山河——';
    const node = text(raw);
    const getWriteCount = countNodeValueWrites(node);
    const surface = element('div', 'mes_text', node);
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    installRules([subRule('text', 'A', ['B']), sameLineDashRule()], [{ mes: raw }]);

    assert.equal(applyVisualMask(raw), 'B山河——');
    assert.equal(applyStreamingVisualMask(surface, raw, applyVisualMask(raw)), true);
    assert.equal(node.nodeValue, 'B山河，');
    assert.equal(getWriteCount(), 1);
    assert.equal(applyStreamingVisualMask(surface, raw, applyVisualMask(raw)), false);
    assert.equal(node.nodeValue, 'B山河，');
});

test('final purifyDOM rerenders a trailing dash as a comma without changing stored, Swipe, Diff, or persistence data', () => {
    const raw = '山河——';
    const node = text(raw);
    const wrapper = element('strong', '', node);
    const built = createMessage([wrapper]);
    installDom([built.message]);
    const chat = [{
        mes: raw,
        swipes: [raw],
        swipe_id: 0,
        swipe_info: [{ extra: { stable: true } }],
        extra: { diff: { source: raw, metadata: { stable: true }, cache: ['unchanged'] }, persisted: true },
    }];
    installRules([sameLineDashRule()], chat);
    runtimeState.isStreamingGeneration = false;
    const before = structuredClone(chat[0]);

    purifyDOM(built.message);
    assert.equal(node.nodeValue, '山河，');
    assert.equal(wrapper.childNodes[0], node);
    assert.deepEqual(chat[0], before);

    node.nodeValue = raw;
    purifyDOM(built.message);
    assert.equal(node.nodeValue, '山河，');
    assert.deepEqual(chat[0], before);
});

function buildDashParagraphSurface(firstParts, secondParts, between = []) {
    const firstNodes = firstParts.map(text);
    const secondNodes = secondParts.map(text);
    const firstWrappers = firstNodes.map((node) => element('span', 'first-inline', node));
    const secondWrappers = secondNodes.map((node) => element('em', 'second-inline', node));
    const paragraphs = [element('p', '', ...firstWrappers), element('p', '', ...secondWrappers)];
    const surface = element('div', 'mes_text', paragraphs[0], ...between, paragraphs[1]);
    return { surface, paragraphs, firstNodes, secondNodes, firstWrappers, secondWrappers };
}

test('cross-paragraph dash display changes only symbols and preserves every paragraph and inline wrapper', () => {
    const raw = '山河——\n——依旧';
    const built = buildDashParagraphSurface(['山河', '—', '—'], ['—', '—', '依旧']);
    const message = new FakeElement('div', { className: 'mes', attributes: { is_user: 'false' } }).append(built.surface);
    installDom([message]);
    const chat = [{ mes: raw, swipes: [raw], swipe_id: 0, swipe_info: [{ extra: { stable: true } }] }];
    installRules([crossParagraphDashRule()], chat);
    const before = structuredClone(chat[0]);
    const paragraphIdentities = [...built.paragraphs];
    const firstWrapperIdentities = [...built.firstWrappers];
    const secondWrapperIdentities = [...built.secondWrappers];

    assert.equal(applyVisualMask(raw), '山河，依旧');
    assert.equal(applyStreamingVisualMask(built.surface, raw, applyVisualMask(raw)), true);
    assert.deepEqual([values(built.firstNodes).join(''), values(built.secondNodes).join('')], ['山河，', '依旧']);
    assert.deepEqual(built.surface.childNodes, paragraphIdentities);
    assert.deepEqual(built.paragraphs[0].childNodes, firstWrapperIdentities);
    assert.deepEqual(built.paragraphs[1].childNodes, secondWrapperIdentities);
    assert.equal(built.surface.childNodes.length, 2);
    assert.deepEqual(chat[0], before);
});

test('cross-paragraph preview keeps the boundary with no leading dash and defers incomplete leading-dash removal', () => {
    const cases = [
        { raw: '山河——\n依旧', second: ['依旧'], expected: ['山河，', '依旧'] },
        { raw: '山河——\n——', second: ['—', '—'], expected: ['山河，', '——'] },
        { raw: '山河——\n——依', second: ['—', '—', '依'], expected: ['山河，', '依'] },
    ];

    for (const fixture of cases) {
        const built = buildDashParagraphSurface(['山河', '—', '—'], fixture.second);
        installDom([new FakeElement('div', { className: 'mes' }).append(built.surface)]);
        installRules([crossParagraphDashRule()], [{ mes: fixture.raw }]);
        const identities = [...built.paragraphs];

        assert.equal(applyStreamingVisualMask(built.surface, fixture.raw, applyVisualMask(fixture.raw)), true);
        assert.deepEqual([values(built.firstNodes).join(''), values(built.secondNodes).join('')], fixture.expected);
        assert.deepEqual(built.surface.childNodes, identities);
    }
});

test('the same-line processor authorizes the paragraph-end comma but not next-paragraph dash removal', () => {
    const raw = '山河——\n——依旧';
    const built = buildDashParagraphSurface(['山河', '—', '—'], ['—', '—', '依旧']);
    installDom([new FakeElement('div', { className: 'mes' }).append(built.surface)]);
    installRules([sameLineDashRule()], [{ mes: raw }]);

    assert.equal(applyStreamingVisualMask(built.surface, raw, applyVisualMask(raw)), true);
    assert.deepEqual([values(built.firstNodes).join(''), values(built.secondNodes).join('')], ['山河，', '——依旧']);
});

test('dash projection activation requires an exact compiled processor with one comma replacement', () => {
    const configurations = [
        [],
        [{ ...sameLineDashRule(), enabled: false }],
        [{ ...sameLineDashRule(), replacements: ['。'] }],
        [{ ...sameLineDashRule(), replacements: ['，', '。'] }],
        [subRule('regex', '/(?<=[\\u3400-\\u9fff])—+(?=[\\u4e00-\\u9fff])/gu', ['，'])],
    ];

    for (const rules of configurations) {
        const node = text('山河——');
        const surface = element('div', 'mes_text', node);
        installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
        installRules(rules, [{ mes: '山河——' }]);
        assert.equal(applyStreamingVisualMask(surface, '山河——', applyVisualMask('山河——')), false);
        assert.equal(node.nodeValue, '山河——');
    }

    const node = text('山河——');
    const surface = element('div', 'mes_text', node);
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    installRules([crossParagraphDashRule()], [{ mes: '山河——' }]);
    assert.equal(applyStreamingVisualMask(surface, '山河——', applyVisualMask('山河——')), true);
    assert.equal(node.nodeValue, '山河，');
});

test('unrelated newline-consuming processors remain final-only while the dash exception is active', () => {
    const nodes = [text('A'), text('B')];
    const surface = element('div', 'mes_text', element('p', '', nodes[0]), element('p', '', nodes[1]));
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    installRules([sameLineDashRule(), subRule('regex', '/A\\nB/gu', ['X'])], [{ mes: 'A\nB' }]);

    assert.equal(applyVisualMask('A\nB'), 'X');
    assert.equal(applyStreamingVisualMask(surface, 'A\nB', applyVisualMask('A\nB')), false);
    assert.deepEqual(values(nodes), ['A', 'B']);
});

test('dash exception stays outside protected content and does not cross structural or message boundaries', () => {
    const protectedNodes = [text('山河——'), text('山河——'), text('山河——'), text('山河——'), text('山河——')];
    const editable = element('span', '', protectedNodes[4]);
    editable.setAttribute('contenteditable', 'true');
    const protectedSurface = element('div', 'mes_text',
        element('code', '', protectedNodes[0]),
        element('pre', '', protectedNodes[1]),
        element('span', 'mes_reasoning', protectedNodes[2]),
        element('span', '', protectedNodes[3]),
        editable);
    protectedSurface.childNodes[3].setAttribute('id', 'blai-purifier-popup');
    const { document } = installDom([new FakeElement('div', { className: 'mes' }).append(protectedSurface)]);
    document.activeElement = editable;
    installRules([crossParagraphDashRule()], [{ mes: '山河——' }]);
    assert.equal(applyStreamingVisualMask(protectedSurface, '山河——', applyVisualMask('山河——')), false);
    assert.deepEqual(values(protectedNodes), ['山河——', '山河——', '山河——', '山河——', '山河——']);

    for (const barrier of [element('br'), element('hr'), element('code', '', text('protected'))]) {
        const built = buildDashParagraphSurface(['山河', '—', '—'], ['依旧'], [barrier]);
        installDom([new FakeElement('div', { className: 'mes' }).append(built.surface)]);
        installRules([crossParagraphDashRule()], [{ mes: '山河——\n依旧' }]);
        assert.equal(applyStreamingVisualMask(built.surface, '山河——\n依旧', applyVisualMask('山河——\n依旧')), false);
        assert.deepEqual([values(built.firstNodes).join(''), values(built.secondNodes).join('')], ['山河——', '依旧']);
    }

    const first = buildDashParagraphSurface(['山河', '—', '—'], ['unrelated']);
    const second = buildDashParagraphSurface(['依旧'], ['unrelated']);
    installDom([
        new FakeElement('div', { className: 'mes' }).append(first.surface),
        new FakeElement('div', { className: 'mes' }).append(second.surface),
    ]);
    installRules([crossParagraphDashRule()], [{ mes: '山河——\n依旧' }, { mes: '依旧' }]);
    assert.equal(applyStreamingVisualMask(first.surface, '山河——\n依旧', applyVisualMask('山河——\n依旧')), false);
    assert.equal(values(first.firstNodes).join(''), '山河——');
});

test('dash exception preserves scope-tag correspondence no-op when Markdown obscures the protected range', () => {
    const node = text('山河——');
    const surface = element('div', 'mes_text', node);
    installDom([new FakeElement('div', { className: 'mes' }).append(surface)]);
    const raw = '<keep>**山河——**</keep>';
    installRules([sameLineDashRule()], [{ mes: raw }], {
        scopeTags: [{ enabled: true, startTag: '<keep>', endTag: '</keep>' }],
        scopeTagMode: 'protect',
    });

    assert.equal(applyStreamingVisualMask(surface, raw, applyVisualMask(raw)), false);
    assert.equal(node.nodeValue, '山河——');
});
