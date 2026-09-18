/**
 * views/collectors/emptyInvText.js — '빈 인벤토리' 배지의 **원인 판정과 문구**(순수, v2.560).
 *
 * 사용자 요청(2026-09-18): "빈 인벤터리로 나올때 **상태와 로그, 해결방법**을 클릭하면 나오게 해줘".
 *
 * ── 왜 필요한가 ──────────────────────────────────────────────────────────────
 * v2.556 까지 '빈 인벤토리' 배지는 클릭되지 않는 `<span title=…>` 이었고 툴팁 한 문장이
 * **조치가 정반대인 상황들**을 덮었다:
 *   · 그 엣지에 vCenter 등록이 0개 → **등록해야 한다**
 *   · 첫 수집 중 → **기다리면 된다**
 *   · vCenter 접속 실패 → 자격증명·방화벽(기다려도 안 된다)
 *   · mock 데이터라 push 에서 빠졌다 → DATA_SOURCE=live
 *   · 그 vCenter 가 실제로 비어 있다 → **이상이 아니다**
 * v2.517 `perfDiagText`(사용량이 왜 비었나) · v2.509 loadState 와 **같은 계열**의 판단이다.
 *
 * ⚠ **원인을 단정하지 않는다**(v2.493 규약). 엣지 상태를 당겨오기 전에는 후보만 나열하고,
 *   `confident:false` 로 그 사실을 밝힌다. 툴팁에만 두지 않는다(복사·공유가 안 되고 모바일에서는
 *   볼 수 없다 — v2.516 규약).
 * ⚠ 문구에 **백틱을 쓰지 말 것** — `BoldText` 는 `**강조**` 만 해석한다(v2.439·2.440·2.505 사고).
 */

const t = (v) => String(v ?? '').trim();
/** ⚠ `v == null || v === ''` 를 먼저 — `Number(null)===0`·`Number('')===0` 함정(v2.525·2.550). */
const n = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

/**
 * 개발용 mock 생성기의 vCenter id 패턴 — 중앙이 받은 id 만으로 판정할 수 있는 **유일한** 원인이다.
 * ⚠ `Collectors.jsx` 가 이 상수를 import 해 쓴다(v2.560 에 그 파일의 지역 복사본을 이리로 옮겼다).
 *   두 벌이 되면 배지는 뜨는데 모달은 다른 원인을 말하는 일이 생긴다(코어는 하나다).
 * ⚠ 넓히지 말 것 — `/^vc-/` 로 두면 현장에서 `vc-hg01` 처럼 이름 지은 **실제** vCenter 가
 *   mock 으로 오판된다. 생성기 id 는 `vc-<지역>-<도시>` 형식이다(`mock/generator.js:34-36`).
 */
export const MOCK_VC_RE = /^vc-(us|br|eu|me|ap|cn)-[a-z]+$/;

export const CAUSE = Object.freeze({
  MOCK: 'mock',                    // 엣지가 mock 데이터로 돌고 있다(중앙이 id 로 바로 안다)
  NO_VCENTER: 'no-vcenter',        // 그 엣지 포탈에 vCenter 등록이 0개다
  PENDING: 'pending',              // 첫 수집 중 — 기다리면 된다
  UNREACHABLE: 'unreachable',      // vCenter 접속 실패
  SKIPPED_MOCK: 'skipped-mock',    // 등록은 있는데 mock 폴백이라 push 에서 빠졌다
  EMPTY_VCENTER: 'empty-vcenter',  // 접속은 되는데 그 vCenter 에 호스트·VM 이 없다(이상이 아닐 수 있다)
  PUSH_ERRORS: 'push-errors',      // push 자체가 실패하고 있다
  NEED_PULL: 'need-pull',          // 아직 엣지 상태를 가져오지 않았다 — 판정 불가
  UNKNOWN: 'unknown',              // 상태를 읽었는데도 설명되지 않는다
});

export const CAUSE_LABEL = Object.freeze({
  mock: 'mock 데이터',
  'no-vcenter': 'vCenter 등록 0개',
  pending: '첫 수집 중',
  unreachable: 'vCenter 접속 실패',
  'skipped-mock': 'mock 이라 전송 제외',
  'empty-vcenter': '그 vCenter 가 비어 있음',
  'push-errors': 'push 실패',
  'need-pull': '엣지 상태 미확인',
  unknown: '원인 미확정',
});

