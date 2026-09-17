/**
 * storage/collectors/unitySsh.js — Unity(uemcli) SSH 수집기(v2.542 전면 재작성).
 *
 * ── 사용자 지시(2026-09-17) ────────────────────────────────────────────────────────
 * "계속 파싱이 안되는데, 지금까지 만든 모든 unity480 파싱 삭제하고 내가 지금 보낸 것에 대한
 *  파싱만 해서 자료 채워줘. 기존에 만들었던 unity480 파싱 자료와 혼합해서 사용하면 더 복잡해진다."
 *
 * ── 무엇을 버렸고 왜 버렸나 ───────────────────────────────────────────────────────
 * v2.526 이 명령을 5개 → **26개**로 늘린 뒤 이 수집기는 계속 실패했다. 사용자 화면의 마지막
 * 증거(v2.541 기준):
 *     config: 명령 출력이 끊겼습니다(시한 초과 · 자동응답 0회 · 45초 · 26B 수신)
 *     accounts: 수집 시간 예산 초과로 이번 주기에는 실행하지 않았습니다
 * 즉 **시간 예산(150초)을 명령 수가 다 먹어** 뒤 항목은 시도조차 못 했다. 그래서 버린 것:
 *  - 명령 26개 → **2개**(+ 폴백 1개). 아래 SPECS 가 전부다.
 *  - `-output csv` 후보: 이 장비의 CSV 출력을 **한 번도 본 적이 없다**(v2.530 이 그렇게 적었다).
 *    못 본 형식을 위해 후보를 하나 더 시도하는 것이 매 항목의 시한을 두 배로 쓰게 했다.
 *  - `deep`/`config` 2단 수집 + 6시간 구성 캐시: 명령이 2개면 나눌 이유가 없다.
 *  - `svc_diag -s spinfo` 호출: 파서(`svcDiag.js`)는 **남겨 두었지만 이 경로에서 부르지 않는다**.
 *    사용자가 준 세 출력에 SP 하드웨어 정보가 없으므로 이 수집기는 그 자료를 채우지 않는다.
 *  - `recordsFor`(CSV/Key=Value 채점) · `normalizeUnitySsh` · `specsFor` 전부 삭제.
 *
 * ── 지금 읽는 것(사용자가 준 실장비 출력 3건이 근거) ────────────────────────────────
 *  ① `uemcli /stor/config/pool show -detail` → 풀 전량(용량·구독·경고 임계·RAID·드라이브·헬스)
 *  ② `uemcli /stor/general/system show`      → 시스템 전체 용량(Total/Used/Free/Preallocated)
 *  ③ `uemcli /stor/config/pool show`         → ①이 실패했을 때만 쓰는 폴백(필드가 적다)
 * 파싱은 `uemcliParse.js` 하나가 한다(순수 — 픽스처로 고정).
 *
 * ⚠ 지킬 것:
 *  - **못 읽은 것을 0 으로 채우지 않는다.** 풀이 0개면 용량 섹션은 오류이고 수치는 null 이다.
 *  - **채우지 않는 섹션을 '오류' 라 하지 않는다.** nodes·accounts·alerts 는 이 세 명령으로는
 *    알 수 없으므로 `미수집(이 수집 방식에서는 조회하지 않음)` 이다 — '확인 못 한 것' 과
 *    '이상' 을 구분하는 v2.519·v2.523 규약과 같다.
 *  - **원문(cliRaw)은 주기 수집에서도 전부 싣는다.** 명령이 3개뿐이라 수 KB 이고, 26B 만 오는
 *    것 같은 문제는 원문을 봐야 잡힌다(예전에는 실패분만 실었다).
 *  - 항등식(`Total = Used + Free + Preallocated`)이 어긋나면 밝힌다 — 조용히 이어가지 않는다.
 */
import { runCliSession, sshFailureSnapshot } from './cliSsh.js';
import { stripUemcliBanner } from '../../proxy/sshExec.js';
import { emptySnapshot } from '../types.js';
import { parsePools, parseSystemSpace, checkSpaceIdentity, parseUemcli } from './uemcliParse.js';
import { versionFromUemcli, versionFromSvcDiag, mergeVersionInfo } from './unityVersion.js';

