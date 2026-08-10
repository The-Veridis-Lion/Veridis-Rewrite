#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    applyWithXmlCommentsProtected,
    collectXmlCommentRanges,
    maskXmlCommentRanges,
} from '../src/aiCommentProtection.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const aiRewriteSource = fs.readFileSync(path.join(repoRoot, 'src', 'aiRewrite.js'), 'utf8');
const templateSource = fs.readFileSync(path.join(repoRoot, 'templates', 'purifier.html'), 'utf8');
const eventsSource = fs.readFileSync(path.join(repoRoot, 'src', 'events.js'), 'utf8');

const comment = '<!-- auto-illustrator:promptId=prompt_i23aag,imageUrl=/user/images/京港高中/京港高中_2026-02-20@01h43m53s.png -->';
const source = `<content>他显得极其强硬。${comment}继续正文。</content>`;
const ranges = collectXmlCommentRanges(source);

assert.equal(ranges.length, 1, '应识别一段 HTML/XML 注释');
assert.equal(source.slice(ranges[0].start, ranges[0].end), comment, '识别出的注释范围必须完整');
assert.equal(maskXmlCommentRanges(source, ranges).length, source.length, '遮蔽注释不能改变文本长度');

const transform = (value) => value.replaceAll('极其', '').replaceAll('promptId', 'prompt');
const protectedResult = applyWithXmlCommentsProtected(source, transform, true);
const unprotectedResult = applyWithXmlCommentsProtected(source, transform, false);

assert.equal(protectedResult.includes('他显得强硬'), true, '保护开启时仍应改写注释外正文');
assert.equal(protectedResult.includes(comment), true, '保护开启时注释必须逐字保留');
assert.equal(unprotectedResult.includes('promptId='), false, '保护关闭时应保留原有可改写行为');

assert.match(aiRewriteSource, /protectXmlComments/u);
assert.match(aiRewriteSource, /collectXmlCommentRanges/u);
assert.match(aiRewriteSource, /rangeOverlapsAny\(start, end, commentRanges\)/u);
assert.match(aiRewriteSource, /applyWithXmlCommentsProtected/u);
assert.match(templateSource, /id="blai-ai-protect-comments"/u);
assert.match(eventsSource, /updateAiRewriteSetting\('protectXmlComments'/u);

console.log('AI HTML/XML 注释保护验证通过');