/** 기다리면 채워지는가 — 이 값이 화면 문구의 방향을 정한다(v2.517 `waiting` 규약). */
export const CAUSE_WAITING = Object.freeze({
  mock: false, 'no-vcenter': false, pending: true, unreachable: false,
  'skipped-mock': false, 'empty-vcenter': false, 'push-errors': false,
  'need-pull': false, unknown: false,
});

/** 엣지 로그 상태 배열에서 한 항목을 꺼낸다(구버전 엣지는 그 키가 없다 → null). */
export function statusValue(items, key) {
  if (!Array.isArray(items)) return null;
  const it = items.find((x) => t(x?.key) === key);
  if (!it) return null;
  return it.ok === true ? (it.value ?? null) : null;
}

/** 그 키가 아예 없는지(구버전) vs 읽기 실패인지 — 조치가 다르다. */
export function statusIssue(items, key) {
  if (!Array.isArray(items)) return 'not-pulled';
  const it = items.find((x) => t(x?.key) === key);
  if (!it) return 'no-key';               // 구버전 엣지 — 업그레이드해야 이 상태가 온다
  if (it.ok !== true) return 'read-failed';
  return null;
}

/**
 * 원인 판정.
 *
 * ⚠⚠ **판정 순서가 계약이다.** 확실한 근거(중앙이 직접 본 것) → 엣지가 말한 사실 → 추정 순이고,
 *   뒤집으면 '기다리면 된다' 와 '기다려도 안 된다' 가 뒤바뀐다.
 *
 * @param {object} p `push` 중앙이 받은 마지막 push(`r.last`) · `statusItems` 엣지 로그의 status 배열
 * @returns {{kind:string, waiting:boolean, confident:boolean, evidence:string[]}}
 */
