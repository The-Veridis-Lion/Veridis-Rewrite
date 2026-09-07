/** Displays an already-computed Program frame through SillyTavern's renderer. */
import { getAppContext } from '../host/appContext.js';
import { getMessageDomNode } from './message.js';

export function renderStreamingProgram(messageId, programText) {
    const { chat, getSillyTavernContext } = getAppContext();
    const message = chat[messageId];
    const surface = getMessageDomNode(messageId)?.querySelector('.mes_text');
    if (!surface) return;
    const { messageFormatting } = getSillyTavernContext();
    surface.innerHTML = messageFormatting(
        programText, message.name, message.is_system, message.is_user, messageId, {}, false,
    );
}
