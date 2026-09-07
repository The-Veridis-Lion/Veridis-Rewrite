// Owns capability-based extension manifest reads for feedback metadata.
export async function readExtensionManifest(externalId, getExtensionManifest) {
    if (typeof getExtensionManifest === 'function') {
        return getExtensionManifest(externalId);
    }

    try {
        const response = await fetch(`/scripts/extensions/${externalId}/manifest.json`);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        return await response.json();
    } catch (error) {
        throw new Error(`Failed to read extension manifest for ${externalId} from the legacy SillyTavern path.`, { cause: error });
    }
}
