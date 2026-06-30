import { applyVisualMask } from './core.js';

const tailMaxChars = 1800;
const tailContextChars = 260;
const hardCommitChars = 4200;
const boundaryLookbackChars = 900;
const sentenceBoundaryRegex = /(?:\r\n|\r|\n|[.!?。！？]["')\]}、，。！？：；”’》」』】〕〉]*\s*)/g;

function findStableCommitIndex(text, committedRawLength) {
    const value = String(text || '');
    const committed = Math.max(0, Math.min(Number(committedRawLength) || 0, value.length));
    const target = value.length - tailMaxChars - tailContextChars;
    if (target <= committed) return committed;

    const scanStart = Math.max(committed, target - boundaryLookbackChars);
    const scanText = value.slice(scanStart, target);
    let stableCut = committed;
    let match;
    sentenceBoundaryRegex.lastIndex = 0;
    while ((match = sentenceBoundaryRegex.exec(scanText)) !== null) {
        stableCut = scanStart + match.index + match[0].length;
    }

    if (stableCut > committed) return stableCut;
    if (value.length - committed > hardCommitChars) return target;
    return committed;
}

export class StreamingSourceCleanser {
    constructor() {
        this.reset();
    }

    reset() {
        this.committedRawLength = 0;
        this.committedCleanText = '';
        this.lastRawLength = 0;
    }

    clean(rawText) {
        if (typeof rawText !== 'string' || rawText.length === 0) {
            this.reset();
            return rawText;
        }

        if (rawText.length < this.lastRawLength || rawText.length < this.committedRawLength) {
            this.reset();
        }

        const commitIndex = findStableCommitIndex(rawText, this.committedRawLength);
        if (commitIndex > this.committedRawLength) {
            const stableChunk = rawText.slice(this.committedRawLength, commitIndex);
            this.committedCleanText += applyVisualMask(stableChunk);
            this.committedRawLength = commitIndex;
        }

        this.lastRawLength = rawText.length;
        const liveTail = rawText.slice(this.committedRawLength);
        return this.committedCleanText + applyVisualMask(liveTail);
    }
}
