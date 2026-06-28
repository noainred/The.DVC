/** Minimal Ollama HTTP client (generate + tags). No external deps. */

import { resilientFetch } from '../util/resilientFetch.js';

export async function ollamaGenerate(cfg, prompt, { format } = {}) {
  // 원격/고RTT Ollama 서버에서 일시 오류 1회 재시도(추론은 멱등). 큰 모델 대비 기본 타임아웃 확대.
  const res = await resilientFetch(`${cfg.url.replace(/\/$/, '')}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model, prompt, stream: false,
      ...(format ? { format } : {}),
      options: { temperature: 0 },
    }),
    timeoutMs: cfg.timeoutMs || 60000, retries: 1,
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return json.response || '';
}

/** List installed models — used by the connectivity test. */
export async function ollamaTest(cfg) {
  const started = Date.now();
  try {
    const res = await resilientFetch(`${cfg.url.replace(/\/$/, '')}/api/tags`, { timeoutMs: cfg.timeoutMs || 30000, retries: 1 });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const json = await res.json();
    const models = (json.models || []).map((m) => m.name);
    return { ok: true, ms: Date.now() - started, models, hasModel: models.includes(cfg.model) };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
