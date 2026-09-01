// Owns Persona-description persistence through SillyTavern settings and post-save live Persona synchronization.

import { getDeepCleanHostOwnershipSnapshot, getSillyTavernContextSnapshot } from '../../host/context.js';
import { cloneJson, isRecord, postJson } from './io.js';

export async function applyPersonaUnit(fetchImpl, context, changes) {
    const response = await postJson(
        fetchImpl,
        context,
        '/api/settings/get',
        {},
        'Deep Clean Persona settings read failed',
    );
    if (typeof response?.settings !== 'string') throw new Error('Deep Clean Persona settings response has no settings JSON');
    let settings;
    try {
        settings = JSON.parse(response.settings);
    } catch {
        throw new Error('Deep Clean Persona settings JSON is invalid');
    }
    const powerUser = settings?.power_user;
    const descriptions = powerUser?.persona_descriptions;
    if (!isRecord(settings) || !isRecord(powerUser) || !isRecord(descriptions)) {
        throw new Error('Deep Clean Persona settings owner is invalid');
    }
    const livePowerUser = getSillyTavernContextSnapshot()?.powerUserSettings;
    if (!isRecord(livePowerUser) || !isRecord(livePowerUser.persona_descriptions)) {
        throw new Error('Deep Clean live Persona owner is unavailable');
    }

    for (const change of changes) {
        const personaKey = change.locator.personaKey;
        const descriptor = descriptions[personaKey];
        if (!isRecord(descriptor) || descriptor.description !== change.originalText) {
            throw new Error(`Deep Clean Persona changed after Freeze: ${personaKey}`);
        }
        descriptor.description = change.reviewedText;
        if (settings.user_avatar === personaKey) powerUser.persona_description = change.reviewedText;
    }

    const saved = await postJson(
        fetchImpl,
        context,
        '/api/settings/save',
        settings,
        'Deep Clean Persona settings save failed',
    );
    if (saved?.result !== 'ok') throw new Error('Deep Clean Persona settings save was not confirmed');

    const currentPersonaIdentity = getDeepCleanHostOwnershipSnapshot().currentPersonaIdentity;
    for (const change of changes) {
        const personaKey = change.locator.personaKey;
        const liveDescriptor = livePowerUser.persona_descriptions[personaKey];
        if (isRecord(liveDescriptor)) liveDescriptor.description = change.reviewedText;
        else livePowerUser.persona_descriptions[personaKey] = cloneJson(descriptions[personaKey]);
        if (currentPersonaIdentity === personaKey) livePowerUser.persona_description = change.reviewedText;
    }
}
