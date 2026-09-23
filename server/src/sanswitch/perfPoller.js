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
import { loadPerfSettings, onPerfSettingsChange } from './perfSettings.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { config } from '../config.js';
import { pushPerfNow } from './perfPush.js';
import { recordActivity, latestEventByDevice } from './perfActivityLog.js';
import { sanAuthGuard, isSanAuthError } from './poller.js'; // v2.590: 기본 수집과 **같은 장비 계정** — 같은 정지 기록
import { poolRun as pool } from '../util/pool.js'; // v2.579(ARCH-01): 동시성 풀 단일 소스 — 손으로 쓴 사본 제거(첫 rejection 전파 = 예전과 같은 의미)

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
/**
 * 진행중 표시(v2.517) — 화면 하단 '수집 작업' 패널의 '진행중' 구획 원천이다. 기본 수집 폴러
 * (`poller.js _inFlight`)와 같은 규약: 시작 시 담고 끝나면 지운다(성공·실패 무관).
 */
const _inFlight = new Map(); // deviceId → { id, name, host, startedAt }

export const perfIntervalMs = () => loadPerfSettings().intervalMs;

/**
 * 한 스위치에서 1샘플 수집(스냅샷 메타를 붙여 저장) + **작업 로그 기록**(v2.517).
 *
 * 왜 로그가 필요한가: v2.516 까지 실패 사유는 `_last.errors` 5건(메모리·장비명 문자열)뿐이라
 * 화면에서 '이 스위치가 왜 안 쌓이나' 를 볼 방법이 없었다. 제한 셸(rbash)처럼 계정 때문에
 * portperfshow 가 안 되는 경우가 실제로 있고(사용자 스크린샷의 `rbash: … command not found`),
 * 그 사유는 사람이 읽어야 조치할 수 있다.
 *
 * ⚠ **REST 장비의 '건너뜀' 은 기록하지 않는다** — 매 주기 시도조차 하지 않으므로 기록하면
 *   상한을 '아무 일도 없었음' 으로 소진한다. 그 사실은 `perfDiag`('rest-method')가 말한다.
 */
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


export async function pollPerfOnce({ force = false } = {}) {
  const st = loadPerfSettings();
  if (!force && !st.enabled) return { ok: false, reason: '포트 사용량 수집이 꺼져 있습니다(설정에서 켜세요).' };
  if (_busy) return { ok: false, reason: '이전 수집 진행 중(겹침 방지)' };
  _busy = true;
  const t0 = Date.now();
  let collected = 0; let failed = 0; let authStopped = 0; const errors = [];
  try {
    const devices = devicesForThisNode();
    await pool(devices, CONCURRENCY, async (d) => {
      // v2.590(감사 F2): 인증 실패로 멈춘 장비는 **주기 수집에서만** 건너뛴다(`force` = 수동 실행 — 막지 않는다).
      // 기본 수집 폴러와 같은 정지 기록이다 — 그쪽이 멈췄으면 여기서도 같은 계정으로 로그인하지 않는다.
      // 작업 로그에는 남기지 않는다(정지 중에는 이벤트가 아니다). 정지 사실은 기본 수집 스냅샷이 말한다.
      const full = getDeviceWithSecret(d.id) || d;
      if (!force && full.collectMethod !== 'rest' && sanAuthGuard.authStopFor(full)) { authStopped++; return; }
      const t = Date.now();
      _inFlight.set(String(d.id), { id: d.id, name: d.name || d.id, host: d.host || '', startedAt: t });
      try {
        const r = await collectOne(d);
        if (r.skipped) return;          // REST 장비 — 로그에 남기지 않는다(위 collectOne 머리말)
        collected++;
        recordActivity({
          deviceId: d.id, name: d.name || d.id, host: d.host || '', source: 'central', ok: true,
          durationMs: Date.now() - t, ports: r.ports ?? null, totalBps: r.total ?? null,
        });
      } catch (e) {
        failed++; errors.push(`${d.name || d.id}: ${e.message}`);
        if (isSanAuthError(e)) {
          const rec = sanAuthGuard.markAuthStopped(full.id || d.id, full, e.message);
          console.warn(`[sanswitch-perf] ${d.name || d.id}: 인증 실패로 주기 수집 정지(${rec.attempts}회) — 비밀번호를 고치면 자동 재개합니다`);
        }
        // ⚠ 실패 이벤트의 수치는 null 이다 — 0 을 실으면 '포트 0개' 라는 거짓이 찍힌다(v2.516 규약).
        recordActivity({
          deviceId: d.id, name: d.name || d.id, host: d.host || '', source: 'central', ok: false,
          durationMs: Date.now() - t, ports: null, totalBps: null, error: e.message,
        });
      } finally { _inFlight.delete(String(d.id)); }
    });
    _last = { at: Date.now(), collected, failed, authStopped, durationMs: Date.now() - t0, total: devices.length, errors: errors.slice(0, 5) };
    // 엣지(v2.423): 수집 직후 중앙으로 중계 — push 타이머를 기다리면 최대 한 주기(기본 5분)가 더 걸린다.
    if (collected && config.agent.centralUrl && config.agent.centralToken) pushPerfNow().catch(() => {});
    return { ok: true, ..._last };
  } finally { _busy = false; }
}

export function startSanSwitchPerfPoller() {
  if (_timer) return;
  _timer = startAdaptiveTimer(perfIntervalMs, async () => {
    if (!loadPerfSettings().enabled) return;   // 꺼져 있으면 틱만 돌고 아무것도 하지 않는다
    await pollPerfOnce();
  }, { firstDelayMs: 70_000, name: 'SAN 포트 사용량 수집', subscribe: onPerfSettingsChange });
}

export function sanSwitchPerfStatus() {
  const st = loadPerfSettings();
  return {
    ..._last, settings: st, busy: _busy, concurrency: CONCURRENCY,
    // 화면 공용 패널(CollectActivity)이 기본 수집과 **같은 키**로 읽는다 — 이름을 바꾸면 한쪽이
    // 조용히 빈다(v2.516 규약). 주기는 서버가 주는 값만 쓰고 문구에 숫자를 박지 않는다.
    intervalMs: perfIntervalMs(),
    inFlight: [..._inFlight.values()],
    enabled: st.enabled,
  };
}

/**
 * 엣지 → 중앙 보고용 상태(v2.517). 표본이 0건이어도 이것만은 올라가야 중앙이 '엣지가 켜졌는지·
 * 돌았는지·왜 실패하는지' 를 안다(`central/sanSwitchPerfEdge.js` 머리말 참조).
 * 장비별 최근 1건은 작업 로그에서 뽑는다 — 폴러의 errors 배열은 id 가 없어 장비와 못 묶는다.
 */
export function perfStatusForCentral({ maxDevices = 300 } = {}) {
  const st = loadPerfSettings();
  const latest = latestEventByDevice(Math.max(50, maxDevices));
  const devices = [];
  for (const d of devicesForThisNode()) {
    const e = latest.get(String(d.id));
    if (!e) continue;
    devices.push({ id: d.id, ok: !!e.ok, at: e.at, error: e.ok ? null : (e.error || null), ports: e.ok ? (e.ports ?? null) : null });
    if (devices.length >= maxDevices) break;
  }
  return {
    enabled: st.enabled, intervalMs: st.intervalMs, sampleSeconds: st.sampleSeconds,
    at: _last?.at || null, collected: _last?.collected ?? null, failed: _last?.failed ?? null,
    total: _last?.total ?? null, devices,
  };
}
