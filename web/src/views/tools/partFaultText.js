/**
 * 파트 장애 화면의 **판정·문구 단일 소스**(v2.547).
 *
 * 웹 테스트는 node 환경(DOM 없음)이라 컴포넌트 렌더 테스트가 불가하다 — 그래서 판정과 문구를
 * 여기(순수 함수)에 두고 vitest 로 회귀를 고정한다(`accessDeniedText.js`·`loadState.js` 관례).
 *
 * ── 이 모듈이 지키는 정직성 규칙(전부 CLAUDE.md 에 근거가 있다) ──────────────────
 *  ① **'장애 0건' 을 '정상' 이라 단정하지 않는다.** 점검이 안 돌았을 수도, 장비를 못 봤을 수도,
 *     상태를 못 읽었을 수도 있다 — 조치가 전부 다르다(v2.517 `perfEmptyDiag` 와 같은 판단).
 *  ② **`unknown`·`absent` 를 정상에도 장애에도 넣지 않는다**(v2.523·v2.526 규약).
 *     `REMOVED`(빈 슬롯)를 고장으로 세면 정상 장비에 장애 12건이 찍힌다 — 실제로 겪은 일이다.
 *  ③ **식별자 등급을 밝힌다.** 슬롯·시리얼로 잡은 파트는 안정적이지만 **순번(index)** 으로 잡은
 *     파트는 장비가 목록 순서를 바꾸면 **다른 부품을 같은 것으로 본다**. 숨기면 거짓이 된다.
 *  ④ **보고가 없는 엣지를 '정상' 이라 말하지 않는다** — '모른다' 다(v2.517).
 *  ⑤ 주기·상한 **숫자를 문구에 박지 않는다** — 서버가 준 값만 쓴다(v2.509 규약).
 */

const n = (v) => (v == null ? null : Number(v));
const num = (v) => (Number.isFinite(Number(v)) && v != null ? Number(v) : 0);

