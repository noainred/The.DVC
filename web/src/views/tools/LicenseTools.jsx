// LicenseTools.jsx — SpecialTools.jsx(구 5,070줄)에서 분리(v2.282 대형 파일 분할). 본문은 원본 그대로 이동.
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, canCsv } from '../../api.js';
import { DataTable, Loading, ErrorBox, UsageCell } from '../../components/ui.jsx';
import { Card, useTool } from './shared.jsx';
import { csvCell } from '../../util/csv.js'; // 수식 인젝션 가드 포함 공통 셀 이스케이프
import { STable } from '../../components/STable.jsx';
import { licenseScopeNote, licenseDupNote } from './licenseScopeText.js'; // v2.603: 범위 밖 제외 안내
import { HorizonServerManager } from '../HorizonAdmin.jsx'; // v2.685: Horizon 연결 서버 등록(설정 메뉴와 공용)
import BoldText from '../../components/boldText.jsx';
import { numOrNull } from '../../numOrNull.js';
import { licensesUnreadNotes, solutionsUnreadCell, solutionsUnreadNote, expiryUnreadNote } from './licenseUnreadText.js'; // v2.742(VC-06): 목록을 못 읽은 vCenter


/**
 * vCenter 카드의 확장 솔루션 표 — 렌더 스모크 테스트가 직접 그린다.
 * v2.742(감사 VC-06): 목록을 못 읽은 vCenter(solutionsUnread)는 '정보 없음' 이 아니라 확인 불가(사유)다 — 문구는 licenseUnreadText 하나.
 */
export function SolutionsTable({ it }) {
  const sols = Array.isArray(it?.solutions) ? it.solutions : [];
  const unread = solutionsUnreadCell(it);
  return (
    <div className="table-wrap">
      {/* v2.575 BUG-19: 상한은 정렬 뒤 적용(먼저 자르면 버전 정렬이 앞 30개 안에서만 돈다). */}
      <STable limit={30}>
        <thead><tr><th>확장 솔루션</th><th>버전</th><th>공급사</th></tr></thead>
        <tbody>
          {sols.map((s) => (
            <tr key={s.key}><td>{/nsx/i.test(s.key + s.label) ? '🛡️ ' : ''}{s.label}</td><td className="tabular">{s.version || '—'}</td><td className="muted">{s.company || '—'}</td></tr>
          ))}
          {sols.length === 0 && (
            <tr><td colSpan={3} className="muted center" style={{ padding: 14, whiteSpace: 'normal', color: unread ? 'var(--amber)' : undefined }} title={unread?.title || undefined}>
              {unread ? unread.text : 'vCenter 확장 솔루션 정보 없음'}
            </td></tr>
          )}
        </tbody>
      </STable>
      {/* v2.575: 조용한 상한 금지 — 뺀 개수를 밝힌다. */}
      {sols.length > 30 && <div className="muted" style={{ fontSize: 11, padding: '4px 8px' }}>전체 {sols.length}건 중 <b>30건만</b> 표시합니다.</div>}
    </div>
  );
}

/** 라이선스 사용 현황 머리 안내 — 렌더 스모크 테스트가 직접 그린다(v2.742 VC-06: 못 읽은 vCenter · 부분 합). */
export function LicensesUnreadBanner({ data }) {
  const n = licensesUnreadNotes(data);
  if (!n.partialNote && !n.disabledNote) return null;
  return (
    <>
      {n.partialNote && (
        <div style={{ marginBottom: 10, padding: '8px 12px', borderRadius: 8, fontSize: 12, background: 'rgba(251,191,36,.1)', color: 'var(--amber)', whiteSpace: 'normal' }}>⚠ {n.partialNote}</div>
      )}
      {n.disabledNote && <div className="muted" style={{ marginBottom: 10, fontSize: 12, whiteSpace: 'normal' }}>ⓘ {n.disabledNote}</div>}
    </>
  );
}

