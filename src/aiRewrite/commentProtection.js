const xmlCommentPattern = /<!--[\s\S]*?-->/g;

export function collectXmlCommentRanges(text) {
    const source = String(text ?? '');
    const ranges = [];
    xmlCommentPattern.lastIndex = 0;
    let match;
    while ((match = xmlCommentPattern.exec(source)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        ranges.push({ start, end });
        if (match[0].length === 0) xmlCommentPattern.lastIndex += 1;
    }
    xmlCommentPattern.lastIndex = 0;
    return ranges;
}

export function maskXmlCommentRanges(text, ranges = collectXmlCommentRanges(text)) {
    const source = String(text ?? '');
    if (!source || !Array.isArray(ranges) || ranges.length === 0) return source;

    let output = '';
    let cursor = 0;
    ranges.forEach((range) => {
        const start = Math.max(cursor, Math.min(source.length, Number(range?.start) || 0));
        const end = Math.max(start, Math.min(source.length, Number(range?.end) || start));
        if (end <= start) return;
        output += source.slice(cursor, start);
        output += source.slice(start, end).replace(/[^\r\n]/g, ' ');
        cursor = end;
    });
    return output + source.slice(cursor);
}

export function applyWithXmlCommentsProtectedTrackedRanges(text, transform, ranges = [], enabled = false) {
    const source = String(text ?? '');
    const tracked = (Array.isArray(ranges) ? ranges : []).map((range) => ({ ...range }));
    let valid = tracked.every((range) => Number.isInteger(range.start)
        && Number.isInteger(range.end)
        && range.start >= 0
        && range.end >= range.start
        && range.end <= source.length);
    if (typeof transform !== 'function' || !valid) return { text: source, ranges: tracked, projection: [], valid };

    const commentRanges = enabled === true ? collectXmlCommentRanges(source) : [];
    const chunks = [];
    let cursor = 0;
    commentRanges.forEach((range) => {
        chunks.push({ start: cursor, end: range.start, transform: true });
        chunks.push({ start: range.start, end: range.end, transform: false });
        cursor = range.end;
    });
    chunks.push({ start: cursor, end: source.length, transform: true });

    let output = '';
    let outputRanges = [];
    const projection = [];
    for (const chunk of chunks) {
        const localRanges = [];
        for (const range of tracked) {
            if (range.end <= chunk.start || range.start >= chunk.end) continue;
            if (range.start < chunk.start || range.end > chunk.end) {
                valid = false;
                continue;
            }
            localRanges.push({ ...range, start: range.start - chunk.start, end: range.end - chunk.start });
        }
        const segment = source.slice(chunk.start, chunk.end);
        const result = chunk.transform
            ? transform(segment, localRanges)
            : { text: segment, ranges: localRanges, projection: [], valid: true };
        if (!result
            || typeof result.text !== 'string'
            || !Array.isArray(result.ranges)
            || !Array.isArray(result.projection)) {
            return { text: source, ranges: tracked, projection: [], valid: false };
        }
        valid = valid && result.valid !== false;
        const outputStart = output.length;
        output += result.text;
        outputRanges.push(...result.ranges.map((range) => ({
            ...range,
            start: range.start + outputStart,
            end: range.end + outputStart,
        })));
        projection.push(...result.projection.map((step) => [
            step[0] + outputStart,
            step[1] + outputStart,
            step[2],
        ]));
    }

    if (outputRanges.length !== tracked.length) valid = false;
    return { text: output, ranges: outputRanges, projection, valid };
}
