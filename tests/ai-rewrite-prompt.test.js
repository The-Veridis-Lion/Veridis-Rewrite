import test from 'node:test';
import assert from 'node:assert/strict';

import {
    aiRewritePromptProtocolVersion,
    defaultAiRewritePrompt,
} from '../src/state.js';
import { normalizePresetAiRewriteSettings } from '../src/utils.js';

test('legacy preset prompts migrate to the compact protocol', () => {
    const normalized = normalizePresetAiRewriteSettings({
        promptTemplate: 'legacy {{rewriteItemsJson}}',
    });

    assert.equal(normalized.promptProtocolVersion, aiRewritePromptProtocolVersion);
    assert.equal(normalized.promptTemplate, defaultAiRewritePrompt);
    assert.match(normalized.promptTemplate, /{{rewriteRulesJson}}/);
    assert.match(normalized.promptTemplate, /{{localFallbackCandidatesJson}}/);
    assert.match(normalized.promptTemplate, /{{annotatedSource}}/);
    assert.doesNotMatch(normalized.promptTemplate, /rewriteItemsJson|rewriteGroups|beforeContext|afterContext/);
});

test('current compact custom prompts remain user-controlled', () => {
    const normalized = normalizePresetAiRewriteSettings({
        promptProtocolVersion: aiRewritePromptProtocolVersion,
        promptTemplate: '自定义 {{annotatedSource}}',
    });

    assert.equal(normalized.promptTemplate, '自定义 {{annotatedSource}}');
});
