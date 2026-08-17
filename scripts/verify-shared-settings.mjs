#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const stateSource = fs.readFileSync(path.join(repoRoot, 'src', 'state.js'), 'utf8');
const indexSource = [
    fs.readFileSync(path.join(repoRoot, 'index.js'), 'utf8'),
    fs.readFileSync(path.join(repoRoot, 'src', 'settingsMigration.js'), 'utf8'),
].join('\n');
const readmeSource = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
const templateSource = fs.readFileSync(path.join(repoRoot, 'templates', 'purifier.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifest.json'), 'utf8'));

assert.match(stateSource, /export const extensionName = "ultimate_purifier_ai_rewrite"/u);
assert.match(stateSource, /export const modifiedExtensionName = "ultimate_purifier_ai_rewrite_modified"/u);
assert.match(stateSource, /diffMetadataKey = `\$\{extensionName\}_diff_state_v3`/u);
assert.match(indexSource, /function maybeImportModifiedSettingsIntoSharedNamespace\(\)/u);
assert.match(indexSource, /extension_settings\[extensionName\] = clonePlain\(modifiedSettings\)/u);
assert.match(indexSource, /hasConfiguredAiRewrite\(settings\)/u);
assert.match(indexSource, /Object\.prototype\.hasOwnProperty\.call\(aiSettings, key\)/u);
assert.match(indexSource, /maybeImportModifiedSettingsIntoSharedNamespace\(\)/u);
assert.match(templateSource, /id="blai-ai-top-p"/u);
assert.doesNotMatch(templateSource, /id="vrm-/u);
assert.equal(manifest.version, '2.6');
assert.doesNotMatch(manifest.display_name, /Modified/u);
assert.match(readmeSource, /当前版本：`2\.6`/u);

console.log('共享设置迁移与原版 blai 运行命名空间验证通过');
