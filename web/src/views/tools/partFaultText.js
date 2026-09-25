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

import { agoText as _ago, elapsedText as _elapsed } from './relTime.js';

const n = (v) => (v == null ? null : Number(v));
const num = (v) => (Number.isFinite(Number(v)) && v != null ? Number(v) : 0);

/** 경과 시간을 사람 말로. ⚠ `v == null` 을 **먼저** 본다(`Number(null) === 0` 함정 — v2.525). */
/**
 * ⚠ v2.574 IMP-03 — 문구는 **공용 코어 `relTime.js`** 가 소유한다. 아래는 호출부 호환을 위한
 *   위임 껍데기다. v2.573 까지 9벌이 각자 구현이었고 **실제로 갈라져 있었다**
 *   (90초 → `2분 전` 7벌 vs `1분 전` 2벌 · 결측 `—` 6벌 / `null` 2벌 / `없음` 1벌).
 *   ⚠ 새 상대시각 문구를 만들지 말 것 — `agoText`(타임스탬프)·`elapsedText`(경과 ms) 를 쓴다.
 */
export const ageText = (ms) => _elapsed(ms, { subMinute: 'seconds' });

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
  const scopes = ['idrac', 'storage', 'sanswitch'];
  const devices = scopes.reduce((a, k) => a + num(scanned[k]?.devices), 0);
  const ok = scopes.reduce((a, k) => a + num(scanned[k]?.ok), 0);
  const failed = scopes.reduce((a, k) => a + num(scanned[k]?.failed), 0);
  const parts = [`장비 ${ok}/${devices}대에서 부품 ${num(s.total)}개를 판정했습니다`];
  if (failed) {
    // v2.548 F1: '보지 못함' 의 이유를 나눈다 — 닿지 못함(불통) / 낡음 / 그 밖. 조치가 다르다.
    const why = [];
    if (num(scanned.idrac?.unreachable)) why.push(`불통 ${num(scanned.idrac.unreachable)}대`);
    if (num(scanned.idrac?.stale)) why.push(`낡음 ${num(scanned.idrac.stale)}대`);
    parts.push(`**${failed}대는 보지 못했습니다**${why.length ? `(${why.join(' · ')})` : ''}`);
  }
  if (num(scanned.idrac?.partial)) parts.push(`일부 부품 종류를 못 읽은 서버 ${num(scanned.idrac.partial)}대(그 종류는 판정 보류)`);
  if (num(s.unknown)) parts.push(`상태를 읽지 못한 부품 ${num(s.unknown)}개(정상이라는 뜻이 아닙니다)`);
  if (num(s.absent)) parts.push(`빈 슬롯 ${num(s.absent)}개(고장이 아닙니다)`);
  if (num(scanned.sanswitch?.notJudged)) parts.push(`링크 없는 SAN 포트 ${num(scanned.sanswitch.notJudged)}개는 판정 대상 아님`);
  return {
    text: parts.join(' · '),
    unknown: num(s.unknown), absent: num(s.absent),
    devices, ok, failed, total: num(s.total),
    unreachable: num(scanned.idrac?.unreachable), partial: num(scanned.idrac?.partial),
  };
}

/**
 * 엣지 보고의 요약(scanned)을 KPI 에 합산한다(v2.548 리뷰 H2 — 중앙 로컬 스캔만 세면 위임 장비의
 * unknown/absent 가 0 으로 보인다). **신선한 프로토콜 2 보고만** 더하고, 요약이 없는(scannedDropped·
 * 구버전) 엣지와 오래된/구 프로토콜 엣지는 개수만 밝힌다 — 0 을 지어내지 않는다.
 * @returns {{agents:number, unknown:number, absent:number, total:number, noSummary:number, skipped:number}}
 */
export function edgeScanTotals(edgeAgents) {
  const out = { agents: 0, unknown: 0, absent: 0, total: 0, noSummary: 0, skipped: 0 };
  for (const a of edgeAgents || []) {
    if (!a) continue;
    if (a.stale || a.legacy) { out.skipped += 1; continue; }
    const s = a.scanned?.summary;
    if (!s || a.scannedDropped) { out.noSummary += 1; continue; }
    out.agents += 1;
    out.unknown += num(s.unknown); out.absent += num(s.absent); out.total += num(s.total);
  }
  return out;
}

