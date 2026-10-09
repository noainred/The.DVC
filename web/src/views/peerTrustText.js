/**
 * views/peerTrustText.js — 설정 › 장비 신뢰(SSH 호스트키·TLS 인증서) 화면의 판정·문구(순수 — vitest 로 고정).
 * 2026-10-09 검토 S-01·S-02(그룹 H). 서버 저장소는 server/src/security/peerTrust.js, API 는 routes/admin/peerTrust.js.
 *
 * 화면 원칙
 *  · **바뀐 지문(대기·changed)이 맨 위**다 — 가로채기 또는 장비 교체 신호이고 그 장비의 수집은 지금 거부되고 있다.
 *  · 관찰(observed)은 '정상' 이 아니라 **미승인**이다(업그레이드 직후 끊기지 않게 임시로 통과시키는 것뿐) — 초록으로 칠하지 않는다.
 *  · 승인은 관리자가 지문을 **장비 콘솔 등 별도 경로로 대조**한 뒤에만 — 확인 문구가 그 사실을 묻는다.
 *  · 값이 없으면 '—'(빈 지문을 지어내지 않는다). 문구에 백틱을 쓰지 않는다(BoldText 는 굵게만 해석).
 */
import { unitText } from './unitText.js';

export const KIND_LABEL = Object.freeze({ ssh: 'SSH 호스트키', tls: 'TLS 인증서' });
export const KINDS = Object.freeze(['ssh', 'tls']);

export const MODE_LABEL = Object.freeze({
  enforce: '승인된 지문만 허용',
  observe: '관찰(처음 보는 장비는 통과·바뀐 지문은 거부)',
});

export const STATE_LABEL = Object.freeze({
  approved: '승인됨',
  observed: '관찰(미승인)',
  pending: '승인 대기',
  rejected: '거부됨',
  none: '기록만',
});

export const PENDING_REASON_TEXT = Object.freeze({
  changed: '지문이 바뀜',
  unknown: '처음 보는 장비',
  'not-approved': '관찰 지문(승인 전)',
});

/** 상태 → 배지 색. 바뀐 지문 대기는 빨강, 그 밖의 대기·관찰은 주황(미승인), 승인은 초록, 거부는 회색. */
export function stateTone(peer) {
  const st = peer?.state;
  if (st === 'pending') return peer?.pending?.reason === 'changed' ? 'red' : 'amber';
  if (st === 'observed') return 'amber';
  if (st === 'approved') return 'green';
  return 'gray';
}

/** 상태 칸 문구 — 대기면 사유를 붙인다. */
export function stateText(peer) {
  const st = peer?.state || 'none';
  const base = STATE_LABEL[st] || STATE_LABEL.none;
  if (st === 'pending') {
    const r = PENDING_REASON_TEXT[peer?.pending?.reason] || '';
    return r ? `${base} · ${r}` : base;
  }
  return base;
}

const ORDER = { 'pending-changed': 0, pending: 1, observed: 2, rejected: 3, approved: 4, none: 5 };
const rankOf = (p) => (p?.state === 'pending' && p?.pending?.reason === 'changed' ? ORDER['pending-changed'] : ORDER[p?.state] ?? 5);

/** 바뀐 지문 → 대기 → 관찰 → 거부 → 승인 순. 같은 등급은 종류·호스트·포트 순. */
export function sortPeers(peers = []) {
  return [...(Array.isArray(peers) ? peers : [])].sort((a, b) => rankOf(a) - rankOf(b)
    || String(a.kind).localeCompare(String(b.kind))
    || String(a.host).localeCompare(String(b.host), undefined, { numeric: true })
    || (Number(a.port) || 0) - (Number(b.port) || 0));
}

/** 거르기 — kind('all'|'ssh'|'tls') · state('all'|'pending'|'observed'|'approved'|'rejected') · 검색어(호스트·지문). */
export function filterPeers(peers = [], { kind = 'all', state = 'all', q = '' } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  return sortPeers(peers).filter((p) => (kind === 'all' || p.kind === kind)
    && (state === 'all' || p.state === state)
    && (!needle || `${p.host}:${p.port}`.toLowerCase().includes(needle)
      || String(p.trusted?.fp || '').toLowerCase().includes(needle)
      || String(p.pending?.fp || '').toLowerCase().includes(needle)));
}

