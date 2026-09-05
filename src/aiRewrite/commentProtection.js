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
