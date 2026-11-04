/**
 * bareos/healthProbe.js — v2.886 사전 점검(시안 docs/design/bareos-precheck · 사용자 컨펌 2026-11-05)의 **읽기 전용** 측정.
 * 작업 표 `ops.health` 가 부른다 — 엣지 대행이면 엣지 노드 안에서(포탈 완전 설치는 FD · SD 가 같은 서버), 중앙 직접이면 중앙 포탈에서.
 *
 *  · vCenter 접속: `tls.connect(vcserver, 443)` — 이름 풀이 · TCP · TLS 핸드셰이크까지만(아무것도 보내지 않는다 · 인증서 검증 없이 지문만 읽는다).
 *    SSRF 가드: IP 리터럴은 `ipBlockReason`, 이름은 `ssrfLookup` 훅(해석한 그 주소로 접속 — 리바인딩 차단). RFC1918 은 허용(사내 vCenter).
 *  · 디스크: `fs.promises.statfs(path)` — 경로마다 여유 · 전체 · 사용(바이트). 경로는 부르는 쪽이 `volumeDirIssue` 로 거른 것만.
 *  · 같은 서버인가: Director 주소가 이 프로세스가 도는 서버의 주소(루프백 · 인터페이스 주소 · 호스트 이름)인가 — 아니면 디스크는 재지 않는다
 *    (다른 서버의 경로를 이 서버에서 재면 엉뚱한 디스크다).
 * 못 읽은 값은 null(0 이 아니다) · 오류는 코드 문자열만(원문 메시지는 싣지 않는다 — 회신 정제 · 메일 · 화면이 코드로 문구를 고른다).
 */
import tls from 'node:tls';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { ipBlockReason } from '../util/ssrfBlock.js';
import { ssrfLookup } from '../util/ssrfLookup.js';

export const VC_TIMEOUT_MS = 10_000;
export const DISKS_MAX = 8;
export const VCS_MAX = 8;
const HOST_RE = /^[A-Za-z0-9.:-]{1,253}$/;
const PATH_RE = /^\/[A-Za-z0-9._/-]{1,200}$/;
/** 접속 오류 코드 → 판정에 쓰는 코드(알려진 것만 · 나머지 'error'). */
const VC_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EPROTO', 'blocked']);

/**
 * vcserver:443 TLS 접속 · SHA1 지문(대문자 콜론 — Node `cert.fingerprint` 모양 그대로).
 * @returns {Promise<{ host, ok:boolean, code:string|null, ms:number|null, thumbprint:string|null }>}
 */
export function checkVc(host, { timeoutMs = VC_TIMEOUT_MS, signal = null, connect = tls.connect } = {}) {
  const h = String(host || '');
  if (!HOST_RE.test(h)) return Promise.resolve({ host: h.slice(0, 253), ok: false, code: 'invalid', ms: null, thumbprint: null });
  const blocked = ipBlockReason(h);
  if (blocked) return Promise.resolve({ host: h, ok: false, code: 'blocked', ms: null, thumbprint: null });
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false; let sock = null;
    const finish = (r) => {
      if (done) return; done = true;
      clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort);
      try { sock?.destroy(); } catch { /* */ }
      resolve({ host: h, ms: Date.now() - t0, thumbprint: null, ...r });
    };
    const onAbort = () => finish({ ok: false, code: 'ETIMEDOUT' });
    const timer = setTimeout(onAbort, Math.max(1000, Math.min(30_000, Number(timeoutMs) || VC_TIMEOUT_MS)));
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      // 이름이면 SNI 를 싣는다(IP 리터럴에는 SNI 를 실을 수 없다 — Node 가 경고). 인증서는 검증하지 않고 지문만 읽는다(자체 서명 vCenter).
      const isIp = /^[0-9.]+$/.test(h) || h.includes(':');
      sock = connect({ host: h, port: 443, rejectUnauthorized: false, lookup: ssrfLookup, ...(isIp ? {} : { servername: h }) }, () => {
        let fp = null;
        try { const c = sock.getPeerCertificate(); fp = typeof c?.fingerprint === 'string' && /^[0-9A-F]{2}(:[0-9A-F]{2}){19}$/.test(c.fingerprint) ? c.fingerprint : null; } catch { fp = null; }
        finish({ ok: true, code: null, thumbprint: fp });
      });
      sock.on('error', (e) => {
        const c = String(e?.code || '');
        finish({ ok: false, code: c === 'ESSRFBLOCKED' ? 'blocked' : (VC_CODES.has(c) ? c : 'error') });
      });
    } catch { finish({ ok: false, code: 'error' }); }
  });
}

/**
 * 볼륨 경로마다 statfs. 경로 형식이 틀린 것은 재지 않는다('invalid').
 * @returns {Promise<{ path, availBytes:number|null, sizeBytes:number|null, usedBytes:number|null, code:string|null }[]>}
 */
export async function checkDisks(paths, { statfs = fsp.statfs } = {}) {
  const list = [...new Set((Array.isArray(paths) ? paths : []).map(String))].slice(0, DISKS_MAX);
  const out = [];
  for (const p of list) {
    if (!PATH_RE.test(p) || p.includes('..')) { out.push({ path: p.slice(0, 200), availBytes: null, sizeBytes: null, usedBytes: null, code: 'invalid' }); continue; }
    try {
      const s = await statfs(p);
      const bs = Number(s?.bsize);
      const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && Number.isFinite(bs) && bs > 0 ? n * bs : null; };
      const sizeBytes = num(s?.blocks); const availBytes = num(s?.bavail); const freeBytes = num(s?.bfree);
      out.push({ path: p, availBytes, sizeBytes, usedBytes: sizeBytes !== null && freeBytes !== null ? Math.max(0, sizeBytes - freeBytes) : null, code: null });
    } catch (e) {
      const c = String(e?.code || '');
      out.push({ path: p, availBytes: null, sizeBytes: null, usedBytes: null, code: ['ENOENT', 'EACCES', 'ENOTDIR', 'EPERM'].includes(c) ? c : 'error' });
    }
  }
  return out;
}

/** Director 주소가 이 서버인가(루프백 · 인터페이스 주소 · 호스트 이름 · 짧은 이름). 모르면 false(디스크를 재지 않는 쪽). */
export function isThisHost(host, { ifaces = os.networkInterfaces(), hostname = os.hostname() } = {}) {
  const h = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  if (h === 'localhost' || h.startsWith('localhost.') || /^127\./.test(h) || h === '::1') return true;
  for (const list of Object.values(ifaces || {})) for (const a of list || []) if (String(a?.address || '').toLowerCase() === h) return true;
  const me = String(hostname || '').toLowerCase();
  return !!me && (h === me || h.split('.')[0] === me.split('.')[0]);
}