/** 정책 줄의 보조 설명 — 왜 이 정책인지(업그레이드 이관·환경변수 강제·저장 파일 손상). */
export function policyNote(kind, policy = {}) {
  const label = KIND_LABEL[kind] || kind;
  if (policy.source === 'env') return `환경변수 ${policy.envKey || ''} 가 ${label} 정책을 정하고 있어 화면에서 바꿀 수 없습니다.`;
  if (policy.origin === 'load-error') return '장비 신뢰 파일을 읽지 못해 승인된 지문만 허용으로 닫았습니다(손상 원본은 보존). 파일을 복구하거나 지문을 다시 승인하세요.';
  if (policy.origin === 'upgrade-migration' && policy.mode === 'observe') {
    return '이 설치는 업그레이드로 **관찰 모드**에서 시작했습니다(업그레이드 직후 수집이 끊기지 않게). 관찰 지문을 장비에서 확인·승인한 뒤 **승인된 지문만 허용**으로 바꾸세요.';
  }
  if (policy.mode === 'observe') return '관찰 모드 — 처음 보는 장비는 지문을 기록하고 통과시킵니다. 바뀐 지문은 거부합니다.';
  return '승인된 지문만 허용 — 처음 보는 장비와 바뀐 지문은 승인 전까지 연결하지 않습니다(비밀번호를 보내지 않습니다).';
}

/** 종류별 요약 — 개수만, 0 은 0 으로(경고색은 화면이 바뀐 지문 개수에만 쓴다). */
export function countsText(counts = {}) {
  const n = (k) => (Number.isFinite(Number(counts[k])) ? Number(counts[k]) : 0);
  const parts = [`승인 ${n('approved')}`, `관찰(미승인) ${n('observed')}`, `대기 ${n('pending')}`];
  if (n('pendingChanged')) parts.push(`⚠ 바뀐 지문 ${n('pendingChanged')}`);
  if (n('rejected')) parts.push(`거부 ${n('rejected')}`);
  return parts.join(' · ');
}

/** 승인 확인 문구(window.confirm) — 별도 경로 대조를 묻는다. 대기 지문과 다른 값을 미리 등록하면 그 사실을 함께 말한다. */
export function approveConfirmText(peer, fp) {
  const label = KIND_LABEL[peer?.kind] || peer?.kind || '';
  const presented = peer?.pending?.fp || peer?.trusted?.fp || '';
  const lines = [
    `${label} ${peer?.host}:${peer?.port}`,
    `승인할 지문: ${fp || '—'}`,
    '',
    '이 지문을 장비 콘솔·관리 화면 등 **이 포탈이 아닌 경로**로 직접 확인했습니까?',
    '포탈 화면에 보이는 값만 보고 승인하면, 가로챈 서버의 키를 신뢰하게 될 수 있습니다.',
  ];
  if (peer?.pending?.reason === 'changed') lines.push('', '⚠ 이 장비의 지문이 바뀌었습니다 — 장비 교체·키 재생성이 실제로 있었는지 먼저 확인하세요.');
  if (presented && fp && presented !== fp) lines.push('', '※ 장비가 마지막으로 내민 지문과 다른 값입니다(교체 예정 장비를 미리 등록하는 경우).');
  return lines.join('\n').replace(/\*\*/g, '');
}

export function bulkConfirmText(kind, n) {
  return `${KIND_LABEL[kind] || kind} 관찰 지문 ${n}개를 한 번에 승인합니다.\n\n각 지문을 장비에서 확인했습니까? 바뀐 지문(승인 대기)은 포함하지 않습니다.`;
}

export function rejectConfirmText(peer, fp) {
  return `${KIND_LABEL[peer?.kind] || peer?.kind} ${peer?.host}:${peer?.port}\n거부할 지문: ${fp || '—'}\n\n거부한 지문은 정책과 무관하게 연결하지 않습니다.`;
}

/** 정책 변경 확인 — observe 로 약화할 때만 경고. */
export function policyConfirmText(kind, mode) {
  if (mode === 'observe') {
    return `${KIND_LABEL[kind] || kind} 정책을 관찰 모드로 바꿉니다.\n\n처음 보는 장비는 확인 없이 통과합니다(지문은 기록). 업그레이드 이관·장비 대량 등록 때만 잠시 쓰고, 확인 뒤 다시 '승인된 지문만 허용' 으로 돌리세요.`;
  }
  return `${KIND_LABEL[kind] || kind} 정책을 '승인된 지문만 허용' 으로 바꿉니다.\n\n아직 승인하지 않은 관찰 지문의 장비는 승인 전까지 연결되지 않습니다.`;
}

