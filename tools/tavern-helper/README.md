# Tavern Helper realtime beauty replay

`realtime-beauty-replay.th.json` is the single-file Tavern Helper import package
for the SillyTavern / JS-Slash-Runner streaming-rendering path.

`realtime-beauty-replay.js` is only the readable source copy.

Purpose:

- Watch only the latest assistant message during DOM updates.
- Mirror current `.mes_text` CSS rules onto Tavern Helper's `.TH-streaming`
  display container, so realtime rendering keeps theme text styling such as
  `q`, `em`, `u`, `blockquote`, `strong`, and code block styles.
- Re-emit the current message render event at a throttled cadence, so existing
  beauty scripts that listen to SillyTavern render events can run again.
- Never write visual styling changes back to chat source text.

Usage:

1. Open Tavern Helper script manager.
2. Import `realtime-beauty-replay.th.json`.
3. Enable the imported script named `实时美化补帧`.

Optional hook:

```js
window.__blaiRealtimeBeautyReplay.register((messageNode, messageIndex) => {
    // Re-run your own beautifier here.
});
```

If another script reacts heavily to `MESSAGE_UPDATED`, keep
`emitMessageUpdatedEvent` disabled. The default only emits
`CHARACTER_MESSAGE_RENDERED`.
