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
const t = (v) => String(v ?? '').trim();
/** ⚠ `v == null` 을 **먼저** 본다 — `Number(null)===0`·`Number('')===0` 이라 결측이 0 으로 둔갑한다. */
const n = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

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

export function ageText(at, now = Date.now()) {
  const v = n(at);
  if (!v) return '—';
  const ms = Math.max(0, now - v);
  if (ms < 60_000) return `${Math.round(ms / 1000)}초 전`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}분 전`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}시간 전`;
  return `${Math.round(ms / 86_400_000)}일 전`;
}

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
export const SRC_MARK = Object.freeze({ os: 'OS', idrac: 'iDRAC', 'idrac+os': 'OS·iDRAC', 'os+idrac': 'OS·iDRAC' });
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
    out.push(k === 'no-telemetry' ? 'iDRAC 텔레메트리 리포트가 없습니다 — **Datacenter 라이선스**가 필요할 수 있습니다(이 경로가 없어도 OS 계정이 있으면 전부 읽습니다).'
      : k === 'auth' ? 'iDRAC 계정·비밀번호를 확인하세요(반복 시도해도 결과는 같습니다).'
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
