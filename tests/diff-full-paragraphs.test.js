import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildDiffResultFromPair, buildDiffResultFromStages } from '../src/diff.js';

function getFullDiffBlocks(fullDiff) {
    return Array.from(fullDiff.matchAll(/<div class="(blai-diff-full-(?:modified|normal))">([\s\S]*?)<\/div>/g), match => ({
        className: match[1],
        html: match[2],
    }));
}

function getTextContent(html) {
    return html.replace(/<[^>]+>/g, '');
}

function hashSnippets(snippets) {
    return createHash('sha256').update(JSON.stringify(snippets)).digest('hex');
}

const pairFixtures = {
    pair: ['第一段旧文本\n第二段旧文本', '第一段新文本\n第二段新文本'],
    multi: ['正文 旧A 正文 旧B 正文', '正文 新A 正文 新B 正文'],
    sandwich: ['第一段旧\n中间不变\n第三段旧', '第一段新\n中间不变\n第三段新'],
    blank: ['第一段旧\n\n\n第二段旧', '第一段新\n\n\n第二段新'],
    lf: ['第一段旧\n第二段旧', '第一段新\n第二段新'],
    crlf: ['第一段旧\r\n第二段旧', '第一段新\r\n第二段新'],
};

const sourceStages = [
    '程序旧\nAI旧\n手工旧',
    '程序新\nAI旧\n手工旧',
    '程序新\nAI新\n手工旧',
    '程序新\nAI新\n手工新',
];

test('full diff separates two changed paragraphs at one LF boundary', () => {
    const { fullDiff } = buildDiffResultFromPair(...pairFixtures.pair);
    const blocks = getFullDiffBlocks(fullDiff);

    assert.deepEqual(blocks.map(block => block.className), [
        'blai-diff-full-modified',
        'blai-diff-full-modified',
    ]);
    assert.match(blocks[0].html, /第一段/);
    assert.doesNotMatch(blocks[0].html, /第二段/);
    assert.match(blocks[1].html, /第二段/);
});

test('full diff keeps multiple changes in one paragraph block', () => {
    const { fullDiff } = buildDiffResultFromPair(...pairFixtures.multi);
    const blocks = getFullDiffBlocks(fullDiff);

    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].className, 'blai-diff-full-modified');
    assert.equal((blocks[0].html.match(/<del\b/g) || []).length, 2);
    assert.equal((blocks[0].html.match(/<ins\b/g) || []).length, 2);
});

test('full diff retains changed, unchanged, changed paragraphs in order', () => {
    const { fullDiff } = buildDiffResultFromPair(...pairFixtures.sandwich);
    const blocks = getFullDiffBlocks(fullDiff);

    assert.deepEqual(blocks.map(block => block.className), [
        'blai-diff-full-modified',
        'blai-diff-full-normal',
        'blai-diff-full-modified',
    ]);
    assert.deepEqual(blocks.map(block => getTextContent(block.html)), [
        '第一段旧新',
        '中间不变',
        '第三段旧新',
    ]);
});

test('full diff ignores consecutive blank lines without merging non-empty paragraphs', () => {
    const { fullDiff } = buildDiffResultFromPair(...pairFixtures.blank);
    const blocks = getFullDiffBlocks(fullDiff);

    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks.map(block => getTextContent(block.html)), [
        '第一段旧新',
        '第二段旧新',
    ]);
    assert.ok(blocks.every(block => block.html.trim().length > 0));
});

test('full diff uses equivalent paragraph grouping for LF and CRLF', () => {
    const lfBlocks = getFullDiffBlocks(buildDiffResultFromPair(...pairFixtures.lf).fullDiff);
    const crlfBlocks = getFullDiffBlocks(buildDiffResultFromPair(...pairFixtures.crlf).fullDiff);

    assert.deepEqual(crlfBlocks.map(block => block.className), lfBlocks.map(block => block.className));
    assert.deepEqual(crlfBlocks.map(block => getTextContent(block.html)), lfBlocks.map(block => getTextContent(block.html)));
    assert.equal(lfBlocks.length, 2);
});

test('full diff preserves program, AI, and manual insertion sources across paragraphs', () => {
    const { fullDiff } = buildDiffResultFromStages(...sourceStages);
    const blocks = getFullDiffBlocks(fullDiff);

    assert.deepEqual(blocks.map(block => block.className), [
        'blai-diff-full-modified',
        'blai-diff-full-modified',
        'blai-diff-full-modified',
    ]);
    assert.deepEqual(blocks.map(block => block.html.match(/data-blai-diff-source="([^"]+)"/)?.[1]), [
        'program',
        'ai',
        'manual',
    ]);
    assert.ok(blocks.every(block => /data-blai-old-start=/.test(block.html)));
    assert.ok(blocks.every(block => /data-blai-old-end=/.test(block.html)));
    assert.ok(blocks.every(block => /data-blai-new-start=/.test(block.html)));
    assert.ok(blocks.every(block => /data-blai-new-end=/.test(block.html)));
});

test('snippet output remains byte-identical to the pre-change fixtures', () => {
    const baselines = {
        pair: '09f0e3adb9dddd8a7a96a8cfccaae898c3ef9d6b9ac5b29e3aa9eec482454147',
        multi: 'b10d8305dd72becec55ed2ee8480299c6e89ae4ff9af53c2d6574fdd630961b2',
        sandwich: 'b9181fa60eb674829798bbbfedb5075cf343ba09c9ff369e12fb8956ed9742b8',
        blank: '5afcf1660438c14c722905246a5bc2849f7e7ea6840cea567b97e4d89f5b2c89',
        lf: '69058757e08706908e3ca0d18783f5087fac05b3d7771e320afe867bcbe4748d',
        crlf: '64727c963dd65547f06a8dd78b445f40b2711685adec5fcdd37f2146a7331a1a',
        sources: 'ca53bc7a59e401d84f061ab6d16fe96a240cfdb706b824d771fddb5387255f6f',
    };

    for (const [name, fixture] of Object.entries(pairFixtures)) {
        assert.equal(hashSnippets(buildDiffResultFromPair(...fixture).snippets), baselines[name], name);
    }
    assert.equal(hashSnippets(buildDiffResultFromStages(...sourceStages).snippets), baselines.sources, 'sources');
});
