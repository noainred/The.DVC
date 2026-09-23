/**
 * views/tools/bmUsageText.js — 베어메탈 사용률 화면의 **판정과 문구**(순수, v2.550).
 *
 * 사용자 요청(2026-09-17): "여기에 분류된 서버들만 CPU memory disk Network HBA 사용율을 수집하고 싶어".
 * 선택: iDRAC + OS SSH 둘 다 · 법인 단위로 켠다 · 5분·원시 90일+일롤업 5년 · Linux + Windows.
 *
 * ── 이 화면이 만들 수 있는 거짓 6가지 — 전부 여기서 막는다 ────────────────────
 *  ① **`null` 을 0 으로 그리지 않는다.** `CPU 0%` 는 '부하 없음' 이라는 뜻이고, 못 읽은 것과
 *     완전히 다르다. 값이 없으면 `—` 다.
 *  ② **첫 주기가 비는 것은 이상이 아니다.** Linux 는 누적 카운터의 차이가 필요해 CPU·디스크·
 *     네트워크·HBA 가 첫 주기에 `null` 이다(메모리·디스크 사용공간은 순간값이라 바로 나온다).
 *     Windows 는 `Win32_PerfFormattedData_*` 가 순간값이라 첫 주기부터 나온다 — **그 차이를 말한다.**
 *  ③ **'대상이 아니다' 를 한 문구로 덮지 않는다** — 법인 미선택·엣지 위임·iDRAC 없음·OS 계정 없음은
 *     조치가 전부 다르다(v2.517 `perfDiagText` 와 같은 판단).
 *  ④ **속도를 모르는 회선의 사용률(%)을 지어내지 않는다** — 처리량만 보여주고 그 사실을 적는다.
 *  ⑤ **'없는 것' 과 '못 읽은 것' 을 구분한다** — FC HBA 가 없는 서버를 '확인 불가' 로 세면
 *     사용자가 멀쩡한 서버의 드라이버를 의심한다.
 *  ⑥ **어느 경로에서 온 값인지 밝힌다** — 같은 서버의 CPU 를 OS 와 iDRAC 이 다르게 말할 수 있다.
 *
 * ⚠ 주기·보존 **숫자를 문구에 박지 말 것** — 서버가 주는 `settings`·`status` 값만 쓴다.
 */

import { agoText as _ago, elapsedText as _elapsed } from './relTime.js';
import { numOrNull } from '../../numOrNull.js';
const t = (v) => String(v ?? '').trim();
/** ⚠ `v == null` 을 **먼저** 본다 — `Number(null)===0`·`Number('')===0` 이라 결측이 0 으로 둔갑한다. */
const n = numOrNull;   // v2.576: 사본 금지 — 코어는 하나다(사본은 Number([])===0 을 막지 못했다)

/** 퍼센트 표시. 값이 없으면 단위를 붙이지 않는다(`— %` 는 0% 처럼 읽힌다 — v2.534 규약). */
export function pctText(v) {
  const x = n(v);
  return x == null ? '—' : `${Math.round(x * 10) / 10}%`;
}

/** 처리량 — 크기에 따라 단위를 고른다(TB 로 굳히면 작은 값이 0.00 으로 보인다 — v2.540 규약). */
export function bpsText(v) {
  const x = n(v);
  if (x == null) return '—';
  if (x < 1024) return `${Math.round(x)} B/s`;
  if (x < 1024 ** 2) return `${(x / 1024).toFixed(1)} KB/s`;
  if (x < 1024 ** 3) return `${(x / 1024 ** 2).toFixed(1)} MB/s`;
  return `${(x / 1024 ** 3).toFixed(2)} GB/s`;
}

/**
 * ⚠ v2.574 IMP-03 — 문구는 **공용 코어 `relTime.js`** 가 소유한다. 아래는 호출부 호환을 위한
 *   위임 껍데기다. v2.573 까지 9벌이 각자 구현이었고 **실제로 갈라져 있었다**
 *   (90초 → `2분 전` 7벌 vs `1분 전` 2벌 · 결측 `—` 6벌 / `null` 2벌 / `없음` 1벌).
 *   ⚠ 새 상대시각 문구를 만들지 말 것 — `agoText`(타임스탬프)·`elapsedText`(경과 ms) 를 쓴다.
 */
export const ageText = (ts, now = Date.now()) => _ago(ts, now, { subMinute: 'seconds' });

/** 임계 색 — 사용률 공통 기준(75/90, V4 규약과 같은 값). 값이 없으면 회색이다(빨강 아니다). */
export function usageTone(v) {
  const x = n(v);
  if (x == null) return 'idle';
  if (x >= 90) return 'bad';
  if (x >= 75) return 'warn';
  return 'ok';
}
export function toneVar(tone) {
  if (tone === 'ok') return 'var(--ok, #4ade80)';
  if (tone === 'warn') return 'var(--warn, #fbbf24)';
  if (tone === 'bad') return 'var(--bad, #f87171)';
  return 'var(--muted, #94a3b8)';
}

/** 값의 출처 표지 — 짧게. 행마다 긴 문장을 넣으면 셀이 세로로 길어진다(v2.509 규약). */
export const SRC_MARK = Object.freeze({
  os: 'OS', idrac: 'iDRAC', 'idrac+os': 'OS·iDRAC', 'os+idrac': 'OS·iDRAC',
  // v2.554 — Enterprise 대체 경로. **텔레메트리와 구분해 표시한다**(측정 방식이 다르다).
  'idrac-ent': 'iDRAC(대체)', 'idrac-ent+os': 'OS·iDRAC(대체)', 'idrac+idrac-ent': 'iDRAC·대체',
});
export function srcMark(src) {
  const s = t(src);
  if (!s) return '';
  return SRC_MARK[s] || s.split('+').map((x) => SRC_MARK[x] || x).join('·');
}

