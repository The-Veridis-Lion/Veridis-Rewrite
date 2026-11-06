// Keep stored ISO timestamps unchanged; display the device's local time explicitly.
export function formatLocalLogTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return String(value ?? '');
    const pad = (number, width = 2) => String(number).padStart(width, '0');
    const offset = -date.getTimezoneOffset();
    const zone = `UTC${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)} ${zone}`;
}