/** 이 수집기가 실행하는 명령 전부. **늘리기 전에 시간 예산을 함께 볼 것**(v2.528 회귀의 원인). */
export const SPECS = [
  { key: 'poolDetail', section: 'pools', required: true, answered: true, rules: ['pager', 'certAccept'],
    cmds: ['uemcli /stor/config/pool show -detail'] },
  { key: 'system', section: 'capacity', required: true, answered: true, rules: ['pager', 'certAccept'],
    cmds: ['uemcli /stor/general/system show'] },
  { key: 'poolShort', answered: true, rules: ['pager', 'certAccept'],
    cmds: ['uemcli /stor/config/pool show'] },
  /*
   * 모델·소프트웨어 버전(v2.544 — 사용자 요청 "버전 보이게 명령어 추가하고 여기에 버전 표시해줘").
   *
   * ⚠ **후보 2개**다(사용자 선택 "둘 다 — 후보 체인"):
   *   ① `uemcli /sys/general show -detail` — uemcli 계열로 통일. 다만 **이 장비의 그 출력을 본
   *      적이 없다**(v2.530 이 CSV 에 대해 적어 둔 것과 같은 상태). 그래서 키를 체인으로 읽는다.
   *   ② `svc_diag` — **사용자가 실제 출력을 보여준 명령**이고 이 장비에서 동작한다.
   * ⚠ **시한을 45초로 주지 말 것** — 후보 2개 × 45초 = 90초가 세션 예산(150초)을 먹어 v2.528 이
   *   고친 '뒤 항목이 실행조차 안 된다' 회귀가 그대로 재발한다. 실측은 uemcli 4초·svc_diag 11초
   *   (사용자 캡처 03:53:47→03:53:58)라 20초면 충분하다.
   * ⚠ **required 가 아니다** — 버전을 못 읽어도 용량·상태는 그대로 쓸모가 있다. 예산이 모자라면
   *   건너뛰고 사유를 밝힌다(`errors[key]`).
   */
  { key: 'version',
    answered: true,
    rules: ['pager', 'certAccept'],
    timeoutMs: 20_000,
    /*
     * ⚠⚠ **순서가 바뀌었다(v2.545)** — `svc_diag` 가 먼저다.
     * v2.544 는 `uemcli /sys/general show -detail` 를 앞에 뒀는데 **이 장비의 그 출력을 한 번도
     * 본 적이 없다**. 반면 `svc_diag` 는 사용자가 실제 출력을 **두 번** 제공했고 동작이 확인됐다.
     * '못 본 형식을 앞에 두는 것' 이 v2.525·2.526·2.529·2.530 네 번의 헛수정을 만든 원인이다 —
     * **확인한 것을 먼저 쓴다.**
     */
    cmds: ['svc_diag', 'uemcli /sys/general show -detail'],
    /*
     * ⚠⚠ **성공 조건은 '오류가 없다' 가 아니라 '버전이나 모델을 읽었다' 다**(v2.545 —
     * 사용자 신고 "아직 버전명이 나오지 않네"). v2.544 는 첫 후보가 오류만 안 내면 거기서
     * 체인을 끝내, 버전이 없어도 다음 후보를 부르지 않았다(실측으로 확정).
     * 두 파서를 다 돌려 보는 것은 여기서도 싸다 — 정규식 몇 번이다.
     */
    accept: (text) => {
      const v = mergeVersionInfo(versionFromSvcDiag(text), versionFromUemcli(parseUemcli(text)));
      return !!(v.version || v.model);
    } },
];

/** 이 수집 방식으로는 알 수 없는 섹션 — '오류' 가 아니라 '미수집' 이다. */
const NOT_COLLECTED = '미수집(이 수집 방식에서는 조회하지 않습니다)';

const firstLine = (s) => String(s || '').split('\n')[0].slice(0, 200);

/**
 * 파싱 결과 → 정규화 스냅샷(순수). 텍스트만 받으므로 테스트가 SSH 없이 고정할 수 있다.
 * @param {object} device
 * @param {{poolDetail?:string, system?:string, poolShort?:string}} out 명령별 원문
 * @param {{errors?:object, usedCmds?:object}} [meta]
 */