/**
 * 빈 화면 판정. ⚠ **행동이 정반대인 상황을 한 문구로 덮지 않는다**(v2.517 규약).
 * @returns {{kind:string, text:string, waiting:boolean}} `waiting` = '기다리면 채워지는가'
 */
export function emptyDiag(d = {}, { now = Date.now() } = {}) {
  const st = d.status || {};
  const counts = d.counts || {};
  const corps = Object.keys((d.settings || {}).corps || {}).length;
  if (!d.enabled) {
    return { kind: 'off', waiting: false, text: '베어메탈 사용률 수집이 **꺼져 있습니다**. 아래 설정에서 켜고 수집할 법인을 고르세요 — 켜야 쌓이기 시작합니다.' };
  }
  if (!corps && !(d.settings || {}).includeUnassigned) {
    return { kind: 'no-corp', waiting: false, text: '수집할 **법인을 아직 고르지 않았습니다**. 법인을 하나 이상 켜야 대상이 생깁니다(기본은 전부 꺼짐 — 한꺼번에 켜면 주기마다 세션이 수백 개 열립니다).' };
  }
  if (!(d.targets || []).length) {
    const by = d.skippedCounts || {};
    const parts = [];
    if (by['edge-delegated']) parts.push(`엣지가 수집하는 서버 **${by['edge-delegated']}대**(그 엣지 화면에서 보입니다)`);
    if (by['corp-off']) parts.push(`켜지 않은 법인 **${by['corp-off']}대**`);
    if (by.unassigned) parts.push(`법인 귀속이 없는 서버 **${by.unassigned}대**`);
    if (by['no-idrac']) parts.push(`iDRAC 등록이 없는 서버 **${by['no-idrac']}대**`);
    if (by['no-os-cred']) parts.push(`OS 계정이 없는 서버 **${by['no-os-cred']}대**`);
    if (by['no-idrac-cred']) parts.push(`iDRAC 계정이 없는 서버 **${by['no-idrac-cred']}대**`);
    return {
      kind: 'no-target', waiting: false,
      text: parts.length
        ? `수집할 수 있는 서버가 없습니다 — ${parts.join(' · ')}. 아래 '대상이 아닌 서버' 를 펼쳐 사유별로 확인하세요.`
        : '베어메탈로 분류된 서버가 없습니다(서버 분석 › 구분 › Baremetal 과 같은 기준입니다).',
    };
  }
  if (d.db && d.db.available === false) {
    return { kind: 'no-db', waiting: false, text: '이 서버의 Node 가 **SQLite 를 지원하지 않아** 추이를 저장할 수 없습니다. 최신값은 보이지만 이력은 쌓이지 않습니다.' };
  }
  if (!(d.rows || []).length) {
    const last = n(st.last?.at);
    if (!last) return { kind: 'first', waiting: true, text: '아직 한 번도 수집하지 않았습니다 — 첫 주기를 **기다리면** 채워집니다. 지금 보려면 \'지금 수집\' 을 누르세요.' };
    if (st.last?.error) return { kind: 'failed', waiting: false, text: `마지막 수집이 실패했습니다 — ${t(st.last.error)}` };
    return { kind: 'no-value', waiting: true, text: `${ageText(last, now)} 수집했지만 저장된 값이 없습니다 — 아래 작업 로그에서 서버별 사유를 보세요.` };
  }
  // 값은 있는데 자동 수집이 오래 멈춰 있으면 초록 '정상' 을 두지 않는다(v2.548 `stale-check` 규약).
  const last = n(st.last?.at);
  if (last && n(st.intervalMs) && now - last > n(st.intervalMs) * 3) {
    return { kind: 'stale', waiting: false, text: `마지막 수집이 **${ageText(last, now)}** 입니다 — 주기의 3배를 넘겼습니다. 아래 작업 로그를 확인하세요.` };
  }
  return { kind: 'ok', waiting: false, text: '' };
}

/** 첫 주기 안내 — Linux 와 Windows 의 차이를 말한다. 해당 없으면 빈 문자열. */
export function firstSampleNote(rows = []) {
  const blanks = rows.filter((r) => n(r.cpu_pct) == null && n(r.mem_pct) != null).length;
  if (!blanks) return '';
  return `**${blanks}대**는 메모리만 값이 있고 CPU·디스크·네트워크·HBA 가 비어 있습니다 — Linux 는 누적 카운터의 **차이**가 필요해 **첫 주기에는 나오지 않습니다**(다음 주기부터 채워집니다). Windows 는 순간값이라 첫 주기부터 나옵니다.`;
}

/**
 * 행에 붙이는 **짧은** 누락 표지. ⚠ 행마다 긴 문장을 넣으면 셀이 세로로 길어지고 같은 문단이
 * 화면을 덮는다(v2.509 규약) — 조치는 `missingFootnotes` 가 표 아래에서 **한 번만** 말한다.
 */
export const MISSING_MARK = Object.freeze({
  'no-os-cred': 'OS 계정 없음',
  'no-idrac': 'iDRAC 등록 없음',
  'no-idrac-cred': 'iDRAC 계정 없음',
});
export function missingMark(list = []) {
  const parts = (list || []).map((k) => MISSING_MARK[k] || k);
  return parts.length ? parts.join(' · ') : '';
}

/**
 * 표 아래 각주 — **표에 실제로 있는 누락 종류만** 한 번씩. 없으면 빈 배열이다.
 * 이것이 없으면 전부 `—` 인 행을 보고 사용자가 '수집이 고장났다' 고 읽는다.
 */
