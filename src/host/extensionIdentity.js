const extensionsPathMarker = '/scripts/extensions/';

/**
 * Derives this extension's SillyTavern identifier from the URL that loaded its
 * entry module, so a local junction may use any folder name.
 */
export function resolveExtensionIdentity(moduleUrl) {
    const pathname = new URL(moduleUrl).pathname;
    const markerIndex = pathname.lastIndexOf(extensionsPathMarker);
    if (markerIndex < 0) {
        throw new Error(`Unable to resolve the SillyTavern extension path from ${moduleUrl}.`);
    }

    const scriptPath = decodeURIComponent(pathname.slice(markerIndex + extensionsPathMarker.length));
    const pathSegments = scriptPath.split('/').filter(Boolean);
    pathSegments.pop(); // index.js
    if (!pathSegments.length) {
        throw new Error(`Unable to resolve the SillyTavern extension identifier from ${moduleUrl}.`);
    }

    const externalId = pathSegments.join('/');
    return {
        externalId,
        folderName: pathSegments.at(-1),
        templateDirectory: `${externalId}/templates`,
    };
}