export function Solutions() {
  const { loading, data, error } = useTool('/tools/solutions', {});
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  // 버전 드리프트 강조(v2.327): 같은 제품인데 버전이 2개 이상이면 노랑(사이트 간 불일치 = 패치 필요 신호).
  const drift = (arr) => (arr || []).length > 1;
  const VerBadges = ({ arr, unit }) => (
    <div className="flex gap wrap" style={{ marginBottom: 14 }}>
      {(arr || []).length === 0 && <span className="muted">정보 없음</span>}
      {(arr || []).map((n) => <span key={n.version} className={`badge ${drift(arr) ? 'amber' : 'blue'}`} style={{ fontSize: 13, padding: '4px 10px' }} title={drift(arr) ? '사이트 간 버전 불일치 — 패치 수준 확인' : '전 사이트 동일 버전'}>{n.version} · {n.count}{unit}</span>)}
    </div>
  );
  return (
    <>
      {/* 전 함대 버전 요약(v2.327, 사용자 요구 — 모든 vCenter 의 NSX 포함 솔루션 버전 한눈에).
          버전이 2개 이상이면(드리프트) 노란 배지로 사이트 간 불일치를 강조한다. */}
      {solutionsUnreadNote(data) && <div className="muted" style={{ marginBottom: 10, fontSize: 12, whiteSpace: 'normal', color: 'var(--amber)' }}>⚠ {solutionsUnreadNote(data)}</div>}
      <div className="section-title" style={{ marginTop: 0 }}>vCenter 버전 분포 <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>({data.items.length} 사이트)</span></div>
      <VerBadges arr={data.vcenterVersions} unit=" 사이트" />
      <div className="section-title">ESXi 버전 분포 <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>(호스트 수)</span></div>
      <VerBadges arr={data.esxiVersions} unit=" 호스트" />
      {/* NSX 버전 분포 — 각 버전이 설치된 법인(datacenter)까지 표시(v2.327 사용자 요구) */}
      <div className="section-title">NSX Manager 버전 분포 <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>(실수집 {data.nsxManagerCount ?? 0} 매니저 · 설치 법인 표시)</span></div>
      <div className="flex gap wrap" style={{ marginBottom: 14 }}>
        {(data.nsxVersions || []).length === 0 && <span className="muted">NSX 정보 없음</span>}
        {(data.nsxVersions || []).map((n) => (
          <div key={n.version} className="card" style={{ padding: '8px 12px', minWidth: 180 }}>
            <div><span className={`badge ${drift(data.nsxVersions) ? 'amber' : 'blue'}`} style={{ fontSize: 13, padding: '3px 9px' }} title={drift(data.nsxVersions) ? '법인 간 NSX 버전 불일치' : '전 법인 동일 버전'}>NSX {n.version}</span> <span className="muted" style={{ fontSize: 12 }}>· {n.count} 매니저</span></div>
            <div className="flex gap wrap" style={{ marginTop: 6 }}>
              {(n.corps || []).map((c) => <span key={c.corp} className="badge gray" style={{ fontSize: 11 }} title={`${c.corp} — NSX Manager ${c.count}`}>{c.corp}{c.count > 1 ? ` ×${c.count}` : ''}</span>)}
            </div>
          </div>
        ))}
      </div>

      <div className="section-title">vCenter별 설치 버전 (vCenter · ESXi · NSX · 확장 솔루션)</div>
      <div className="grid cols-2">
        {data.items.map((it) => (
          <div className="card" key={it.vcenterId}>
            <div className="flex between" style={{ marginBottom: 8 }}>
              <b>{it.name}{it.corp ? <span className="muted" style={{ fontSize: 11, fontWeight: 400 }}> · 법인 {it.corp}</span> : it.region ? <span className="muted" style={{ fontSize: 11, fontWeight: 400 }}> · {it.region}</span> : ''}</b>
              <span className="muted" style={{ fontSize: 12 }}>vCenter v{it.version || '—'}{it.build ? ` (b${it.build})` : ''}</span>
            </div>
            {/* ESXi 버전(사이트 내 호스트) — 여러 버전이면 드리프트 */}
            {(it.esxi || []).length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <span className="muted" style={{ fontSize: 11, marginRight: 4 }}>ESXi</span>
                {it.esxi.map((e) => <span key={e.version} className={`badge ${it.esxi.length > 1 ? 'amber' : 'gray'}`} style={{ marginRight: 4, fontSize: 11 }}>{e.version} × {e.count}</span>)}
              </div>
            )}
            {/* 실제 NSX Manager(nsxStore) — vCenter 확장 항목보다 권위 있음 */}
            {(it.nsxManagers || []).length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <span className="muted" style={{ fontSize: 11, marginRight: 4 }}>🛡️ NSX</span>
                {it.nsxManagers.map((m, i) => <span key={i} className={`badge ${m.status === 'connected' ? 'green' : 'red'}`} style={{ marginRight: 4, fontSize: 11 }} title={`${m.host || ''} · ${m.status}`}>{m.name} {m.version || '?'}</span>)}
              </div>
            )}
            <SolutionsTable it={it} />
          </div>
        ))}
      </div>
    </>
  );
}