export function missingFootnotes(rows = []) {
  const kinds = new Set();
  for (const r of rows) for (const k of (r.missing || [])) kinds.add(k);
  const out = [];
  if (kinds.has('no-os-cred')) out.push('**OS 계정 없음** — 그 서버는 CPU·메모리만(iDRAC 텔레메트리) 읽습니다. 디스크·네트워크·HBA 를 보려면 설정 › 베어메탈 스토리지에 그 호스트를 등록하세요(같은 계정을 두 번 등록하지 않도록 그 등록부를 재사용합니다).');
  if (kinds.has('no-idrac')) out.push('**iDRAC 등록 없음** — 수동 태그로 베어메탈이 된 ESXi 호스트일 수 있습니다. OS 계정만 있으면 다섯 지표를 모두 읽습니다.');
  if (kinds.has('no-idrac-cred')) out.push('**iDRAC 계정 없음** — 설정 › iDRAC 등록에서 계정·비밀번호를 채우세요.');
  return out;
}

/** 대상이 아닌 서버 — 사유마다 조치가 다르므로 **있는 사유만** 한 번씩 적는다. */
export function skippedNotes(counts = {}, reasons = {}) {
  const out = [];
  for (const [kind, cnt] of Object.entries(counts)) {
    if (!cnt) continue;
    out.push(`**${kind === 'edge-delegated' ? '엣지 수집' : kind === 'corp-off' ? '법인 미선택' : kind === 'unassigned' ? '법인 귀속 없음' : kind === 'no-idrac' ? 'iDRAC 등록 없음' : kind === 'no-idrac-cred' ? 'iDRAC 계정 없음' : kind === 'no-os-cred' ? 'OS 계정 없음' : kind === 'both-off' ? '두 경로 모두 꺼짐' : kind} ${cnt}대** — ${t(reasons[kind]) || '사유 미상'}`);
  }
  return out;
}

/** 한 서버의 상세 안내 — '무엇을 읽었고 무엇을 못 읽었나'. */
export function detailNotes(detail = {}) {
  const out = [];
  const kind = t(detail.osKind);
  if (kind) out.push(`OS 경로: **${kind === 'windows' ? 'Windows(PowerShell)' : 'Linux(/proc)'}** · 읽음 ${(detail.osRead || []).join('·') || '없음'}`);
  if ((detail.osMissing || []).length) out.push(`**읽지 못한 항목**: ${detail.osMissing.join('·')} — 권한이나 명령 부재일 수 있습니다.`);
  // ⚠ '없는 것' 을 '못 읽은 것' 이라 말하지 않는다. 다만 원인을 단정하지도 않는다.
  if ((detail.osAbsent || []).length) {
    const has = (x) => detail.osAbsent.includes(x);
    if (has('hba')) out.push('**FC HBA 가 없습니다**(또는 드라이버가 올라오지 않았습니다) — 이상이 아니라 그 서버에 해당 항목이 없는 것입니다.');
    if (has('diskspace')) out.push('디스크 **사용 공간**은 측정할 마운트를 등록해야 나옵니다(설정 › 베어메탈 스토리지).');
  }
  if (t(detail.osError)) out.push(`OS 수집 실패: ${t(detail.osError)}`);
  if (t(detail.idracKind)) {
    const k = t(detail.idracKind);
    out.push(k === 'no-telemetry' ? telemetryMissingText(detail)
      : k === 'auth' ? 'iDRAC 계정·비밀번호를 확인하세요(반복 시도해도 결과는 같습니다).'
        // v2.591(감사 R-BM2): 403 은 자격증명 거부가 아니다 — 로그인은 됐고 그 리포트가 허락되지 않았다.
        : k === 'forbidden' ? 'iDRAC 이 텔레메트리 조회를 **거부했습니다(403)** — 라이선스(Datacenter)나 계정 권한 문제일 수 있습니다. 비밀번호 문제가 아니므로 주기 수집을 멈추지 않습니다.'
        : k === 'empty-report' ? 'iDRAC 텔레메트리 리포트가 비어 있습니다 — 텔레메트리가 켜져 있지 않을 수 있습니다.'
          : k === 'ids-unmatched' ? `iDRAC 응답에서 **아는 메트릭 id 를 찾지 못했습니다** — 이 환경의 id 를 확인해야 합니다${(detail.idracSeenIds || []).length ? `(응답 id ${detail.idracSeenIds.length}개)` : ''}.`
            : `iDRAC 수집 실패: ${t(detail.idracError)}`);
  }
  if (detail.idracUsedIds && Object.keys(detail.idracUsedIds).length) {
    out.push(`iDRAC 이 쓴 메트릭 id: ${Object.entries(detail.idracUsedIds).map(([k, v]) => `${k}=${v}`).join(' · ')} — **이 id 는 이 환경에서 확인한 값입니다**(추정이 아닙니다).`);
  }
  const noSpeed = (detail.interfaces || []).filter((x) => n(x.bps ?? x.bytesPerSec) != null && n(x.bitsPerSec) == null);
  if (noSpeed.length) out.push(`**링크 속도를 읽지 못한 인터페이스 ${noSpeed.length}개** — 그 회선의 사용률(%)은 내지 않고 처리량만 보여줍니다.`);
  const fcNoSpeed = (detail.fc || []).filter((x) => n(x.bps) != null && !n(x.pct));
  if (fcNoSpeed.length) out.push(`**속도를 읽지 못한 FC 포트 ${fcNoSpeed.length}개** — 사용률(%) 대신 처리량만 보여줍니다.`);
  return out;
}

/**
 * 인증 실패로 **주기 수집이 정지된** 대상 안내. ⚠ 이것이 없으면 '조용한 정지' 가 된다 —
 * 사용자는 수집되는 줄 알고 값이 낡아 가는 것을 못 본다(v2.528 규약: "말없이 멈추면 사용자는
 * '수집되는 줄' 안다 — 이 기능이 만들 수 있는 최악의 거짓이다").
 * 정지 대상이 없으면 **문구를 만들지 않는다**.
 */