export function diagnoseEmptyInventory({ push = null, statusItems = null } = {}) {
  const ev = [];
  const vcId = t(push?.vcenterId);

  // ① 중앙이 받은 id 자체가 mock 생성기 것이면 그것으로 확정된다(엣지 상태가 필요 없다).
  if (vcId && MOCK_VC_RE.test(vcId)) {
    ev.push(`중앙이 받은 vCenter id 가 ‘${vcId}’ 입니다(개발용 mock 생성기의 id 형식).`);
    return { kind: CAUSE.MOCK, waiting: false, confident: true, evidence: ev };
  }

  const inv = statusValue(statusItems, 'collect.inventory');
  const pushSt = statusValue(statusItems, 'push.inventory');
  const invIssue = statusIssue(statusItems, 'collect.inventory');

  // ② 엣지 상태가 없으면 **판정하지 않는다**(원인을 지어내지 않는다 — v2.493).
  if (!inv) {
    if (invIssue === 'no-key') ev.push('이 엣지는 구버전이라 vCenter 수집 상태를 보고하지 않습니다.');
    else if (invIssue === 'read-failed') ev.push('엣지가 vCenter 수집 상태를 읽지 못했습니다.');
    return { kind: CAUSE.NEED_PULL, waiting: false, confident: false, evidence: ev };
  }

  const reg = n(inv.registered);
  const c = inv.counts || {};
  ev.push(`엣지에 등록된 vCenter ${reg == null ? '?' : reg}개`
    + ` (정상 ${n(c.ok) ?? 0} · 첫수집 ${n(c.pending) ?? 0} · 접속실패 ${n(c.unreachable) ?? 0}`
    + ` · 비활성 ${n(c.disabled) ?? 0} · mock ${n(c.mock) ?? 0}).`);

  // ③ 등록이 0개 — 등록해야 한다(기다려도 안 된다).
  if (reg === 0) return { kind: CAUSE.NO_VCENTER, waiting: false, confident: true, evidence: ev };

  // ④ mock 폴백 — push 에서 빠지므로 중앙에는 빈 인벤토리로 보인다.
  if ((n(c.mock) || 0) > 0 || (n(pushSt?.last?.skippedMock) || 0) > 0) {
    if (n(pushSt?.last?.skippedMock)) ev.push(`마지막 push 가 mock vCenter ${pushSt.last.skippedMock}개를 제외했습니다.`);
    return { kind: CAUSE.SKIPPED_MOCK, waiting: false, confident: true, evidence: ev };
  }

  // ⑤ 접속 실패가 있으면 그것이 원인이다(오류 문구를 근거로 싣는다).
  if ((n(c.unreachable) || 0) > 0) {
    const bad = (inv.vcenters || []).filter((v) => t(v.status).toLowerCase() === 'unreachable');
    for (const v of bad.slice(0, 5)) ev.push(`${v.id || v.name}: ${t(v.error) || '접속 실패'}${v.code ? ` (${v.code})` : ''}`);
    if (bad.length > 5) ev.push(`… 외 ${bad.length - 5}곳`);
    return { kind: CAUSE.UNREACHABLE, waiting: false, confident: true, evidence: ev };
  }

  // ⑥ push 자체가 실패 중이면 그 사실이 먼저다(수집은 됐는데 못 보낸 것이다).
  const perrs = Array.isArray(pushSt?.last?.errors) ? pushSt.last.errors : [];
  if (perrs.length > 0) {
    for (const e of perrs.slice(0, 5)) ev.push(`push 실패: ${t(e)}`);
    return { kind: CAUSE.PUSH_ERRORS, waiting: false, confident: true, evidence: ev };
  }

  // ⑦ 첫 수집 중 — **기다리면 된다**. ⑤⑥ 보다 뒤에 둔다(실패가 있는데 '기다리세요' 라 하면 거짓이다).
  if ((n(c.pending) || 0) > 0 && (n(c.ok) || 0) === 0) {
    ev.push('아직 첫 수집이 끝나지 않았습니다.');
    return { kind: CAUSE.PENDING, waiting: true, confident: true, evidence: ev };
  }

  // ⑧ 접속은 되는데 호스트·VM 이 0 — **이상이 아닐 수 있다**(빈 vCenter).
  const live = (inv.vcenters || []).filter((v) => !['unreachable', 'disabled'].includes(t(v.status).toLowerCase()));
  const sumH = live.reduce((a, v) => a + (n(v.hosts) || 0), 0);
  const sumV = live.reduce((a, v) => a + (n(v.vms) || 0), 0);
  if (live.length > 0 && sumH === 0 && sumV === 0) {
    ev.push('엣지의 vCenter 는 정상인데 호스트·VM 이 0개입니다.');
    return { kind: CAUSE.EMPTY_VCENTER, waiting: false, confident: true, evidence: ev };
  }

  // ⑨ 엣지에는 데이터가 있는데 중앙은 0 을 받았다 — 설명되지 않는다. 단정하지 않는다.
  ev.push(`엣지는 호스트 ${sumH}·VM ${sumV} 를 갖고 있는데 중앙이 받은 push 는 호스트 ${n(push?.hosts) ?? '?'}·VM ${n(push?.vms) ?? '?'} 입니다.`);
  return { kind: CAUSE.UNKNOWN, waiting: false, confident: false, evidence: ev };
}

/** 원인별 설명 — `BoldText` 로 렌더한다. */
export const CAUSE_WHY = Object.freeze({
  mock: '이 엣지가 **개발용 mock 데이터**로 돌고 있습니다 — 실제 vCenter 에 접속하고 있지 않습니다. DATA_SOURCE 가 mock 이거나, auto 인데 vCenter 접속이 안 돼 가짜 데이터로 폴백한 상태입니다.',
  'no-vcenter': '그 엣지 포탈에 **등록된 vCenter 가 없습니다**. push 는 되지만 보낼 인벤토리가 없어 호스트 0 · VM 0 으로 도착합니다.',
  pending: '그 엣지가 **첫 수집을 아직 끝내지 않았습니다** — 기다리면 채워집니다.',
  unreachable: '그 엣지가 **vCenter 에 접속하지 못하고 있습니다**. 기다려도 채워지지 않습니다 — 아래 오류 문구가 원인을 가리킵니다.',
  'skipped-mock': '그 엣지에 vCenter 등록은 있는데 **mock 폴백 상태**라, 가짜 데이터를 중앙에 올리지 않도록 전송에서 제외됩니다(그래서 중앙에는 빈 인벤토리로 보입니다). 이 제외는 의도된 동작입니다.',
  'empty-vcenter': '그 엣지의 vCenter 는 정상인데 **그 vCenter 에 호스트·VM 이 없습니다**. 신규 구축이나 철거 직후라면 **이상이 아닙니다**.',
  'push-errors': '수집은 됐는데 **중앙으로 보내는 과정이 실패**하고 있습니다 — 아래 오류 문구를 보세요.',
  'need-pull': '아직 그 엣지의 상태를 가져오지 않아 **원인을 말할 수 없습니다**. 아래 ‘엣지 상태·로그 가져오기’ 를 누르면 그 엣지의 vCenter 수집 상태와 최근 로그를 그때그때 읽어 옵니다(상시 트래픽은 없습니다).',
  unknown: '엣지는 데이터를 갖고 있다고 보고하는데 중앙이 받은 push 는 비어 있습니다 — **원인이 확정되지 않았습니다**. 아래 로그를 보고 판단하세요.',
});