/** 경과 시간을 사람 말로. ⚠ `v == null` 을 **먼저** 본다(`Number(null) === 0` 함정 — v2.525). */
export function ageText(ms) {
  if (ms == null || !Number.isFinite(Number(ms)) || Number(ms) < 0) return '—';
  const s = Math.floor(Number(ms) / 1000);
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

/** 주기(ms) → '몇 분' 문구. 서버가 준 값만 쓴다(하드코딩 금지). */
export function intervalText(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '';
  const m = Math.round(Number(ms) / 60000);
  return m >= 60 ? `${Math.round(m / 60)}시간` : `${m}분`;
}

/**
 * 스캔 요약 한 줄. **확인 불가·빈 슬롯을 따로 말한다**(규칙 ②).
 * @returns {{text:string, unknown:number, absent:number, devices:number, failed:number}|null}
 */
export function scanNote(scanned) {
  if (!scanned) return null;
  const s = scanned.summary || {};
  const devices = num(scanned.idrac?.devices) + num(scanned.storage?.devices);
  const ok = num(scanned.idrac?.ok) + num(scanned.storage?.ok);
  const failed = num(scanned.idrac?.failed) + num(scanned.storage?.failed);
  const parts = [`장비 ${ok}/${devices}대에서 부품 ${num(s.total)}개를 판정했습니다`];
  if (failed) parts.push(`수집이 없거나 낡아 **${failed}대는 보지 못했습니다**`);
  if (num(s.unknown)) parts.push(`상태를 읽지 못한 부품 ${num(s.unknown)}개(정상이라는 뜻이 아닙니다)`);
  if (num(s.absent)) parts.push(`빈 슬롯 ${num(s.absent)}개(고장이 아닙니다)`);
  return {
    text: parts.join(' · '),
    unknown: num(s.unknown), absent: num(s.absent),
    devices, ok, failed, total: num(s.total),
  };
}

/**
 * 목록이 비었을 때 **왜 비었는지**를 판정한다. 한 문구로 덮지 않는다(규칙 ①).
 * 판정 순서: DB 불가 → 점검 안 함(꺼짐/첫 주기) → 본 장비 0 → 엣지 무보고 → 정상.
 * @returns {{kind:string, text:string, tone:'bad'|'warn'|'ok'|'muted', waiting:boolean}}
 */
export function emptyDiag({ open = [], poller = null, db = null, edges = null, role = 'central' } = {}) {
  if (open.length) return { kind: 'has', text: '', tone: 'bad', waiting: false };

  if (db && db.available === false) {
    return {
      kind: 'db',
      text: `파트 장애 DB 를 열지 못했습니다${db.error ? ` — ${db.error}` : ''}. 기록·비교가 되지 않으므로 목록이 비어 있는 것을 **정상으로 읽지 마세요**.`,
      tone: 'bad', waiting: false,
    };
  }
  if (role === 'edge') {
    // 엣지는 중앙 DB 를 갖지 않는다 — 여기서 목록이 비는 것은 당연하고, 볼 곳은 중앙이다.
    return {
      kind: 'edge-node',
      text: '이 노드는 엣지입니다 — 로컬에서 판정한 **장애만 중앙으로 보냅니다**. 기록과 알림은 중앙 포탈에서 봅니다.',
      tone: 'muted', waiting: false,
    };
  }
  if (poller && poller.enabled === false && !poller.last) {
    return {
      kind: 'disabled',
      text: '파트 장애 점검이 **꺼져 있습니다**(기본값). 켜면 다음 주기부터 부품 상태를 판정해 기록합니다 — 지금 한 번만 보려면 아래 **지금 점검**을 누르세요.',
      tone: 'warn', waiting: false,
    };
  }
  if (!poller || !poller.last) {
    return {
      kind: 'first',
      text: '아직 한 번도 점검하지 않았습니다. **지금 점검**을 누르거나 첫 주기를 기다리면 채워집니다.',
      tone: 'muted', waiting: true,
    };
  }
  if (poller.last.error) {
    return { kind: 'error', text: `직전 점검이 실패했습니다 — ${poller.last.error}`, tone: 'bad', waiting: false };
  }

  const sn = scanNote(poller.last.local);
  if (sn && sn.devices === 0) {
    return {
      kind: 'no-devices',
      text: '점검 대상 장비가 없습니다 — iDRAC 서버나 스토리지 장비가 이 노드에 등록되어 있는지 확인하세요.',
      tone: 'warn', waiting: false,
    };
  }
  if (sn && sn.ok === 0 && sn.devices > 0) {
    return {
      kind: 'all-failed',
      text: `등록된 ${sn.devices}대 **전부**에서 최신 수집 결과를 읽지 못했습니다. 장애가 없는 것이 아니라 **확인하지 못한 것**입니다.`,
      tone: 'bad', waiting: false,
    };
  }

  const silent = edges?.silent?.length || 0;
  const stale = (edges?.reports || []).filter((r) => r.stale).length;
  const extra = [];
  if (sn?.failed) extra.push(`보지 못한 장비 ${sn.failed}대`);
  if (sn?.unknown) extra.push(`상태를 읽지 못한 부품 ${sn.unknown}개`);
  if (silent) extra.push(`보고가 없는 엣지 ${silent}곳`);
  if (stale) extra.push(`보고가 오래된 엣지 ${stale}곳`);
  if (extra.length) {
    return {
      kind: 'partial',
      text: `확인한 범위에서는 장애가 없습니다. 다만 ${extra.join(' · ')}가 있어 **'전부 정상' 이라고는 말할 수 없습니다**.`,
      tone: 'warn', waiting: false,
    };
  }
  return { kind: 'ok', text: '확인한 모든 부품이 정상입니다.', tone: 'ok', waiting: false };
}

/**
 * 엣지 보고 현황 문구. **보고가 없는 것을 '꺼짐' 이라 말하지 않는다**(규칙 ④).
 * @returns {{text:string, tone:string, silent:number, stale:number, fresh:number}}
 */
export function edgeNote(edges) {
  const reports = edges?.reports || [];
  const silent = edges?.silent?.length || 0;
  const stale = reports.filter((r) => r.stale).length;
  const fresh = reports.length - stale;
  if (!reports.length && !silent) {
    return { text: '엣지 위임 없음 — 이 노드가 직접 수집한 장비만 판정합니다.', tone: 'muted', silent, stale, fresh };
  }
  const bits = [`엣지 보고 ${fresh}곳 정상`];
  if (stale) bits.push(`**${stale}곳은 보고가 오래됐습니다**(그 장비의 장애를 해소로 처리하지 않습니다)`);
  if (silent) bits.push(`**${silent}곳은 한 번도 보고하지 않았습니다** — 그 법인 장비는 '장애 없음' 이 아니라 '모름' 입니다`);
  return { text: bits.join(' · '), tone: (stale || silent) ? 'warn' : 'ok', silent, stale, fresh };
}

/**
 * 파트 식별자 등급 안내(규칙 ③). 안정적인 키(slot/serial)는 **문구를 만들지 않는다** —
 * 모든 행에 안내를 붙이면 사람이 읽지 않게 된다.
 */
export function keyKindNote(keyKind, notes = {}) {
  // slot·serial·name 은 **조용하다**. 장비가 준 이름은 대체로 안정적이고(`types.js KEY_KIND` 주석),
  // 모든 행에 호박색 안내가 붙으면 정작 위험한 `index` 를 아무도 읽지 않는다
  // (v2.547 Chromium 판독에서 실제로 그렇게 보였다 — 정상 행이 경고처럼 보였다).
  if (keyKind === 'slot' || keyKind === 'serial' || keyKind === 'name') return '';
  return notes[keyKind] || '';
}

/**
 * 상태 색. ⚠ **두 어휘를 모두 받아야 한다** — 서버 `PART_STATE_TONE` 은 `red/amber/green/gray`,
 * 화면 진단(`emptyDiag`)은 `bad/warn/ok/muted` 를 쓴다. 한쪽만 매핑하면 표의 상태 글자가
 * **색을 잃는다**(초판이 실제로 그랬고 스크린샷을 읽어야 보였다 — 수치로는 안 잡혔다.
 * v2.526 `healthBadge` 와 같은 유형: 사람은 색을 먼저 읽는다).
 */
export function toneVar(tone) {
  switch (String(tone || '')) {
    case 'red': case 'bad': return 'var(--red)';
    case 'amber': case 'warn': return 'var(--amber)';
    case 'green': case 'ok': return 'var(--green)';
    default: return 'var(--text-faint)';   // gray·muted·모르는 값 — '확인 불가' 는 빨강이 아니다
  }
}

/**
 * 열린 장애가 '왜 아직 열려 있나' — 전이가 보류한 사유. 없으면 빈 문자열.
 * ⚠ **짧게 쓴다.** 행마다 긴 문장을 넣으면 화면이 같은 말로 뒤덮인다(v2.509 규약 —
 *   v2.547 400px 판독에서 5행이 전부 같은 두 줄 문장이었다. 스크린샷을 읽어야 보인다).
 *   긴 설명은 `holdNote()` 가 **배너에서 한 번만** 한다.
 */
export function holdText(holdReason) {
  const map = {
    unknown: '판정 보류 — 상태를 읽지 못함',
    'device-failed': '판정 보류 — 이 장비 수집 실패',
    missing: '판정 보류 — 이번 목록에 없음',
  };
  return map[holdReason] || '';
}

/**
 * 보류 건수 요약(배너 1회). **'해소로 처리하지 않았다' 는 사실을 여기서 한 번 말한다.**
 * @returns {string} 보류가 없으면 빈 문자열
 */
export function holdNote(open = []) {
  const by = { unknown: 0, 'device-failed': 0, missing: 0 };
  for (const p of open) if (by[p?.holdReason] != null) by[p.holdReason] += 1;
  const total = by.unknown + by['device-failed'] + by.missing;
  if (!total) return '';
  const bits = [];
  if (by['device-failed']) bits.push(`이 장비 수집 실패 ${by['device-failed']}건`);
  if (by.unknown) bits.push(`상태를 읽지 못함 ${by.unknown}건`);
  if (by.missing) bits.push(`이번 목록에 없음 ${by.missing}건`);
  return `판정 보류 ${total}건(${bits.join(' · ')}) — 이번 점검에서 확인하지 못해 **해소로 처리하지 않았습니다**.`
    + ' 사유는 각 행에 적혀 있습니다.';
}

/** 전이 이벤트 1건 → 사람 말. `close` 는 사유(ok/removed)를 구분한다. */
export function eventText(ev, labels = {}) {
  if (!ev) return '';
  const st = (s) => labels.state?.[s] || s || '?';
  if (ev.event === 'open') return `장애 발생 — ${st(ev.state)}`;
  if (ev.event === 'change') return `상태 변화 — ${st(ev.prevState)} → ${st(ev.state)}`;
  if (ev.event === 'close') {
    return ev.closeReason === 'removed'
      ? `해소(부품이 **제거**됨 — 교체 중일 수 있습니다) — 직전 ${st(ev.prevState)}`
      : `해소(정상으로 복귀) — 직전 ${st(ev.prevState)}`;
  }
  return ev.event || '';
}

/** 알림 상태 한 줄. **상한으로 빠진 건수를 밝힌다**(조용한 상한 금지). */
export function notifyNote(last) {
  const nt = last?.notify;
  if (!nt) return '';
  const bits = [`알림 ${num(nt.sent)}건 발송`];
  if (num(nt.capped)) bits.push(`**상한으로 ${num(nt.capped)}건은 보내지 않았습니다**`);
  if (num(nt.dropped)) bits.push(`채널 미설정 등으로 ${num(nt.dropped)}건 미발송`);
  return bits.join(' · ');
}

/** 마지막 점검 요약. 값이 없으면 지어내지 않는다. */
export function lastRunText(poller, now = Date.now()) {
  const l = poller?.last;
  if (!l) return '점검 이력 없음';
  if (l.error) return `직전 점검 실패(${ageText(now - num(l.at))}) — ${l.error}`;
  const s = l.stats || {};
  return `직전 점검 ${ageText(now - num(l.at))} · ${num(l.ms)}ms · 신규 ${num(s.opened)} · 해소 ${num(s.closed)} · 변화 ${num(s.changed)}`;
}

export const _n = n; // 테스트에서 null 처리 확인용(굳이 쓰지 않아도 계약을 고정한다)