/** TLS 항목의 인증서 정보(주체·발급자·만료). 없으면 ''. */
export function certMetaText(o = {}) {
  const parts = [];
  if (o.subject) parts.push(`주체 ${o.subject}`);
  if (o.issuer) parts.push(`발급 ${o.issuer}`);
  if (o.validTo) parts.push(`만료 ${o.validTo}`);
  return parts.join(' · ');
}

/** 시각(epoch ms) → 표시. 없으면 '—'. */
export function whenText(ts) {
  const n = Number(ts);
  if (ts == null || ts === '' || !Number.isFinite(n) || n <= 0) return '—';
  return new Date(n).toLocaleString('ko-KR');
}

/** 직접 등록 폼 검사(서버와 같은 규칙) — 오류 문구 또는 null. */
export function manualIssue({ kind, host, port, fp } = {}) {
  if (!KINDS.includes(kind)) return '종류를 고르세요.';
  if (!/^[A-Za-z0-9._:%[\]-]{1,255}$/.test(String(host || '').trim())) return '호스트는 이름·IP 만 입력하세요(공백·특수문자 불가).';
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return '포트는 1~65535 정수입니다.';
  const f = String(fp || '').trim();
  if (kind === 'ssh' && !/^(?:sha256:)?[A-Za-z0-9+/]{43}=?$/i.test(f)) return 'SSH 지문은 SHA256:<base64 43자> 형식입니다(ssh-keygen -lf 출력).';
  if (kind === 'tls' && !/^[0-9A-Fa-f]{64}$/.test(f.replace(/^sha256:/i, '').replace(/[\s:]/g, ''))) return 'TLS 지문은 SHA-256 16진 64자리입니다(콜론 구분 가능).';
  return null;
}

/* ── TLS 탭(그룹 I 의 server/src/security/tlsTrust.js tlsTrustStatus() 를 그린다 — 읽기만) ── */

/** 수집기 TLS 모드 이름(tlsMode.js 의 verify·strict·insecure). */
export const TLS_MODE_LABEL = Object.freeze({
  verify: '검증(CA 체인 또는 승인 지문)',
  strict: '엄격(CA 체인만)',
  insecure: '예외(검증 안 함)',
});

/** 거부 사유(tlsTrust.js 의 reason — PIN_TEXT 키 + 'chain'). 모르는 값은 원문 그대로. */
export const TLS_REASON_TEXT = Object.freeze({
  chain: 'CA 체인 검증 실패(엄격 모드)',
  unknown: '승인된 지문 없음',
  changed: '지문이 바뀜',
  rejected: '관리자가 거부한 지문',
  'not-approved': '관찰 지문(승인 전)',
  'bad-fingerprint': '지문을 읽지 못함',
  'no-cert': '장비가 인증서를 내지 않음',
  'resumed-unknown': '기억하지 않은 세션 재개',
});

/** tlsTrust 의 chainError 코드 → 짧은 문구(모르는 코드는 그대로). */
const CHAIN_SHORT = Object.freeze({
  CERT_HAS_EXPIRED: '인증서 만료',
  CERT_NOT_YET_VALID: '유효 기간 전',
  ERR_TLS_CERT_ALTNAME_INVALID: '이름 불일치',
  DEPTH_ZERO_SELF_SIGNED_CERT: '자체서명',
  SELF_SIGNED_CERT_IN_CHAIN: '신뢰하지 않는 자체서명 CA',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '신뢰하는 CA 서명 아님',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: '신뢰하는 CA 서명 아님',
  UNABLE_TO_GET_ISSUER_CERT: '신뢰하는 CA 서명 아님',
});

export function tlsReasonText(r = {}) {
  const base = TLS_REASON_TEXT[r.reason] || (r.reason ? String(r.reason) : '—');
  const chain = r.chainError ? (CHAIN_SHORT[r.chainError] || String(r.chainError)) : '';
  return chain && r.reason !== 'chain' ? `${base} · CA: ${chain}` : chain ? `${base} · ${chain}` : base;
}

/**
 * 최근 거부 행에서 바로 승인할 수 있는가 — { ok, why }.
 * 지문이 없으면 승인할 값이 없고, 엄격 모드(CA 체인만)는 승인 지문을 쓰지 않으므로 승인해도 연결되지 않는다(사설 CA 등록이 조치).
 */