export function buildSnapshot(device, out = {}, { errors = {}, usedCmds = {} } = {}) {
  const snap = emptySnapshot(device);
  snap.extra = { collectMethod: 'ssh', usedCmds };

  // ── ① 풀 ──────────────────────────────────────────────────────────────────────
  let pools = out.poolDetail ? parsePools(out.poolDetail) : [];
  let poolsFrom = pools.length ? 'pool show -detail' : null;
  if (!pools.length && out.poolShort) {
    pools = parsePools(out.poolShort);
    if (pools.length) poolsFrom = 'pool show(폴백 — 필드가 적습니다)';
  }
  if (pools.length) {
    snap.pools = pools;
    snap.sections.pools = 'ok';
    snap.extra.poolsFrom = poolsFrom;
  } else {
    snap.sections.pools = errors.poolDetail
      ? `오류: ${firstLine(errors.poolDetail)}`
      : '오류: 풀 출력을 읽지 못했습니다(상세의 CLI 원문 확인).';
  }

  // ── ② 용량 — 풀 합계가 기준이고, 시스템 값은 대조용이다 ──────────────────────────
  const readable = pools.filter((p) => Number.isFinite(p.totalBytes) && p.totalBytes > 0);
  const sys = out.system ? parseSystemSpace(out.system) : null;
  if (readable.length) {
    const total = readable.reduce((a, p) => a + p.totalBytes, 0);
    const used = readable.reduce((a, p) => a + (Number.isFinite(p.usedBytes) ? p.usedBytes : 0), 0);
    snap.capacity = { totalBytes: total, usedBytes: used, pct: total ? Math.round((used / total) * 1000) / 10 : null };
    snap.sections.capacity = 'ok';
    // 용량을 못 읽은 풀은 합계에서 뺐다는 사실을 밝힌다(v2.525 규약).
    if (readable.length !== pools.length) snap.extra.poolsUnreadable = pools.length - readable.length;
    snap.extra.capacityBasisNote = '사용량은 풀의 **Current allocation**(장비가 보고한 실제 할당량)이고 '
      + '전체 용량은 **풀 합계**입니다 — 풀 밖 미할당 드라이브는 빠집니다.';
    if (readable.some((p) => p.usedSource === 'computed')) {
      snap.extra.capacityBasisNote += ' ⚠ 일부 풀은 `Current allocation` 을 받지 못해 '
        + '**전체 − 잔여**로 계산했습니다(선할당분만큼 실제보다 큽니다).';
    }
  } else if (sys && Number.isFinite(sys.totalBytes) && sys.totalBytes > 0) {
    // 풀을 못 읽었지만 시스템 전체 용량은 읽은 경우 — 그 사실을 밝히고 그것을 쓴다.
    snap.capacity = { totalBytes: sys.totalBytes, usedBytes: sys.usedBytes ?? null,
      pct: sys.usedBytes != null ? Math.round((sys.usedBytes / sys.totalBytes) * 1000) / 10 : null };
    snap.sections.capacity = 'ok';
    snap.extra.capacityBasisNote = '풀 목록을 읽지 못해 **시스템 전체 용량**(`/stor/general/system show`)을 씁니다.';
  } else {
    snap.capacity = { totalBytes: null, usedBytes: null, pct: null }; // 0 을 만들지 않는다
    snap.sections.capacity = errors.system
      ? `오류: ${firstLine(errors.system)}`
      : '오류: 용량을 읽지 못했습니다(상세의 CLI 원문 확인).';
  }

  if (sys) {
    snap.extra.systemSpace = sys;
    if (sys.dataReductionRatio) snap.extra.dataReduction = sys.dataReductionRatio;
    const id = checkSpaceIdentity(sys);
    if (id.checked && !id.ok) {
      snap.extra.spaceIdentityWarning = `시스템 용량 항등식이 어긋납니다(전체 − 사용 − 여유 − 선할당 = ${id.diff}B) `
        + '— 파싱이 깨졌을 수 있으니 CLI 원문을 확인하세요.';
    }
    // 풀 합계와 시스템 전체가 다르면 밝힌다(둘 중 하나를 조용히 고르지 않는다).
    if (readable.length && Number.isFinite(sys.totalBytes)) {
      const t = readable.reduce((a, p) => a + p.totalBytes, 0);
      if (Math.abs(sys.totalBytes - t) > 1024 ** 3) {
        snap.extra.capacityCrossCheck = `시스템 전체 용량(${sys.totalBytes})과 풀 합계(${t})가 다릅니다`
          + ' — 풀 밖 미할당 드라이브가 있다는 뜻이고, 화면 수치는 **풀 합계** 기준입니다.';
      }
    }
  } else if (out.system) {
    snap.extra.missingCmds = { ...(snap.extra.missingCmds || {}), system: '시스템 용량 출력을 인식하지 못했습니다.' };
  }

  // ── ③ 모델·소프트웨어 버전(v2.544) ──────────────────────────────────────────────
  /*
   * ⚠ **두 파서를 다 돌리고 합친다** — 후보 체인이라 어느 명령이 성공했는지 여기서는 모른다.
   *   서로의 형식에 대해 안전하다: uemcli 출력은 ` = ` 라 svc_diag 파서의 `키: 값` 목록에
   *   걸리지 않고, svc_diag 출력은 ` = ` 가 없어 `parseUemcli` 가 빈 배열을 준다.
   * ⚠ 읽지 못하면 **빈 문자열**이다(`emptySnapshot` 기본값). 화면은 `—` 로 둔다 — 지어내지 않는다.
   */
  if (out.version) {
    const info = mergeVersionInfo(
      versionFromUemcli(parseUemcli(out.version)),
      versionFromSvcDiag(out.version),
    );
    if (info.version) snap.version = info.version;
    if (info.serial) snap.serial = info.serial;
    if (info.model) snap.extra.model = info.model;
    // 원문을 나란히 남긴다 — `5.4.0.0.5.094` 추출이 다른 장비에서 빗나갈 수 있다(화면이 툴팁으로 보여준다).
    if (info.versionRaw && info.versionRaw !== info.version) snap.extra.versionRaw = info.versionRaw;
    if (info.sources.length) snap.extra.versionSource = info.sources.join(' + ');
    if (info.usedKey) snap.extra.versionKey = info.usedKey;
    if (!info.version && !info.model) {
      snap.extra.missingCmds = { ...(snap.extra.missingCmds || {}),
        version: '버전 출력을 인식하지 못했습니다(상세의 CLI 원문 확인).' };
    }
  } else if (errors.version) {
    // 실행 자체가 안 된 것 — '형식을 못 읽었다' 와 조치가 다르므로 사유를 그대로 전한다.
    snap.extra.missingCmds = { ...(snap.extra.missingCmds || {}), version: errors.version };
  }

  // ── ④ 이 세 명령으로는 알 수 없는 것 — '오류' 가 아니라 '미수집' ────────────────────
  snap.sections.config = snap.sections.pools === 'ok' || snap.sections.capacity === 'ok' ? 'ok' : snap.sections.pools;
  snap.sections.nodes = NOT_COLLECTED;
  snap.sections.accounts = NOT_COLLECTED;
  snap.sections.alerts = NOT_COLLECTED;
  snap.nodes = { count: null, unhealthy: null, unknown: null, list: [] }; // 0 은 '노드 0대' 라는 거짓
  snap.accounts = [];
  snap.alerts = { unresolved: null };
  snap.extra.notCollected = ['nodes', 'accounts', 'alerts'];
  snap.extra.scopeNote = '이 수집 방식은 **풀·시스템 용량 + 모델·버전**만 조회합니다 '
    + '— 노드·계정·경보는 조회하지 않으므로 0 이 아니라 빈 값입니다.';

  snap.ok = snap.sections.pools === 'ok' || snap.sections.capacity === 'ok';
  if (!snap.ok && !snap.error) snap.error = 'uemcli 출력을 읽지 못했습니다(상세의 CLI 원문 확인).';
  return snap;
}

