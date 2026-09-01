import { extensionName } from '../settings/defaults.js';
import { getAppContext } from '../host/appContext.js';

/** Owns projection of the Persona-description protection control only; the setting and protection policy remain elsewhere. */

export function syncPersonaDescriptionProtectionControl() {
    const settings = getAppContext().extension_settings?.[extensionName];
    if (!settings || typeof document === 'undefined') return;

    const updateButton = (button) => {
        if (!button) return;
        const enabled = settings.protectPersonaDescription === true;
        button.classList.toggle('is-active', enabled);
        button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        button.setAttribute('title', enabled ? '已保护用户设定描述，点击取消保护' : '点击保护用户设定描述');
        const text = button.querySelector('.blai-persona-protect-text');
        const isPanelControl = Boolean(button.closest('#blai-purifier-popup'));
        if (text) text.textContent = isPanelControl ? (enabled ? '开启' : '关闭') : (enabled ? '已保护' : '保护');
        const icon = button.querySelector('i');
        if (icon) icon.className = enabled ? 'fa-solid fa-shield-halved' : 'fa-solid fa-shield';
    };

    document
        .querySelectorAll('.blai-persona-description-protect-toggle')
        .forEach(updateButton);

    const anchor = document.querySelector('[data-for="persona_description"]');
    const textarea = document.querySelector('#persona_description, [name="persona_description"]');
    const heading = anchor?.closest?.('h4') || textarea?.previousElementSibling;
    if (!heading || heading.querySelector?.('.blai-persona-description-protect-toggle')) {
        return;
    }

    const enabled = settings.protectPersonaDescription === true;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `blai-persona-description-protect-toggle${enabled ? ' is-active' : ''}`;
    button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    button.setAttribute('title', enabled ? '已保护用户设定描述，点击取消保护' : '点击保护用户设定描述');
    button.innerHTML = `<i class="${enabled ? 'fa-solid fa-shield-halved' : 'fa-solid fa-shield'}"></i><span class="blai-persona-protect-text">${enabled ? '已保护' : '保护'}</span>`;
    heading.appendChild(button);
    updateButton(button);
}