export function rejectApprovable(r = {}) {
  const fp = String(r.fingerprint || '').trim();
  if (!fp) return { ok: false, why: '장비가 낸 인증서 지문이 없어 승인할 수 없습니다.' };
  if (r.mode === 'strict') return { ok: false, why: '이 수집기는 엄격 모드(CA 체인만)라 지문 승인을 쓰지 않습니다 — 사설 CA 를 번들에 등록하세요.' };
  if (!r.host || !Number.isInteger(Number(r.port))) return { ok: false, why: '호스트·포트를 알 수 없습니다.' };
  return { ok: true, why: '' };
}

/** 사설 CA 번들 카드 — { tone, title, lines[] }. 값이 없으면 지어내지 않는다. */
export function caBundleView(cb) {
  if (!cb || typeof cb !== 'object') return { tone: 'gray', title: '사설 CA 번들 상태를 읽지 못했습니다', lines: [] };
  const file = cb.file || 'CONFIG_DIR/tls-ca-bundle.pem';
  if (cb.present === false) {
    return {
      tone: 'gray',
      title: '사설 CA 번들 없음',
      lines: [`파일: ${file}`, '사내 CA 로 발급한 장비 인증서는 이 파일(PEM)에 CA 인증서를 두면 지문 승인 없이 CA 체인으로 검증됩니다.'],
    };
  }
  if (cb.error) return { tone: 'red', title: '사설 CA 번들을 쓰지 않습니다', lines: [`파일: ${file}`, `사유: ${cb.error}`] };
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const lines = [`파일: ${file}`, `인증서 ${unitText(n(cb.certs), '개')}${cb.truncated ? ' (상한으로 일부만 읽음)' : ''}`];
  const warn = [];
  if (n(cb.expired)) warn.push(`만료된 인증서 ${n(cb.expired)}개`);
  if (n(cb.notCa)) warn.push(`CA 가 아닌 인증서 ${n(cb.notCa)}개(장비 인증서를 넣었다면 CA 인증서로 바꾸세요)`);
  const errs = Array.isArray(cb.errors) ? cb.errors.length : 0;
  if (errs) warn.push(`읽지 못한 블록 ${errs}개(쓰지 않음)`);
  if (n(cb.otherBlocks)) warn.push(`인증서가 아닌 블록 ${n(cb.otherBlocks)}개(쓰지 않음)`);
  return { tone: warn.length ? 'amber' : (n(cb.certs) ? 'green' : 'amber'), title: n(cb.certs) ? '사설 CA 번들 사용 중' : '사설 CA 번들에 쓸 수 있는 인증서가 없습니다', lines: [...lines, ...warn] };
}

/** 수집기 행의 모드 문구 — 한 수집기가 여러 모드로 불렸으면 전부. */
export function subsystemModesText(s = {}) {
  const modes = Array.isArray(s.modes) ? s.modes : [];
  if (!modes.length) return '—';
  return modes.map((m) => TLS_MODE_LABEL[m] || m).join(' · ');
}

/** 수집기 판정 횟수 요약(재시작 뒤 0 부터 센다 — 화면 각주가 말한다). */
export function tlsCountsText(c = {}) {
  const n = (k) => (Number.isFinite(Number(c[k])) ? Number(c[k]) : 0);
  const parts = [`CA 체인 ${n('chain')}`, `승인 지문 ${n('pin')}`, `관찰 통과 ${n('observed')}`, `거부 ${n('rejected')}`];
  if (n('resumed')) parts.push(`세션 재개 ${n('resumed')}`);
  if (n('insecure')) parts.push(`검증 안 함 ${n('insecure')}`);
  if (n('plain')) parts.push(`평문(http) ${n('plain')}`);
  return parts.join(' · ');
}

/** '예외 사용 중' 배너 — 예외가 없으면 null. */
export function exceptionBannerText(exceptions) {
  const list = Array.isArray(exceptions) ? exceptions.filter((x) => x && typeof x === 'object') : [];
  if (!list.length) return null;
  const names = list.map((x) => `${x.label || x.subsystem}${x.envKey ? `(${x.envKey})` : ''}`).join(', ');
  return `**예외 사용 중** — 다음 수집기는 장비 인증서를 검증하지 않습니다: ${names}. 이 경로로는 가로챈 서버에도 자격증명이 갑니다. 사설 CA 를 등록하거나 지문을 승인한 뒤 그 환경변수를 지우세요.`;
}

/** 최근 거부 행 → 승인 확인 대화상자에 넘길 peer 모양. */
export function rejectAsPeer(r = {}) {
  return { kind: 'tls', host: String(r.host || ''), port: Number(r.port), pending: { fp: r.fingerprint || '', reason: r.reason === 'changed' ? 'changed' : 'unknown' } };
}