/**
 * 목록이 비었을 때 **왜 비었는지**를 판정한다. 한 문구로 덮지 않는다(규칙 ①).
 * 판정 순서: DB 불가 → 점검 안 함(꺼짐/첫 주기) → 본 장비 0 → 엣지 무보고 → 정상.
 * @returns {{kind:string, text:string, tone:'bad'|'warn'|'ok'|'muted', waiting:boolean}}
 */
export function emptyDiag({ open = [], poller = null, db = null, edges = null, role = 'central', now = Date.now() } = {}) {
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
      text: '이 노드는 엣지입니다 — 로컬에서 판정한 결과(장애 + 전체 요약)를 **중앙으로 보냅니다**. 기록·이력·알림은 중앙 포탈에서 봅니다.',
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
  // v2.548 리뷰 H4 — 마지막 점검이 낡았으면 '정상' 이라 말하지 않는다. 주기는 서버가 준 값만 쓴다(숫자 하드코딩 금지).
  const lastAt = num(poller.last.at);
  if (poller.enabled === false) {
    return {
      kind: 'stale-off',
      text: `자동 점검이 **꺼져 있습니다** — 마지막 점검(${lastAt ? ageText(now - lastAt) : '시각 미상'}) 이후의 부품 상태는 모릅니다. 켜거나 **지금 점검**을 누르세요.`,
      tone: 'warn', waiting: false,
    };
  }
  const iv = num(poller.intervalMs);
  if (iv && lastAt && now - lastAt > 2 * iv) {
    return {
      kind: 'stale-check',
      text: `마지막 점검이 ${ageText(now - lastAt)}으로 주기의 2배를 넘겼습니다 — 그 뒤의 부품 상태는 모릅니다. 폴러가 멈추지 않았는지 확인하세요.`,
      tone: 'warn', waiting: false,
    };
  }

  // v2.548 리뷰 H1 — 중앙 직접 장비만 보고 판정하면 전부 위임된 현장에서 '장비가 없다' 고 오판한다. 엣지 행을 함께 본다.
  const c = edges?.counts || {};
  const edgeRows = num(edges?.rows?.length);
  const freshEdges = num(c.fresh);
  const sn = scanNote(poller.last.local);
  if (sn && sn.devices === 0 && !edgeRows) {
    return {
      kind: 'no-devices',
      text: '점검 대상 장비가 없습니다 — iDRAC 서버나 스토리지 장비가 이 노드에 등록되어 있는지 확인하세요.',
      tone: 'warn', waiting: false,
    };
  }
  // v2.603 EDGE2603-05: 중앙 설정으로 끈 엣지('off')는 원인을 안다 — '보고가 없다' 로 추측하지 않는다.
  const offEdges = num(c.off);
  if (sn && sn.devices === 0 && edgeRows && !freshEdges && offEdges >= edgeRows) {
    return {
      kind: 'edges-off',
      text: `중앙이 직접 수집하는 장비는 없고, 엣지 ${edgeRows}곳 **모두 중앙 설정에서 파트 장애 기능을 꺼 두었습니다**. 판정한 부품이 없으므로 **'장애 없음' 이 아니라 '점검 안 함'** 입니다. 켜려면 파트 장애 스위치를 확인하세요.`,
      tone: 'muted', waiting: false,
    };
  }
  if (sn && sn.devices === 0 && edgeRows && !freshEdges) {
    return {
      kind: 'edges-not-fresh',
      text: `중앙이 직접 수집하는 장비는 없고, 엣지 ${edgeRows}곳 **모두 정상 보고가 없습니다**(구버전·보고 없음·오래됨). 장애가 없는 것이 아니라 **아직 아무것도 판정하지 못한 것**입니다.`,
      tone: 'bad', waiting: false,
    };
  }
  if (sn && sn.ok === 0 && sn.devices > 0 && !freshEdges) {
    return {
      kind: 'all-failed',
      text: `등록된 ${sn.devices}대 **전부**에서 최신 수집 결과를 읽지 못했습니다. 장애가 없는 것이 아니라 **확인하지 못한 것**입니다.`,
      tone: 'bad', waiting: false,
    };
  }

  const extra = [];
  if (sn && sn.devices === 0 && freshEdges) extra.push('중앙 직접 수집 장비 없음(엣지 보고만 판정)');
  if (sn && sn.ok === 0 && sn.devices > 0 && freshEdges) extra.push(`중앙 직접 장비 ${sn.devices}대 전부 못 읽음`);
  if (sn?.failed) extra.push(`보지 못한 장비 ${sn.failed}대`);
  if (sn?.partial) extra.push(`일부 부품 종류를 못 읽은 서버 ${sn.partial}대`);
  if (sn?.unknown) extra.push(`상태를 읽지 못한 부품 ${sn.unknown}개`);
  if (num(c['old-version'])) extra.push(`구버전 엣지 ${num(c['old-version'])}곳`);
  if (num(c.legacy)) extra.push(`구 프로토콜 엣지 ${num(c.legacy)}곳`);
  if (num(c.silent)) extra.push(`보고가 없는 엣지 ${num(c.silent)}곳`);
  if (num(c.off)) extra.push(`중앙 설정으로 파트 장애를 끈 엣지 ${num(c.off)}곳`);
  if (num(c.stale)) extra.push(`보고가 오래된 엣지 ${num(c.stale)}곳`);
  if (num(c['unknown-version'])) extra.push(`버전 미상 엣지 ${num(c['unknown-version'])}곳`);
  if (extra.length) {
    return {
      kind: 'partial',
      text: `확인한 범위에서는 장애가 없습니다. 다만 ${extra.join(' · ')}가 있어 **'전부 정상' 이라고는 말할 수 없습니다**.`,
      tone: 'warn', waiting: false,
    };
  }
  return { kind: 'ok', text: '확인한 모든 부품이 정상입니다.', tone: 'ok', waiting: false };
}