export function authStopNote(stops = [], { now = Date.now() } = {}) {
  const list = Array.isArray(stops) ? stops : [];
  if (!list.length) return '';
  const names = list.slice(0, 4).map((x) => t(x.name) || t(x.key)).filter(Boolean);
  const more = list.length > names.length ? ` 외 ${list.length - names.length}대` : '';
  const oldest = list.map((x) => n(x.since)).filter((v) => v != null).sort((a, b) => a - b)[0];
  return `**${list.length}대는 인증 실패로 주기 수집이 정지됐습니다**(${names.join(' · ')}${more})`
    + `${oldest ? ` — 가장 오래된 정지는 ${ageText(oldest, now)}입니다` : ''}.`
    + ' 반복 시도는 결과가 같고 **계정만 잠급니다** — 비밀번호를 고치면 자동으로 재개합니다.'
    + " '지금 수집' 은 정지와 무관하게 동작하니 고친 뒤 눌러 확인하세요 — 같은 계정으로 성공하면 정지가 풀립니다(iDRAC 은 주 전력 수집의 정지도 함께 풀립니다).";
}

/**
 * **키 충돌** 안내(v2.550.3). ⚠ 조용히 두면 안 되는 종류다 — DB 기본키가 `(agent, key, ts)` 라
 * 두 서버가 같은 키를 쓰면 **한쪽의 사용률이 다른 서버 값으로 보이고 오류는 나지 않는다**
 * (v2.548 F2 와 같은 유형). 대상에서 빼지 않는 이유도 함께 말한다(어느 쪽을 버릴지 알 수 없다).
 * 충돌이 없으면 **문구를 만들지 않는다**.
 */
export function keyConflictNote(list = []) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return '';
  const shown = arr.slice(0, 3).map((x) => `${t(x.key)}(${(x.names || []).join(' · ')})`);
  const more = arr.length > shown.length ? ` 외 ${arr.length - shown.length}건` : '';
  return `**식별 키가 겹치는 서버 ${arr.length}건**이 있습니다 — ${shown.join(' / ')}${more}.`
    + ' 같은 키를 쓰면 **한 서버의 값이 다른 서버 것으로 보입니다**(추이가 섞입니다).'
    + ' 서비스태그가 비어 있어 이름·내부 id 로 키가 정해진 경우가 대부분이니'
    + ' 설정 › iDRAC 등록에서 **서비스태그를 채우면** 해결됩니다.'
    + ' 어느 쪽을 버릴지 판단할 근거가 없어 **수집에서 빼지는 않았습니다**.';
}

/** 보존·행 수 안내 — 서버가 준 값으로만 만든다(숫자를 박지 않는다). */
export function retentionNote(settings = {}, db = {}) {
  const raw = n(settings.rawRetentionDays);
  const daily = n(settings.dailyRetentionDays);
  if (raw == null || daily == null) return '';
  const years = Math.round((daily / 365) * 10) / 10;
  const rows = n(db.rawRows);
  return `원시 표본은 **${raw}일**, 하루 단위 롤업은 **${years}년** 보관합니다(롤업은 평균과 **최대**를 함께 둡니다 — 평균만 두면 피크가 사라집니다).${rows != null ? ` 현재 원시 ${rows.toLocaleString()}행.` : ''}`;
}

/** 엣지 노드에서 본 화면 — 자기 것만 수집한다는 사실을 말한다. */
export function edgeNote(isEdge) {
  if (!isEdge) return '';
  return '이 포탈은 **엣지**입니다 — 자기 법인의 베어메탈만 수집하고, 중앙은 중앙이 직접 닿는 서버만 수집합니다(같은 서버를 두 곳에서 찌르지 않습니다).';
}

/* ══════════════ v2.551 개선 — 집계·상위 N·CSV ══════════════════════════════ */

/**
 * `deviceFacets.facetState` 가 읽는 축(`datacenterId`·`type`)을 베어메탈 행에 붙인다.
 * ⚠ **공용 모듈을 고치지 않는다** — 그 모듈은 스토리지·증가량 화면이 함께 쓰므로(v2.533
 *   '코어는 하나다') 축 이름을 바꾸면 그쪽이 깨진다. 이 쪽에서 맞춰 준다.
 * 종류 축은 **수집 경로**다 — 'OS 계정이 있는 서버만 보기' 가 되어 실제로 쓸모가 있다.
 */
export function facetRows(rows = []) {
  return (rows || []).map((r) => ({
    ...r,
    datacenterId: t(r.vcenterId) || '',
    type: (r.paths || []).includes('os') ? (((r.paths || []).length > 1) ? 'idrac+os' : 'os') : 'idrac',
  }));
}
export const PATH_LABEL = Object.freeze({ 'idrac+os': 'iDRAC·OS', os: 'OS 만', idrac: 'iDRAC 만' });
export function pathTypeLabel(x) { return PATH_LABEL[t(x)] || t(x) || '미상'; }

/**
 * **가장 바쁜 서버 상위 N**. ⚠ 값이 없는 서버를 0 으로 세어 목록 끝에 넣지 않는다 —
 * 아예 **제외하고 개수를 밝힌다**(0% 로 줄 세우면 '한가한 서버' 라는 거짓이 된다).
 * @returns {{list:Array, excluded:number, metric:string}}
 */
export function topBusiest(rows = [], { metric = 'cpu_pct', limit = 5 } = {}) {
  const withVal = [];
  let excluded = 0;
  for (const r of rows || []) {
    const v = n(r[metric]);
    if (v == null) { excluded += 1; continue; }
    withVal.push({ ...r, _v: v });
  }
  withVal.sort((a, b) => b._v - a._v || String(a.name).localeCompare(String(b.name), 'ko'));
  return { list: withVal.slice(0, Math.max(1, limit)), excluded, metric };
}