/*
 * v2.743(감사 WEB-05) — 라이선스 used·total 은 못 읽으면 null 이다(v2.727 C-02 — vim25 의 used 는 선택 필드). 예전 화면은
 *   `l.total ? round(used/total*100) : 0` 이라 못 읽은 값을 사용률 0%(= 사용 없음)로, 제품 카드를 '0/0' 으로 그렸다.
 *   판정은 서버 롤업(usedUnknown·totalUnknown)을 읽기만 하고, 값이 없으면 '—' 와 '사용량 모름 N건' 을 말한다(순수 함수 — 테스트 고정).
 */
const numText = (v) => (numOrNull(v) == null ? '—' : String(numOrNull(v)));
/** 사용률(%) — 사용량·총량을 둘 다 읽었고 총량이 0 보다 클 때만. 아니면 null(UsageCell 이 '—'). */
export function licenseUsePct(l) {
  const u = numOrNull(l?.used);
  const t = numOrNull(l?.total);
  if (u == null || t == null || t <= 0) return null;
  return Math.round((u / t) * 100);
}
/** 제품 카드 — `{ value, meta }`. 못 읽은 보고 단위가 있으면 그 수를 meta 로 밝힌다(합계에서 빠졌다는 뜻). */
export function licenseCardText(b) {
  const uu = numOrNull(b?.usedUnknown) || 0;
  const tu = numOrNull(b?.totalUnknown) || 0;
  const parts = [];
  if (b?.productVersion) parts.push(`v${b.productVersion}`);
  if (uu > 0) parts.push(`사용량 모름 ${uu}건`);
  if (tu > 0) parts.push(`총량 모름 ${tu}건`);
  return { value: `${numText(b?.used)}/${numText(b?.total)}`, meta: parts.join(' · ') };
}
/** 화면 머리 안내 — 사용량·총량을 못 읽은 라이선스가 있으면 한 줄(없거나 구버전 서버면 null). */
export function licenseUnknownNote(data) {
  const uu = numOrNull(data?.usedUnknown) || 0;
  const tu = numOrNull(data?.totalUnknown) || 0;
  if (uu <= 0 && tu <= 0) return null;
  const what = [uu > 0 ? `사용량 모름 ${uu}건` : '', tu > 0 ? `총량 모름 ${tu}건` : ''].filter(Boolean).join(' · ');
  return `vCenter 가 사용량·총량을 보고하지 않은 라이선스가 있습니다(${what}) — 0 이 아니라 확인 불가이고, 제품별 합계와 사용률에서 빠졌습니다.`;
}

