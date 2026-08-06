export function classifyHostGenerationStart(type, options, dryRun) {
    const mode = typeof type === 'string' && type ? type : 'generation';
    if (dryRun === true) return { track: false, mode, reason: 'dry-run' };

    const isBackground = mode === 'quiet'
        || (typeof options?.quiet_prompt === 'string'
            && options.quiet_prompt.length > 0
            && options.quietToLoud !== true);
    if (isBackground) return { track: false, mode, reason: 'background-generation' };

    return { track: true, mode, reason: '' };
}