/**
 * 법인별 집계. ⚠ **`null` 을 분모에 넣지 않는다** — 넣으면 '못 읽은 서버' 가 평균을 끌어내린다
 * (v2.550 DB 롤업과 같은 규칙). 읽은 대수(`n`)를 함께 내 화면이 '몇 대 기준' 인지 말할 수 있게 한다.
 */
export function corpSummary(rows = [], { metric = 'cpu_pct' } = {}) {
  const by = new Map();
  for (const r of rows || []) {
    const k = t(r.vcenterId) || '(귀속 없음)';
    const cur = by.get(k) || { vcenterId: k, servers: 0, n: 0, sum: 0, max: null, over90: 0 };
    cur.servers += 1;
    const v = n(r[metric]);
    if (v != null) {
      cur.n += 1; cur.sum += v;
      if (cur.max == null || v > cur.max) cur.max = v;
      if (v >= 90) cur.over90 += 1;
    }
    by.set(k, cur);
  }
  return [...by.values()].map((x) => ({
    ...x,
    // ⚠ 읽은 대수가 0 이면 평균은 **null** 이다(0 이 아니다).
    avg: x.n > 0 ? Math.round((x.sum / x.n) * 10) / 10 : null,
    unread: x.servers - x.n,
  })).sort((a, b) => (b.max ?? -1) - (a.max ?? -1) || a.vcenterId.localeCompare(b.vcenterId, 'ko'));
}

/** CSV 열 — 화면 표와 **같은 순서**를 쓴다(내보낸 파일이 화면과 달라 보이면 안 된다). */
export const CSV_COLS = Object.freeze([
  ['server', '서버'], ['serviceTag', '서비스태그'], ['vcenterId', '법인'], ['model', '모델'],
  ['paths', '수집경로'], ['src', '값출처'],
  ['cpu_pct', 'CPU(%)'], ['mem_pct', '메모리(%)'], ['disk_busy_pct', '디스크I/O(%)'],
  ['disk_used_pct', '디스크공간(%)'], ['net_pct', '네트워크(%)'], ['net_bps', '네트워크(B/s)'],
  ['hba_pct', 'HBA(%)'], ['hba_bps', 'HBA(B/s)'], ['io_pct', 'iDRAC_IO(%)'],
  ['collectedAt', '수집시각(KST)'], ['missing', '누락'],
]);

/**
 * CSV 본문. ⚠ **값이 없으면 빈 칸이다 — 0 을 쓰지 않는다**(엑셀에서 0 은 '부하 없음' 으로 읽힌다).
 * ⚠ 자격증명·호스트 주소는 담지 않는다(응답에 이미 없지만 열 정의에서도 배제한다).
 */
export function csvOf(rows = []) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const cell = (r, key) => {
    if (key === 'server') return t(r.name);
    if (key === 'paths') return (r.paths || []).map((p) => (p === 'os' ? 'OS' : 'iDRAC')).join('+');
    if (key === 'src') return t(r.src);
    if (key === 'missing') return (r.missing || []).join('+');
    if (key === 'collectedAt') {
      const ts = n(r.ts);
      if (ts == null) return '';
      const d = new Date(ts + 9 * 3_600_000);
      return d.toISOString().slice(0, 19).replace('T', ' ');
    }
    const v = r[key];
    return v == null || v === '' ? '' : String(v);
  };
  const head = CSV_COLS.map(([, label]) => esc(label)).join(',');
  const body = (rows || []).map((r) => CSV_COLS.map(([k]) => esc(cell(r, k))).join(',')).join('\n');
  return `${head}\n${body}`;
}

/**
 * iDRAC 텔레메트리 전수 모드 안내(v2.551). 장비가 **무엇을 지원하는지** 말한다(사용자 선택).
 * 충족 조건이 없으면 문구를 만들지 않는다.
 */
export function telemetryNote(detail = {}) {
  const used = detail.idracReports || [];
  const seen = detail.idracSeenReports || [];
  if (!seen.length && !used.length) return '';
  const absent = detail.idracAbsent || [];
  const parts = [];
  parts.push(`iDRAC 이 가진 텔레메트리 리포트 **${seen.length}종** 중 **${used.length}종**을 읽었습니다`
    + `${used.length ? `(${used.slice(0, 5).join(' · ')}${used.length > 5 ? ' 외' : ''})` : ''}.`);
  const missKind = [];
  if (absent.includes('net')) missKind.push('네트워크');
  if (absent.includes('hba')) missKind.push('HBA');
  if (absent.includes('disk')) missKind.push('디스크');
  if (missKind.length) {
    parts.push(`**${missKind.join('·')} 통계 리포트가 없습니다** — iDRAC Datacenter 라이선스나 펌웨어에 따라 다릅니다.`
      + ' OS 계정을 등록하면 그 지표는 OS 경로로 읽습니다.');
  }
  if (absent.includes('diskbusy') && !absent.includes('disk')) {
    parts.push('디스크 **사용률(busy%)** 은 iDRAC 텔레메트리에 없습니다(용량·상태 계열만 있습니다) — 그 값은 OS 경로만 줍니다.');
  }
  return parts.join(' ');
}


/* ══════════════ v2.554 — iDRAC 라이선스 인식 · Enterprise 대체 수집 ══════════ */

/**
 * ⚠⚠ **'텔레메트리가 왜 비었나' 를 추측으로 말하지 않는다**(v2.554).
 *
 * v2.550~2.551 은 `Datacenter 라이선스가 필요할 수 있습니다` 라고 **추측**했다. 그런데 라이선스
 * 목록은 iDRAC 인벤토리에 이미 있다(`redfish.js:653` → `invCache`) — 그래서 등급을 읽었으면
 * **단정**하고, 못 읽었으면 그 사실을 말한다. 근거가 있으면 말해야 하고, 없으면 말하지 않는다.
 *
 * ⚠ '텔레메트리 = Datacenter' 의 근거는 **사용자 확인**이다(2026-09-17 신고 원문). Dell 의 기능
 *   매트릭스 원문은 이 환경에서 읽지 못했다 — 그래서 문구가 '확인된 것은' 형태다.
 */