/** 엣지 분류 라벨(v2.548). 서버 `classifyEdges` 의 kind 와 글자 그대로 짝이다. */
export const EDGE_KIND_LABEL = Object.freeze({
  fresh: '정상 보고', stale: '보고 오래됨', legacy: '구 프로토콜(v2.547)',
  'old-version': '구버전(보고 불가)', silent: '보고 없음', 'unknown-version': '버전 미상',
  off: '꺼짐(중앙 설정)',   // v2.603 EDGE2603-05 — 중앙이 이 엣지에 꺼짐을 내려보낸다(원인을 안다)
});
export const EDGE_KIND_TONE = Object.freeze({
  fresh: 'ok', stale: 'warn', legacy: 'warn', 'old-version': 'warn', silent: 'warn', 'unknown-version': 'muted', off: 'muted',
});

/**
 * 엣지 보고 현황 문구(v2.548). **보고가 없는 것을 '정상' 이라 말하지 않고 이유를 나눈다** —
 * 구버전(업그레이드해야 보인다) / 보고 없음(꺼져 있거나 첫 push 대기) / 오래됨(엣지 확인) / 구 프로토콜
 * (닫지 못한다 — 업그레이드). 조치가 전부 다르다.
 * @param {{rows:Array, counts:Object, minVersion:string}|null} edges
 * @returns {{text:string, tone:string, total:number, notFresh:number, counts:Object}}
 */
export function edgeNote(edges) {
  const rows = edges?.rows || [];
  const c = edges?.counts || {};
  const total = rows.length;
  if (!total) return { text: '엣지 위임 없음 — 이 노드가 직접 수집한 장비만 판정합니다.', tone: 'muted', total: 0, notFresh: 0, counts: c };
  const bits = [`엣지 ${total}곳 중 정상 보고 ${num(c.fresh)}곳`];
  if (num(c['old-version'])) bits.push(`**구버전 ${num(c['old-version'])}곳**(${edges.minVersion || ''} 미만 — 업그레이드 전까지 그 법인 부품은 보이지 않습니다)`);
  if (num(c.legacy)) bits.push(`구 프로토콜 ${num(c.legacy)}곳(장애는 보이지만 **해소를 판정하지 못합니다** — 업그레이드 필요)`);
  if (num(c.silent)) bits.push(`보고 없음 ${num(c.silent)}곳(꺼져 있거나 첫 push 대기 — '장애 없음' 이 아니라 '모름')`);
  if (num(c.off)) bits.push(`꺼짐 ${num(c.off)}곳(중앙 설정에서 파트 장애를 끔 — 그 법인 부품은 판정하지 않습니다)`);
  if (num(c.stale)) bits.push(`보고 오래됨 ${num(c.stale)}곳(그 장비의 장애를 해소로 처리하지 않습니다)`);
  if (num(c['unknown-version'])) bits.push(`버전 미상 ${num(c['unknown-version'])}곳`);
  const rejected = rows.reduce((a, r) => a + num(r.rejected), 0);
  if (rejected) bits.push(`**소유권 불일치로 버린 장비 ${rejected}대**(엣지가 자기 몫이 아닌 장비를 보고했습니다)`);
  // 중앙 수신 상한(v2.548 S2) — 잘린 장비는 '닫지 않는 쪽' 으로 보류된다. 조용히 줄이지 않는다.
  const partsOmitted = rows.reduce((a, r) => a + num(r.partsOmitted), 0);
  if (partsOmitted) bits.push(`**수신 상한으로 잘린 파트 ${partsOmitted}개**(그 장비의 장애는 해소로 처리하지 않습니다 — 엣지 보고가 비정상적으로 큽니다)`);
  const scannedDropped = rows.filter((r) => r.scannedDropped).length;
  if (scannedDropped) bits.push(`요약(scanned)이 너무 커서 버린 엣지 ${scannedDropped}곳`);
  // v2.603: 중앙이 일부러 끈 엣지는 '주의' 대상이 아니다(조치할 것이 없다) — 개수는 위 문구가 밝힌다.
  const notFresh = total - num(c.fresh) - num(c.off);
  return { text: bits.join(' · '), tone: notFresh ? 'warn' : 'ok', total, notFresh, counts: c };
}