/** 라이선스 사용 현황 본문(조회와 분리 — 렌더 테스트가 계약 모양 응답으로 직접 그린다). */
export function LicensesView({ data }) {
  const cols = [
    { key: 'name', label: '라이선스', render: (l) => <b>{l.name}</b> },
    { key: 'vcenterName', label: 'vCenter', render: (l) => <span className="muted">{l.vcenterName}</span> },
    { key: 'productVersion', label: '버전' },
    { key: 'used', label: '사용', align: 'right', sortValue: (l) => numOrNull(l.used), render: (l) => numText(l.used) },
    { key: 'total', label: '총량', align: 'right', sortValue: (l) => numOrNull(l.total), render: (l) => numText(l.total) },
    { key: 'usePct', label: '사용률', sortValue: (l) => licenseUsePct(l), render: (l) => <UsageCell pct={licenseUsePct(l)} /> },
    { key: 'expires', label: '만료', render: (l) => <span style={{ color: isSoon(l.expires) ? 'var(--amber)' : undefined }}>{l.expires || '—'}</span> },
  ];
  const unknownNote = licenseUnknownNote(data);
  return (
    <>
      <LicensesUnreadBanner data={data} />
      <div className="section-title" style={{ marginTop: 0 }}>제품별 합계</div>
      <div className="kpis" style={{ marginBottom: 14 }}>
        {(data.byLicense || []).map((b) => { const c = licenseCardText(b); return <Card key={b.name} label={b.name} value={c.value} meta={c.meta} />; })}
      </div>
      {unknownNote && <p className="muted" style={{ fontSize: 12, margin: '-6px 0 10px', whiteSpace: 'normal' }}>{unknownNote}</p>}
      {licenseDupNote(data) && <p className="muted" style={{ fontSize: 12, margin: '-6px 0 10px' }}>{licenseDupNote(data)}</p>}
      <DataTable columns={cols} rows={data.items || []} initialSort={{ key: 'used', dir: 'desc' }} />
    </>
  );
}

export function Licenses({ scope }) {
  const { loading, data, error } = useTool('/tools/licenses', scope ? { vcenterId: scope } : {});
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  return <LicensesView data={data} />;
}
function isSoon(d) { if (!d) return false; const t = Date.parse(d); return t && t - Date.now() < 90 * 86400000; }

/**
 * v2.732(점검 2회차 B3-01 후속, 그룹 i3): 데모 계정이 사람이 등록한 Horizon 커넥션 서버에 접속하지 않은 사실(`demoSkipped`)은
 * **수집 실패가 아니다** — 서버(routes/api/toolsInfo.js)는 호환을 위해 그 안내를 collectionErrors 에도 한 줄 넣는데, 화면이 그것을
 * '⚠ 일부 수집 실패:' 줄에 섞으면 머리말과 내용이 어긋난다(사용자는 멀쩡한 커넥션 서버를 의심한다). 그 줄을 빼고 별도 안내로 말한다.
 * 그 줄은 서버 문구의 머리(DEMO_SKIP_PREFIX)로 알아본다 — 웹 테스트가 서버 소스와 대조한다. demoSkipped 가 없는(구버전 서버·데모 아님)
 * 응답은 예전 그대로다. 반환 `{ failures: string[], demoNote: string }`.
 */
export const DEMO_SKIP_PREFIX = 'Horizon: 데모 계정은';
export function licenseNotices(data) {
  const errs = Array.isArray(data?.collectionErrors) ? data.collectionErrors.map((e) => String(e ?? '')) : [];
  const skipped = numOrNull(data?.demoSkipped);
  const failures = skipped == null ? errs : errs.filter((e) => !e.startsWith(DEMO_SKIP_PREFIX));
  const demoNote = skipped != null && skipped > 0
    ? `**데모 계정**이라 사람이 등록한 Horizon 커넥션 서버 ${skipped}대에는 접속하지 않았습니다(실제 로그인 방지) — 그 서버의 라이선스는 이 목록에 없습니다. 수집 실패가 아닙니다.`
    : '';
  return { failures, demoNote };
}