export function telemetryMissingText(detail = {}) {
  const lic = detail.license || null;
  const tier = t(lic?.tier);
  const base = 'iDRAC 텔레메트리 리포트가 없습니다';
  /*
   * ⚠ **꼬리 문장을 지우지 말 것**(v2.550 부터의 규약): 이 경로가 없어도 OS 계정이 있으면 다섯
   *   지표를 전부 읽는다 — 그 사실을 말하지 않으면 사용자가 라이선스를 사야 한다고 읽는다.
   */
  const tail = ' 이 경로가 없어도 **OS 계정**이 등록돼 있으면 디스크·네트워크·HBA 까지 전부 읽습니다.';
  if (tier && tier !== 'unknown' && tier !== 'datacenter') {
    return `${base} — 이 iDRAC 의 라이선스는 **${t(lic.label) || tier}** 입니다.`
      + ' 텔레메트리(SystemUsage)는 **Datacenter 등급**에서만 제공됩니다.'
      + ' 아래 **Enterprise 대체 수집**을 켜면 표준 Redfish 센서와 iDRAC SSH(racadm)로 CPU·메모리를 읽습니다.'
      + tail;
  }
  if (tier === 'datacenter') {
    return `${base} — 라이선스는 **Datacenter** 로 읽혔으므로 등급 문제가 아닙니다.`
      + ' iDRAC 에서 **텔레메트리가 꺼져 있거나** 펌웨어가 오래되었을 수 있습니다.'
      + tail;
  }
  return `${base} — **이 iDRAC 의 라이선스 등급을 읽지 못했습니다**(인벤토리가 아직 수집되지 않았을 수 있습니다).`
    + ' Datacenter 등급이 필요한 기능이라 등급 문제일 가능성이 있지만 **단정할 수 없습니다**.'
    + tail;
}

/** 표 행에 붙이는 **짧은** 라이선스 표지. 값이 없으면 빈 문자열(행마다 긴 문장 금지 — v2.509). */
export function licenseMark(license = null) {
  const tier = t(license?.tier);
  if (!tier || tier === 'unknown') return '';
  return t(license.label) || tier;
}

/**
 * 라이선스 상세 한 줄. ⚠ **언제 본 값인지 밝힌다** — 라이선스를 추가 설치했는데 화면이 옛 등급으로
 * 말하면 사용자가 '기능이 고장났다' 고 읽는다. 인벤토리는 느린 주기(기본 30분)로 갱신된다.
 */
export function licenseNote(license = null, { now = Date.now() } = {}) {
  if (!license) return '';
  const tier = t(license.tier);
  if (!tier || tier === 'unknown') {
    if (!license.count) return 'iDRAC 라이선스 목록을 읽지 못했습니다(인벤토리 미수집 또는 이 iDRAC 이 목록을 주지 않음) — **등급 미상**입니다.';
    return `iDRAC 라이선스 **${license.count}건**을 읽었지만 등급 단어(Datacenter·Enterprise·Express)를 찾지 못했습니다 — **등급 미상**입니다.`
      + (license.expired ? ` 만료된 항목 ${license.expired}건이 있습니다.` : '');
  }
  const parts = [`iDRAC 라이선스 **${t(license.label) || tier}**`];
  if (license.at) parts.push(`(인벤토리 ${ageText(license.at, now)} 기준)`);
  if (license.evaluation) parts.push('· **평가판(Evaluation)** 항목이 포함돼 있습니다');
  if (license.expired) parts.push(`· 만료 항목 ${license.expired}건은 등급 판정에서 제외했습니다`);
  return `${parts.join(' ')}.`;
}

/**
 * Enterprise 대체 수집 **동의 고지**(사용자 지시: "시스템에 부하는 있겠지만, 사용할것이냐고
 * 물어보고 사용하겠다고 하면 기능을 구현한다").
 * ⚠ **부하를 축소해 말하지 않는다** — 관리자가 무엇에 동의하는지 알아야 동의가 의미를 갖는다.
 */
export function enterpriseConsentNote() {
  return '⚠ **이 경로는 장비에 부하를 더합니다.** 주기마다 그 서버의 iDRAC 에 **표준 Redfish 센서 GET 4회**가 붙고,'
    + ' 센서로 읽지 못하면 **iDRAC SSH 세션 1개**를 열어 racadm 을 실행합니다. BMC 는 약한 프로세서라 이 부하가 작지 않습니다.'
    + ' 그래서 **켜려면 아래 동의가 필요합니다** — 동의 없이는 저장되지 않습니다.'
    + ' 대신 텔레메트리가 **정상인 서버에는 붙지 않습니다**(Datacenter 등급이고 값이 나오면 건너뜁니다).';
}

/**
 * Enterprise 대체 수집 현재 상태. ⚠ **'켰는데 왜 값이 없나' 를 말한다** — 주기당 예산으로 미룬
 * 대수, 어느 경로로 읽었는지, 형식을 못 읽은 대수까지. 조건이 없으면 빈 문자열이다.
 */
