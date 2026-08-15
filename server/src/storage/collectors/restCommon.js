/**
 * storage/collectors/restCommon.js — REST 수집기 공용 HTTP 헬퍼(v2.309).
 * PowerStore/Unity 수집기가 공유한다(isilon.js 의 get/getAny 와 동일 철학 — 포트·헤더만 다름).
 * 자체서명 장비 한정 로컬 TLS 디스패처(전역 오염 금지 — server/CLAUDE.md). 401 은 명시 오류로
 * 던져 수집기가 즉시 중단하게 한다(장비 계정 잠금 예방 — isilon 과 동일 규칙).
 */
import { Agent } from 'undici';

const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
const TIMEOUT_MS = Number(process.env.STORAGE_HTTP_TIMEOUT_MS) || 15_000;

export function makeGetter(device, { port = 443, headers = {} } = {}) {
  const auth = Buffer.from(`${device.username}:${device.password || ''}`).toString('base64');
  return async (apiPath) => {
    const res = await fetch(`https://${device.host}:${port}${apiPath}`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', ...headers },
      dispatcher, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) throw new Error('인증 실패(401) — 계정/비밀번호 확인');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
}

/** 후보 경로 순차 시도(버전차 폴백) — 전부 실패 시 마지막 오류 throw. */
export async function tryAny(get, paths) {
  let err;
  for (const p of paths) { try { return await get(p); } catch (e) { err = e; if (/401/.test(e.message)) throw e; } }
  throw err;
}
