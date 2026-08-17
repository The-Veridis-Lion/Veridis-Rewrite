import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyHostGenerationStart } from '../src/hostGenerationEvent.js';

test('quiet host generations do not supersede the active rewrite generation', () => {
    assert.deepEqual(classifyHostGenerationStart('quiet', { quiet_prompt: 'background work' }, false), {
        track: false,
        mode: 'quiet',
        reason: 'background-generation',
    });
});

test('dry-run prompt assembly does not supersede the active rewrite generation', () => {
    assert.deepEqual(classifyHostGenerationStart('normal', {}, true), {
        track: false,
        mode: 'normal',
        reason: 'dry-run',
    });
});

test('foreground normal, regenerate and swipe generations remain superseding events', () => {
    for (const mode of ['normal', 'regenerate', 'swipe']) {
        assert.deepEqual(classifyHostGenerationStart(mode, {}, false), {
            track: true,
            mode,
            reason: '',
        });
    }
});

