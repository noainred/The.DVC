/**
 * loganalysis/journal.js — systemd 저널 읽기(v2.583). 설정 › Log › 로그 분석의 '서비스 저널' 원천.
 *
 * 현장은 폐쇄망이라 저널을 밖으로 가져갈 수 없다. 포탈이 **자기 서비스의 저널을 직접** 읽는다.
 *  · 인자는 고정이다 — 사용자가 주는 것은 시간(1~168)뿐이고 유닛 이름은 환경 변수(PORTAL_SYSTEMD_UNIT,
 *    기본 vmware-portal)에서 형식 검사 후 쓴다. 셸을 거치지 않는다(execFile 계열 spawn).
 *  · 줄·바이트·시간 상한이 있다(기본 30만 줄 · 80MB · 90초). 넘으면 멈추고 **잘렸다고 밝힌다**.
 *  · ⚠ 서비스 계정(시스템 사용자)은 보통 시스템 저널을 읽을 권한이 없다. journalctl 은 그때 **종료코드 0
 *    으로 빈 출력**과 경고 한 줄을 준다 — 빈 결과를 '로그 없음' 이라 말하면 거짓이다. 경고 문구로
 *    `permission` 을 판정해 조치(그 계정을 systemd-journal 그룹에 추가)를 화면이 말한다.
 *  · 동시에 하나만 돈다(재진입 가드) — 연타가 저널 스캔을 곱하지 않게.
 */
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { parseTextLine } from './parse.js';

const UNIT_RE = /^[A-Za-z0-9@._:-]{1,80}$/;
let running = false;

export const journalUnit = () => {
  const u = String(process.env.PORTAL_SYSTEMD_UNIT || 'vmware-portal').trim();
  return UNIT_RE.test(u) ? u : 'vmware-portal';
};

/**
 * @param {{hours?:number, onItem:(item)=>void, maxLines?:number, maxBytes?:number, timeoutMs?:number, bin?:string}} o
 * @returns {Promise<{ok:boolean, reason?:string, detail?:string, lines:number, bytes:number, truncated:boolean, continuation:number, unit:string, ms:number}>}
 */
export async function readJournal({ hours = 24, onItem, maxLines = 300_000, maxBytes = 80 * 1048576, timeoutMs = 90_000, bin = 'journalctl' } = {}) {
  const unit = journalUnit();
  const h = Math.max(1, Math.min(168, Math.round(Number(hours) || 24)));
  if (running) return { ok: false, reason: 'busy', detail: '이미 저널을 읽는 중입니다.', lines: 0, bytes: 0, truncated: false, continuation: 0, unit, ms: 0 };
  running = true;
  const t0 = Date.now();
  let lines = 0; let bytes = 0; let cont = 0; let truncated = false; let stderr = '';
  try {
    const child = spawn(bin, ['-u', unit, `--since=-${h}h`, '-o', 'short-iso', '--no-pager'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const done = new Promise((resolve) => {
      let settled = false;
      const fin = (v) => { if (!settled) { settled = true; resolve(v); } };
      child.on('error', (e) => fin({ spawnError: e }));
      child.on('close', (code, signal) => fin({ code, signal }));
    });
    child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += String(d); });
    const timer = setTimeout(() => { truncated = true; try { child.kill('SIGTERM'); } catch { /* */ } }, timeoutMs);
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (truncated) return;
      bytes += Buffer.byteLength(line) + 1;
      if (lines >= maxLines || bytes >= maxBytes) { truncated = true; try { child.kill('SIGTERM'); } catch { /* */ } rl.close(); return; }
      const p = parseTextLine(line);
      if (!p) return;
      if (p.cont) { cont += 1; return; }
      lines += 1;
      try { onItem?.(p); } catch { /* 분석 실패가 읽기를 멈추지 않는다 */ }
    });
    const res = await done;
    clearTimeout(timer);
    const ms = Date.now() - t0;
    const base = { lines, bytes, truncated, continuation: cont, unit, ms };
    if (res.spawnError) {
      const nf = res.spawnError.code === 'ENOENT';
      return { ok: false, reason: nf ? 'no-journalctl' : 'spawn', detail: nf ? 'journalctl 이 없습니다(systemd 가 아닌 환경이거나 PATH 에 없음).' : String(res.spawnError.message).slice(0, 200), ...base };
    }
    // ⚠ '권한 없음' 과 '저널 파일 자체가 없음' 은 조치가 다르다(v2.583 목 서버 실측에서 둘을 섞은 것을 발견):
    //   권한 → 서비스 계정을 systemd-journal 그룹에 / 파일 없음 → journald 가 없거나 영속 저장이 꺼진 환경.
    const permHint = /insufficient permissions|not seeing messages from other users|Permission denied|No journal files were opened/i.test(stderr);
    const noFiles = /No journal files were found/i.test(stderr);
    if (!lines && permHint) return { ok: false, reason: 'permission', detail: stderr.trim().slice(0, 300), ...base };
    if (!lines && noFiles) return { ok: false, reason: 'no-journal', detail: stderr.trim().slice(0, 300), ...base };
    if (!lines && !truncated && res.code !== 0) return { ok: false, reason: 'exit', detail: `종료코드 ${res.code}: ${stderr.trim().slice(0, 300)}`, ...base };
    return { ok: true, ...base, ...(permHint ? { warning: stderr.trim().slice(0, 300) } : {}) };
  } catch (e) {
    return { ok: false, reason: 'spawn', detail: String(e?.message || e).slice(0, 200), lines, bytes, truncated, continuation: cont, unit, ms: Date.now() - t0 };
  } finally { running = false; }
}
