import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const partialNames = [
    '01-foundation.css',
    '02-shell-and-lists.css',
    '03-dialogs-and-diff.css',
    '04-legacy-responsive.css',
    '05-current-shell.css',
    '05-home-page.css',
    '06-current-responsive.css',
    '06-clean-page.css',
    '06-tools-page.css',
    '07-cascade-seal.css',
];

function relativeLuminance(hex) {
    const channels = hex.match(/[a-f\d]{2}/gi).map((channel) => Number.parseInt(channel, 16) / 255);
    const [red, green, blue] = channels.map((channel) => (
        channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4
    ));
    return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}

function contrastRatio(first, second) {
    const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
    return (lighter + 0.05) / (darker + 0.05);
}

test('style.css imports every CSS layer in the declared cascade order', async () => {
    const imports = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    assert.equal(imports, `${partialNames.map((name) => `@import url('./styles/${name}');`).join('\n')}\n`);
    await Promise.all(partialNames.map((name) => readFile(new URL(`../styles/${name}`, import.meta.url), 'utf8')));
});

test('plugin theme is local, defaults to auto, and has readable light tokens', async () => {
    const foundation = await readFile(new URL('../styles/01-foundation.css', import.meta.url), 'utf8');
    const template = await readFile(new URL('../templates/purifier.html', import.meta.url), 'utf8');
    const aiSettings = await readFile(new URL('../src/events/aiSettings.js', import.meta.url), 'utf8');

    assert.match(template, /id="blai-purifier-popup"[^>]*data-theme="auto"/);
    assert.match(aiSettings, /\.attr\('data-theme', normalized\)/);
    assert.doesNotMatch(foundation, /(^|,)\s*(html|:root|body)(?=\s*[{[,])/m);
    assert.match(foundation, /\[data-theme="auto"\][\s\S]*?--bg-base: var\(--SmartThemeBlurTintColor\);[\s\S]*?--bg-surface: var\(--SmartThemeBlurTintColor\);[\s\S]*?--accent-color: var\(--SmartThemeQuoteColor\);[\s\S]*?--text-main: var\(--SmartThemeBodyColor\);[\s\S]*?--text-secondary: color-mix\(\s*in srgb,\s*var\(--SmartThemeBodyColor\) 68%,\s*transparent\s*\);[\s\S]*?--border-color: var\(--SmartThemeBorderColor\);/);
    assert.doesNotMatch(foundation, /--text-secondary:\s*var\(--SmartThemeEmColor\)/);
    assert.doesNotMatch(foundation, /--(?:bg-base|bg-surface|accent-color|text-main|text-secondary|border-color): var\(--SmartTheme[^)]*,/);
    assert.match(foundation, /\[data-theme="light"\][\s\S]*?--bg-base: #F5F7F4;[\s\S]*?--bg-surface: #FFFFFF;[\s\S]*?--accent-color: #5C7662;[\s\S]*?--text-main: #3A403C;[\s\S]*?--text-secondary: #657068;[\s\S]*?--border-color: #E2E8E4;/);
    assert.match(foundation, /\[data-theme="dark"\][\s\S]*?--bg-base: #1C1D1A;[\s\S]*?--bg-surface: #252622;[\s\S]*?--accent-color: #D4B872;[\s\S]*?--text-main: #E0E3DD;[\s\S]*?--text-secondary: #9B9E98;[\s\S]*?--border-color: #383A35;/);
    assert.doesNotMatch(foundation, /#(?:8AA691|7A857D)/i);
    assert.ok(contrastRatio('#5C7662', '#F5F7F4') >= 4.5);
    assert.ok(contrastRatio('#5C7662', '#FFFFFF') >= 4.5);
});

test('CSS partials have no self-referential theme properties or page-local core tokens', async () => {
    const partials = await Promise.all(partialNames.map(async (name) => [
        name,
        await readFile(new URL(`../styles/${name}`, import.meta.url), 'utf8'),
    ]));
    const selfReferences = partials.flatMap(([name, css]) => [...css.matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*var\(\1\)/g)]
        .map((match) => `${name}: ${match[0]}`));
    const cleanPageCss = partials.find(([name]) => name === '06-clean-page.css')[1];
    const toolsPageCss = partials.find(([name]) => name === '06-tools-page.css')[1];
    const allCss = partials.map(([, css]) => css).join('\n');
    const coreThemeToken = '(?:bg-base|bg-surface|accent-color|text-main|text-secondary|border-color)';

    assert.deepEqual(selfReferences, []);
    assert.doesNotMatch(allCss, /#(?:8AA691|7A857D)/i);
    assert.doesNotMatch(cleanPageCss, new RegExp(`\\.blai-clean-page\\s*\\{[^}]*--${coreThemeToken}\\s*:`, 's'));
    assert.doesNotMatch(toolsPageCss, new RegExp(`\\.blai-tools-page\\s*\\{[^}]*--${coreThemeToken}\\s*:`, 's'));
});

test('desktop and sticky home canvases share the surface token', async () => {
    const homePageCss = await readFile(new URL('../styles/05-home-page.css', import.meta.url), 'utf8');
    const cascadeSealCss = await readFile(new URL('../styles/07-cascade-seal.css', import.meta.url), 'utf8');

    assert.match(cascadeSealCss, /@media \(min-width: 601px\) \{[\s\S]*?\.pages \{[\s\S]*?background: var\(--bg-surface\) !important;/);
    assert.match(homePageCss, /\.blai-home-sticky-controls \{[\s\S]*?background: var\(--bg-surface\);/);
});

test('Diff rewrite sources have distinct component-owned legend and insertion treatments', async () => {
    const css = await readFile(new URL('../styles/03-dialogs-and-diff.css', import.meta.url), 'utf8');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
        selectors: match[1].split(',').map((selector) => selector.trim()),
        body: match[2],
    }));
    const uniqueRuleBody = (selector) => {
        const owners = rules.filter((rule) => rule.selectors.includes(selector));
        assert.equal(owners.length, 1, `${selector} must have exactly one owner`);
        return owners[0].body;
    };
    const treatment = (body) => ({
        color: body.match(/color:\s*([^;]+);/)?.[1],
        background: body.match(/background:\s*([^;]+);/)?.[1],
    });
    const modalOwner = uniqueRuleBody('#blai-diff-modal');
    const sourceTreatments = {};

    for (const source of ['program', 'ai', 'manual']) {
        const colorToken = `--blai-diff-source-${source}-color`;
        const backgroundToken = `--blai-diff-source-${source}-background`;
        assert.match(modalOwner, new RegExp(`${colorToken}:`));
        assert.match(modalOwner, new RegExp(`${backgroundToken}:`));
        assert.equal(css.match(new RegExp(`${colorToken}:`, 'g'))?.length, 1);
        assert.equal(css.match(new RegExp(`${backgroundToken}:`, 'g'))?.length, 1);

        const legendLabel = uniqueRuleBody(`.blai-diff-legend-item[data-source="${source}"]`);
        const legendDot = uniqueRuleBody(`.blai-diff-legend-item[data-source="${source}"] i`);
        assert.match(legendLabel, new RegExp(`color: var\\(${colorToken}\\) !important;`));
        assert.match(legendDot, new RegExp(`background: var\\(${colorToken}\\) !important;`));

        const snippet = uniqueRuleBody(`.blai-diff-snippet ins[data-blai-diff-source="${source}"]`);
        const fullText = uniqueRuleBody(`.blai-diff-full-modified ins[data-blai-diff-source="${source}"]`);
        sourceTreatments[source] = treatment(snippet);
        assert.deepEqual(treatment(fullText), sourceTreatments[source]);
        assert.deepEqual(sourceTreatments[source], {
            color: `var(${colorToken}) !important`,
            background: `var(${backgroundToken}) !important`,
        });
    }

    assert.equal(new Set(Object.values(sourceTreatments).map(JSON.stringify)).size, 3);
    assert.doesNotMatch(uniqueRuleBody('.blai-diff-legend-item[data-source="ai"] i'), /var\(--accent-color\)/);
    assert.doesNotMatch(uniqueRuleBody('.blai-diff-legend-item[data-source="manual"] i'), /var\(--accent-color\)/);
    assert.doesNotMatch(sourceTreatments.ai.color, /var\(--accent-color\)/);
    assert.doesNotMatch(sourceTreatments.manual.color, /var\(--accent-color\)/);
    assert.doesNotMatch(css, /#blai-diff-modal\[data-theme="dark"\][^{]*(?:data-source="manual"|data-blai-diff-source="manual")/);

    for (const selector of ['.blai-diff-snippet del', '.blai-diff-full-modified del']) {
        const deletion = uniqueRuleBody(selector);
        assert.match(deletion, /color: var\(--status-danger\) !important;/);
        assert.doesNotMatch(deletion, /--blai-diff-source-/);
    }
});

test('phone clean-mode cards preserve two columns and a readable compact interior', async () => {
    const cleanPageCss = await readFile(new URL('../styles/06-clean-page.css', import.meta.url), 'utf8');

    assert.match(cleanPageCss, /@media \(max-width: 700px\) \{[\s\S]*?\.blai-clean-mode-cards \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);[\s\S]*?gap: 8px;/);
    assert.doesNotMatch(cleanPageCss, /@media \(max-width: 700px\) \{[\s\S]*?\.blai-clean-mode-cards \{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/);
    assert.match(cleanPageCss, /@media \(max-width: 700px\) \{[\s\S]*?\.blai-clean-mode-card \{[\s\S]*?grid-template-columns: 18px minmax\(0, 1fr\);[\s\S]*?\.blai-clean-mode-copy > span \{[\s\S]*?font-size: 10px;/);
});

test('home previews use two matching badges and aligned, bold source and target rows', async () => {
    const ui = await readFile(new URL('../src/ui.js', import.meta.url), 'utf8');
    const homePageCss = await readFile(new URL('../styles/05-home-page.css', import.meta.url), 'utf8');

    assert.match(ui, /'<span class="blai-home-rule-badge">AI 改写<\/span>'/);
    assert.doesNotMatch(ui, /blai-home-rule-badge-muted/);
    assert.doesNotMatch(homePageCss, /\.blai-home-rule-badge-muted/);
    assert.match(homePageCss, /\.blai-home-rule-labels \{[\s\S]*?min-height: 18px;/);
    assert.match(homePageCss, /\.blai-home-source-text,\s*\n#blai-purifier-popup \.blai-home-target-text \{[\s\S]*?color: var\(--text-main\);[\s\S]*?font-size: 12px;[\s\S]*?font-weight: 750;[\s\S]*?line-height: 1\.35;/);
    assert.match(homePageCss, /\.blai-home-preview-label \{[\s\S]*?min-height: 18px;[\s\S]*?display: inline-flex;[\s\S]*?align-items: center;[\s\S]*?color: var\(--text-main\);[\s\S]*?font-weight: 750;/);
});

test('toast has a surface, readable content, and a visible edge without inline icon styling', async () => {
    const legacyResponsiveCss = await readFile(new URL('../styles/04-legacy-responsive.css', import.meta.url), 'utf8');
    const ui = await readFile(new URL('../src/ui.js', import.meta.url), 'utf8');

    assert.match(legacyResponsiveCss, /\.blai-toast \{[\s\S]*?border: 1px solid color-mix\([\s\S]*?background: var\(--bg-surface\) !important;[\s\S]*?color: var\(--text-main\) !important;[\s\S]*?box-shadow: 0 12px 32px color-mix\(in srgb, var\(--text-main\) 24%, transparent\) !important;/);
    assert.match(legacyResponsiveCss, /\.blai-toast > i \{[\s\S]*?color: inherit;[\s\S]*?font-size: 15px;/);
    assert.doesNotMatch(legacyResponsiveCss, /background: color-mix\(in srgb, var\(--bg-base\) 85%, transparent\) !important;[\s\S]*?color: var\(--bg-surface\) !important;/);
    assert.doesNotMatch(ui, /blai-toast[\s\S]*?style="margin-right: 6px; font-size: 15px;"/);
});

test('AI rewrite toast has one content-sensitive responsive owner without phone overrides', async () => {
    const css = await readFile(new URL('../styles/03-dialogs-and-diff.css', import.meta.url), 'utf8');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
        selectors: match[1].split(',').map((selector) => selector.trim()),
        body: match[2],
    }));
    const ruleBodies = (selector) => {
        return rules.filter((rule) => rule.selectors.includes(selector)).map((rule) => rule.body);
    };
    const uniqueRuleBody = (selector) => {
        const bodies = ruleBodies(selector);
        assert.equal(bodies.length, 1, `${selector} must have exactly one owner across base and media rules`);
        return bodies[0];
    };
    const toast = uniqueRuleBody('body #toast-container > .blai-ai-rewrite-toast');
    const progress = uniqueRuleBody('body #toast-container > .blai-ai-rewrite-toast.blai-ai-rewrite-progress-toast');
    const title = uniqueRuleBody('body #toast-container > .blai-ai-rewrite-toast > .toast-title');
    const message = uniqueRuleBody('body #toast-container > .blai-ai-rewrite-toast > .toast-message');
    const progressTitle = uniqueRuleBody('body #toast-container > .blai-ai-rewrite-toast.blai-ai-rewrite-progress-toast > .toast-title');
    const progressMessage = uniqueRuleBody('body #toast-container > .blai-ai-rewrite-toast.blai-ai-rewrite-progress-toast > .toast-message');
    const close = uniqueRuleBody('body #toast-container > .blai-ai-rewrite-toast > .toast-close-button');
    const actions = uniqueRuleBody('body #toast-container > .blai-ai-rewrite-toast.blai-ai-rewrite-progress-toast > .blai-ai-toast-actions');
    const stop = uniqueRuleBody('.blai-ai-toast-stop');
    const stopHover = uniqueRuleBody('.blai-ai-toast-stop:hover');

    assert.match(toast, /width: fit-content !important;/);
    assert.match(toast, /min-width: min\(300px, 80vw\) !important;/);
    assert.match(toast, /max-width: min\(380px, 80vw\) !important;/);
    assert.doesNotMatch(toast, /(?:^|\n)\s*width:\s*(?:300|380)px/);
    assert.match(toast, /box-sizing: border-box !important;/);
    assert.match(toast, /text-align: left !important;/);
    assert.match(toast, /padding-block: 8px !important;/);
    assert.match(toast, /padding-right: 36px !important;/);
    assert.doesNotMatch(toast, /(?:^|\n)\s*padding(?:-left)?\s*:/);
    assert.doesNotMatch(css, /360px|blai-ai-completion-toast/);

    assert.match(progress, /display: grid !important;/);
    assert.match(progress, /grid-template-columns: minmax\(0, 1fr\) auto !important;/);
    assert.match(progress, /grid-template-areas:\s*"title title"\s*"message action" !important;/);
    assert.match(progress, /column-gap: 8px !important;/);
    assert.match(progress, /row-gap: 0 !important;/);
    assert.match(progress, /align-items: center !important;/);
    assert.doesNotMatch(progress, /(?:^|\n)\s*(?:width|min-width|max-width)\s*:/);
    assert.doesNotMatch(progress, /font-size|line-height/);

    assert.match(title, /font-size: calc\(14px \+ 1pt\) !important;/);
    assert.match(title, /line-height: 1\.2 !important;/);
    assert.match(title, /margin: 0 !important;/);
    assert.match(title, /text-align: left !important;/);
    assert.match(title, /white-space: nowrap !important;/);

    assert.match(message, /font-size: calc\(12\.5px \+ 1pt\) !important;/);
    assert.match(message, /line-height: 1\.2 !important;/);
    assert.match(message, /margin: 0 !important;/);
    assert.match(message, /min-width: 0 !important;/);
    assert.match(message, /white-space: normal !important;/);
    assert.match(message, /overflow-wrap: anywhere !important;/);
    assert.match(message, /display: -webkit-box !important;/);
    assert.match(message, /-webkit-box-orient: vertical !important;/);
    assert.match(message, /-webkit-line-clamp: 2 !important;/);
    assert.match(message, /overflow: hidden !important;/);
    assert.doesNotMatch(message, /white-space: nowrap|text-overflow: ellipsis/);
    assert.match(progressTitle, /grid-area: title !important;/);
    assert.match(progressMessage, /grid-area: message !important;/);
    assert.doesNotMatch(`${progressTitle}\n${progressMessage}`, /font-size|line-height/);
    assert.doesNotMatch(css, /(?:^|,)\s*\.toast-title\s*\{/m);
    assert.doesNotMatch(css, /(?:^|,)\s*\.toast-message\s*\{/m);
    assert.doesNotMatch(css, /(?:^|,)\s*\.toast-success\s*\{/m);
    assert.doesNotMatch(css, /(?:^|,)\s*\.toast-(?:info|warning|error)\s*\{/m);

    assert.match(actions, /grid-area: action !important;/);
    assert.match(stop, /min-height: 28px !important;/);
    assert.match(stop, /padding: 4px 8px !important;/);
    assert.match(stop, /font-size: 12px !important;/);
    assert.match(stop, /line-height: 1\.2 !important;/);
    assert.match(stop, /border: 1px solid color-mix\(in srgb, currentColor 65%, transparent\) !important;/);
    assert.match(stop, /background: color-mix\(in srgb, currentColor 14%, transparent\) !important;/);
    assert.match(stopHover, /background: color-mix\(in srgb, currentColor 24%, transparent\) !important;/);
    assert.match(stopHover, /border-color: currentColor !important;/);
    assert.doesNotMatch(`${stop}\n${stopHover}`, /--bg-base|--bg-surface/);
    for (const dimension of ['width', 'min-width', 'height', 'min-height']) {
        assert.match(close, new RegExp(`${dimension}: 32px !important;`));
    }
});

test('clean switches share their active state and have no skip-user visual special case', async () => {
    const partials = await Promise.all(partialNames.map(async (name) => [
        name,
        await readFile(new URL(`../styles/${name}`, import.meta.url), 'utf8'),
    ]));
    const cleanPageCss = partials.find(([name]) => name === '06-clean-page.css')[1];
    const allCss = partials.map(([, css]) => css).join('\n');

    assert.match(cleanPageCss, /\.blai-clean-group-switch\.is-on \.blai-clean-switch-track,\s*\n#blai-purifier-popup \.blai-clean-switch\[aria-pressed="true"\] \.blai-clean-switch-track,\s*\n#blai-purifier-popup \.blai-clean-tag-switch input:checked \+ \.blai-clean-switch-track,\s*\n#blai-purifier-popup \.blai-clean-checkbox-switch input:checked \+ \.blai-clean-switch-track \{[\s\S]*?background: var\(--accent-color\);/);
    assert.match(cleanPageCss, /\.blai-clean-group-switch:focus-visible \.blai-clean-switch-track,\s*\n#blai-purifier-popup \.blai-clean-switch:focus-visible \.blai-clean-switch-track,\s*\n#blai-purifier-popup \.blai-clean-tag-switch input:focus-visible \+ \.blai-clean-switch-track,\s*\n#blai-purifier-popup \.blai-clean-checkbox-switch input:focus-visible \+ \.blai-clean-switch-track/);
    assert.doesNotMatch(allCss, /#blai-skip-user-toggle/);
});

test('clean page has one non-override stylesheet owner', async () => {
    const cleanPageCss = await readFile(new URL('../styles/06-clean-page.css', import.meta.url), 'utf8');
    const cascadeSealCss = await readFile(new URL('../styles/07-cascade-seal.css', import.meta.url), 'utf8');
    const quickInputOwners = [...cleanPageCss.matchAll(/^#blai-purifier-popup \.blai-clean-add-field input \{([\s\S]*?)^\}/gm)];
    assert.equal(quickInputOwners.length, 1, 'quick tag input must have exactly one owner');
    assert.match(quickInputOwners[0][1], /(?:^|\n)    padding: 0 6px !important;/);
    assert.match(quickInputOwners[0][1], /(?:^|\n)    background: transparent !important;/);
    assert.deepEqual(
        [...cleanPageCss.matchAll(/^\s*[a-z-]+:\s*[^;\n]*!important;/gmi)].map((match) => match[0].trim()),
        ['padding: 0 6px !important;', 'background: transparent !important;'],
    );
    assert.equal(cleanPageCss.match(/!important/g)?.length, 2);
    assert.equal(cascadeSealCss.includes('.page-panel[data-page="clean"]'), false);
});

test('tools page has one non-override stylesheet owner', async () => {
    const toolsPageCss = await readFile(new URL('../styles/06-tools-page.css', import.meta.url), 'utf8');
    const cascadeSealCss = await readFile(new URL('../styles/07-cascade-seal.css', import.meta.url), 'utf8');
    assert.equal(toolsPageCss.includes('!important'), false);
    assert.equal(cascadeSealCss.includes('.page-panel[data-page="tools"]'), false);
});

test('home page has one non-override stylesheet owner', async () => {
    const homePageCss = await readFile(new URL('../styles/05-home-page.css', import.meta.url), 'utf8');
    const cascadeSealCss = await readFile(new URL('../styles/07-cascade-seal.css', import.meta.url), 'utf8');
    const responsiveCss = await readFile(new URL('../styles/06-current-responsive.css', import.meta.url), 'utf8');
    const authorizedImportantDeclarations = [
        'padding: 0 38px 0 14px !important;',
        'background-color: var(--bg-surface) !important;',
        'background-image: none !important;',
        'padding: 0 24px 0 9px !important;',
    ];
    assert.equal(homePageCss.match(/!important/g)?.length, authorizedImportantDeclarations.length);
    for (const declaration of authorizedImportantDeclarations) {
        assert.equal(homePageCss.split(declaration).length - 1, 1, `${declaration} must appear exactly once`);
    }
    assert.equal(cascadeSealCss.includes('blai-home-'), false);
    assert.equal(responsiveCss.includes('blai-home-'), false);
});

test('global header owns the sole page introduction and body columns start each page', async () => {
    const template = await readFile(new URL('../templates/purifier.html', import.meta.url), 'utf8');
    const count = (pattern) => template.match(pattern)?.length || 0;

    assert.equal(count(/id="blai-responsive-title"/g), 1);
    assert.equal(count(/id="blai-responsive-preset-title"/g), 1);
    assert.equal(count(/id="blai-responsive-description"/g), 1);
    assert.match(template, /<header class="blai-global-header">[\s\S]*?<div class="blai-global-actions">[\s\S]*?<\/div>\s*<p\s+id="blai-responsive-description"\s+class="blai-global-description"/);
    assert.doesNotMatch(template, /blai-(?:ai|clean|tools)-page-header/);
    assert.doesNotMatch(template, /<h1>\s*(?:AI 配置|净化与保护|工具与系统)\s*<\/h1>/);
    assert.match(template, /<div id="blai-ai-settings" class="blai-ai-settings">\s*<div class="blai-ai-columns">/);
    assert.match(template, /<div class="blai-clean-page">\s*<div class="blai-clean-columns">/);
    assert.match(template, /<div class="blai-tools-page">\s*<div class="blai-tools-columns">/);
    for (const heading of ['API 连接', '标签作用范围', '预设绑定解析']) {
        assert.match(template, new RegExp(`>${heading}<`));
    }
});

test('responsive page switching owns exact page titles and descriptions', async () => {
    const ui = await readFile(new URL('../src/ui.js', import.meta.url), 'utf8');
    const events = await readFile(new URL('../src/events.js', import.meta.url), 'utf8');
    const showPageStart = ui.indexOf("export function showResponsivePage(pageId = 'overview')");
    const showPageEnd = ui.indexOf('function buildRuleSearchHaystack', showPageStart);
    const showPage = ui.slice(showPageStart, showPageEnd);

    for (const [page, title, description] of [
        ['overview', '首页', '管理规则集、查看统计并编辑规则。'],
        ['ai', 'AI', '配置 AI 改写引擎、连接参数和全局提示词。'],
        ['clean', '净化', '管理需要被改写或保护的 XML 标签范围及深度净化设置。'],
        ['tools', '工具', '管理预设绑定、简繁转换及其他扩展功能。'],
    ]) {
        assert.match(ui, new RegExp(`${page}: \\{\\s*title: '${title}',\\s*description: '${description}',\\s*\\}`));
    }
    assert.match(ui, /bind: \{\s*title: '绑定',\s*description: '',\s*\}/);
    assert.match(showPage, /#blai-responsive-title'[)]\.text\(title\)/);
    assert.match(showPage, /#blai-responsive-description'[)]\.text\(description\)/);
    assert.equal(ui.match(/#blai-responsive-description/g)?.length, 1);
    assert.match(ui, /#blai-responsive-preset-title, #blai-responsive-mobile-preset-title, #blai-bind-active-preset'\)\.text\(activePresetLabel\)/);
    assert.equal(events.match(/\.on\('click', '#blai-purifier-popup \[data-page-target\]'/g)?.length, 1);
});

test('global header is a compact two-row grid with one responsive description owner', async () => {
    const homePageCss = await readFile(new URL('../styles/05-home-page.css', import.meta.url), 'utf8');
    const cascadeSealCss = await readFile(new URL('../styles/07-cascade-seal.css', import.meta.url), 'utf8');
    const header = homePageCss.match(/^#blai-purifier-popup \.blai-global-header \{([\s\S]*?)^\}/m)?.[1];
    const description = homePageCss.match(/^#blai-purifier-popup \.blai-global-description \{([\s\S]*?)^\}/m)?.[1];
    const phone = homePageCss.match(/@media \(max-width: 600px\) \{([\s\S]*?)^\}/m)?.[1];

    assert.ok(header, 'base global-header owner must remain present');
    assert.match(header, /grid-template-columns: minmax\(88px, 1fr\) auto minmax\(88px, 1fr\);/);
    assert.match(header, /grid-template-rows: auto auto;/);
    assert.match(header, /column-gap: 12px;/);
    assert.match(header, /row-gap: 4px;/);
    assert.doesNotMatch(header, /(?:^|\n)\s*gap:/);
    assert.ok(description, 'global description must have one base owner');
    assert.match(description, /grid-column: 1 \/ -1;/);
    assert.match(description, /grid-row: 2;/);
    assert.match(description, /margin: 0;/);
    assert.match(description, /color: var\(--text-secondary\);/);
    assert.match(description, /min-width: 0;/);
    assert.match(description, /max-width: 100%;/);
    assert.match(description, /overflow: hidden;/);
    assert.match(description, /text-align: center;/);
    assert.ok(phone, 'phone media owner must remain present');
    assert.match(phone, /\.blai-global-header \{[\s\S]*?grid-template-rows: auto auto;[\s\S]*?column-gap: 8px;[\s\S]*?row-gap: 4px;/);
    assert.match(phone, /\.blai-global-description \{[\s\S]*?overflow-wrap: anywhere;[\s\S]*?white-space: normal;/);
    assert.doesNotMatch(phone, /\.blai-global-description \{[^}]*font-size:\s*(?:[0-9]|9(?:\.\d+)?)px;/);
    assert.match(cascadeSealCss, /grid-template-rows: auto minmax\(0, 1fr\) !important;/);
    assert.doesNotMatch(cascadeSealCss, /grid-template-rows: 64px minmax\(0, 1fr\) !important;/);
    assert.equal(homePageCss.match(/#blai-purifier-popup \.blai-global-header \{/g)?.length, 3);
    assert.equal(homePageCss.match(/#blai-purifier-popup \.blai-global-description \{/g)?.length, 2);
    assert.equal(cascadeSealCss.includes('blai-global-header'), false);
});

test('obsolete body page-header CSS is removed while live section headers remain', async () => {
    const cleanPageCss = await readFile(new URL('../styles/06-clean-page.css', import.meta.url), 'utf8');
    const toolsPageCss = await readFile(new URL('../styles/06-tools-page.css', import.meta.url), 'utf8');
    const cascadeSealCss = await readFile(new URL('../styles/07-cascade-seal.css', import.meta.url), 'utf8');
    const allCss = `${cleanPageCss}\n${toolsPageCss}\n${cascadeSealCss}`;

    assert.doesNotMatch(allCss, /\.blai-(?:ai|clean|tools)-page-header/);
    assert.match(cascadeSealCss, /\.blai-ai-section-header/);
    assert.match(cleanPageCss, /\.blai-clean-section-header/);
    assert.match(toolsPageCss, /\.blai-tools-section-header/);
    assert.doesNotMatch(cleanPageCss, /\.blai-clean-page h1/);
    assert.doesNotMatch(toolsPageCss, /\.blai-tools-page h1/);
});

test('overview preset selector owns its theme-native presentation', async () => {
    const css = await readFile(new URL('../styles/05-home-page.css', import.meta.url), 'utf8');
    const ruleBodies = (selector) => {
        const selectorPattern = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return [...css.matchAll(new RegExp(`^${selectorPattern}\\s*\\{([\\s\\S]*?)^\\}`, 'gm'))]
            .map((match) => match[1]);
    };
    const uniqueRuleBody = (selector) => {
        const bodies = ruleBodies(selector);
        assert.equal(bodies.length, 1, `${selector} must have one base owner`);
        return bodies[0];
    };
    const field = uniqueRuleBody('#blai-purifier-popup .blai-home-preset-field');
    const arrow = uniqueRuleBody('#blai-purifier-popup .blai-home-preset-field::after');
    const select = uniqueRuleBody('#blai-purifier-popup .blai-home-preset-select');
    const option = uniqueRuleBody('#blai-purifier-popup .blai-home-preset-select option');
    const selectedOption = uniqueRuleBody('#blai-purifier-popup .blai-home-preset-select option:checked');
    const hover = uniqueRuleBody('#blai-purifier-popup .blai-home-preset-select:hover');
    const mobile = css.match(/@media \(max-width: 600px\) \{[\s\S]*?^    #blai-purifier-popup \.blai-home-preset-select \{([\s\S]*?)^    \}/m)?.[1];

    assert.match(field, /position: relative;/);
    assert.match(arrow, /border-right: 2px solid var\(--text-secondary\);/);
    assert.match(arrow, /border-bottom: 2px solid var\(--text-secondary\);/);
    assert.match(arrow, /pointer-events: none;/);
    assert.doesNotMatch(select, /appearance: auto;/);
    assert.match(select, /(?:^|\n)    appearance: none;/);
    assert.match(select, /(?:^|\n)    -webkit-appearance: none;/);
    assert.match(select, /padding: 0 38px 0 14px !important;/);
    assert.match(select, /background-color: var\(--bg-surface\) !important;/);
    assert.match(select, /background-image: none !important;/);
    assert.match(select, /color: var\(--text-main\);/);
    assert.match(select, /border: 1px solid var\(--border-color\);/);
    assert.match(hover, /border-color: color-mix\(in srgb, var\(--accent-color\) 42%, var\(--border-color\)\);/);
    assert.match(option, /background-color: var\(--bg-surface\);/);
    assert.match(option, /color: var\(--text-main\);/);
    assert.match(selectedOption, /background-color: color-mix\([\s\S]*?var\(--accent-color\) 20%,[\s\S]*?var\(--bg-surface\)[\s\S]*?\);/);
    assert.match(selectedOption, /color: var\(--text-main\);/);
    assert.ok(mobile, 'mobile preset-select owner must remain present');
    assert.match(mobile, /height: 38px;/);
    assert.match(mobile, /padding: 0 24px 0 9px !important;/);
    assert.match(mobile, /font-size: 11px;/);
    assert.doesNotMatch(mobile, /(?:-webkit-)?appearance: auto;/);
    assert.equal(
        [...css.matchAll(/^\s*#blai-purifier-popup \.blai-home-preset-select\s*\{/gm)].length,
        2,
        'preset select must have exactly one base owner and one mobile owner',
    );
    const selectWithoutAuthorizedImportant = select
        .replace('padding: 0 38px 0 14px !important;', '')
        .replace('background-color: var(--bg-surface) !important;', '')
        .replace('background-image: none !important;', '');
    const mobileWithoutAuthorizedImportant = mobile.replace('padding: 0 24px 0 9px !important;', '');
    assert.doesNotMatch(selectWithoutAuthorizedImportant, /!important/);
    assert.doesNotMatch(mobileWithoutAuthorizedImportant, /!important/);
    for (const rule of [field, arrow, option, selectedOption, hover]) {
        assert.doesNotMatch(rule, /!important/);
    }
    assert.doesNotMatch(css, /^\s*(?:select|option)\b[^\n{]*\{/m);
    assert.doesNotMatch(css, /^\s*color-scheme\s*:/m);
});

test('home page uses the requested dataset, toolbar, batch, and card-grid structure', async () => {
    const template = await readFile(new URL('../templates/purifier.html', import.meta.url), 'utf8');
    const ui = await readFile(new URL('../src/ui.js', import.meta.url), 'utf8');
    const events = await readFile(new URL('../src/events.js', import.meta.url), 'utf8');
    const css = await readFile(new URL('../styles/05-home-page.css', import.meta.url), 'utf8');
    assert.match(template, /class="blai-global-header"/);
    assert.match(template, /class="fas fa-floppy-disk"/);
    assert.match(template, /class="blai-app-shell scheme-a" data-theme="auto"/);
    assert.match(template, /id="blai-batch-toggle" type="button" class="blai-home-toolbar-button" aria-expanded="false"/);
    assert.match(template, /class="blai-home-dataset"/);
    assert.match(template, /class="blai-home-sticky-controls">[\s\S]*?class="blai-home-toolbar"[\s\S]*?class="blai-home-batch-panel" id="blai-batch-operations"[\s\S]*?<section class="blai-home-rules"/);
    assert.match(template, /class="blai-home-toolbar"/);
    assert.match(template, /<h2>规则集<\/h2>/);
    assert.match(template, /class="blai-home-batch-panel" id="blai-batch-operations"/);
    assert.match(template, /id="blai-home-rule-grid" class="blai-home-rule-grid"/);
    assert.match(ui, /<article class="blai-home-card/);
    assert.match(events, /\.toggleClass\('blai-active', isBatchMode\)/);
    assert.match(css, /grid-template-columns: minmax\(88px, 1fr\) auto minmax\(88px, 1fr\);/);
    assert.match(css, /\.blai-global-heading \{[\s\S]*?display: inline-flex;[\s\S]*?align-items: baseline;/);
    assert.match(css, /\.blai-home-dataset-summary \{[\s\S]*?flex: 0 1 auto;[\s\S]*?gap: 10px;/);
    assert.match(css, /\.blai-home-preset-field \{[\s\S]*?width: clamp\(240px, 26vw, 320px\);[\s\S]*?flex: 0 1 clamp\(240px, 26vw, 320px\);/);
    assert.match(css, /\.blai-home-dataset-actions \{[\s\S]*?margin-left: auto;[\s\S]*?justify-content: flex-end;/);
    assert.match(css, /\.blai-home-sticky-controls \{[\s\S]*?position: sticky;[\s\S]*?top: 0;[\s\S]*?display: grid;[\s\S]*?gap: 0;[\s\S]*?background: var\(--bg-surface\);/);
    assert.match(css, /\.blai-home-toolbar \{[\s\S]*?padding: 4px 0;/);
    assert.match(css, /\.blai-home-toolbar-button \{[\s\S]*?min-height: 34px;[\s\S]*?padding: 0 10px;/);
    for (const selector of [
        'blai-global-heading span',
        'blai-home-metrics',
        'blai-home-dataset-actions button',
        'blai-home-toolbar-button',
        'blai-home-batch-actions button',
    ]) {
        const selectorPattern = selector.replaceAll(' ', '\\s+');
        assert.match(css, new RegExp(`\\.${selectorPattern}\\s*\\{[\\s\\S]*?color: var\\(--text-main\\);`));
    }
    assert.doesNotMatch(css, /\.blai-home-dataset \{[^}]*position: sticky;/);
    assert.doesNotMatch(css, /\.blai-home-toolbar \{[^}]*position: sticky;/);
    assert.match(css, /\.blai-home-card \{[\s\S]*?background: transparent;[\s\S]*?box-shadow: none;/);
    assert.doesNotMatch(template, /overview-preset-panel|rules-panel|blai-tags-container|规则合集/);
});

test('mobile home owns its gutters, aligns preset metrics, and compacts transparent cards', async () => {
    const template = await readFile(new URL('../templates/purifier.html', import.meta.url), 'utf8');
    const css = await readFile(new URL('../styles/05-home-page.css', import.meta.url), 'utf8');
    const responsiveCss = await readFile(new URL('../styles/06-current-responsive.css', import.meta.url), 'utf8');

    assert.match(css, /@media \(max-width: 1120px\) \{[\s\S]*?\.blai-home-dataset-row \{[\s\S]*?flex-direction: column;[\s\S]*?\.blai-home-rule-grid \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/);
    assert.match(css, /@media \(min-width: 601px\) and \(max-width: 780px\)/);
    assert.match(css, /@media \(max-width: 600px\) \{[\s\S]*?\.blai-home-page \{[\s\S]*?padding: 0 16px 84px;[\s\S]*?gap: 16px;/);
    assert.match(css, /@media \(max-width: 600px\) \{[\s\S]*?\.blai-home-dataset \{[\s\S]*?padding-top: 12px;[\s\S]*?padding-bottom: 8px;/);
    assert.match(css, /@media \(max-width: 600px\) \{[\s\S]*?\.blai-home-dataset-row \{[\s\S]*?gap: 4px;/);
    assert.match(css, /@media \(max-width: 600px\) \{[\s\S]*?\.blai-home-dataset-summary \{[\s\S]*?flex-direction: row;/);
    assert.match(css, /\.blai-home-preset-field \{[\s\S]*?width: clamp\(104px, 34vw, 132px\);/);
    assert.match(css, /\.blai-home-metrics \{[\s\S]*?width: auto;[\s\S]*?font-size: 10px;/);
    assert.match(css, /@media \(max-width: 600px\) \{[\s\S]*?\.blai-home-metrics \{[\s\S]*?justify-content: flex-end;[\s\S]*?gap: 8px;/);
    assert.match(css, /@media \(max-width: 600px\) \{[\s\S]*?\.blai-home-dataset-actions button \{[\s\S]*?min-height: 30px;/);
    assert.match(css, /@media \(max-width: 600px\) \{[\s\S]*?\.blai-home-toolbar-actions \{[\s\S]*?gap: 4px;[\s\S]*?\.blai-home-toolbar-button \{[\s\S]*?min-height: 30px;[\s\S]*?padding-inline: 6px;/);
    assert.match(css, /@media \(max-width: 600px\) \{[\s\S]*?\.blai-home-batch-actions \{[\s\S]*?grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
    assert.match(css, /@media \(max-width: 600px\) \{[\s\S]*?\.blai-home-batch-panel \{[\s\S]*?border: 0;[\s\S]*?border-radius: 0;[\s\S]*?background: transparent;/);
    assert.match(css, /@media \(max-width: 600px\) \{[\s\S]*?\.blai-home-batch-heading \{\s*display: none;/);
    assert.doesNotMatch(css, /\.blai-home-batch-actions button span \{\s*display: none;/);
    assert.match(css, /@media \(max-width: 600px\) \{[\s\S]*?\.blai-home-batch-actions button \{[\s\S]*?min-height: 30px;[\s\S]*?padding: 0 4px;[\s\S]*?font-size: 10px;/);
    assert.match(css, /@media \(max-width: 600px\) \{[\s\S]*?\.blai-home-card \{[\s\S]*?background: transparent;[\s\S]*?box-shadow: none;/);
    assert.match(responsiveCss, /\.page-panel:not\(\[data-page="overview"\]\) \{\s*gap: 0 !important;\s*padding: 0 !important;/);
    assert.doesNotMatch(responsiveCss, /\.page-panel \{\s*gap: 0 !important;\s*padding: 0 !important;/);
    for (const label of ['全选', '反选', '复制或转移', '删除选中规则组']) {
        assert.match(template, new RegExp(`aria-label="${label}"`));
    }
});

test('tools page uses the two-column system layout without legacy tool panels', async () => {
    const template = await readFile(new URL('../templates/purifier.html', import.meta.url), 'utf8');
    assert.doesNotMatch(template, /<h1>工具与系统<\/h1>/);
    assert.match(template, /class="blai-tools-columns"/);
    assert.equal(template.match(/class="blai-tools-binding-item blai-proxy-field"/g)?.length, 3);
    assert.match(template, /type="range" id="blai-diff-limit-input"/);
    assert.doesNotMatch(template, /preset-management-panel|binding-tools-panel|tools-combined-panel|blai-zh-compat-toggle/);
});

test('mobile AI layout moves the authoritative controls and restores the desktop column', async () => {
    const template = await readFile(new URL('../templates/purifier.html', import.meta.url), 'utf8');
    const events = await readFile(new URL('../src/events/aiSettings.js', import.meta.url), 'utf8');
    const css = await readFile(new URL('../styles/07-cascade-seal.css', import.meta.url), 'utf8');

    for (const id of ['blai-ai-temperature', 'blai-ai-generation-section', 'blai-ai-backend-section']) {
        assert.equal(template.match(new RegExp(`id="${id}"`, 'g'))?.length, 1);
    }
    assert.match(events, /window\.matchMedia\('\(max-width: 600px\)'\)/);
    assert.match(events, /\$temperatureField\.insertAfter\('\.blai-ai-xml-control'\)/);
    assert.match(events, /\$generationSection\.appendTo\('#blai-ai-generation-modal-body'\)/);
    assert.match(events, /\$backendSection\.insertAfter\(\$\('#blai-ai-debug-log'\)\.closest\('\.blai-ai-section'\)\)/);
    assert.match(events, /\$temperatureField\.prependTo\(\$generationSection\.find\('\.blai-ai-parameter-grid'\)\)/);
    assert.match(css, /\.blai-ai-generation-open \{[\s\S]*?display: none !important;/);
    assert.match(css, /\.blai-ai-connection-grid \{[\s\S]*?minmax\(112px, 0\.52fr\)/);
});
