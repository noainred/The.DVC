/** Minimal Ollama HTTP client (generate + tags). No external deps. */

import { resilientFetch } from '../util/resilientFetch.js';
import { readBodyPrefix } from '../util/readPrefix.js';

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
  // v2.604(감사 CEN2604-02 형제): 오류 본문은 앞 200바이트만 읽는다 — 전체를 읽고 자르면 거대(압축) 응답이 메모리를 채운다.
  if (!res.ok) { const pre = await readBodyPrefix(res, 200).catch(() => ({ text: '' })); throw new Error(`Ollama HTTP ${res.status}: ${pre.text}`); }
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
    // v2.590 D6: 'fetch failed' 만으로는 원인을 알 수 없다 — SSRF 가드(ESSRFBLOCKED)·연결 거부 사유를 붙인다.
    const cause = err?.cause?.message || err?.cause?.code || '';
    return { ok: false, reason: cause && !String(err.message).includes(cause) ? `${err.message} — ${cause}` : err.message };
  }
}
