/** Minimal Ollama HTTP client (generate + tags). No external deps. */

export async function ollamaGenerate(cfg, prompt, { format } = {}) {
  const res = await fetch(`${cfg.url.replace(/\/$/, '')}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model, prompt, stream: false,
      ...(format ? { format } : {}),
      options: { temperature: 0 },
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs || 30000),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return json.response || '';
}

/** List installed models — used by the connectivity test. */
export async function ollamaTest(cfg) {
  const started = Date.now();
  try {
    const res = await fetch(`${cfg.url.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(cfg.timeoutMs || 30000) });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const json = await res.json();
    const models = (json.models || []).map((m) => m.name);
    return { ok: true, ms: Date.now() - started, models, hasModel: models.includes(cfg.model) };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