/**
 * 끊긴/중단된 명령을 스냅샷에 **정직하게** 반영한다(v2.543 — 순수 함수로 분리해 테스트로 고정).
 *
 * 규칙 셋:
 *  ① 끊김을 '형식 문제' 와 구분해 말한다(v2.539) — 26B 만 받은 것을 '형식이 다르다' 고 하면
 *     사용자는 파서를 의심하며 고친다. 실제로 그렇게 **네 번** 헛수정했다.
 *  ② 중단(abort)은 '시간 부족' 과 조치가 다르다. 섹션 문구는 **짧게** 쓰고, 긴 사유는
 *     머리말이 **한 번만** 말한다 — 섹션이 6개라 긴 문장을 넣으면 같은 문단이 화면에 6번
 *     반복된다(CLAUDE.md v2.509. 스크린샷을 읽어야 보인다).
 *  ③ ⚠⚠ **머리말이 원인을 말한다.** 예전에는 중단됐을 때도 맨 위가
 *     `uemcli 출력을 읽지 못했습니다(상세의 CLI 원문 확인)` — **형식 탓**이었고, 진짜 원인은
 *     CLI 원문을 펼쳐야만 보였다. 원인을 아는 순간에는 맨 위에서 말한다.
 */
export function applyCutInfo(snap, truncated = {}) {
  if (Object.keys(truncated).length) snap.extra.cliTruncated = truncated;
  for (const [key, t] of Object.entries(truncated)) {
    const sect = SPECS.find((s) => s.key === key)?.section;
    if (!sect || snap.sections[sect] === 'ok') continue;
    snap.sections[sect] = t.aborted
      ? `오류: 답할 수 없는 프롬프트로 중단됐습니다(${Math.round(t.ms / 1000)}초 · ${t.bytes}B 수신)`
        + ' — 사유는 위 안내, 원문은 아래 CLI 명령 원문.'
      : `오류: 명령 출력이 끊겼습니다(${t.timedOut ? '시한 초과' : '자동응답 상한'}`
        + ` · 자동응답 ${t.answers}회 · ${Math.round(t.ms / 1000)}초 · ${t.bytes}B 수신)`
        + ' — 형식 문제가 아니라 대화형 프롬프트/시간 문제입니다(상세의 CLI 원문 확인).';
  }
  // ⚠ `config` 는 pools/capacity 를 비추는 **파생 값**이다(`buildSnapshot` 참조). 위에서 그 둘을
  //   고쳐 놓고 여기를 두면 한 화면에서 **서로 다른 원인**을 말한다 — 실측(v2.543 판독):
  //   `config: 풀 출력을 읽지 못했습니다` 와 `pools: 중단됐습니다` 가 나란히 떴다.
  if (snap.sections.config !== 'ok') {
    snap.sections.config = snap.sections.pools === 'ok' || snap.sections.capacity === 'ok'
      ? 'ok'
      : snap.sections.pools;
  }
  const reasons = [...new Set(Object.values(truncated).filter((t) => t.aborted).map((t) => t.abortReason))];
  if (reasons.length) snap.error = reasons.join(' / ');
  return snap;
}