/** 장비 식별자 등급 안내(v2.548 F2). localId(IP)만 밝힌다 — 나머지는 조용하다. */
export function deviceKeyNote(deviceKeyKind, notes = {}) {
  if (!deviceKeyKind || deviceKeyKind === 'serviceTag' || deviceKeyKind === 'uuid' || deviceKeyKind === 'centralId') return '';
  return notes[deviceKeyKind] || '';
}

/**
 * 행 안의 **짧은 표지**(각주와 짝) — 조용한 등급이면 빈 문자열. `none` 은 '식별 불가 식별' 처럼 겹말이 되므로
 * '그룹 단위' 라고 말한다(v2.548 Chromium 판독에서 실제로 그렇게 찍혔다).
 */
export function keyKindMark(keyKind, labels = {}) {
  if (!keyKindNote(keyKind, { [keyKind]: 'x' })) return '';
  if (keyKind === 'none') return '⚠ 그룹 단위';
  return `⚠ ${labels[keyKind] || keyKind} 식별`;
}
export function deviceKeyMark(deviceKeyKind, labels = {}) {
  if (!deviceKeyNote(deviceKeyKind, { [deviceKeyKind]: 'x' })) return '';
  return `⚠ ${labels[deviceKeyKind] || deviceKeyKind} 식별`;
}

/**
 * 열린 장애 표 **아래 각주**(v2.548 Chromium 400px 판독): 행마다 긴 식별 안내를 되풀이하면 400px 에서
 * 장비 셀이 세로로 길어지고 1440px 에서는 같은 문단이 화면을 덮는다(v2.509 규약). 표시된 행에 실제로
 * 해당하는 안내만 **한 번씩** 모은다 — 행에는 짧은 표지(`⚠ 로컬 id 식별`)만 남긴다.
 * @returns {string[]} 중복 제거된 안내 문구(없으면 빈 배열)
 */
export function tableFootnotes(rows, labels = {}) {
  const out = [];
  const seen = new Set();
  for (const p of rows || []) {
    for (const t of [deviceKeyNote(p.deviceKeyKind, labels.deviceKeyKindNote), keyKindNote(p.keyKind, labels.keyKindNote)]) {
      if (t && !seen.has(t)) { seen.add(t); out.push(t); }
    }
  }
  return out;
}

/** 키 체계 변경으로 이력을 새로 시작한 사실(v2.548 스키마 v2). 없으면 빈 문자열. */
export function resetNote(reset) {
  if (!reset || !reset.at) return '';
  const d = new Date(reset.at).toLocaleString('ko-KR');
  return `${d} 에 **파트 키 체계가 바뀌어 이력을 새로 시작했습니다**(스키마 ${reset.from ?? '?'}→${reset.to ?? '?'}). 그 전 이력은 이어 붙이지 않습니다 — 법인 축이 없던 키라 다른 법인 장비와 섞였을 수 있습니다.`;
}

/**
 * 엣지 노드의 push 상태 문구(v2.548). 왜 안 보내는지를 **각각** 말한다 — 토큰 없음 / 꺼짐 / 중앙 거부(403) /
 * 본문 거부(413) / 첫 push 대기 / 정상. 한 문구로 덮으면 조치가 정반대인 상황이 같아 보인다.
 * @returns {{text:string, tone:string, kind:string}}
 */
