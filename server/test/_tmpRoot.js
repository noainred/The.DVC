/**
 * test/_tmpRoot.js — 시험용 임시 폴더의 **계정별 상위 폴더 + 죽은 실행의 폴더 청소**(서버 `_isolateConfig.js` 와 웹 `vitest.globalSetup.js` 가 같이 쓴다 · 2026-11-26).
 *
 * 폴더는 `<tmp>/<tag>-<uid>/<pid>-XXXXXX`. 실행이 정상으로 끝나면 부른 쪽이 지우고, 죽으면(시한 초과 · Ctrl-C · KILL) 다음 실행이
 * **이름의 pid 가 없고(ESRCH) 10분 넘게 손대지 않은** 폴더를 지운다(같은 상위 폴더만 읽는다 — /tmp 전체를 훑지 않는다).
 * 상위 폴더는 계정마다 · 0700 · 심링크가 아닌 내 폴더일 때만 쓴다 — 공용 이름 하나면 root 로 한 번 돈 뒤 다른 계정의 시험이 전부 EACCES 였고,
 * 심링크면 청소가 가리키는 곳의 하위를 지웠다(둘 다 재현). 조건이 맞지 않으면 OS 임시 폴더에 바로 만들고 청소는 하지 않는다(시험을 멈추게 하지 않는다).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const STALE_MS = 10 * 60_000;
const uid = () => (typeof process.getuid === 'function' ? process.getuid() : 'u');

/** 계정별 상위 폴더 경로(만들지 않는다). */
export function tmpRootOf(tag) { return path.join(os.tmpdir(), `${tag}-${uid()}`); }

/** root 가 쓸 수 있는 내 폴더인가(없으면 0700 으로 만든다). 심링크 · 남의 소유 · 남이 쓸 수 있는 권한이면 false. */
export function rootIsMine(root) {
  try { fs.mkdirSync(root, { mode: 0o700 }); } catch (e) { if (e?.code !== 'EEXIST') return false; }
  try {
    const st = fs.lstatSync(root);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false;
    if ((st.mode & 0o022) !== 0) return false;
    return true;
  } catch { return false; }
}

/** 죽은 실행이 남긴 폴더를 지운다 — 이름의 pid 가 없고(ESRCH) staleMs 넘게 손대지 않은 진짜 폴더만(심링크는 따라가지 않는다). 실패는 시험 결과가 아니다. */
export function sweepStale(root, { now = Date.now(), staleMs = STALE_MS } = {}) {
  let names = [];
  try { names = fs.readdirSync(root); } catch { return; }
  for (const n of names) {
    const m = /^(\d+)-/.exec(n);
    if (!m || Number(m[1]) === process.pid) continue;
    try { process.kill(Number(m[1]), 0); continue; } catch (e) { if (e?.code !== 'ESRCH') continue; }   // 살아 있다(EPERM 포함) — 건드리지 않는다
    const p = path.join(root, n);
    try { const st = fs.lstatSync(p); if (st.isDirectory() && !st.isSymbolicLink() && now - st.mtimeMs > staleMs) fs.rmSync(p, { recursive: true, force: true }); } catch { /* */ }
  }
}

/** 이 프로세스의 임시 폴더를 만든다(상위가 내 폴더면 먼저 청소). @returns {string} 만든 폴더 */
export function makeOwnTmpDir(tag) {
  const root = tmpRootOf(tag);
  const mine = rootIsMine(root);
  if (mine) sweepStale(root);
  return fs.mkdtempSync(mine ? path.join(root, `${process.pid}-`) : path.join(os.tmpdir(), `${tag}-${process.pid}-`));
}