export function enterpriseStatusNote(status = {}) {
  if (!status || status.enterpriseActive !== true) return '';
  const last = status.last?.ent || null;
  const parts = [`Enterprise 대체 수집이 **켜져 있습니다**(모드 ${t(status.enterpriseMode) || 'auto'}).`];
  if (!last) { parts.push('아직 이 경로로 수집한 주기가 없습니다 — 다음 주기를 기다리거나 ‘지금 수집’ 을 누르세요.'); return parts.join(' '); }
  parts.push(`마지막 주기에 **${n(last.tried) ?? 0}대**를 시도해 **${n(last.ok) ?? 0}대**에서 값을 읽었습니다`
    + `(Redfish 센서 ${n(last.viaApi) ?? 0}대 · racadm ${n(last.viaSsh) ?? 0}대).`);
  if (n(last.deferred)) {
    parts.push(`**${last.deferred}대는 이번 주기 예산을 넘겨 미뤘습니다** — 다음 주기에 시도합니다(장비 부하를 평탄화하기 위한 상한입니다).`);
  }
  if (n(last.unparsed)) {
    parts.push(`**${last.unparsed}대는 racadm 출력 형식을 읽지 못했습니다** — 그 서버를 눌러 상세의 원문을 확인해 주세요(이 현장 출력 형식을 아직 확인하지 못했습니다).`);
  }
  return parts.join(' ');
}

/**
 * Enterprise 대체 경로의 서버별 상세. ⚠ **원문을 보여주는 것이 이 기능의 정직성 장치**다 —
 * 파싱이 빗나가도 사용자가 실제 출력을 보고 알려줄 수 있어야 한다(v2.542 규약).
 */
export function entDetailNotes(detail = {}) {
  const out = [];
  const tried = detail.entTried || [];
  if (!tried.length) return out;
  const via = t(detail.entVia);
  if (via) {
    const how = [];
    if (via.includes('api')) how.push(`표준 Redfish 센서(${Object.keys(detail.entUsedPaths || {}).length}개)`);
    if (via.includes('ssh')) how.push(`iDRAC SSH — ${t(detail.entUsedCmd) || 'racadm'}`);
    out.push(`대체 경로로 읽었습니다: **${how.join(' + ')}**.`);
    const stat = detail.entUsedStat || {};
    const peak = Object.entries(stat).filter(([, v]) => v === 'peak' || v === 'avg');
    if (peak.length) {
      out.push(`⚠ **${peak.length}개 지표는 현재값이 아니라 ${peak.some(([, v]) => v === 'peak') ? '최고치' : '평균'} 열을 읽었습니다** — 그 값은 지금 부하가 아닙니다.`);
    }
  }
  const kind = t(detail.entKind);
  if (kind) {
    out.push(kind === 'auth' ? '대체 경로: iDRAC 계정·비밀번호가 거부됐습니다(401) — **반복 시도하지 않습니다**(계정이 잠깁니다).'
      // v2.591(감사 R-BM2): 403 은 로그인은 됐고 그 자원이 허락되지 않은 것 — 잠금 경로가 아니다.
      : kind === 'forbidden' ? '대체 경로: iDRAC 이 센서 조회를 **거부했습니다(403)** — 계정 권한 문제일 수 있습니다. 비밀번호 문제가 아니므로 수집을 멈추지 않습니다.'
      : kind === 'ssh-auth' ? '대체 경로: iDRAC **SSH 로그인**이 거부됐습니다 — 반복 시도하지 않습니다(계정이 잠깁니다).'
        : kind === 'auth-stopped' ? `대체 경로가 **인증 실패로 정지**됐습니다 — ${t(detail.entError)}`
          : kind === 'unparsed' ? '대체 경로: **racadm 출력 형식을 읽지 못했습니다** — 아래 원문을 보고 알려 주시면 파서를 맞추겠습니다(이 현장 출력을 확인한 적이 없습니다).'
            : kind === 'timeout' ? '대체 경로: 시한을 넘겨 중단했습니다(다음 주기에 다시 시도합니다).'
              : kind === 'absent' ? '대체 경로: 이 iDRAC 에 표준 Redfish 사용률 센서가 없습니다 — racadm 경로로 넘어갑니다.'
                : kind.startsWith('not-eligible') ? '' : `대체 경로 실패: ${t(detail.entError) || kind}`);
  }
  for (const sk of (detail.entSkipped || [])) {
    if (t(sk.reason)) out.push(`대체 경로 생략: ${t(sk.reason)}`);
  }
  if ((detail.entSeenSensors || []).length && !Object.keys(detail.entUsedPaths || {}).length) {
    out.push(`이 iDRAC 의 센서 **${detail.entSeenSensors.length}개** 중 사용률 이름이 맞는 것이 없었습니다 — 센서 이름을 알려 주시면 패턴을 맞추겠습니다.`);
  }
  return out.filter(Boolean);
}

/**
 * **'법인 귀속 없음' 의 원인과 조치**(v2.554 — 사용자 지시 "네 — 원인까지 조사").
 *
 * 이 현장은 이 사유로 500대가 제외돼 표가 통째로 비어 있었다. '귀속 없음' 만 말하면 사용자가
 * 무엇을 고쳐야 하는지 알 수 없다 — 원인마다 **조치가 다르다**.
 * ⚠ 자동 귀속을 제안하지 않는다 — 어느 서버가 어느 법인인지 포탈은 알지 못하고, 틀리게 귀속하면
 *   그 법인의 부하 통계가 거짓이 된다.
 * @returns {{head:string, items:string[], how:string}|null}
 */
