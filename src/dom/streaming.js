/** Displays an already-computed Program frame through SillyTavern's renderer. */
import { getAppContext } from '../host/appContext.js';
import { getMessageDomNode } from './message.js';

export function renderStreamingProgram(messageId, programText) {
    const { chat, getSillyTavernContext, applyStreamFadeIn } = getAppContext();
    const message = chat[messageId];
    const surface = getMessageDomNode(messageId)?.querySelector('.mes_text');
    if (!surface) return;
    const { messageFormatting, powerUserSettings } = getSillyTavernContext();
    const formattedText = messageFormatting(
        programText, message.name, message.is_system, message.is_user, messageId, {}, false,
    );
    if (powerUserSettings.stream_fade_in) {
        applyStreamFadeIn(surface, formattedText);
    } else {
        surface.innerHTML = formattedText;
    }
}
