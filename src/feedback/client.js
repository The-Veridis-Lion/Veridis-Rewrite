// Owns the single anonymous feedback POST and gateway response parsing.
import { feedbackEndpoint } from './config.js';

export async function submitFeedbackPayloadJson(payloadJson, fetchImpl = globalThis.fetch?.bind(globalThis)) {
    if (typeof fetchImpl !== 'function') throw new Error('Feedback submission is unavailable.');
    const response = await fetchImpl(feedbackEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payloadJson,
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
