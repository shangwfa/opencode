async function request(path, init) {
    const res = await fetch(path, {
        headers: { 'Content-Type': 'application/json' },
        ...init,
    });
    if (!res.ok) {
        const body = (await res.json().catch(() => ({})));
        throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
}
export const api = {
    listSessions: () => request('/api/sessions'),
    createSession: (prompt, model) => request('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ prompt, model }),
    }),
    deleteSession: (id) => request(`/api/sessions/${id}`, { method: 'DELETE' }),
    sendPrompt: (id, text, model) => request(`/api/sessions/${id}/prompt`, {
        method: 'POST',
        body: JSON.stringify({ text, model }),
    }),
    abortSession: (id) => request(`/api/sessions/${id}/abort`, { method: 'POST' }),
    listMessages: (id) => request(`/api/sessions/${id}/messages`),
    listModels: () => request('/api/models'),
};
