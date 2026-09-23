/**
 * bmusage/collectors/idracEnterprise.js — **Enterprise 라이선스 서버의 대체 수집**(v2.554).
 *
 * 사용자 신고·지시(2026-09-17):
 *   "여기서 idarc 텔레메트리는 라인선스가 data center 라이선스가 필요한데, 내가 가진건 enterprise
 *    라이선스라서, 엔터프라이즈 라이선스 대상 서버도 수집하는 기능 추가로 만들어줘"
 *   → 선택: "**엔터프라이즈 라이선스를 idarc api/ssh 로 사용할 수 있으니 시스템에 부하는 있겠지만,
 *      사용할것이냐고 물어보고 사용하겠다고 하면 기능을 구현한다**"
 *
 * ── 왜 '물어본 뒤에만' 인가(설계의 중심) ────────────────────────────────────
 * 이 경로는 텔레메트리와 달리 **장비를 더 괴롭힌다** — 표준 Redfish 센서 GET 4회 + (필요하면)
 * iDRAC SSH 세션 1개다. BMC 는 약한 프로세서라 5분마다 200대에 SSH 를 열면 그 자체가 부하다.
 * 그래서 `bmusage/settings.js` 의 `enterpriseAck` 가 **true 일 때만** 이 모듈이 불린다(기본 꺼짐).
 * 화면이 부하를 먼저 말하고 관리자가 동의한다 — **동의를 기본값으로 바꾸지 말 것.**
 *
 * ── 수집하지 않는 것(사용자 지시) ────────────────────────────────────────────
 * ⚠⚠ **전력(W)·온도(℃)를 사용률의 대체값으로 수집하지 않는다.** 설문에 그대로 물었고 사용자가
 *   "**수집하지 않는다**" 를 골랐다. 전력·온도는 이미 전력 대시보드·전산실 온도 화면이 갖고 있고,
 *   그것을 'CPU 사용률 대용' 으로 쓰면 **숫자는 있는데 뜻이 다른** 최악의 거짓이 된다.
 *   여기서 `fetchPower`·`fetchSensors` 를 부르려 하지 말 것.
 *
 * ── 예산(v2.528·v2.550.3 규약 — 되돌리지 말 것) ─────────────────────────────
 * ⚠⚠ **세션 예산은 폴러의 장비 시한보다 반드시 작아야 한다.** 같거나 크면 `withDeadline` 이 먼저
 *   던져 **그때까지 모은 결과가 통째로 버려진다**(v2.528 Unity 전량 실패와 같은 사고). 각 단계는
 *   `min(단계 시한, 남은 예산)` 으로 실행하고, 남은 시간이 `MIN_*_SLICE_MS` 아래면 **시작하지 않고
 *   사유를 남긴다**(조용한 생략 금지). `test/bmUsageEnterprise2554.test.js` 가 산수를 고정한다.
 *
 * ── 정직 기록 — 실장비로 확인하지 못한 것 ────────────────────────────────────
 *  ① 표준 Redfish `Chassis/<id>/Sensors` 컬렉션의 실제 응답(있는지·이름이 무엇인지)
 *  ② `racadm systemperfstatistics` 의 출력 형식 — 그래서 파서가 관용적이고(`parse/racadm.js`)
 *     **원문(`raw`)을 그대로 실어 화면이 보여준다**(v2.542 `cliRaw` 규약). 첫 실수집에서 좁힐 것.
 *  ③ iDRAC SSH 가 exec 채널로 `racadm …` 을 받는지(대화형 `racadm>>` 셸만 주는 장비가 있을 수 있다).
 *     그 경우 출력이 비고 `parsed:false` 가 되며 **정상을 지어내지 않는다**.
 */
import { withSsh, isSshAuthError } from '../../proxy/sshExec.js';
import { parseSystemPerf, rawSample } from '../parse/racadm.js';

/** 세션 전체 예산 — ⚠ **폴러의 장비 시한(기본 60초)보다 작아야 한다**(위 주석). */
export const SESSION_BUDGET_MS = Math.max(15_000, Number(process.env.BMUSAGE_ENT_BUDGET_MS) || 45_000);
/** Redfish 센서 단계에 줄 수 있는 최대 시간. */
export const API_SLICE_MS = Math.max(5_000, Number(process.env.BMUSAGE_ENT_API_MS) || 20_000);
/** SSH 핸드셰이크 시한 — ⚠ ssh2 기본(60초)을 그대로 쓰면 예산이 통째로 날아간다. */
export const SSH_READY_MS = Math.max(5_000, Number(process.env.BMUSAGE_ENT_SSH_READY_MS) || 12_000);
/** 명령 1개 시한. */
export const CMD_TIMEOUT_MS = Math.max(5_000, Number(process.env.BMUSAGE_ENT_CMD_MS) || 12_000);
/** 남은 예산이 이보다 적으면 **SSH 를 시작하지 않는다**(핸드셰이크만 하고 잘리면 결과가 0이다). */
export const MIN_SSH_SLICE_MS = Math.max(8_000, SSH_READY_MS + 3_000);

