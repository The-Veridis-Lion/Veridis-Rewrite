import { extensionName } from '../settings/defaults.js';
import { getAppContext } from '../host/appContext.js';

export function normalizeUiFontScale(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(1.6, Math.max(1, Math.round(number * 10) / 10)) : 1;
}

export function bindUiFontScaleEvents() {
    const { extension_settings, saveSettingsDebounced } = getAppContext();
    const settings = extension_settings[extensionName];
    for (const [key, id, variable] of [
        ['uiFontScale', 'blai-ui-font-scale', '--blai-ui-font-scale'],
        ['diffFontScale', 'blai-diff-font-scale', '--blai-diff-font-scale'],
    ]) {
        const select = document.getElementById(id);
        const sync = () => {
            const scale = normalizeUiFontScale(settings[key]);
            document.documentElement.style.setProperty(variable, String(scale));
            if (select) select.value = String(scale);
        };
        if (select) select.onchange = () => {
            settings[key] = normalizeUiFontScale(select.value);
            sync();
            saveSettingsDebounced();
        };
        sync();
    }
}
