import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildAiRewriteGenerateRawConfig } from '../src/aiGeneration.js';
import { resolveAiModelListBaseUrl } from '../src/utils.js';
import { getMvuExtraModelTransaction, shouldWaitForMvuExtraModelTransaction } from '../src/platform.js';
import { defaultAiRewriteSettings, defaultSettings, initAppContext, normalizeAiSamplingSettings, normalizeShujukuAutoProgramRewriteEnabled } from '../src/state.js';

const eventsFacadeSource = await readFile(new URL('../src/events.js', import.meta.url), 'utf8');
const aiSettingsEventsSource = await readFile(new URL('../src/events/aiSettings.js', import.meta.url), 'utf8');
const diffEventsSource = await readFile(new URL('../src/events/diff.js', import.meta.url), 'utf8');
const hostLifecycleSource = await readFile(new URL('../src/events/hostLifecycle.js', import.meta.url), 'utf8');
const eventsSource = `${eventsFacadeSource}\n${aiSettingsEventsSource}\n${diffEventsSource}\n${hostLifecycleSource}`;
const aiFacadeSource = await readFile(new URL('../src/aiRewrite.js', import.meta.url), 'utf8');
const aiRuntimeSource = await readFile(new URL('../src/aiRewrite/runtime.js', import.meta.url), 'utf8');
const aiDebugSource = await readFile(new URL('../src/aiRewrite/debug.js', import.meta.url), 'utf8');
const aiSource = `${aiFacadeSource}\n${aiRuntimeSource}\n${aiDebugSource}`;
const generationLifecycleSource = await readFile(new URL('../src/generationLifecycle.js', import.meta.url), 'utf8');
const diffSource = await readFile(new URL('../src/diff.js', import.meta.url), 'utf8');
const messageMetaSource = await readFile(new URL('../src/messageMeta.js', import.meta.url), 'utf8');
const domSource = await readFile(new URL('../src/dom.js', import.meta.url), 'utf8');
const replacementEngineSource = await readFile(new URL('../src/replacementEngine.js', import.meta.url), 'utf8');
const stateSource = await readFile(new URL('../src/state.js', import.meta.url), 'utf8');
const coreSource = await readFile(new URL('../src/core.js', import.meta.url), 'utf8');
const cleanseSource = await readFile(new URL('../src/cleanse.js', import.meta.url), 'utf8');
const shujukuCompatibilitySource = await readFile(new URL('../src/shujukuCompatibility.js', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const settingsMigrationSource = await readFile(new URL('../src/settingsMigration.js', import.meta.url), 'utf8');
const purifierTemplateSource = await readFile(new URL('../templates/purifier.html', import.meta.url), 'utf8');
const composerButtonSource = await readFile(new URL('../src/composerButton.js', import.meta.url), 'utf8');
const streamingDomStart = domSource.indexOf('function findTavernHelperStreamingSurface');
const streamingDomEnd = domSource.indexOf('export function getMessageDomNode', streamingDomStart);
const streamingDomSource = domSource.slice(streamingDomStart, streamingDomEnd);

function installMvuRoutingRuntime({ updateMode = '额外模型解析', autoRequest = true, entries = [] } = {}) {
    const chat = [
        { is_user: true, mes: '用户消息' },
        { is_user: false, mes: '助手消息' },
    ];
    initAppContext({
        extension_settings: {
            mvu_settings: {
                更新方式: updateMode,
                额外模型解析配置: {
                    启用自动请求: autoRequest,
                    应答格式: '聊天消息',
                },
            },
        },
        chat,
        getSillyTavernContext: () => ({ chat }),
    });
    globalThis.Mvu = {
        events: { BEFORE_MESSAGE_UPDATE: 'mag_before_message_update' },
        isDuringExtraAnalysis: () => false,
    };
    globalThis.TavernHelper = {
        getCurrentCharPrimaryLorebook: () => 'current-character-book',
        getLorebookEntries: async () => entries,
        getTavernHelperVersion: () => '4.8.4',
    };
}

test.afterEach(() => {
    delete globalThis.Mvu;
    delete globalThis.TavernHelper;
});

test('MVU one-output mode never waits for an extra-model transaction', async () => {
    installMvuRoutingRuntime({
        updateMode: '随AI输出',
        entries: [{ comment: '[mvu_update] variable rules' }],
    });

    assert.equal(getMvuExtraModelTransaction().enabled, false);
    assert.equal(await shouldWaitForMvuExtraModelTransaction(1), false);
});

test('ordinary card does not wait when the global MVU selection is extra-model parsing', async () => {
    installMvuRoutingRuntime({ entries: [{ comment: 'ordinary lorebook entry' }] });

    assert.equal(getMvuExtraModelTransaction().enabled, true);
    assert.equal(await shouldWaitForMvuExtraModelTransaction(1), false);
});

test('extra-model MVU card waits only when its current lorebook declares support', async () => {
    installMvuRoutingRuntime({ entries: [{ comment: '[MVU_PLOT] plot extraction' }] });

    assert.equal(await shouldWaitForMvuExtraModelTransaction(1), true);
});

test('disabled MVU automatic requests do not create a transaction wait', async () => {
    installMvuRoutingRuntime({
        autoRequest: false,
        entries: [{ comment: '[mvu_update] variable rules' }],
    });

    assert.equal(await shouldWaitForMvuExtraModelTransaction(1), false);
});

test('AI lifecycle fix contains no prompt viewer or dialog special case', () => {
    const combined = `${eventsSource}\n${aiSource}`;
    assert.doesNotMatch(combined, /\.mes_prompt|promptItemize|prompt viewer|querySelector\([^)]*dialog/i);
});

test('automatic AI modules do not call latest-assistant resolver', () => {
    assert.doesNotMatch(eventsSource, /resolveLatestTrackableMessageIndex/);
    assert.doesNotMatch(aiSource, /resolveLatestTrackableMessageIndex/);
});

test('AI rewrite uses TavernHelper transport with the independently configured API and model', () => {
    const request = buildAiRewriteGenerateRawConfig('rewrite this', {
        ...defaultAiRewriteSettings,
        baseUrl: 'https://rewrite.example/v1',
        apiKey: 'rewrite-key',
        model: 'rewrite-model',
    }, 'generation-contract');

    assert.equal(request.generation_id, 'generation-contract');
    assert.equal(request.should_stream, false);
    assert.deepEqual(request.ordered_prompts, [{ role: 'user', content: 'rewrite this' }]);
    assert.equal(request.custom_api.apiurl, 'https://rewrite.example/v1');
    assert.equal(request.custom_api.key, 'rewrite-key');
    assert.equal(request.custom_api.model, 'rewrite-model');
    assert.equal(request.custom_api.source, 'custom');
    assert.deepEqual(request.custom_api.custom_include_body.response_format, { type: 'json_object' });
    assert.match(aiSource, /stopGenerationById\?\.\(generationId\)/);
    assert.doesNotMatch(aiSource, /chat_completion_source: 'custom'/);
    assert.doesNotMatch(aiSource, /reasoning_effort:/);
    assert.doesNotMatch(aiSource, /\bthinking\s*:/);
});

test('AI model discovery supports OpenAI and Qianfan Token Plan base URLs', () => {
    assert.equal(resolveAiModelListBaseUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1');
    assert.equal(resolveAiModelListBaseUrl('https://qianfan.baidubce.com/v2/tokenplan/personal'), 'https://qianfan.baidubce.com/v2');
    assert.equal(resolveAiModelListBaseUrl('https://qianfan.baidubce.com/v2/tokenplan/personal/'), 'https://qianfan.baidubce.com/v2');
    assert.match(eventsSource, /resolveAiModelListBaseUrl\(aiSettings\.baseUrl\)/);
    assert.match(eventsSource, /tavernHelper\.getModelList\(\{ apiurl, key \}\)/);
});

test('API presets save, compare, restore, and boot-normalize temperature with the model configuration', () => {
    const runtimeNormalizerStart = eventsSource.indexOf('const normalizeAiApiPresetSnapshot');
    const runtimeNormalizerEnd = eventsSource.indexOf('const getCurrentAiApiPresetSnapshot', runtimeNormalizerStart);
    const runtimeNormalizer = eventsSource.slice(runtimeNormalizerStart, runtimeNormalizerEnd);
    const bootNormalizerStart = settingsMigrationSource.indexOf('function normalizeAiApiPresetEntry');
    const bootNormalizerEnd = settingsMigrationSource.indexOf('function normalizeAiApiPresets', bootNormalizerStart);
    const bootNormalizer = settingsMigrationSource.slice(bootNormalizerStart, bootNormalizerEnd);

    assert.ok(runtimeNormalizerStart >= 0 && runtimeNormalizerEnd > runtimeNormalizerStart);
    assert.ok(bootNormalizerStart >= 0 && bootNormalizerEnd > bootNormalizerStart);
    assert.match(runtimeNormalizer, /\.\.\.normalizeAiSamplingSettings\(value\)/);
    assert.match(bootNormalizer, /\.\.\.normalizeAiSamplingSettings\(value\)/);
    assert.equal(normalizeAiSamplingSettings({ temperature: 0.75 }).temperature, 0.75);
    assert.equal(normalizeAiSamplingSettings({ temperature: 99 }).temperature, 2);
    assert.match(eventsSource, /aiSettings\.apiPresets\[name\] = getCurrentAiApiPresetSnapshot\(aiSettings\)/);
    assert.match(eventsSource, /Object\.assign\(aiSettings, normalizeAiApiPresetSnapshot\(preset\), \{ activeApiPreset: name \}\)/);
});

test('temperature recommendations are available in the runtime template', () => {
    assert.match(purifierTemplateSource, /查看模型推荐温度/);
    assert.match(purifierTemplateSource, /dsv4f[\s\S]*1\.00[\s\S]*92\.13s[\s\S]*98\.6/);
    assert.match(purifierTemplateSource, /gemini3f[\s\S]*0\.95[\s\S]*76\.33s[\s\S]*97\.4/);
    assert.match(purifierTemplateSource, /gemini3\.1p[\s\S]*0\.45[\s\S]*29\.05s[\s\S]*99\.1/);
    assert.match(purifierTemplateSource, /gemini3\.6f[\s\S]*0\.90[\s\S]*22\.04s[\s\S]*98\.9/);
    assert.match(purifierTemplateSource, /其他模型请自行测试合适温度/);
});

test('AI debug log copy uses the TavernHelper host clipboard API', () => {
    assert.match(eventsSource, /tavernHelper\.builtin\.copyText\(logText\)/);
    assert.doesNotMatch(eventsSource, /navigator\.clipboard\.writeText\(logText\)/);
});

test('generation finalization is direct and has no lifecycle timer API', () => {
    assert.match(eventsSource, /const finalizeGenerationMessage = async \(messageId, source, generationId = ''\) =>/);
    assert.match(eventsSource, /generationLifecycle\.markFinalSource\(resolution\.generationId, source\)/);
    assert.match(eventsSource, /markAiRewriteFinalCleanseReady\(stablePayload\)/);
    assert.doesNotMatch(eventsSource, /scheduleTimer|150ms|700ms|FinalTimer/);
    assert.doesNotMatch(generationLifecycleSource, /scheduleTimer|clearTimers|completedTimerPhases|setTimeoutFn|clearTimeoutFn/);
});

test('AI-owned Shujuku pending is armed once by exact host finalization ownership', () => {
    const finalizationStart = hostLifecycleSource.indexOf('const finalizeGenerationMessage = async');
    const finalizationEnd = hostLifecycleSource.indexOf('const cancelAutomaticGeneration', finalizationStart);
    const finalization = hostLifecycleSource.slice(finalizationStart, finalizationEnd);
    const aiOwnership = finalization.indexOf('const aiOwnsFinalCommit = markAiRewriteFinalCleanseReady(stablePayload)');
    const nonAiReturn = finalization.indexOf('return;', aiOwnership);
    const pendingArm = finalization.indexOf("markLatestMessageShujukuRewritePending(resolution.messageIndex, 'ai-finalization')");
    const deferredDiagnostic = finalization.indexOf("recordAiRewriteRuntimeDebug('final-cleanse-deferred-to-ai'");

    assert.match(hostLifecycleSource, /import \{ markLatestMessageShujukuRewritePending \} from '\.\.\/shujukuCompatibility\.js'/);
    assert.ok(aiOwnership >= 0);
    assert.ok(nonAiReturn > aiOwnership);
    assert.ok(pendingArm > nonAiReturn);
    assert.ok(deferredDiagnostic > pendingArm);
    assert.equal((finalization.match(/markLatestMessageShujukuRewritePending\(/g) || []).length, 1);
    assert.doesNotMatch(aiRuntimeSource, /markLatestMessageShujukuRewritePending|pendingShujukuRewrite/);
});

test('Shujuku callback ownership is the validated pending-arm path, not startup timing', () => {
    assert.equal((hostLifecycleSource.match(/event_types\.GENERATION_ENDED/g) || []).length, 2);
    assert.doesNotMatch(indexSource, /registerShujukuTableUpdateCallback|AutoCardUpdaterAPI|folderName === 'shujuku'/);
    const pendingArmStart = shujukuCompatibilitySource.indexOf('export function markLatestMessageShujukuRewritePending');
    const pendingArmEnd = shujukuCompatibilitySource.indexOf('async function processPendingShujukuRewrite', pendingArmStart);
    const pendingArm = shujukuCompatibilitySource.slice(pendingArmStart, pendingArmEnd);
    assert.ok(pendingArm.indexOf('registerShujukuTableUpdateCallback()') >= 0);
    assert.ok(pendingArm.indexOf('registerShujukuTableUpdateCallback()') < pendingArm.indexOf('pendingShujukuRewrite = {'));
    assert.equal((pendingArm.match(/registerShujukuTableUpdateCallback\(\)/g) || []).length, 1);
    assert.equal((shujukuCompatibilitySource.match(/api\.registerTableUpdateCallback\(onShujukuTableUpdate\)/g) || []).length, 1);
    assert.doesNotMatch(shujukuCompatibilitySource, /GENERATION_ENDED|setTimeout|setInterval|poll|retry|grace/i);
    assert.doesNotMatch(hostLifecycleSource, /pendingShujukuRewrite|activeShujukuRewritePromise/);
});

test('Shujuku persistence ownership does not reproduce scheduling or previous-message heuristics', () => {
    assert.doesNotMatch(shujukuCompatibilitySource, /skipUpdateFloors|updateConfig\.skipFloors|autoUpdateFrequency|contextDepth/);
    assert.doesNotMatch(shujukuCompatibilitySource, /previousAssistant|triggerIndex\s*-|messageIndex\s*-\s*\d/);
});

test('generation lifecycle retains only the active session and minimal one-shot receipts', () => {
    const recordStart = generationLifecycleSource.indexOf('recordStreamingHostReceipt(generationId, messageId, messageRef)');
    const consumeStart = generationLifecycleSource.indexOf('consumeStreamingHostReceipt(messageId, messageRef)', recordStart);
    const validateStart = generationLifecycleSource.indexOf('validate(generationId, options = {})', consumeStart);
    const recordReceipt = generationLifecycleSource.slice(recordStart, consumeStart);
    const consumeReceipt = generationLifecycleSource.slice(consumeStart, validateStart);

    assert.match(generationLifecycleSource, /this\.active = null/);
    assert.match(generationLifecycleSource, /this\.pendingStreamingHostReceipts = \[\]/);
    assert.doesNotMatch(generationLifecycleSource, /this\.sessions|sessions\s*=\s*new Map|pendingStreamingHostReceipt:/);
    assert.match(generationLifecycleSource, /active\?\.generationId === generationId \? active : null/);
    assert.match(recordReceipt, /this\.pendingStreamingHostReceipts\.push\(\{\s*generationId,\s*messageId,\s*messageRef,\s*\}\)/);
    assert.doesNotMatch(recordReceipt, /getSession\(/);
    assert.match(consumeReceipt, /receipt\.messageId === messageId && receipt\.messageRef === messageRef/);
    assert.match(consumeReceipt, /splice\(receiptIndex, 1\)\[0\]/);
    assert.doesNotMatch(generationLifecycleSource, /new Map\(|new Set\(|WeakMap|tombstone|\bTTL\b|setTimeout|setInterval|LRU|history cache|refcount/i);
});

test('streaming receipt discard is exact to generation and message ownership', () => {
    const discardStart = generationLifecycleSource.indexOf('discardStreamingHostReceipt(generationId, messageId)');
    const consumeStart = generationLifecycleSource.indexOf('consumeStreamingHostReceipt(messageId, messageRef)', discardStart);
    const discardReceipt = generationLifecycleSource.slice(discardStart, consumeStart);

    assert.ok(discardStart >= 0 && consumeStart > discardStart);
    assert.match(discardReceipt, /receipt\.generationId === generationId/);
    assert.match(discardReceipt, /receipt\.messageId === messageId/);
    assert.match(discardReceipt, /pendingStreamingHostReceipts\.splice\(/);
    assert.doesNotMatch(discardReceipt, /messageRef|new Map\(|new Set\(|setTimeout|setInterval|manager|phase/i);
});

test('Diff floor retention has no fixed Swipe cap or generation-lifecycle coupling', () => {
    assert.doesNotMatch(messageMetaSource, /branchMetaLimit|pruneBranchMeta/);
    assert.doesNotMatch(diffSource, /generationLifecycle|pruneHistoricalSessions/);
    assert.doesNotMatch(generationLifecycleSource, /pruneHistoricalSessions|retainedMessageIndices/);
    assert.doesNotMatch(generationLifecycleSource, /retention|tombstone|setTimeout|setInterval|new Set\(/i);
    assert.doesNotMatch(`${diffSource}\n${generationLifecycleSource}`, /sessionRetention|retainedSessionLimit|generationHistoryLimit/);
    assert.match(diffEventsSource, /syncTrackedIndicesToLatestAssistantMessages\(\{ cleanupHistoricalResidue: true \}\)/);
});

test('MESSAGE_RECEIVED ownership never uses Diff floor membership', () => {
    const receivedStart = hostLifecycleSource.indexOf('if (event_types.MESSAGE_RECEIVED)');
    const receivedEnd = hostLifecycleSource.indexOf('const mvuBeforeMessageUpdateEvent', receivedStart);
    assert.ok(receivedStart >= 0 && receivedEnd > receivedStart);
    const receivedBlock = hostLifecycleSource.slice(receivedStart, receivedEnd);

    assert.match(receivedBlock, /consumeStreamingHostReceipt\(messageId, messageRef\)/);
    assert.match(receivedBlock, /finalizeGenerationMessage\(messageId, 'message-received', streamingReceipt\?\.generationId \|\| ''\)/);
    assert.doesNotMatch(receivedBlock, /getLatestTrackableDiffIndices|diffTrackedMessageLimit|trackedDiffMessageOrder|retained.*floor|floor.*membership/i);
    assert.doesNotMatch(hostLifecycleSource, /import .*getLatestTrackableDiffIndices.* from '\.\.\/diff\.js'/);
});

test('automatic streaming request uses target identity freshness before entering run', () => {
    assert.match(aiSource, /validateAutomaticAiRewriteContent\(/);
    assert.match(aiSource, /source: 'schedule-callback'/);
    assert.match(aiSource, /validationMode: 'target-identity'/);
    assert.doesNotMatch(aiSource, /content-scope-changed|messageTextHashAtBuild|hashLifecycleText/);
    assert.doesNotMatch(aiSource, /setTimeout\(\(\) => \{[\s\S]{0,500}generationLifecycle\.validate\(payload\.generationId/);
});

test('AI rewrite recovery subtraction leaves no deleted task or item fields', () => {
    const candidateStart = aiRuntimeSource.indexOf('function buildAiRewriteCandidate(');
    const candidateEnd = aiRuntimeSource.indexOf('function buildAiRewriteTaskCheck(', candidateStart);
    const candidateSource = aiRuntimeSource.slice(candidateStart, candidateEnd);

    assert.ok(candidateStart >= 0 && candidateEnd > candidateStart);
    assert.match(candidateSource, /messageRef: msg/);
    assert.doesNotMatch(candidateSource, /\n\s*msg,/);
    assert.match(aiRuntimeSource, /const \{ settings, aiSettings, index, messageRef: msg, items, versionToken, dedupeKey \} = readyTask/);
    assert.doesNotMatch(aiRuntimeSource, /rebindStreamingTaskBranchIfStable|branchReboundLogged|task-branch-rebound|relativeEnd|matchedTerms/);
});

test('streaming content identity is created only after the host commits the message', () => {
    const interceptorStart = eventsSource.indexOf('processor.onProgressStreaming = async function');
    const interceptorEnd = eventsSource.indexOf('return result;', interceptorStart);
    const interceptor = eventsSource.slice(interceptorStart, interceptorEnd);
    assert.ok(interceptorStart >= 0 && interceptorEnd > interceptorStart);
    assert.ok(interceptor.indexOf('await originalOnProgress.call') < interceptor.indexOf('maybeNotifyAiRewriteReadyFromStreamingText'));
    assert.match(interceptor, /hostCommitted: true/);
    assert.match(aiSource, /if \(lifecycle\.hostCommitted !== true\)/);
    assert.match(aiSource, /const committedText = typeof resolution\.message\?\.mes === 'string'/);
    assert.match(aiSource, /const frozenSnapshot = committedScope\.text/);
    assert.doesNotMatch(aiSource, /const frozenSnapshot = getAiXmlScopedRequestText\(sourceText/);
});

test('direct final cleanse acknowledges only a reported plugin-owned text change', () => {
    assert.match(eventsSource, /cleanseResult\?\.dataChanged === true/);
    assert.match(eventsSource, /acknowledgeGenerationId: resolution\.generationId/);
    assert.match(eventsSource, /acknowledgementSource: 'direct-final-cleanse'/);
    assert.doesNotMatch(eventsSource, /refreshMessageHash/);
    assert.match(coreSource, /const afterCleanseText = typeof msg\.mes === 'string'/);
});

test('AI finalization owns one message commit and one atomic host render', () => {
    assert.equal((aiSource.match(/\bmsg\.mes\s*=(?!=)/g) || []).length, 0);
    assert.match(aiSource, /function commitAiRewriteText\(/);
    assert.match(aiSource, /const atomicSwap = beginAtomicMessageDisplaySwap\(index\)[\s\S]{0,500}commitCurrentMessageText\(msg, finalText, branchKey\)/);
    assert.match(aiSource, /if \(!textCommit\.ok\)[\s\S]{0,200}return \{ committed: false, reason: textCommit\.reason \}/);
    assert.match(aiSource, /refreshMessageDisplay\(index, \{ atomic: true, atomicSwap, emitRenderedEvent: 'auto' \}\)/);
    assert.doesNotMatch(aiSource, /purifyDOM\(/);
    assert.match(domSource, /beginAtomicMessageDisplaySwap/);
    assert.match(domSource, /messageNode\.style\.visibility = 'hidden'/);

    const finalizationStart = eventsSource.indexOf('const finalizeGenerationMessage = async');
    const finalizationEnd = eventsSource.indexOf('const cancelAutomaticGeneration', finalizationStart);
    const finalization = eventsSource.slice(finalizationStart, finalizationEnd);
    assert.ok(finalization.indexOf('markAiRewriteFinalCleanseReady(stablePayload)') < finalization.indexOf('runFinalStreamingCleanse(stablePayload'));
    assert.doesNotMatch(eventsSource, /shouldDeferFinalCleanseForAiRewrite/);
});

test('ordinary AI progress contains no internal lifecycle details', () => {
    assert.match(aiSource, /return `命中 \$\{hitCount\} 处 · 正在处理 \$\{safeCurrent\}\/\$\{safeTotal\}…`/);
    assert.doesNotMatch(aiSource, /AI规则 \$\{|文本命中 \$\{|本批 \$\{|等待最终净化后写回/);
});

test('DOM purification walks text nodes only and uses message body allowlist', () => {
    assert.match(domSource, /const messageBodySelector = '\.mes \.mes_text'/);
    assert.match(domSource, /NodeFilter\.SHOW_TEXT/);
    assert.doesNotMatch(domSource, /SHOW_TEXT\s*\|\s*NodeFilter\.SHOW_COMMENT/);
});

test('streaming presentation never rewrites host message text or chat source', () => {
    assert.match(eventsSource, /originalOnProgress\.call\(this, messageId, rawText, isFinal\)/);
    assert.doesNotMatch(eventsSource, /originalOnProgress\.call\(this, messageId, cleanText, isFinal\)/);
    const interceptorStart = eventsSource.indexOf('processor.onProgressStreaming = async function');
    const interceptorEnd = eventsSource.indexOf('return result;', interceptorStart);
    const interceptor = eventsSource.slice(interceptorStart, interceptorEnd);
    assert.ok(interceptor.indexOf('await originalOnProgress.call') < interceptor.indexOf('streamingCommittedMessageCache.set'));
    assert.ok(interceptor.indexOf('streamingCommittedMessageCache.set') < interceptor.indexOf('renderStreamingVisualMask'));
    assert.match(interceptor, /renderStreamingVisualMask\(numericMessageId, committedText\)/);
    assert.match(domSource, /runtimeState\.isStreamingGeneration === true\) return;/);
    assert.match(domSource, /applyStreamingVisualMask\(surface, rawText, applyVisualMask\(rawText\), options\)/);
    assert.match(domSource, /requireSourceCorrespondence: true/);
    assert.match(domSource, /collectScopedReplacementRanges\(rawText\)/);
    assert.match(domSource, /currentVisibleText !== visibleRawText\) return false/);
    assert.doesNotMatch(domSource, /collectScopedReplacementRanges\(runSnapshot\.text\)/);
    assert.match(domSource, /for \(let index = matches\.length - 1; index >= 0; index--\)/);
    assert.match(domSource, /parent\.closest\?\.\(excludedMessageContentSelector\)/);
    assert.doesNotMatch(streamingDomSource, /\.innerHTML\s*=/);
    assert.doesNotMatch(streamingDomSource, /morphdom|cloneNode/);
    assert.doesNotMatch(domSource, /purifyStreamingMessageDom/);
});

test('streaming presentation preserves code-block collapse and helper-owned DOM', () => {
    assert.match(domSource, /'code'/);
    assert.match(domSource, /'pre'/);
    assert.match(domSource, /'\.TH-collapse-code-block-button'/);
    assert.doesNotMatch(domSource, /blai-streaming-visual-preview/);
    assert.doesNotMatch(domSource, /helperSurface\.innerHTML/);
});

test('raw stream token events only install the committed processor patch', () => {
    const listenerStart = eventsSource.indexOf('const onStreamTokenReceived = () =>');
    const listenerEnd = eventsSource.indexOf('if (typeof eventSource.makeFirst', listenerStart);
    const listener = eventsSource.slice(listenerStart, listenerEnd);
    assert.ok(listenerStart >= 0 && listenerEnd > listenerStart);
    assert.match(listener, /installStreamingProcessorVisualMaskFromEvents\(\)/);
    assert.doesNotMatch(listener, /payload|rawText|messageId|maybeNotifyAiRewriteReadyFromStreamingText/);
    assert.doesNotMatch(eventsSource, /streamEventTextByMessageId|streamEventProbeByMessageId|streamEventNoTextProbeCount|describeStreamPayload|classifyStreamSnapshot/);
    assert.match(eventsSource, /streamingCommittedMessageCache\.set\(numericMessageId, committedText\)/);
    assert.match(eventsSource, /maybeNotifyAiRewriteReadyFromStreamingText\(numericMessageId, committedText/);
});

test('Tavern Helper render notifications cannot trigger data cleansing during streaming', () => {
    assert.match(eventsSource, /scheduleRenderedMessageCleanse = \(payload, delay = 120\) => \{\s*if \(runtimeState\.isStreamingGeneration === true\) return;/);
    assert.match(eventsSource, /blai:realtime-beauty-frame/);
    assert.match(eventsSource, /replayStreamingVisualMask/);
    assert.match(domSource, /streamingCommittedMessageCache\.get\(index\)/);
});

test('composer button delegates placement to TavernHelper and requests manual AI rewrite for the latest assistant', () => {
    assert.match(stateSource, /showComposerAiRewriteButton:\s*false/);
    assert.match(settingsMigrationSource, /settings\.showComposerAiRewriteButton = settings\.showComposerAiRewriteButton === true/);
    assert.match(purifierTemplateSource, /在输入框区域显示手动 AI 改写按钮/);
    assert.match(purifierTemplateSource, /最新一条助手消息执行手动 AI 改写/);
    assert.match(composerButtonSource, /updateScriptTreesWith\([\s\S]*\{ type: 'global' \}/);
    assert.match(composerButtonSource, /composerButtonName = 'AI 改写'/);
    assert.match(composerButtonSource, /composerButtonAiRewriteEvent = 'veridis-rewrite:manual-ai-rewrite-latest'/);
    assert.match(composerButtonSource, /requestManualAiRewrite = requestManualAiRewriteForMessage/);
    assert.match(composerButtonSource, /resolveLatestTrackableMessageIndex\(\)/);
    assert.match(composerButtonSource, /return requestManualAiRewrite\(index\)/);
    assert.match(indexSource, /syncComposerButtonScript\(extension_settings\[extensionName\]\.showComposerAiRewriteButton\)/);
    assert.match(eventsFacadeSource, /bindComposerButtonAiRewriteEvent\(eventSource\)/);
    assert.match(eventsFacadeSource, /\.off\('click', '#blai-wand-btn, #blai-wand-btn-panel, #blai-extension-settings-entry'\)\.on\('click',[^\n]*openPurifier\)/);
    assert.doesNotMatch(eventsFacadeSource, /bindComposerButtonAiRewriteEvent\(eventSource,\s*openPurifier\)/);
    assert.doesNotMatch(composerButtonSource, /openPurifier/);
    assert.doesNotMatch(composerButtonSource, /#qr--bar|\.qr--buttons|MutationObserver|ButtonManager|Teleport|Pinia|setInterval|setTimeout/);
    assert.doesNotMatch(composerButtonSource, /replaceScriptTrees|replaceScriptButtons|updateScriptButtonsWith|appendInexistentScriptButtons/);
});

test('automatic Shujuku integration is a normalized global Tools preference outside preset ownership', () => {
    assert.equal(defaultSettings.shujukuAutoProgramRewriteEnabled, false);
    assert.equal(normalizeShujukuAutoProgramRewriteEnabled(undefined), false);
    assert.equal(normalizeShujukuAutoProgramRewriteEnabled(null), false);
    assert.equal(normalizeShujukuAutoProgramRewriteEnabled(1), false);
    assert.equal(normalizeShujukuAutoProgramRewriteEnabled(true), true);
    assert.match(settingsMigrationSource, /settings\.shujukuAutoProgramRewriteEnabled = normalizeShujukuAutoProgramRewriteEnabled\(settings\.shujukuAutoProgramRewriteEnabled\)/);

    const presetBuilderStart = eventsFacadeSource.indexOf('function buildPresetExportPayload');
    const presetBuilderEnd = eventsFacadeSource.indexOf('function makeUniquePresetName', presetBuilderStart);
    const presetBuilder = eventsFacadeSource.slice(presetBuilderStart, presetBuilderEnd);
    assert.doesNotMatch(presetBuilder, /shujukuAutoProgramRewriteEnabled/);
    assert.doesNotMatch(shujukuCompatibilitySource, /rewriteLatestMessageShujukuCells[\s\S]*shujukuAutoProgramRewriteEnabled/);

    const integrationIndex = purifierTemplateSource.indexOf('界面集成');
    const compatibilityIndex = purifierTemplateSource.indexOf('扩展兼容');
    const openccIndex = purifierTemplateSource.indexOf('简繁转换 (OpenCC)');
    assert.ok(integrationIndex >= 0 && integrationIndex < compatibilityIndex && compatibilityIndex < openccIndex);
    assert.match(purifierTemplateSource, /控制 Veridis 与其他 SillyTavern 扩展的自动联动。/);
    assert.match(purifierTemplateSource, /Shujuku 数据库自动净化/);
    assert.match(purifierTemplateSource, /在 Shujuku 自动写入数据库后，同步应用当前的程序净化规则。仅在使用 Shujuku 数据库时需要。/);
    assert.match(purifierTemplateSource, /id="blai-shujuku-auto-rewrite-toggle"[\s\S]*class="blai-tools-switch"[\s\S]*aria-pressed="false"/);
    assert.match(eventsFacadeSource, /clearPendingShujukuRewrite\(\)/);
});

test('composer button has no residue from the unreleased purifier-open semantics', () => {
    const composerFeatureSources = `${composerButtonSource}\n${eventsFacadeSource}\n${stateSource}\n${settingsMigrationSource}\n${purifierTemplateSource}\n${indexSource}`;
    assert.doesNotMatch(composerFeatureSources, /veridis-rewrite:open-purifier|showComposerPurifierButton|在输入框区域显示净化助手按钮/);
});

test('manifest declares JS-Slash-Runner as the sole dependency and loads after it', () => {
    assert.deepEqual(manifest.dependencies, ['third-party/JS-Slash-Runner']);
    assert.ok(manifest.loading_order > 100);
});

test('composer startup keeps one direct synchronization without readiness machinery', () => {
    const startupSynchronizations = indexSource.match(/syncComposerButtonScript\(extension_settings\[extensionName\]\.showComposerAiRewriteButton\)/g) || [];
    assert.equal(startupSynchronizations.length, 1);
    assert.doesNotMatch(composerButtonSource, /retry|poll|MutationObserver|setInterval|setTimeout|readiness|ready manager|#qr--bar|\.qr--buttons/i);
});

test('obsolete streaming mask mechanisms remain subtracted', () => {
    const streamingSources = `${eventsSource}\n${domSource}\n${replacementEngineSource}\n${stateSource}\n${settingsMigrationSource}\n${purifierTemplateSource}`;
    assert.doesNotMatch(streamingSources, /StreamingSourceCleanser|streaming_source_cleanser/);
    assert.doesNotMatch(streamingSources, /streamingPresentationByMessageId|pendingStreamingPresentationIds|streamingPresentationFrameId/);
    assert.doesNotMatch(streamingSources, /queueStreamingPresentation|clearStreamingPresentations/);
    assert.doesNotMatch(streamingDomSource, /requestAnimationFrame|setTimeout|new Map|new Set/);
    assert.doesNotMatch(streamingSources, /realtimeMaskMode|blai-realtime-mask/);
    assert.doesNotMatch(streamingSources, /unsafeRegexOnly|projectTextAcrossNodes/);
    assert.doesNotMatch(domSource, /document\.querySelectorAll\?\.\('#chat \.TH-streaming'\)/);
});

test('generation started handler consumes the real SillyTavern event signature', () => {
    assert.match(eventsSource, /GENERATION_STARTED, \(type, options, dryRun\) =>/);
    assert.match(eventsSource, /classifyHostGenerationStart\(type, options, dryRun\)/);
});

test('host lifecycle handlers use event-specific target contracts', () => {
    assert.match(hostLifecycleSource, /MESSAGE_RECEIVED, \(messageId, hostGenerationType\) =>/);
    assert.match(hostLifecycleSource, /consumeStreamingHostReceipt\(messageId, messageRef\)/);
    assert.match(hostLifecycleSource, /finalizeGenerationMessage\(messageId, 'message-received', streamingReceipt\?\.generationId \|\| ''\)/);
    assert.match(hostLifecycleSource, /GENERATION_ENDED, \(postOperationChatLength\) =>/);
    assert.match(hostLifecycleSource, /GENERATION_STOPPED, \(\) =>/);
    assert.match(hostLifecycleSource, /MESSAGE_DELETED, \(postDeleteChatLength\) =>/);
    assert.match(hostLifecycleSource, /MESSAGE_SWIPED, \(messageId\) =>/);
    assert.match(hostLifecycleSource, /payload\?\.messageId/);
    assert.doesNotMatch(hostLifecycleSource, /eventMessageIndex/);

    const endedStart = hostLifecycleSource.indexOf('if (event_types.GENERATION_ENDED)');
    const receivedStart = hostLifecycleSource.indexOf('if (event_types.MESSAGE_RECEIVED)', endedStart);
    const coarseHandlers = hostLifecycleSource.slice(endedStart, receivedStart);
    assert.doesNotMatch(coarseHandlers, /bindMessage|finalizeGenerationMessage|performIncrementalCleanse|markAiRewriteFinalCleanseReady/);
});

test('streaming processor rejects a stale host UI-end call before invoking the host', () => {
    const patchStart = hostLifecycleSource.indexOf('const installStreamingProcessorVisualMask = () =>');
    const patchEnd = hostLifecycleSource.indexOf('installStreamingProcessorVisualMaskFromEvents = installStreamingProcessorVisualMask', patchStart);
    const processorPatch = hostLifecycleSource.slice(patchStart, patchEnd);
    const uiStopStart = processorPatch.indexOf('processor.markUIGenStopped = function(...args)');
    const progressStart = processorPatch.indexOf('processor.onProgressStreaming = async function', uiStopStart);
    const uiStopWrapper = processorPatch.slice(uiStopStart, progressStart);
    const endedStart = hostLifecycleSource.indexOf('if (event_types.GENERATION_ENDED)');
    const stoppedStart = hostLifecycleSource.indexOf('if (event_types.GENERATION_STOPPED)', endedStart);
    const endedHandler = hostLifecycleSource.slice(endedStart, stoppedStart);

    assert.ok(patchStart >= 0 && patchEnd > patchStart);
    assert.match(processorPatch, /const\s+\w+\s*=\s*processor\.markUIGenStopped/);
    assert.ok(uiStopStart >= 0 && progressStart > uiStopStart);
    assert.equal((uiStopWrapper.match(/\.apply\(this, args\)/g) || []).length, 1);
    assert.match(uiStopWrapper, /generationLifecycle\.getActive\(\)\?\.generationId/);
    assert.match(uiStopWrapper, /if\s*\(\w+\s*&&\s*\w+\s*!==\s*processorGenerationId\)/);
    assert.ok(uiStopWrapper.indexOf('activeGenerationId !== processorGenerationId')
        < uiStopWrapper.indexOf('originalMarkUIGenStopped.apply(this, args)'));
    assert.doesNotMatch(uiStopWrapper, /hostUiEndGenerationId|try\s*\{|finally\s*\{/);

    assert.ok(endedStart >= 0 && stoppedStart > endedStart);
    assert.equal((endedHandler.match(/runtimeState\.isStreamingGeneration\s*=\s*false/g) || []).length, 1);
    assert.doesNotMatch(endedHandler, /processorGenerationId|hostUiEndGenerationId|staleProcessorOwner|bindMessage|finalizeGenerationMessage|consumeStreamingHostReceipt|recordStreamingHostReceipt/);
});

test('committed streaming final and message received converge on one finalizer', () => {
    const interceptorStart = hostLifecycleSource.indexOf('processor.onProgressStreaming = async function');
    const interceptorEnd = hostLifecycleSource.indexOf('return result;', interceptorStart);
    const interceptor = hostLifecycleSource.slice(interceptorStart, interceptorEnd);
    const finalizerStart = hostLifecycleSource.indexOf('const finalizeGenerationMessage = async');
    const finalizerEnd = hostLifecycleSource.indexOf('const cancelAutomaticGeneration', finalizerStart);
    const finalizer = hostLifecycleSource.slice(finalizerStart, finalizerEnd);

    assert.ok(interceptor.indexOf('await originalOnProgress.call') < interceptor.indexOf('await finalizeCommittedStreamingMessageFromProcessor'));
    assert.ok(interceptor.indexOf('await finalizeCommittedStreamingMessageFromProcessor') < interceptor.indexOf('recordStreamingHostReceipt'));
    assert.equal((interceptor.match(/recordStreamingHostReceipt\(/g) || []).length, 1);
    assert.match(hostLifecycleSource, /if \(isFinal === true && typeof finalizeCommittedStreamingMessageFromProcessor === 'function'\)/);
    assert.match(hostLifecycleSource, /finalizeGenerationMessage\(messageId, 'streaming-committed-final', generationId\)/);
    assert.match(hostLifecycleSource, /generationId: processorGenerationId/);
    assert.ok(finalizer.indexOf('generationLifecycle.bindMessage') < finalizer.indexOf('runtimeState.isStreamingGeneration = false'));
    assert.equal((hostLifecycleSource.match(/const finalizeGenerationMessage = async/g) || []).length, 1);
    assert.match(generationLifecycleSource, /session\.phase !== 'active'/);
    assert.match(generationLifecycleSource, /session\.phase = 'finalizing'/);
});

test('processor finalization scope discards only its orphan streaming receipt', () => {
    const patchStart = hostLifecycleSource.indexOf('const installStreamingProcessorVisualMask = () =>');
    const finalizeStart = hostLifecycleSource.indexOf('processor.finalizeIntermediaryMessage = async function(...args)', patchStart);
    const finalizeEnd = hostLifecycleSource.indexOf('processor.onErrorStreaming = function(...args)', finalizeStart);
    const finalizeWrapper = hostLifecycleSource.slice(finalizeStart, finalizeEnd);

    assert.ok(finalizeStart >= 0 && finalizeEnd > finalizeStart);
    assert.match(finalizeWrapper, /const messageId = args\[0\]/);
    assert.match(finalizeWrapper, /try\s*\{/);
    assert.match(finalizeWrapper, /return await originalFinalizeIntermediaryMessage\.apply\(this, args\)/);
    assert.match(finalizeWrapper, /finally\s*\{/);
    assert.match(finalizeWrapper, /discardStreamingHostReceipt\(\s*processorGenerationId,\s*messageId,?\s*\)/);
    assert.doesNotMatch(finalizeWrapper, /catch\s*\{|clear|setTimeout|setInterval|retry|fallback|manager/i);
});

test('streaming error receipts are recorded before the exact host error callback emits', () => {
    const patchStart = hostLifecycleSource.indexOf('const installStreamingProcessorVisualMask = () =>');
    const errorStart = hostLifecycleSource.indexOf('processor.onErrorStreaming = function(...args)', patchStart);
    const errorEnd = hostLifecycleSource.indexOf('processor.markUIGenStopped = function(...args)', errorStart);
    const errorWrapper = hostLifecycleSource.slice(errorStart, errorEnd);

    assert.ok(errorStart >= 0 && errorEnd > errorStart);
    assert.match(errorWrapper, /this\.type !== 'swipe'/);
    assert.match(errorWrapper, /this\.type !== 'impersonate'/);
    assert.match(errorWrapper, /this\.type !== 'continue'/);
    assert.equal((errorWrapper.match(/recordStreamingHostReceipt\(/g) || []).length, 1);
    assert.equal((errorWrapper.match(/originalOnError\.apply\(this, args\)/g) || []).length, 1);
    assert.ok(errorWrapper.indexOf('recordStreamingHostReceipt') < errorWrapper.indexOf('originalOnError.apply(this, args)'));
    assert.doesNotMatch(errorWrapper, /try\s*\{|catch\s*\{|retry|fallback|setTimeout|setInterval/);
});

test('automatic and manual AI payloads accept only their explicit message ID forms', () => {
    assert.match(aiRuntimeSource, /function getAiRewriteMessageId\(payload\)/);
    assert.match(aiRuntimeSource, /Number\.isInteger\(payload\)/);
    assert.match(aiRuntimeSource, /Number\.isInteger\(payload\.messageId\)/);
    assert.doesNotMatch(aiRuntimeSource, /parseStableMessagePayload|message_id|mesId|mesid/);
    assert.doesNotMatch(generationLifecycleSource, /MESSAGE_INDEX_FIELDS|normalizeMessageIndex|parseStableMessagePayload|allowBoundMessage/);
});

test('swipe start never cleanses an unmaterialized swipe slot', () => {
    const handlerStart = eventsSource.indexOf('if (event_types.MESSAGE_SWIPED)');
    const handlerEnd = eventsSource.indexOf("if (event_types.PRESET_CHANGED)", handlerStart);
    const handler = eventsSource.slice(handlerStart, handlerEnd);

    assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
    assert.match(handler, /cancelAutomaticGeneration\('target-message-swiped'\)/);
    assert.match(handler, /activeSession\?\.messageRef === msg/);
    assert.match(handler, /const hasMaterializedSwipe =/);
    assert.match(handler, /if \(hasMaterializedSwipe\) runFinalStreamingCleanse/);
    assert.equal((handler.match(/runFinalStreamingCleanse\(index/g) || []).length, 1);
});

test('message and swipe deletion handlers classify target identity before cancellation', () => {
    assert.match(eventsSource, /reconcileMessageDeletion\(\{/);
    assert.match(eventsSource, /hasInvalidAiRewriteTarget\(chat\)/);
    assert.match(eventsSource, /MESSAGE_SWIPE_DELETED/);
    assert.match(eventsSource, /deletedSwipeIndex <= activeBranchIndex/);
    assert.doesNotMatch(eventsSource, /rebindAiRewrite|rebindMessageIndexRuntimeState|rebindStreamingPresentationMessageIndex/);
});

test('global and deep cleanse do not recursively scrub unknown metadata or settings', () => {
    assert.doesNotMatch(coreSource, /deepCleanObjectSync/);
    assert.doesNotMatch(cleanseSource, /chat_metadata/);
    assert.doesNotMatch(cleanseSource, /scope:\s*'settings'/);
    assert.match(cleanseSource, /scope:\s*'chat'/);
    assert.match(cleanseSource, /scope:\s*'world-info'/);
});
