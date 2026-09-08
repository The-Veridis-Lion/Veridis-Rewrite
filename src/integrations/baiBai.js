/** Owns BaiBai Toolkit presence detection for the existing display refresh path, not its job or save state. */
import { getGlobalObject } from '../host/context.js';

export function isBaiBaiToolkitInstalled() {
    const root = getGlobalObject();
    return Boolean(
        root.__baiBaiToolkitExtensionInstalled
        || root.__baiBaiToolkitSaveGenerateFetchPatched
        || root.__baiBaiToolkitSaveRequestGzipFetchPatched,
    );
}