export async function collectViaSsh(device) {
  let raw = [];
  try {
    // 배너·인증서 프롬프트 잔재를 걷어낸 뒤 파싱한다(판정과 파싱이 같은 텍스트를 봐야 한다).
    const r = await runCliSession(device, SPECS, { clean: stripUemcliBanner });
    raw = r.raw;
    const usedCmds = {};
    for (const x of raw) if (x.ok && !usedCmds[x.key]) usedCmds[x.key] = x.cmd;

    const snap = buildSnapshot(device, r.out, { errors: r.errors, usedCmds });

    applyCutInfo(snap, r.truncated || {});

    if (r.skipped?.length) snap.extra.cliSkipped = r.skipped.length;
    if (r.elapsedMs != null) { snap.extra.cliElapsedMs = r.elapsedMs; snap.extra.cliBudgetMs = r.budgetMs; }

    // ⚠ 원문을 **항상 전부** 싣는다 — 명령이 3개뿐이라 수 KB 다. 실패분만 싣던 예전 방식으로
    //   되돌리지 말 것: '성공했다고 표시됐는데 값이 비었다' 는 경우를 볼 수 없게 된다.
    snap.extra.cliRaw = raw;
    snap.extra.cliRawMode = 'all';
    return snap;
  } catch (e) {
    return sshFailureSnapshot(device, e, raw);
  }
}