/**
 * racadm 명령 후보. ⚠ **후보를 늘리려면 위의 예산 산수를 먼저 볼 것**(명령당 최대 12초다).
 *  · `racadm …` — iDRAC SSH 의 일반 형태
 *  · `systemperfstatistics` — 접속 즉시 racadm 셸인 장비 대비
 * ⚠ 이 현장에서 어느 것이 통하는지 확인하지 못했다 — 통한 것을 `usedCmd` 로 밝힌다.
 */
export const PERF_CMDS = Object.freeze(['racadm systemperfstatistics', 'systemperfstatistics']);

const t = (v) => String(v ?? '').trim();
/** iDRAC 등록부의 host 에는 스킴이 붙어 있다(`https://10.0.0.1`) — SSH 는 주소만 쓴다. */
export function sshHostOf(host) {
  let s = t(host).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
  if (s.startsWith('[')) { const m = /^\[([^\]]+)\]/.exec(s); return m ? m[1] : s; }
  s = s.split('/')[0];
  const colon = s.lastIndexOf(':');
  if (colon > 0 && /^\d+$/.test(s.slice(colon + 1))) s = s.slice(0, colon);   // Redfish 포트를 SSH 에 쓰지 않는다
  return s;
}

/**
 * Enterprise 대체 수집 — API(표준 센서) → 없으면 SSH(racadm).
 *
 * @param {object} entry   iDRAC 등록 항목(host·username·password)
 * @param {object} opt
 * @param {'auto'|'api'|'ssh'} opt.mode  `auto` = API 로 못 읽은 것만 SSH 로 채운다(기본)
 * @param {boolean} opt.allowProbe       센서 경로 탐색을 이번 주기에 허용하는가(주기 예산)
 * @param {AbortSignal} [opt.signal]     폴러의 장비 시한 — SSH 세션을 **실제로 끊는다**(v2.417)
 * @param {number} [opt.budgetMs]
 * @param {function} [opt._deps]         테스트 주입(내부용)
 * @returns {Promise<object>} `{ ok, via, cpuPct?, memPct?, ioPct?, sysPct?, usedPaths, usedCmd,
 *   usedStat, seenSensors, raw, skipped, kind?, error? }`
 */
