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
import { withSsh, withDeadline } from '../proxy/sshExec.js';
import { probeCommands } from './collectors/fosSsh.js';
import { devicesForThisNode, getDeviceWithSecret } from './registry.js';
import { getSnapshot } from './store.js';
import { parsePortPerfShow } from './collectors/fosParse.js';
import { savePerfSample } from './perfDb.js';
import { loadPerfSettings } from './perfSettings.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';

const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.SANSW_PERF_CONCURRENCY) || 2));
/**
 * 장비당 타임아웃(v2.417) — 접속(≤60초) + 캡처(sampleSeconds) + 여유. 예전에는 없어서(주석만 있었음)
 * 스위치가 많으면 한 주기가 수십 분까지 늘어졌다. 기한 만료 시 세션을 실제로 끊는다(withDeadline).
 * 경로 추측 후보(FOS_DIRS)는 없앴다 — 기본 수집기(v2.413)와 같이 PATH 조사(probeCommands) 결과로
 * 'portperfshow' 유무를 판단하고, 없으면 사유를 사실로 남긴다(부재 장비에서 6×캡처 시간 낭비 제거).
 */
const DEVICE_TIMEOUT_MS = (captureMs) => Math.max(30_000, Number(process.env.SANSW_PERF_DEVICE_TIMEOUT_MS) || (60_000 + captureMs * 2 + 30_000));

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
  const r = await withDeadline(DEVICE_TIMEOUT_MS(captureMs), (signal) => withSsh(
    { host: full.host, port: Number(full.sshPort) || 22, username: full.username, password: full.password || '', signal },
    async (sh) => {
      const caps = await probeCommands(sh, `${full.host}|${full.username}`);
      if (caps.has && !caps.has.has('portperfshow')) {
        return { parsed: null, why: `이 스위치에 'portperfshow' 명령이 없습니다(확인 경로: ${caps.path.join(':')})` };
      }
      const out = await sh.execCapture(`${pre}portperfshow`, captureMs);
      const text = String(out.stdout || '');
      if (/command not found|not recognized|no such file or directory/i.test(text)) return { parsed: null, why: `portperfshow 실행 실패: ${text.trim().slice(0, 120)}` };
      if (!text.trim()) return { parsed: null, why: `portperfshow 출력이 비어 있습니다(캡처 ${Math.round(captureMs / 1000)}초)` };
      const parsed = parsePortPerfShow(text);
      if (!Object.keys(parsed.ports).length) return { parsed: null, why: 'portperfshow 출력 형식을 읽지 못했습니다' };
      return { parsed, rawLen: text.length };
    },
  ), '포트 사용량 수집 타임아웃');
  if (!r.parsed) throw new Error(r.why || 'portperfshow 출력을 읽지 못했습니다.');

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