export function unassignedNote(info = null) {
  if (!info || !n(info.total)) return null;
  const by = info.byCause || {};
  const items = [];
  if (by['registry-no-vc']) {
    items.push(`**iDRAC 등록에 법인이 비어 있음 ${by['registry-no-vc']}대** — 설정 › iDRAC 등록에서 각 서버의 법인을 고르거나, 서버 분석 › 통합 인벤토리에서 **일괄 지정**하세요.`);
  }
  if (by['assign-ghost']) {
    items.push(`**지금 없는 법인을 가리킴 ${by['assign-ghost']}대** — 수동 귀속이 삭제된 vCenter 를 가리킵니다. 다시 지정하면 해결됩니다.`);
  }
  if (by['edge-no-vc']) {
    items.push(`**엣지가 보고했지만 법인이 없음 ${by['edge-no-vc']}대** — 그 법인 포탈의 iDRAC 등록에서 지정해야 합니다(중앙에서는 바꿀 수 없습니다).`);
  }
  if (by['no-registry-match']) {
    items.push(`**등록부에서 찾지 못함 ${by['no-registry-match']}대** — iDRAC 등록이 없거나 **서비스태그가 비어 키가 맞지 않습니다**. 둘 중 어느 것인지는 여기서 구분할 수 없습니다.`);
  }
  if (info.error) items.push(`⚠ 원인을 판정하지 못했습니다: ${t(info.error)}`);
  return {
    head: `**법인 귀속이 없어 ${info.total}대가 수집 대상에서 빠졌습니다.** 어느 법인의 부하인지 알 수 없어 기본 제외입니다 — 이것은 이상이 아니라 **등록 데이터가 비어 있는 것**입니다.`,
    items,
    how: '지금 바로 보려면 설정에서 **‘법인 귀속 없는 서버도 포함’** 을 켤 수 있습니다.'
      + ' 다만 그 서버들의 사용률은 **법인별 집계에 들어가지 않습니다**(귀속 없음으로 묶입니다) —'
      + ' 법인별로 보려면 귀속을 지정하는 것이 맞습니다.',
  };
}

/**
 * 엣지 보관분 한 줄의 상태(v2.554). ⚠⚠ **값이 없는 것을 '정상' 으로 칠하지 않는다** —
 * 이 표 최악의 거짓이다. 이유를 **순서대로** 말한다(v2.552 `rowState` 와 같은 규약).
 * @returns {{state:string, label:string, why:string, tone:string}}
 */
export function edgePullState(row = {}, { minEdgeVersion = '', staleMs = 30 * 60_000, now = Date.now() } = {}) {
  const at = n(row.snapAt);
  const att = row.lastAttempt || null;
  if (row.enabled === false) return { state: 'off-central', label: '중앙에서 비활성', why: '중앙에서 이 수집 서버를 비활성으로 두었습니다 — 켜야 가져올 수 있습니다.', tone: 'idle' };
  if (!row.hasUrl) return { state: 'no-url', label: 'URL 없음', why: '설정 › 수집 서버에 이 엣지의 URL 이 없습니다.', tone: 'bad' };
  if (!at) {
    if (!att) return { state: 'never', label: '가져온 적 없음', why: '아직 한 번도 가져오지 않았습니다 — 이 기능은 **누를 때만** 나가므로 이상이 아닙니다.', tone: 'idle' };
    return {
      state: 'failed', label: '실패', tone: 'bad',
      why: att.kind === 'old-version' ? `이 엣지에 해당 경로가 없습니다 — v${minEdgeVersion} 이상으로 업그레이드해야 합니다(다시 눌러도 같습니다).`
        : att.kind === 'auth' ? '수집 서버 토큰이 맞지 않습니다 — 중앙 등록값과 그 엣지의 설정을 대조하세요(다시 눌러도 같습니다).'
          : att.kind === 'disabled' ? '그 엣지에서 수집 서버 토큰이 설정돼 있지 않습니다.'
            : `${t(att.kind) || '실패'}: ${t(att.reason)}`,
    };
  }
  if (row.enabledOnEdge === false) {
    return { state: 'off-edge', label: '엣지에서 꺼짐', why: '그 엣지에서 베어메탈 사용률 수집이 꺼져 있습니다 — 그 법인 포탈에서 켜야 값이 생깁니다(중앙에서는 켤 수 없습니다).', tone: 'warn' };
  }
  const old = now - at > staleMs;
  if (att && !att.ok) {
    return { state: 'stale-failed', label: '마지막 시도 실패', tone: 'warn', why: `아래 값은 ${ageText(at, now)} 가져온 것이고, **가장 최근 시도는 실패**했습니다 — ${t(att.kind)}: ${t(att.reason)}` };
  }
  if (old) return { state: 'stale', label: '낡음', tone: 'warn', why: `${ageText(at, now)} 가져온 값입니다 — 지금 값을 보려면 다시 가져오세요.` };
  return { state: 'ok', label: '보관분 있음', tone: 'ok', why: `${ageText(at, now)} 가져온 값입니다.` };
}

/**
 * 엣지 패널 머리말. ⚠ **'push 가 없다' 는 사실을 말한다** — 값이 낡은 것이 장애가 아니라 설계다
 * (사용자 선택: "중앙으로 전달은 중앙에서 조회할때만").
 */
export function edgePullNote(rows = []) {
  const arr = Array.isArray(rows) ? rows : [];
  const have = arr.filter((r) => n(r.snapAt)).length;
  return `엣지는 자기 법인 베어메탈을 **스스로 수집·종합**하고, 중앙은 **누를 때만** 그 결과를 가져옵니다(상시 전송 없음).`
    + ` 등록된 엣지 **${arr.length}곳** 중 **${have}곳**의 보관분이 있습니다.`
    + (have < arr.length ? ' 보관분이 없는 곳은 아직 가져오지 않은 것이며 이상이 아닙니다.' : '');
}

/**
 * 숫자 설정 칸의 입력 해석(v2.583 감사 #36, 순수). 비었거나 숫자가 아니면 **null** — 저장하지 않는다.
 * ⚠ `Number('') === 0` 이라 그대로 PUT 하면 서버가 0 을 하한으로 올려 보존일이 7일·30일로 줄고,
 *   다음 prune 이 그 차이만큼 이력을 지운다(되돌릴 수 없다). 0 자체가 유효한 칸(지속 0분)은 0 을 돌려준다.
 */
export function blurNumber(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
export const BLANK_KEPT_TEXT = '빈 칸은 저장하지 않았습니다 — 이전 값으로 되돌렸습니다.';