/** 원인별 조치 — **후보를 나열하지 말고 그 원인에 맞는 것만** 준다(틀린 조언은 무음 실패보다 나쁘다). */
export const CAUSE_FIX = Object.freeze({
  mock: [
    '그 엣지 호스트의 portal.env 에 DATA_SOURCE=live 를 넣습니다.',
    '그 엣지 포탈의 설정 › vCenter 관리에서 실제 vCenter 를 등록하고 연결 테스트를 통과시킵니다.',
    '엣지 포탈을 재시작합니다(systemctl restart vmware-portal).',
  ],
  'no-vcenter': [
    '그 엣지 포탈에 접속해 설정 › vCenter 관리에서 그 법인의 vCenter 를 등록합니다.',
    '등록 후 연결 테스트로 자격증명을 확인합니다.',
  ],
  pending: ['그대로 기다립니다 — 다음 수집 주기에 채워집니다.'],
  unreachable: [
    '그 엣지 포탈의 설정 › vCenter 관리에서 그 vCenter 의 연결 테스트를 눌러 오류를 확인합니다.',
    '계정·비밀번호, 인증서, 방화벽(443)을 확인합니다.',
    '아래 로그의 실패 원문이 어느 단계에서 끊겼는지 가리킵니다.',
  ],
  'skipped-mock': [
    '그 엣지의 DATA_SOURCE 를 live 로 고정합니다(auto 는 접속 실패 시 가짜 데이터로 폴백합니다).',
    'vCenter 접속이 되는지 그 엣지에서 연결 테스트로 확인합니다.',
  ],
  'empty-vcenter': [
    '그 vCenter 에 실제로 호스트가 없다면 조치가 필요하지 않습니다.',
    '있어야 한다면 그 엣지 계정의 권한(읽기 범위)이 클러스터·호스트를 볼 수 있는지 확인합니다.',
  ],
  'push-errors': [
    '아래 오류 문구의 HTTP 상태를 봅니다 — 403 은 토큰, 413 은 본문 크기, 5xx 는 중앙 쪽입니다.',
    '토큰 문제라면 특수기능 › 포탈 점검 › 토큰 점검에서 중앙·엣지 값을 대조합니다.',
  ],
  'need-pull': ['아래 ‘엣지 상태·로그 가져오기’ 를 누릅니다.'],
  unknown: [
    '아래 로그에서 inv-push 줄을 찾아 어느 vCenter 가 전송됐는지 봅니다.',
    '중앙의 vCenter 목록에서 그 법인 항목의 수집 방식(위임/직접)이 의도한 값인지 확인합니다.',
  ],
});

/** 모달 제목 줄 — 확정 여부를 **말로** 밝힌다(추정을 사실로 말하지 않는다). */
export function headline(d) {
  const label = CAUSE_LABEL[d?.kind] || CAUSE_LABEL.unknown;
  if (d?.confident) return `원인: **${label}**`;
  return `원인 후보: **${label}** (확정하지 못했습니다)`;
}

/** 로그에서 이 진단에 쓸모 있는 줄만 — 전부 보여주면 사람이 못 찾는다. */
export const LOG_FILTER_RE = /inv-push|vcenter|vc-|store|refresh|soap|mock|DATA_SOURCE/i;
export function relevantLogs(items, max = 60) {
  if (!Array.isArray(items)) return [];
  const hit = items.filter((e) => LOG_FILTER_RE.test(t(e?.msg)));
  const use = hit.length ? hit : items;
  return use.slice(-max);
}
