// Run against the actual extracted release/remote file set, not only the working tree.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
const root = path.resolve(process.env.VERIDIS_DISTRIBUTION_ROOT || fileURLToPath(new URL('..', import.meta.url)));
test('distributed entry and relative module dependencies are complete', () => {
    const pending = ['index.js'], seen = new Set();
    while (pending.length) {
        const relative = pending.pop();
        if (seen.has(relative)) continue;
        seen.add(relative);
        const filename = path.join(root, relative);
        assert.ok(fs.existsSync(filename), `Missing distributed module: ${relative}`);
        const source = fs.readFileSync(filename, 'utf8');
        const imports = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\bnew\s+URL\(\s*)['"]([^'"]+)['"]/g;
        for (const match of source.matchAll(imports)) {
            if (!match[1].startsWith('.')) continue;
            const target = path.resolve(path.dirname(filename), match[1]);
            const dependency = path.relative(root, target);
            if (dependency.startsWith('..') || path.isAbsolute(dependency)) continue; // host-owned modules
            assert.ok(fs.existsSync(target), `${relative} imports missing ${dependency}`);
            if (target.endsWith('.js')) pending.push(dependency);
        }
    }
    assert.ok(seen.size > 1, 'entry dependency graph must be traversed');
});
