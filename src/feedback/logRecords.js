// Display existing records only; no generation state or extra storage.
export function renderLogRecords(output, records, emptyText) {
    const documentRef = output.ownerDocument;
    const fragment = documentRef.createDocumentFragment();
    for (const record of records) {
        const section = documentRef.createElement('section');
        section.className = 'blai-log-record';
        const header = documentRef.createElement('header');
        header.className = 'blai-feedback-local-heading';
        const title = documentRef.createElement('strong');
        title.textContent = record.title;
        const button = documentRef.createElement('button');
        button.type = 'button';
        button.dataset.feedbackCopyRecord = '';
        button.textContent = '复制本组';
        const body = documentRef.createElement('pre');
        body.className = 'blai-feedback-log-output';
        body.tabIndex = 0;
        body.textContent = `${record.title}\n\n${record.text}`;
        header.append(title, button);
        section.append(header, body);
        fragment.append(section);
    }
    if (!records.length) fragment.append(documentRef.createTextNode(emptyText));
    output.replaceChildren(fragment);
}
