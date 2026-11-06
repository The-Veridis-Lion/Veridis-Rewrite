import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderDiffDocument } from '../src/diff/compare.js';

test('full preview omits an unchanged second stage without mutating recorded text', () => {
    const pairs = [{section:'ai',oldText:'旧标题。正文。',newText:'新标题。正文。'},
        {section:'program',oldText:'新标题。正文。',newText:'新标题。正文。'}];
    const before = structuredClone(pairs);
    assert.equal(renderDiffDocument(pairs,'full').length,1);
    assert.deepEqual(pairs,before);
});
test('full preview retains both changed stages and a standalone unchanged record', () => {
    assert.equal(renderDiffDocument([{section:'ai',oldText:'甲。',newText:'乙。'},
        {section:'program',oldText:'乙。',newText:'丙。'}],'full').length,2);
    assert.equal(renderDiffDocument([{section:'program',oldText:'甲。',newText:'甲。'}],'full').length,1);
});