export function pushNote(push, now = Date.now()) {
  if (!push) return { text: '', tone: 'muted', kind: 'none' };
  if (!push.configured) return { text: 'CENTRAL_URL/CENTRAL_TOKEN 이 없어 중앙으로 보내지 않습니다.', tone: 'warn', kind: 'unconfigured' };
  if (!push.enabled) return { text: `파트 장애 기능이 **꺼져 있습니다**(${push.source === 'env' ? '이 엣지의 PARTFAULT_ENABLED' : push.source === 'edge-central' ? '중앙 설정' : '기본값 — 중앙 설정이 아직 내려오지 않았습니다'}). 켜지면 다음 주기부터 보냅니다.`, tone: 'warn', kind: 'disabled' };
  const l = push.last;
  if (!l) return { text: '첫 push 대기 중입니다(기동 직후).', tone: 'muted', kind: 'first' };
  if (l.skipped) return { text: `직전 주기는 건너뛰었습니다 — ${l.reason || ''}`, tone: 'warn', kind: 'skipped' };
  // v2.548 리뷰 H6 — 중앙이 응답에 실어 준 스위치 상태. 보냈는데 중앙이 꺼져 있으면 기록·알림이 되지 않는다.
  if (l.ok && l.centralEnabled === false) return { text: `마지막 push ${ageText(now - num(l.at))} · 장비 ${num(l.devices)}대 · 열린 장애 ${num(l.open)}건 — 그런데 **중앙의 파트 장애 기능이 꺼져 있어** 보낸 판정이 기록·알림되지 않습니다. 중앙 설정을 확인하세요.`, tone: 'warn', kind: 'central-off' };
  if (l.ok) return { text: `마지막 push ${ageText(now - num(l.at))} · 장비 ${num(l.devices)}대 · 열린 장애 ${num(l.open)}건${l.omitted ? ` · **상한으로 ${l.omitted}대 제외**` : ''}${l.rejected ? ` · **중앙이 소유권 불일치로 버린 장비 ${l.rejected}대**` : ''}`, tone: 'ok', kind: 'ok' };
  if (l.httpStatus === 403) return { text: `중앙이 이 엣지를 **거부했습니다(403)** — AGENT_NAME 과 중앙의 수집 서버 이름·토큰이 맞는지 확인하세요. (${l.error || ''})`, tone: 'bad', kind: 'rejected' };
  if (l.httpStatus === 413) return { text: `중앙이 **본문 크기를 거부했습니다(413)** — 중앙의 BIG_JSON 등록 또는 상한 설정을 확인하세요.`, tone: 'bad', kind: 'too-large' };
  return { text: `마지막 push 실패(${ageText(now - num(l.at))}) — ${l.error || '사유 없음'}`, tone: 'bad', kind: 'error' };
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
    'collection-failed': '판정 보류 — 이 부품 종류만 수집 실패',   // v2.548 F1: 장비엔 닿았는데 그 컬렉션 GET 만 실패
    missing: '판정 보류 — 이번 목록에 없음',
    unassigned: '판정 보류 — 이 수집 서버가 더는 이 장비를 보고하지 않음(재배정·등록 삭제?)',   // v2.548 C5
    'no-report': '판정 보류 — 이 수집 서버의 보고가 없음',
    'edge-stale': '판정 보류 — 이 수집 서버의 보고가 오래됨(엣지 상태를 확인하세요)',            // v2.548 H7
    'edge-legacy': '판정 보류 — 구버전 수집 서버(해소를 판정할 수 없음 — 업그레이드 필요)',
  };
  return map[holdReason] || '';
}

/**
 * 보류 건수 요약(배너 1회). **'해소로 처리하지 않았다' 는 사실을 여기서 한 번 말한다.**
 * @returns {string} 보류가 없으면 빈 문자열
 */
