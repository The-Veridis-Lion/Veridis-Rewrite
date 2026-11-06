import { getMessageDiffMeta, isMessageDiffReverted, writeMessageDiffAiStage } from './messageMeta.js';
import { getMessageDiffBranchKey, commitCurrentMessageText, clearMessageDisplayText, syncCurrentSwipeExtra } from '../chat/messageBranch.js';

export function captureFragmentEdit(chat, msg, section, change) {
    const meta = getMessageDiffMeta(msg);
    if (!Array.isArray(chat) || !chat.includes(msg) || !meta || isMessageDiffReverted(msg) || msg.mes !== meta.programMes) return null;
    const oldText = section === 'ai' ? meta.originalMes : meta.aiMes ?? meta.originalMes;
    const newText = section === 'ai' ? meta.aiMes : meta.programMes;
    // Intermediate-stage offsets are not final-body offsets. Do not guess a mapping.
    if (!['ai', 'program'].includes(section) || newText !== msg.mes) return null;
    const { oldStart, oldEnd, newStart, newEnd, deletedText, insertedText } = change;
    if (![oldStart, oldEnd, newStart, newEnd].every(Number.isInteger)
        || oldStart < 0 || oldEnd < oldStart || oldEnd > oldText.length
        || newStart < 0 || newEnd < newStart || newEnd > newText.length
        || oldText.slice(oldStart, oldEnd) !== deletedText || newText.slice(newStart, newEnd) !== insertedText) return null;
    return { chat, msg, index: chat.indexOf(msg), branch: getMessageDiffBranchKey(msg), meta, section, newStart, newEnd, deletedText, insertedText, text: msg.mes };
}

export function applyFragmentEdit(chat, draft, value) {
    if (!draft || typeof value !== 'string' || chat !== draft.chat || chat[draft.index] !== draft.msg) return false;
    const { msg, meta, branch } = draft;
    if (getMessageDiffBranchKey(msg) !== branch || msg.mes !== draft.text || isMessageDiffReverted(msg)
        || JSON.stringify(getMessageDiffMeta(msg)) !== JSON.stringify(meta)) return false;
    const next = draft.text.slice(0, draft.newStart) + value + draft.text.slice(draft.newEnd);
    if (!commitCurrentMessageText(msg, next, branch).ok) return false;
    // Keep original and AI provenance; user edits become the final stage.
    writeMessageDiffAiStage(msg, branch, meta.originalMes, meta.aiMes, next, meta.aiUnchanged);
    clearMessageDisplayText(msg);
    syncCurrentSwipeExtra(msg);
    return true;
}
