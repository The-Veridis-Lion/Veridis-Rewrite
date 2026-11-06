/** Apply exact source-anchored edits within one authorized target only. */
export function applyLocalEdits(source, edits) {
    if (typeof source !== 'string' || !Array.isArray(edits) || edits.length > 256) throw new Error('需要目标内局部修改数组');
    const spans = edits.map(edit => {
        if (!edit || Object.keys(edit).sort().join(',') !== 'after,before,occurrence'
            || typeof edit.before !== 'string' || !edit.before.length || typeof edit.after !== 'string'
            || !Number.isSafeInteger(edit.occurrence) || edit.occurrence < 0 || edit.occurrence > source.length) throw new Error('局部修改字段不合法');
        let start = -1;
        for (let n = 0; n <= edit.occurrence; n++) {
            start = source.indexOf(edit.before, start + 1);
            if (start < 0) throw new Error('原文锚点不属于本目标');
        }
        return { start, end: start + edit.before.length, after: edit.after };
    }).sort((a,b) => a.start - b.start);
    let cursor = 0, output = '';
    for (const span of spans) {
        if (span.start < cursor) throw new Error('局部修改重叠');
        output += source.slice(cursor, span.start) + span.after;
        cursor = span.end;
    }
    return output + source.slice(cursor);
}