export function holdNote(open = []) {
  const by = { unknown: 0, 'device-failed': 0, 'collection-failed': 0, missing: 0, unassigned: 0, 'no-report': 0, 'edge-stale': 0, 'edge-legacy': 0 };
  for (const p of open) if (by[p?.holdReason] != null) by[p.holdReason] += 1;
  const total = Object.values(by).reduce((a, b) => a + b, 0);
  if (!total) return '';
  const bits = [];
  if (by['device-failed']) bits.push(`이 장비 수집 실패 ${by['device-failed']}건`);
  if (by['collection-failed']) bits.push(`부품 종류 수집 실패 ${by['collection-failed']}건`);
  if (by.unknown) bits.push(`상태를 읽지 못함 ${by.unknown}건`);
  if (by.missing) bits.push(`이번 목록에 없음 ${by.missing}건`);
  if (by['no-report']) bits.push(`수집 서버 보고 없음 ${by['no-report']}건`);
  if (by['edge-stale']) bits.push(`수집 서버 보고 오래됨 ${by['edge-stale']}건`);
  if (by['edge-legacy']) bits.push(`구버전 수집 서버 ${by['edge-legacy']}건(업그레이드 전까지 해소 판정 불가)`);
  // v2.548 C5 — 재배정·등록 삭제된 장비는 스스로 닫히지 않는다. 관리자가 사유를 적어 닫는 길을 알린다.
  if (by.unassigned) bits.push(`**수집 서버가 더는 보고하지 않는 장비 ${by.unassigned}건**(재배정·삭제했다면 관리자가 행의 '닫기' 로 정리하세요)`);
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
    // v2.612 LEFT2612-04: 장비 식별 키가 바뀌어(HPE 서비스태그 교정 등) 새 키 행으로 옮겨진 것 — 고쳐진 것이 아니다.
    if (ev.closeReason === 'key-migrated') return `**식별 키 변경**으로 새 행으로 옮김(부품이 고쳐졌다는 뜻이 아닙니다) — 직전 ${st(ev.prevState)}`;
    if (ev.closeReason === 'manual') return `관리자가 **수동으로 닫음**(재배정·등록 삭제 등 — 장비가 고쳐졌다는 뜻이 아닙니다) — 직전 ${st(ev.prevState)}`;
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

/**
 * 이력 탭이 비었을 때의 문구(v2.598 WEBUI-2598-03).
 * '변화가 없었다' 는 **점검이 돌았을 때만** 참이다 — 한 번도 점검하지 않았거나 마지막 점검이 조회 기간
 * 이전이면 그 문장은 거짓이다(기록이 없는 이유가 '변화 없음' 이 아니라 '보지 않았음' 이다).
 * ⚠ `poller.last` 는 인메모리라 재시작 뒤 비어 있을 수 있다 — 그래서 DB 에 남은 부품 상태(`db.openParts`)
 *   ·전이(`db.rows`)가 있으면 '한 번도 안 했다' 고 단정하지 않는다.
 * @returns {{kind:'never'|'before'|'nochange', text:string}}
 */
export function historyEmptyText({ poller = null, db = null, days = 30, now = Date.now() } = {}) {
  const lastAt = poller?.last?.at == null ? null : Number(poller.last.at);
  const hasDbTrace = Number(db?.openParts) > 0 || Number(db?.rows) > 0;
  if ((lastAt == null || !Number.isFinite(lastAt)) && !hasDbTrace) {
    return {
      kind: 'never',
      text: poller && poller.enabled === false
        ? '아직 점검이 한 번도 실행되지 않아 **이력이 없습니다**(자동 점검 꺼짐) — 변화가 없었다는 뜻이 아닙니다. **지금 점검**을 누르거나 자동 점검을 켜세요.'
        : '아직 점검이 한 번도 실행되지 않아 **이력이 없습니다** — 변화가 없었다는 뜻이 아닙니다. **지금 점검**을 누르거나 첫 주기를 기다리세요.',
    };
  }
  const from = now - Number(days) * 86_400_000;
  if (lastAt != null && Number.isFinite(lastAt) && lastAt < from) {
    return {
      kind: 'before',
      text: `마지막 점검(${ageText(now - lastAt)})이 조회 기간(최근 ${days}일) **이전**입니다 — 이 기간에는 점검이 돌지 않아 기록이 없습니다(변화가 없었다는 뜻이 아닙니다).`,
    };
  }
  return {
    kind: 'nochange',
    text: '이 기간에 기록된 전이가 없습니다. 이력은 **상태가 바뀐 순간만** 남기므로, 기록이 없다는 것은 그동안 변화가 없었다는 뜻입니다.',
  };
}

/** KPI 수치 — 요약이 없으면 '—'(0 으로 채우지 않는다). v2.598 WEBUI-2598-06 */
export function kpiValue(summary, key) {
  const v = summary?.[key];
  return v == null || !Number.isFinite(Number(v)) ? '—' : Number(v);
}

/** KPI 강조색 — 0·결측은 경고색을 쓰지 않는다(숫자는 '문제 없음' 인데 색이 '문제 있음' 이라 말하지 않게). */
export function kpiAccent(value, color) {
  return typeof value === 'number' && value > 0 ? color : undefined;
}