export async function collectEnterpriseUsage(entry, {
  mode = 'auto', allowProbe = true, signal = null, budgetMs = SESSION_BUDGET_MS,
  _fetchUsageSensors = null, _withSsh = null,
} = {}) {
  const t0 = Date.now();
  const left = () => budgetMs - (Date.now() - t0);
  const out = {
    ok: false, via: '', usedPaths: {}, usedCmd: '', usedStat: {}, seenSensors: [],
    raw: '', skipped: [], absent: [], tried: [],
  };
  const host = sshHostOf(entry?.host);

  // ── ① API — 표준 Redfish Sensors(텔레메트리가 아니다) ──────────────────────
  if (mode === 'auto' || mode === 'api') {
    out.tried.push('api');
    if (left() < 3_000) {
      out.skipped.push({ step: 'api', reason: '남은 시간이 부족해 Redfish 센서 조회를 시작하지 않았습니다.' });
    } else {
      const fn = _fetchUsageSensors || (await import('../../idrac/redfish.js')).fetchUsageSensors;
      let r = null;
      try {
        r = await withStepDeadline(Math.min(API_SLICE_MS, left()), () => fn(entry, { allowProbe }));
      } catch (e) {
        r = { ok: false, kind: 'unreachable', error: String(e?.message || e).slice(0, 300) };
      }
      if (r) {
        out.seenSensors = r.seenSensors || [];
        if (Array.isArray(r.absent)) out.absent.push(...r.absent);
        if (r.ok) {
          for (const f of ['cpuPct', 'memPct', 'ioPct', 'sysPct']) if (r[f] != null) out[f] = r[f];
          out.usedPaths = r.usedPaths || {};
          out.ok = true;
          out.via = 'api';
        } else {
          out.apiKind = r.kind || '';
          out.apiError = r.error || '';
          /*
           * ⚠⚠ **401(자격증명 거부)은 SSH 로 폴백하지 않는다.** 같은 계정이라 결과가 같고, 반복 시도가
           *   **iDRAC 계정을 잠근다**(v2.535 `authGuard` · `bulkRun.js` '자동 재시도 금지' 와 같은 사고).
           *   v2.591(감사 R-BM2): 403 은 `forbidden` 이다(로그인은 통했다 — 잠금 경로가 아니다) — SSH(racadm)는
           *   Redfish 자원 권한과 별개라 폴백한다.
           */
          if (r.kind === 'auth') {
            return { ...out, ok: false, kind: 'auth', error: r.error || 'iDRAC 인증 거부(401/403)', ms: Date.now() - t0 };
          }
        }
      }
    }
  }

  // ── ② SSH — racadm. API 로 **CPU·메모리를 못 읽었을 때만**(auto) ───────────
  const needSsh = mode === 'ssh' || (mode === 'auto' && out.cpuPct == null && out.memPct == null);
  if (needSsh) {
    out.tried.push('ssh');
    if (!host) {
      out.skipped.push({ step: 'ssh', reason: 'iDRAC 주소를 읽지 못해 SSH 를 시도하지 않았습니다.' });
    } else if (left() < MIN_SSH_SLICE_MS) {
      out.skipped.push({ step: 'ssh', reason: `남은 시간(${Math.round(left() / 1000)}초)이 SSH 핸드셰이크에 모자라 시작하지 않았습니다 — 다음 주기에 시도합니다.` });
    } else {
      const runner = _withSsh || withSsh;
      try {
        const res = await runner({
          host, port: 22, username: t(entry?.username), password: entry?.password,
          readyTimeout: Math.min(SSH_READY_MS, Math.max(3_000, left() - 3_000)), signal,
        }, async (api) => {
          const acc = { raw: '', usedCmd: '', perf: null, tried: [] };
          for (const cmd of PERF_CMDS) {
            const slice = Math.min(CMD_TIMEOUT_MS, left() - 1_000);
            if (slice < 3_000) { acc.budgetOut = true; break; }
            acc.tried.push(cmd);
            let r;
            try { r = await api.exec(cmd, slice); } catch (e) { acc.lastError = String(e?.message || e).slice(0, 200); continue; }
            const text = `${r.stdout || ''}${r.stderr ? `\n${r.stderr}` : ''}`;
            if (!acc.raw) acc.raw = text;
            const perf = parseSystemPerf(text);
            /*
             * ⚠ **성공 조건은 '오류가 없다' 가 아니라 '원하는 것을 읽었다' 다**(v2.545 규약).
             *   racadm 은 알 수 없는 하위명령에 exit 0 + 안내문으로 답할 수 있다.
             */
            if (perf.parsed) { acc.perf = perf; acc.usedCmd = cmd; acc.raw = text; break; }
          }
          return acc;
        }, { signal });
        out.raw = rawSample(res.raw || '');
        out.sshTried = res.tried || [];
        if (res.budgetOut) out.skipped.push({ step: 'ssh-cmd', reason: '남은 시간이 부족해 다음 racadm 후보를 시도하지 않았습니다.' });
        if (res.perf) {
          for (const f of ['cpuPct', 'memPct', 'ioPct', 'sysPct']) {
            // ⚠ API 값이 있으면 덮지 않는다(어느 쪽을 썼는지 `usedCmd`·`usedPaths` 로 밝힌다).
            if (out[f] == null && res.perf[f] != null) { out[f] = res.perf[f]; out.usedStat[f] = res.perf.usedStat?.[f] || ''; }
          }
          out.usedCmd = res.usedCmd || '';
          out.ok = out.ok || ['cpuPct', 'memPct', 'ioPct', 'sysPct'].some((f) => out[f] != null);
          out.via = out.via ? `${out.via}+ssh` : 'ssh';
        } else {
          out.sshKind = 'unparsed';
          out.sshError = res.lastError
            ? `racadm 실행 실패: ${res.lastError}`
            : 'racadm 출력에서 사용률을 읽지 못했습니다(형식 미인식) — 아래 원문을 보고 알려 주세요.';
        }
      } catch (e) {
        const msg = String(e?.message || e);
        if (isSshAuthError(e)) {
          return { ...out, ok: false, kind: 'ssh-auth', error: msg.slice(0, 300), ms: Date.now() - t0 };
        }
        out.sshKind = /취소|타임아웃|timed out|timeout/i.test(msg) ? 'timeout' : 'unreachable';
        out.sshError = msg.slice(0, 300);
      }
    }
  }

  out.ms = Date.now() - t0;
  if (!out.ok && !out.kind) {
    out.kind = out.sshKind || out.apiKind || 'no-value';
    out.error = out.sshError || out.apiError || '이 경로에서 사용률을 읽지 못했습니다.';
  }
  return out;
}

/** 단계별 시한 — 결과만 포기하는 것이라 **SSH 세션에는 쓰지 않는다**(그쪽은 signal 로 끊는다). */
async function withStepDeadline(ms, fn) {
  let timer = null;
  try {
    return await Promise.race([
      fn(),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`단계 시한 초과(${Math.round(ms / 1000)}초)`)), Math.max(1_000, ms)); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
