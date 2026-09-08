// Owns the single anonymous feedback POST and gateway response parsing.
import { feedbackEndpoint } from './config.js';

export function validateFeedbackAttachments(attachments) {
    if (attachments.length > 5) throw new Error('Select at most 5 attachments.');
    for (const file of attachments) {
        if (file.size > 10 * 1024 * 1024) throw new Error(`Attachment exceeds 10 MiB: ${file.name}`);
        if (!/^(image\/[^\s;]+|text\/[^\s;]+|application\/(pdf|json))$/i.test(file.type)) {
            throw new Error(`Attachment must be an image, PDF, text, or JSON file: ${file.name}`);
        }
    }
}

export async function submitFeedbackPayloadJson(payloadJson, attachments = [], fetchImpl = globalThis.fetch?.bind(globalThis)) {
    if (typeof fetchImpl !== 'function') throw new Error('Feedback submission is unavailable.');
    validateFeedbackAttachments(attachments);
    const body = new FormData();
    body.append('payload', payloadJson);
    for (const file of attachments) body.append('attachments', file, file.name);
    const response = await fetchImpl(feedbackEndpoint, {
        method: 'POST',
        body,
    });
    const responseBody = await response.json();
    if (!response.ok) {
        throw new Error(String(responseBody?.error || `Feedback submission failed (${response.status}).`));
    }
    if (responseBody?.feedbackId === undefined || responseBody?.feedbackId === null || responseBody?.feedbackId === '') {
        throw new Error('Feedback gateway returned no feedback ID.');
    }
    return { feedbackId: String(responseBody.feedbackId) };
}
