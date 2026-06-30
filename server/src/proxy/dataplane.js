/**
 * Minimal HAProxy Data Plane API client (v2/v3). Provisions a TCP frontend +
 * backend per remote-access mapping so the proxy forwards a public port to the
 * target's (possibly non-standard) SSH/RDP port. All changes go through a
 * transaction which is committed (triggering a graceful HAProxy reload).
 */

import { resilientFetch } from '../util/resilientFetch.js';

const feName = (id) => `ra_fe_${id}`;
const beName = (id) => `ra_be_${id}`;

function base(dp) {
  if (!dp?.url) throw new Error('Data Plane API URL이 설정되지 않았습니다.');
  return `${dp.url.replace(/\/$/, '')}${dp.basePath || '/v3'}/services/haproxy`;
}

async function call(dp, method, pathQuery, body) {
  const headers = { Accept: 'application/json' };
  if (dp.username) headers.Authorization = 'Basic ' + Buffer.from(`${dp.username}:${dp.password || ''}`).toString('base64');
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // 고RTT 상향(15s→30s) + 일시 오류 1회 재시도. resilientFetch는 연결오류·5xx만 재시도하고
  // 4xx(이미 존재 등)는 재시도하지 않으므로 트랜잭션 변경의 중복 적용 위험이 낮다.
  const res = await resilientFetch(`${base(dp)}${pathQuery}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
    timeoutMs: 30000, retries: 1,
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) {
    const msg = (json && (json.message || json.error)) || text || `HTTP ${res.status}`;
    const err = new Error(msg); err.status = res.status; throw err;
  }
  return json;
}

async function configVersion(dp) {
  const v = await call(dp, 'GET', '/configuration/version');
  return typeof v === 'number' ? v : (v?.version ?? v?._version ?? 1);
}

async function withTransaction(dp, fn) {
  const version = await configVersion(dp);
  const tx = await call(dp, 'POST', `/transactions?version=${version}`);
  const id = tx.id || tx._id;
  try {
    await fn(id);
    return await call(dp, 'PUT', `/transactions/${id}`); // commit → reload
  } catch (err) {
    try { await call(dp, 'DELETE', `/transactions/${id}`); } catch { /* ignore */ }
    throw err;
  }
}

/** Connectivity/auth probe used by the UI test button. */
export async function testDataplane(dp) {
  const started = Date.now();
  try {
    const info = await call(dp, 'GET', '/configuration/global').catch(() => null);
    await configVersion(dp);
    return { ok: true, ms: Date.now() - started, reachable: true, info: !!info };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/** Create the TCP frontend+backend for a mapping. */
export async function applyMapping(dp, m) {
  await withTransaction(dp, async (tx) => {
    const q = `transaction_id=${tx}`;
    await call(dp, 'POST', `/configuration/backends?${q}`, { name: beName(m.id), mode: 'tcp' });
    await call(dp, 'POST', `/configuration/servers?backend=${beName(m.id)}&${q}`,
      { name: 'target', address: m.targetHost, port: Number(m.targetPort) });
    await call(dp, 'POST', `/configuration/frontends?${q}`,
      { name: feName(m.id), mode: 'tcp', default_backend: beName(m.id) });
    await call(dp, 'POST', `/configuration/binds?frontend=${feName(m.id)}&${q}`,
      { name: `b_${m.publicPort}`, address: dp.bindAddress || '*', port: Number(m.publicPort) });
  });
}

/** Remove the frontend+backend for a mapping (best-effort per element). */
export async function removeMapping(dp, m) {
  await withTransaction(dp, async (tx) => {
    const q = `transaction_id=${tx}`;
    try { await call(dp, 'DELETE', `/configuration/frontends/${feName(m.id)}?${q}`); } catch { /* may not exist */ }
    try { await call(dp, 'DELETE', `/configuration/backends/${beName(m.id)}?${q}`); } catch { /* may not exist */ }
  });
}
