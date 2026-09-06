/**
 * sanswitch/perfPoller.js — portperfshow 주기 수집 폴러(v2.411).
 *
 * 흐름: 이 노드 몫 스위치마다 SSH 세션 → `portperfshow` 를 sampleSeconds 동안 받아쓰기 →
 *       마지막(가장 최근) 행렬을 파싱 → perfDb 에 1샘플 저장.
 *
 * 왜 별도 폴러인가: 기본 수집(switchshow 등)은 5분/구성 조회이고, 사용량은 더 자주 보고 싶을
 * 수도 반대로 훨씬 뜸하게 볼 수도 있다. 무엇보다 portperfshow 는 **세션을 수 초 붙잡는**
 * 성격이라 기본 수집과 주기를 섞으면 서로를 지연시킨다.
 *
 * CLAUDE.md 폴러 규칙: 재진입 가드(수동 실행과 공유) + 동시 수집 제한 + 장비당 타임아웃 +
 * startAdaptiveTimer(주기를 상수로 굳히지 않는다 — 설정 변경이 재시작 없이 먹어야 한다).
 */
import { withSsh } from '../proxy/sshExec.js';
import { devicesForThisNode, getDeviceWithSecret } from './registry.js';
import { getSnapshot } from './store.js';
import { parsePortPerfShow } from './collectors/fosParse.js';
import { savePerfSample } from './perfDb.js';
import { loadPerfSettings } from './perfSettings.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';

const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.SANSW_PERF_CONCURRENCY) || 2));
/** 후보 명령 — FOS 배포마다 PATH 가 달라 기본 수집기와 같은 대체 경로 규약을 따른다. */
const FOS_DIRS = ['/fabos/cliexec', '/fabos/link_bin', '/fabos/bin', '/bin', '/usr/bin'];

let _timer = null;
let _busy = false;
let _last = { at: 0, collected: 0, failed: 0 };

export const perfIntervalMs = () => loadPerfSettings().intervalMs;

/** 한 스위치에서 1샘플 수집(스냅샷 메타를 붙여 저장). */
async function collectOne(dev) {
  const st = loadPerfSettings();
  const full = getDeviceWithSecret(dev.id) || dev;
  if (full.collectMethod === 'rest') {
    // REST 방식 장비는 이미 옥텟 카운터로 처리량을 계산한다(rates.js) — portperfshow 는 CLI 전용.
    return { skipped: 'REST 수집 장비(포트 통계 카운터로 계산)' };
  }
  const pre = full.vfId ? `setcontext ${Number(full.vfId)}; ` : '';
  const captureMs = Math.max(3000, st.sampleSeconds * 1000);
  const r = await withSsh(
    { host: full.host, port: Number(full.sshPort) || 22, username: full.username, password: full.password || '' },
    async (sh) => {
      for (const cmd of [`${pre}portperfshow`, ...FOS_DIRS.map((d) => `${pre}${d}/portperfshow`)]) {
        const out = await sh.execCapture(cmd, captureMs);
        const text = String(out.stdout || '');
        if (/command not found|not recognized|no such file or directory/i.test(text) || !text.trim()) continue;
        const parsed = parsePortPerfShow(text);
        if (Object.keys(parsed.ports).length) return { parsed, cmd, rawLen: text.length };
      }
      return { parsed: null };
    },
  );
  if (!r.parsed) throw new Error('portperfshow 출력을 읽지 못했습니다(명령 없음 또는 형식 불일치).');

  // 포트 메타(연결 장비·속도)는 기본 수집 스냅샷에서 가져온다 — 시계열을 '어느 스토리지의
  // 트래픽'으로 묶어 보기 위한 것. 기본 수집 전이면 메타 없이 수치만 저장한다(나중에 채워진다).
  const snap = getSnapshot(dev.id);
  const meta = (snap?.ports?.list || []).map((p) => ({
    port: p.index, attachedName: p.attachedName || '', attachedWwn: (p.attached || [])[0] || '',
    speed: p.speed || '', portType: p.portType || '',
  }));
  const saved = await savePerfSample(dev.id, Date.now(), r.parsed.ports, meta, st.retentionDays);
  return { ports: Object.keys(r.parsed.ports).length, total: r.parsed.total, saved: saved.saved };
}

async function pool(items, limit, fn) {
  const it = items[Symbol.iterator]();
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let n = it.next(); !n.done; n = it.next()) await fn(n.value);
  }));
}

export async function pollPerfOnce({ force = false } = {}) {
  const st = loadPerfSettings();
  if (!force && !st.enabled) return { ok: false, reason: '포트 사용량 수집이 꺼져 있습니다(설정에서 켜세요).' };
  if (_busy) return { ok: false, reason: '이전 수집 진행 중(겹침 방지)' };
  _busy = true;
  const t0 = Date.now();
  let collected = 0; let failed = 0; const errors = [];
  try {
    const devices = devicesForThisNode();
    await pool(devices, CONCURRENCY, async (d) => {
      try {
        const r = await collectOne(d);
        if (r.skipped) return;
        collected++;
      } catch (e) { failed++; errors.push(`${d.name || d.id}: ${e.message}`); }
    });
    _last = { at: Date.now(), collected, failed, durationMs: Date.now() - t0, total: devices.length, errors: errors.slice(0, 5) };
    return { ok: true, ..._last };
  } finally { _busy = false; }
}

export function startSanSwitchPerfPoller() {
  if (_timer) return;
  _timer = startAdaptiveTimer(perfIntervalMs, async () => {
    if (!loadPerfSettings().enabled) return;   // 꺼져 있으면 틱만 돌고 아무것도 하지 않는다
    await pollPerfOnce();
  }, { firstDelayMs: 70_000, name: 'SAN 포트 사용량 수집' });
}

export function sanSwitchPerfStatus() {
  const st = loadPerfSettings();
  return { ..._last, settings: st, busy: _busy, concurrency: CONCURRENCY };
}
