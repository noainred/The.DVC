/**
 * bmstor/collect.js — 베어메탈 스토리지(v2.340): SSH `df` 로 서버 로컬 디스크(지정 마운트
 * 포인트)의 총/사용/가용 용량을 수집한다. 파서·검증은 순수 함수로 분리(vitest 대상).
 *
 * 명령은 POSIX `df -P -k -- <mounts...>` — -B1(GNU 전용) 대신 -k(1024 블록)로 이식성 확보.
 * ssh2 exec 는 셸을 거치므로 **마운트 경로는 엄격한 허용 문자만** 통과시킨다(명령 주입 방어).
 * df 는 없는 마운트가 섞여도 있는 것은 출력하고 exit≠0 — 있는 것은 살리고 없는 것만 오류 표기.
 */

import { withSsh } from '../proxy/sshExec.js';

/** 마운트 경로 검증 — 절대경로 + 안전 문자만(공백/따옴표/셸 메타문자 거부 = 명령 주입 방어). */
export const MOUNT_RE = /^\/[A-Za-z0-9._\/-]*$/;

/**
 * 마운트 목록 정규화/검증. 문자열(줄바꿈·쉼표·세미콜론 구분) 또는 배열을 받는다.
 * @returns {{mounts:string[], errors:string[]}} 중복 제거·정렬 없음(입력 순서 보존).
 */
export function sanitizeMounts(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[\n,;]/);
  const mounts = []; const errors = []; const seen = new Set();
  for (const m of raw.map((s) => String(s).trim()).filter(Boolean)) {
    if (!MOUNT_RE.test(m)) { errors.push(`허용되지 않는 마운트 경로: ${m} (절대경로 + 영숫자/._-/ 만)`); continue; }
    if (m.length > 256) { errors.push(`마운트 경로가 너무 김: ${m.slice(0, 40)}…`); continue; }
    if (!seen.has(m)) { seen.add(m); mounts.push(m); }
  }
  return { mounts, errors };
}

/**
 * `df -P -k` 출력 파싱 → 요청 마운트별 용량(바이트).
 * POSIX -P 는 6컬럼(fs, 1024-blocks, used, available, capacity, mounted-on)을 보장하고,
 * mounted-on 은 마지막 컬럼이므로 공백 포함 경로도 뒤에서부터 안전하게 잡는다.
 * @returns {{mounts:Array<{mount,totalBytes,usedBytes,availBytes,usedPct}>, missing:string[]}}
 */
export function parseDfOutput(stdout, requestedMounts) {
  const byMount = new Map();
  for (const line of String(stdout || '').split(/\r?\n/).slice(1)) { // 1행 = 헤더
    const t = line.trim();
    if (!t) continue;
    const cols = t.split(/\s+/);
    if (cols.length < 6) continue;
    // 마운트 경로에 공백이 있으면 컬럼이 6개를 넘는다 → 숫자 4개(2~5번째) 뒤 전부가 경로.
    const nums = cols.slice(1, 5);
    const totalKb = Number(nums[0]); const usedKb = Number(nums[1]); const availKb = Number(nums[2]);
    if (!Number.isFinite(totalKb) || !Number.isFinite(usedKb) || !Number.isFinite(availKb)) continue;
    const mount = cols.slice(5).join(' ');
    const totalBytes = totalKb * 1024; const usedBytes = usedKb * 1024; const availBytes = availKb * 1024;
    byMount.set(mount, {
      mount, totalBytes, usedBytes, availBytes,
      usedPct: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
    });
  }
  const mounts = []; const missing = [];
  for (const m of requestedMounts || []) {
    const hit = byMount.get(m);
    if (hit) mounts.push(hit);
    else missing.push(m); // df 가 그 마운트를 못 찾음(미마운트/오타) — 서버 전체 실패로 만들지 않는다
  }
  return { mounts, missing };
}

/**
 * 서버 1대 수집 — SSH 접속 → df 실행 → 파싱. 실패해도 throw 하지 않고 {ok:false, error}.
 * @param {{host,port,username,password,mounts:string[]}} server
 * @returns {Promise<{ok:boolean, mounts:Array, missing?:string[], error?:string}>}
 */
export async function collectServer(server) {
  const { mounts, errors } = sanitizeMounts(server.mounts);
  if (!mounts.length) return { ok: false, mounts: [], error: errors[0] || '측정할 마운트 포인트가 없습니다.' };
  try {
    const r = await withSsh({
      host: server.host, port: Number(server.port) || 22,
      username: server.username || 'root', password: server.password || '',
      readyTimeout: Number(process.env.BMSTOR_SSH_TIMEOUT_MS) || 15000,
    }, async ({ exec }) => {
      const out = await exec(`df -P -k -- ${mounts.join(' ')}`);
      return { out };
    });
    const { mounts: rows, missing } = parseDfOutput(r.out.stdout, mounts);
    if (!rows.length) {
      const err = (r.out.stderr || '').trim().split('\n')[0] || 'df 출력에서 요청 마운트를 찾지 못했습니다.';
      return { ok: false, mounts: [], missing, error: err };
    }
    return { ok: true, mounts: rows, missing };
  } catch (e) {
    return { ok: false, mounts: [], error: e.message };
  }
}

/** 소규모 동시성 풀 — 서버 수십 대를 한꺼번에 SSH 하지 않게 제한(기본 4). */
export async function collectMany(servers, { concurrency = Number(process.env.BMSTOR_CONCURRENCY) || 4 } = {}) {
  const list = [...servers];
  const results = new Array(list.length);
  let idx = 0;
  const worker = async () => {
    while (idx < list.length) {
      const i = idx++;
      results[i] = { id: list[i].id, ...(await collectServer(list[i])) };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, worker));
  return results;
}
