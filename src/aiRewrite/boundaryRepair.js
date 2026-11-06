import { resolveRewriteTrackedRanges } from './matching.js';
import { trimCopiedBoundaryDialogue } from './boundaryDialogue.js';
import { renderPrompt } from './planning.js';
import { parseAiResponse } from './response.js';

export function getBoundaryRepairItems(task, items, accepted) {
    const resolved = resolveRewriteTrackedRanges(task.snapshotText, items, task.aiSettings);
    if (!resolved.valid) return [];
    const replacements = resolved.ranges.filter(range => range.rangeType === 'sentence' && accepted.has(range.itemId))
        .map(range => ({ ...range, rewritten: accepted.get(range.itemId) }));
    const rejected = new Set(trimCopiedBoundaryDialogue(task.snapshotText, replacements).replacements
        .filter(range => range.strategy === 'boundary-dialogue-rejected').map(range => range.itemId));
    return items.filter(item => rejected.has(item.id));
}

export async function repairBoundaryCopies(task, group, accepted, request) {
    const items = getBoundaryRepairItems(task, group.items, accepted);
    if (!items.length) return 0;
    const prompt = renderPrompt(task.snapshotText, items, task.settings, task.aiSettings, group.promptTemplate)
        + '\n\n【替换边界纠正】上次返回存在引语边界问题：可能复制了目标外引语（包括去掉引号、重排修饰或换词补全其后内容），或把引语后承接主语的谓语半句清空，导致只剩名词片段。若是后者，须保留原有情绪影响或事件，按绑定规则改成通顺的承接分句，不返回空字符串；不得把目标外主语或引语抄入结果。本次仍须完成上述绑定的措辞清理，只返回本次 id 内的替换稿。目标外的引语由插件保留，不能复制进返回值。目标内部的事实和修饰关系全部留在目标内部，不得把它们移到外部引语之后。必要时重组目标内部语序，保留否定、数量和动作；不要返回上次错误结果，也不要仅为避错照抄未经清理的原文。';
    const repaired = parseAiResponse(await request(prompt), new Map(items.map(item => [item.id, item])));
    // Check against all group replacements so an edited neighbor is not treated as an anchor.
    const combined = new Map([...accepted, ...repaired]);
    const rejected = new Set(getBoundaryRepairItems(task, group.items, combined).map(item => item.id));
    let count = 0;
    for (const item of items) {
        if (repaired.has(item.id) && !rejected.has(item.id)) {
            accepted.set(item.id, repaired.get(item.id));
            count++;
        }
    }
    return count;
}