// v2.744(감사 LEFT-04): 라이선스 만료 표의 폭 제한(px). 줄바꿈 칸은 inline-block + white-space normal — tbody td 가 nowrap 이라
//   안쪽에서 풀어야 칸이 좁아진다(styles.css 'tbody td'). 키는 한 줄 말줄임(키 일부만 보여도 대조할 수 있게 title 에 전체).
export const LIC_NAME_MAXW = 220;
export const LIC_SOURCE_MAXW = 200;
export const LIC_KEY_MAXW = 140;
// v2.744(회귀 검토 GI-R1): 줄바꿈 칸의 최소 폭(px). overflow-wrap:anywhere 는 min-content 를 한 글자 폭으로 만들어, 표가 칸보다 넓은 폭
//   (400px)에서 자동 표 레이아웃이 '라이선스'·'소스' 열을 51~74px 로 짜부라뜨렸다(행 37 → 141px, 'vC/ent/er' 처럼 단어 중간 줄바꿈).
//   min-width 가 그 열의 하한이 되어 나머지는 표 래퍼(DataTable 의 table-wrap, overflow:auto)가 가로 스크롤로 넘긴다. anywhere 는 남긴다 —
//   상자(140~220px)보다 긴 한 단어(공백·하이픈 없는 FQDN)만 끊는다(break-word·normal 은 그 단어 폭만큼 열을 넓혀 1280px 에서 상태 열을
//   밀어냈고, normal 은 상자를 넘쳐 옆 칸과 겹쳤다 — Chromium 실측).
// v2.744(최종 검토 RV-GI-R1-01 — Chromium 재현): 그 하한을 **언제나** 걸면 표가 들어갈 수 있는 폭에서도 표 최소 폭이 약 1042px 가 되어
//   1280px(래퍼 996px)에서 48px · 1200px(펼침, 916px)에서 128px · 1024px(레일, 912px)에서 132px 가 래퍼 밖으로 밀려 '상태' 열이 잘렸다
//   (하한이 없던 판은 같은 폭에서 0px — 행 높이도 1280px 에서 같았다). 그래서 하한은 **표 칸(래퍼) 폭이 LIC_WRAP_NARROW_PX 보다 좁을 때만**
//   건다 — 그 폭에서는 나머지 열(약 700px)만으로 칸을 거의 채워 하한이 없으면 두 열이 머리글 폭(51~74px)까지 짜부라지고(행 평균 143~161px),
//   어차피 가로 스크롤이 생긴다. 그보다 넓으면 하한 없이 자동 표 레이아웃이 두 열을 칸에 맞춘다(1024px 레일에서 행 평균 80px · 상태 열 보임).
//   판정은 CSS 컨테이너 단위다 — 표를 감싸는 div(LIC_TABLE_HOST)가 inline-size 컨테이너이고, 칸 안 상자의 min-width 는
//   clamp(0, (기준 − 100cqi) × 1000, 140px) 로 기준보다 좁으면 140px · 넓으면 0 인 계단이다(사이드바가 펼침·레일·서랍 어느 쪽이든
//   뷰포트가 아니라 실제 칸 폭을 본다). 컨테이너 단위를 모르는 브라우저는 선언 전체를 버려 하한이 없던 판과 같다(상태 열은 보인다).
//   기준(880px)은 목 데이터의 나머지 열 합(706px) + 두 열에 머리글보다 넓은 최소 내용 폭(약 60px)을 준 값이다 — 운영 데이터의 버전·제품군
//   문자열이 더 길면 그만큼 기준 위에서 두 열이 좁아진다(정직 기록 — 실운영 라이선스 이름 길이로는 보지 못했다).
export const LIC_WRAP_MINW = 140;
export const LIC_WRAP_NARROW_PX = 880;
export const LIC_WRAP_MIN_CSS = `clamp(0px, calc((${LIC_WRAP_NARROW_PX}px - 100cqi) * 1000), ${LIC_WRAP_MINW}px)`;
const LIC_TABLE_HOST = { containerType: 'inline-size' };
const LIC_WRAP = (maxWidth) => ({ display: 'inline-block', minWidth: LIC_WRAP_MIN_CSS, maxWidth, whiteSpace: 'normal', overflowWrap: 'anywhere', verticalAlign: 'top' });
const LIC_KEY_STYLE = { fontSize: 11, display: 'inline-block', maxWidth: LIC_KEY_MAXW, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' };

/**
 * 라이선스 만료일 확인 — vCenter LicenseManager(ESXi·vCenter·vSAN·VCF/VVF 등 등록 전 제품)
 * + NSX Manager + Horizon Connection Server(등록 시 REST 직수집)의 유효/만료 날짜 통합.
 * 만료(빨강)/90일 임박(노랑)/정상/영구 분류 + 제품군 필터 + CSV. 관리자는 Horizon 서버 등록 가능.
 */
export function LicenseExpiry({ scope, isAdmin, initialData = null }) {
  // initialData 는 렌더 스모크 테스트용(서버 없이 계약 모양 응답으로 그린다) — 화면은 넘기지 않는다(마운트 때 읽는다).
  const [data, setData] = useState(initialData);
  const [err, setErr] = useState(null);
  const [statusSel, setStatusSel] = useState('');
  const [familySel, setFamilySel] = useState('');

  // 세대 가드(v2.611 WEB2611-07) — 범위를 바꾼 뒤 늦게 도착한 이전 범위 응답은 버린다.
  const licGen = useRef(0);
  const load = () => {
    const gen = ++licGen.current;
    fetchJson('/tools/license-expiry', scope ? { vcenterId: scope } : {})
      .then((d) => { if (gen === licGen.current) { setData(d); setErr(null); } })
      .catch((e) => { if (gen === licGen.current) setErr(e.message); });
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [scope]);

  if (err) return <ErrorBox message={err} />;
  if (!data) return <Loading />;

  const STATUS = [
    ['expired', '만료', 'var(--red)'], ['expiring', '90일 이내 만료', 'var(--amber)'],
    ['ok', '정상', 'var(--green)'], ['perpetual', '영구/만료없음', 'var(--text-faint)'],
  ];
  const statusLabel = Object.fromEntries(STATUS.map(([k, l]) => [k, l]));
  const statusColor = Object.fromEntries(STATUS.map(([k, , c]) => [k, c]));
  const rows = (data.items || []).filter((i) => (!statusSel || i.status === statusSel) && (!familySel || i.family === familySel));
  const notices = licenseNotices(data);

  const dday = (i) => (i.daysLeft == null ? '' : i.daysLeft < 0 ? `D+${-i.daysLeft}` : `D-${i.daysLeft}`);
  const cols = [
    { key: 'family', label: '제품군', render: (i) => <span className="badge blue">{i.family}</span> },
    // v2.744(감사 LEFT-04): 1440px 에서 표 폭(1222px)이 칸(1154px)보다 넓어 맨 오른쪽 '상태' 배지가 잘렸다 — 폭 제한이 없던
    //   '라이선스'·'소스 · where' 는 줄바꿈을 허용하고, '키' 는 폭을 묶어 말줄임(전체는 title)으로 둔다. 열 순서·정렬 값·CSV 열은 그대로다.
    { key: 'name', label: '라이선스', render: (i) => <b style={LIC_WRAP(LIC_NAME_MAXW)}>{i.name}</b> },
    { key: 'source', label: '소스', render: (i) => <span className="muted" style={LIC_WRAP(LIC_SOURCE_MAXW)}>{i.source} · {i.where}</span> },
    { key: 'productVersion', label: '버전', render: (i) => <span className="muted">{i.productVersion || '—'}</span> },
    { key: 'key', label: '키', render: (i) => <span className="muted" style={LIC_KEY_STYLE} title={i.key || undefined}>{i.key || '—'}</span> },
    { key: 'used', label: '사용/총량', align: 'right', sortValue: (i) => i.used ?? null, render: (i) => (i.total != null ? `${i.used ?? '—'}/${i.total}` : '—') },
    { key: 'expires', label: '만료일', sortValue: (i) => (i.expires ? Date.parse(i.expires) : Infinity), render: (i) => (i.expires ? <b style={{ color: statusColor[i.status] }}>{i.expires}</b> : <span className="muted">영구/미표기</span>) },
    { key: 'daysLeft', label: '남은 기간', align: 'right', sortValue: (i) => (i.daysLeft == null ? Infinity : i.daysLeft), render: (i) => <b style={{ color: statusColor[i.status] }}>{dday(i) || '—'}</b> },
    { key: 'status', label: '상태', render: (i) => <span className="badge" style={{ color: statusColor[i.status], borderColor: statusColor[i.status] }}>{statusLabel[i.status]}</span> },
  ];

  const exportCsv = () => {
    const head = ['family', 'name', 'source', 'where', 'edition', 'productVersion', 'key', 'used', 'total', 'expires', 'daysLeft', 'status'];
    const lines = rows.map((i) => [i.family, i.name, i.source, i.where, i.edition, i.productVersion, i.key, i.used ?? '', i.total ?? '', i.expires || 'perpetual', i.daysLeft ?? '', statusLabel[i.status]]);
    const csv = [head, ...lines].map((r) => r.map(csvCell).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'license-expiry.csv'; a.click(); URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="kpis" style={{ marginBottom: 12 }}>
        <Card label="전체 라이선스" value={data.total} meta={scope ? '선택 vCenter' : `vCenter+NSX+Horizon${data.horizonServers ? `(${data.horizonServers})` : ''}`} />
        {STATUS.map(([k, l]) => <Card key={k} label={l} value={data.summary?.[k] || 0} />)}
      </div>

      {licenseScopeNote(data) && (
        <div className="muted" style={{ marginBottom: 10, fontSize: 12 }}>ⓘ {licenseScopeNote(data)}</div>
      )}

      {notices.failures.length > 0 && (
        <div style={{ marginBottom: 10, padding: '8px 12px', borderRadius: 8, fontSize: 12, background: 'rgba(251,191,36,.1)', color: 'var(--amber)' }}>
          ⚠ 일부 수집 실패: {notices.failures.join(' · ')}
        </div>
      )}
      {/* v2.742(VC-06): 비활성 vCenter 는 수집하지 않아 목록에 없다(실패가 아니다 — 그 밖의 못 읽은 vCenter 는 위 '일부 수집 실패' 줄이 말한다) */}
      {expiryUnreadNote(data) && <div className="muted" style={{ marginBottom: 10, fontSize: 12, whiteSpace: 'normal' }}>ⓘ {expiryUnreadNote(data)}</div>}
      {/* v2.732(그룹 i3): 데모 계정의 '접속 안 함' 은 실패가 아니다 — 별도 안내(회색) */}
      {notices.demoNote && (
        <div className="muted" style={{ marginBottom: 10, fontSize: 12, whiteSpace: 'normal' }}>ⓘ <BoldText text={notices.demoNote} /></div>
      )}

      <div className="flex gap wrap" style={{ marginBottom: 10, alignItems: 'center' }}>
        {STATUS.map(([k, l, c]) => (
          <button key={k} className="tab" style={{ padding: '5px 12px', fontWeight: 700, color: c, background: statusSel === k ? 'rgba(148,163,184,.15)' : undefined }}
            onClick={() => setStatusSel(statusSel === k ? '' : k)}>{l} <b>{data.summary?.[k] || 0}</b></button>
        ))}
        <span style={{ width: 10 }} />
        {(data.families || []).map((f) => (
          <button key={f} className="tab" style={{ padding: '5px 12px', background: familySel === f ? 'rgba(34,211,238,.15)' : undefined }}
            onClick={() => setFamilySel(familySel === f ? '' : f)}>{f}</button>
        ))}
        {canCsv() && <button className="tab" style={{ marginLeft: 'auto', padding: '5px 12px' }} onClick={exportCsv}>CSV 내보내기</button>}
      </div>

      {/* v2.744(RV-GI-R1-01): 줄바꿈 칸의 최소 폭이 표 칸 폭(cqi)을 보도록 inline-size 컨테이너로 감싼다(위 LIC_WRAP_MIN_CSS) */}
      <div style={LIC_TABLE_HOST}>
        <DataTable columns={cols} rows={rows} initialSort={{ key: 'daysLeft', dir: 'asc' }} />
      </div>

      <div className="muted" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.7 }}>
        vCenter 소스는 LicenseManager에 등록된 모든 키(ESXi·vCenter·vSAN·VCF/VVF 및 vCenter에 할당된 타 제품 포함)이고, NSX는 각 매니저에서 직접 수집합니다.
        Horizon은 아래에 Connection Server를 등록하면 REST API로 만료일을 직수집합니다(10분 캐시).
      </div>

      {/* v2.685: 등록 화면은 HorizonServerManager 하나 — 설정 › Horizon 연결 서버 와 같은 컴포넌트 */}
      {isAdmin && <HorizonServerManager variant="details" onChanged={load} />}
    </>
  );
}
