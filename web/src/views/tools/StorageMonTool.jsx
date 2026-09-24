import React, { useEffect, useMemo, useState } from 'react';
import { useLatest } from '../../hooks/useLatest.js';
import { useHashTab } from '../../hooks/useHashTab.js';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import { fetchJson, postJson, delJson, downloadFile } from '../../api.js';
import { Loading, ErrorBox, Kpi, UsageCell, Modal, SearchBox, usageColor } from '../../components/ui.jsx';
import { columnsFor, cellValue, sortValue } from './storageColumns.js';
import { UNIT_OPTIONS, formatBytes, loadUnit, saveUnit, capacityTotals } from './storageUnits.js';
import { emptyListText, conflictText, edgeReportNotes, edgeIntervalText } from './storageListText.js';
import { collectDropNote } from './collectDropText.js';
import { hostText, addressHiddenNote } from './addressHiddenText.js'; // v2.599 AUTHZ-2599-03
import { STable } from '../../components/STable.jsx';
import { collectMethodView } from './storageMethodText.js';
import BulkDeviceIo from './BulkDeviceIo.jsx';
// v2.532: 법인·장비 종류 필터의 **판정과 마크업을 증가량 화면과 공유**한다(CLAUDE.md '코어는
// 하나다'). 여기 있던 것을 옮긴 것이고, 복사해 두면 '같은 메뉴' 가 조용히 갈라진다.
import { facetState, toggleIn as toggleSet, groupBy as groupByKey } from './deviceFacets.js';
import DeviceFacetBar from './DeviceFacetBar.jsx';
import UnityConfigPanels from './UnityConfigPanels.jsx';   // v2.525: Unity 구성 정보 패널
import UnityCapacityPlanPanel from './UnityCapacityPlanPanel.jsx'; // v2.540: Unity 용량 산정
import CollectActivity from './CollectActivity.jsx';
import BoldText from '../../components/boldText.jsx';
import { areasStopNote, areaBadgeSuffix } from './areasStopText.js'; // v2.598 T2598-01: 영역 수집이 도중에 멈춘 사실
import { healthBadge, sectionBadge, cliCutText } from './storageNodeText.js';   // v2.526: 헬스 배지 색 판정(순수)
import { authFailInfo } from './storageAuthText.js';  // v2.528: 401 진단 문구(순수)
import { capacityRows, srpRows, subscribedNote, usageTrust } from './powermaxCapacityText.js'; // v2.534: 구독/할당/실제기록(순수)
import { nodeFaultSummary, nodeRows, nodeKindLabel, bpsText, faultBadgeTitle } from './storageNodeText.js';
import { versionCellInfo } from './storageVersionText.js';
import { unitText } from '../unitText.js';
import { hardwareSummaryParts } from './storageHardwareText.js'; // v2.599 C2599-06: 빈 슬롯·미확인을 이상과 나눠 말한다

/**
 * 특수기능 › 스토리지 모니터링(v2.302) — 글로벌 법인 스토리지(Isilon 우선, XtremIO·PowerStore·
 * PowerMax 등 확장 예정)의 사용량·버전·계정·노드 상태를 중앙에서 통합 조회.
 *
 * 데이터 흐름(사용자 설계 요구): 중앙에서 장비+수집 주체(엣지) 등록 → 엣지가 자기 몫을 pull →
 * 현지에서 OneFS API 수집 → 정규화 스냅샷을 중앙으로 push → 이 화면이 법인별/타입별/장비별로
 * 그룹핑해 표시(그룹핑은 프론트 — 뷰 추가에 서버 변경 불필요).
 * 조회는 전체 범위 계정 전용(서버 403 — 스토리지는 vCenter 범위 개념 밖), 등록/삭제는 admin.
 */
/**
 * 용량 표시(v2.406) — 화면 상단에서 고른 단위(자동/PB/TB/GB)를 따른다.
 * ⚠ 이 파일 안에서 tbFmt 는 표·상세·차트 27곳이 쓴다. 각 호출부에 단위를 인자로 넘기려면
 * 중첩 컴포넌트(표 셀·모달·차트) 전부에 prop 을 뚫어야 해서, 모듈 스코프 변수 하나를
 * StorageMonTool 렌더 시작 시 갱신하는 방식을 택했다(부모 본문이 자식 렌더보다 먼저 돌아
 * 항상 최신 값이 쓰인다). 단위 선택은 React state 라 바뀌면 전체가 다시 그려진다.
 * 포맷 규칙 자체는 storageUnits.js(순수·테스트로 고정)에 있다.
 */
let ACTIVE_UNIT = 'auto';
const tbFmt = (bytes) => formatBytes(bytes, ACTIVE_UNIT);
// bps 표기(isi status 스타일 — k/M/G). null 은 '—'(수집 실패를 0 으로 위장하지 않음).
const bps = (v) => (v == null ? '—' : v >= 1e9 ? `${(v / 1e9).toFixed(1)}G` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(Math.round(v)));
// 미디어 풀 셀(HDD/SSD 공용) — 사용/전체(%). null = 해당 미디어 없음(무디스크 노드 등).
const MediaCell = ({ m }) => (m ? <span title={`${tbFmt(m.usedBytes)} / ${tbFmt(m.totalBytes)}`}>{m.pct != null ? <UsageCell pct={m.pct} /> : <span className="muted">—</span>}<span className="muted" style={{ fontSize: 10.5, display: 'block' }}>{tbFmt(m.usedBytes)}/{tbFmt(m.totalBytes)}</span></span> : <span className="muted">—</span>);
const ago = (ts) => {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? `${s}초 전` : s < 3600 ? `${Math.round(s / 60)}분 전` : `${Math.round(s / 3600)}시간 전`;
};

/**
 * 수집 실패 사유 한 줄. snap.error 가 비면 섹션별 오류 문자열로 폴백한다 — 부분 실패(일부
 * 섹션만 오류)일 때도 사유가 반드시 드러나야 하기 때문이다(v2.316 에서 확인된 요구사항).
 * 목록의 '실패' 배지 툴팁과 상세 창이 같은 문자열을 쓰도록 여기 한 곳에 둔다.
 */
/** 부분 실패 사유(v2.422) — ok 인데 섹션 오류가 있으면 그 목록(없으면 ''). */
function partialReason(s) {
  return Object.entries(s?.sections || {}).filter(([, v]) => /오류/.test(String(v))).map(([k, v]) => `${k} ${v}`).join(' · ');
}

function failReason(s) {
  if (!s) return '수집 기록 없음';
  return s.error
    || Object.entries(s.sections || {}).filter(([, v]) => /오류/.test(String(v))).map(([k, v]) => `${k} ${v}`).join(' · ')
    || '사유 미상(장비 상세에서 섹션별 결과를 확인하세요)';
}

/**
 * 한 칸 렌더(v2.406) — ⚠ 렌더 함수 **밖**에 둔다(v2.417): 안에서 정의하면 매 렌더 새 컴포넌트 타입이 되어
 * 셀이 언마운트/재마운트되고 버튼 포커스가 끊긴다(StorageIntervals 와 같은 결함).
 * 원문: — 값 계산은 storageColumns.cellValue(순수, 테스트로 고정)가 하고
 * 여기서는 '어떻게 보일지'만 정한다. 값이 null 이면 '—'(0 으로 위장 금지).
 */
/**
 * 한 타입만 담긴 표(컬럼이 그 타입 전용). ⚠ 모듈 최상위 컴포넌트(v2.425, 리뷰 #7) — 예전에는 StorageMonTool 렌더 함수
 * 안에서 정의돼 30초 폴링마다 새 함수 타입이 되어 서브트리가 **재마운트**됐다(STable 정렬 상태·포커스·스크롤 소실).
 */
/**
 * **노드 장애 상세 팝업**(v2.523 — 사용자 요청 "장애표지 클릭하면 어떤 장애인지 확인하는 팝업").
 *
 * 판정·문구는 `storageNodeText.js`(순수, vitest 고정). 여기서는 조립만 한다.
 * ⚠ `상태 미확인`(unknown)을 **비정상으로도 정상으로도** 세지 않는다 — 수집기와 같은 기준이고,
 *   그 개수를 따로 밝힌다.
 * ⚠ 노드 목록이 없는 수집기에서는 **'어느 노드인지 모른다' 고 말한다**(지어내지 않는다).
 */
/**
 * VMAX/PowerMax 용량 구성(v2.534) — **구독 · 할당 · 실제 기록을 섞지 않는다**.
 * 사용자 신고 "할당량 말고 실제로 디스크에 기록한 사용량 보여줘" 에 대한 화면 쪽 답이다.
 * 값이 없으면 아무 것도 그리지 않는다(다른 타입 화면은 변화 없음).
 */
function PowerMaxCapacityPanel({ ex }) {
  const rows = capacityRows(ex);
  const srps = srpRows(ex);
  const subNote = subscribedNote(ex);
  const trust = usageTrust(ex);
  if (!rows.length && !srps.length && trust.kind !== 'suspect') return null;
  return (
    <div style={{ marginTop: 10 }}>
      {/* ⚠ 의심 경고를 맨 위에 — 아래 숫자를 읽기 전에 보아야 한다. */}
      {trust.text && (
        <div className="badge amber" style={{ display: 'block', padding: '8px 10px', whiteSpace: 'normal', lineHeight: 1.6, marginBottom: 8 }}>
          <BoldText text={trust.text} />
        </div>
      )}
      {rows.length > 0 && (
        <>
          <div className="muted" style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>용량 구성</div>
          <div className="table-wrap">
            <STable>
              <thead><tr><th>항목</th><th style={{ textAlign: 'right' }}>용량</th><th>설명</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.strong ? <b>{r.label}</b> : r.label}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                      {r.strong ? <b>{r.value}</b> : r.value}
                    </td>
                    <td className="muted" style={{ fontSize: 11.5, whiteSpace: 'normal', lineHeight: 1.6 }}>{r.desc}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
          </div>
          {subNote && <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>ℹ {subNote}</div>}
        </>
      )}
      {srps.length > 0 && (
        <>
          <div className="muted" style={{ fontSize: 12, fontWeight: 700, margin: '10px 0 4px' }}>SRP(풀)별</div>
          <div className="table-wrap">
            <STable>
              <thead><tr><th>SRP</th><th style={{ textAlign: 'right' }}>실제 기록</th><th style={{ textAlign: 'right' }}>전체</th><th style={{ textAlign: 'right' }}>사용률</th><th>비고</th></tr></thead>
              <tbody>
                {srps.map((x, i) => (
                  <tr key={`${x.array}-${x.id}-${i}`}>
                    <td style={{ whiteSpace: 'nowrap', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }} title={`${x.array ? `${x.array} · ` : ''}${x.id}`}>
                      {x.id}
                      {/* 어느 필드로 읽었는지 밝힌다 — 버전차를 추측 없이 진단하기 위해(v2.522 규약). */}
                      <div className="muted" style={{ fontSize: 10.5 }}>{x.basis}</div>
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{x.used}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{x.total}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{x.pct == null ? '—' : `${x.pct}%`}</td>
                    <td className="muted" style={{ fontSize: 11.5, whiteSpace: 'normal', lineHeight: 1.6 }}>{x.meta || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
          </div>
        </>
      )}
    </div>
  );
}

function NodeFaultModal({ r, typeLabel, onClose }) {
  const [onlyBad, setOnlyBad] = useState(true);
  const s = r?.snap || null;
  const sum = useMemo(() => nodeFaultSummary(s), [s]);
  const rows = useMemo(() => {
    const all = nodeRows(s);
    const list = onlyBad ? all.filter((x) => x.kind !== 'ok') : all;
    const ord = { bad: 0, unknown: 1, ok: 2 };
    return [...list].sort((a, b) => ord[a.kind] - ord[b.kind] || String(a.label).localeCompare(String(b.label), 'ko', { numeric: true }));
  }, [s, onlyBad]);
  if (!r) return null;
  return (
    <Modal title={`노드 상태 — ${s?.name || r.name || r.host}`} onClose={onClose} width={860}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10, minWidth: 0 }}>
        <div style={{ border: `1px solid var(--${sum.tone === 'red' ? 'red' : sum.tone === 'amber' ? 'amber' : 'border'})`, borderRadius: 8, padding: '9px 11px' }}>
          <div style={{ fontWeight: 700, color: sum.tone === 'red' ? 'var(--red)' : sum.tone === 'amber' ? 'var(--amber)' : undefined }}>{sum.title}</div>
          {sum.body && <div className="muted" style={{ fontSize: 12.5, marginTop: 3, whiteSpace: 'normal', lineHeight: 1.6 }}><BoldText text={sum.body} /></div>}
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            {typeLabel(r.type)} · {hostText(r.host)} · 수집 {s?.collectedAt ? new Date(s.collectedAt).toLocaleString() : '—'}
            {s?.sections?.nodes && s.sections.nodes !== 'ok' ? ` · 노드 수집: ${s.sections.nodes}` : ''}
          </div>
        </div>
        {!!sum.listed && (
          <>
            <div className="flex gap wrap" style={{ alignItems: 'center' }}>
              <button className={onlyBad ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '2px 9px', fontSize: 11 }} onClick={() => setOnlyBad(!onlyBad)}>
                {onlyBad ? '문제·미확인만 보는 중' : '전체 보는 중'}
              </button>
              <span className="muted" style={{ fontSize: 11.5 }}>전체 {sum.listed}대 · 이상 {sum.badRows.length} · 상태 미확인 {sum.unknown}</span>
            </div>
            <div className="table-wrap">
              <STable>
                <thead><tr><th>노드</th><th>IP</th><th>상태</th><th>장비 보고값</th><th>HDD</th><th>SSD</th><th>수신</th><th>송신</th></tr></thead>
                <tbody>
                  {rows.map((x) => {
                    const k = nodeKindLabel(x.kind);
                    return (
                      <tr key={x.key}>
                        <td><b>{x.label}</b></td>
                        <td className="muted" style={{ fontSize: 11.5 }}>{x.ip || '—'}</td>
                        <td data-sort={x.kind} style={{ color: `var(--${k.color})`, fontWeight: k.color === 'green' ? 400 : 600, whiteSpace: 'nowrap' }}>{k.label}</td>
                        {/* 장비가 보고한 원문 — 우리가 해석한 것과 나란히 두어 판정 근거를 숨기지 않는다. */}
                        <td><code style={{ fontSize: 11 }}>{x.health || '—'}</code></td>
                        <td data-sort={String(x.hddPct ?? -1)} style={{ textAlign: 'right' }}>{x.hddPct == null ? '—' : `${x.hddPct}%`}</td>
                        <td data-sort={String(x.ssdPct ?? -1)} style={{ textAlign: 'right' }}>{x.ssdPct == null ? '—' : `${x.ssdPct}%`}</td>
                        <td data-sort={String(x.inBps ?? -1)} style={{ textAlign: 'right' }}>{bpsText(x.inBps)}</td>
                        <td data-sort={String(x.outBps ?? -1)} style={{ textAlign: 'right' }}>{bpsText(x.outBps)}</td>
                      </tr>
                    );
                  })}
                  {!rows.length && <tr><td colSpan={8} className="muted">{onlyBad ? '이상·미확인 노드가 없습니다.' : '표시할 노드가 없습니다.'}</td></tr>}
                </tbody>
              </STable>
            </div>
          </>
        )}
        <div className="muted" style={{ fontSize: 11, whiteSpace: 'normal' }}>
          이 팝업은 <b>마지막 수집 스냅샷</b>을 보여 줍니다 — 장비에 새로 접속하지 않습니다. 최신 상태가 필요하면 그 장비의 <b>수집</b>을 먼저 누르세요.
        </div>
      </div>
    </Modal>
  );
}

function TypedTable({ list, type, caption, ctx, typeLabel, empty, onClear }) {
  const cols = columnsFor(type);
  return (
    <div style={{ marginBottom: caption ? 10 : 0 }}>
      {caption && (
        <div className="muted" style={{ fontSize: 12, margin: '0 0 4px 2px' }}>
          <span className="badge blue">{typeLabel(type)}</span> <span style={{ marginLeft: 4 }}>{list.length}대</span>
        </div>
      )}
      {/* ⚠ 표에 자체 세로 스크롤(max-height)을 다시 넣지 말 것 — 장비가 20대만 넘어도 페이지
          스크롤과 표 스크롤이 이중으로 겹쳐 목록을 훑기 불편하다(2026-09-02 사용자 지적). */}
      <div className="table-wrap">
        <STable>
          <thead><tr>{cols.map((c) => <th key={c.key} className={c.align === 'right' ? 'right' : undefined} style={c.align === 'right' ? { textAlign: 'right' } : undefined}>{c.label}</th>)}</tr></thead>
          <tbody>
            {/* ⚠ 여기에 '등록된 장비가 없습니다' 를 다시 하드코딩하지 말 것(v2.522, 사용자 신고
                '표에는 없는데 등록하면 있다고 나온다'): 필터가 걸린 0대에도 그 문구가 나와
                **42대가 등록돼 있는데 화면이 없다고 말하고 있었다**. 문구 판정은 순수 모듈
                storageListText.emptyListText 가 갖는다(웹 테스트가 node 환경이라 회귀 고정). */}
            {list.length === 0 && (
              <tr><td colSpan={cols.length} className="center muted" style={{ padding: 20 }}>
                {empty?.text || '등록된 장비가 없습니다 — "+ 장비 등록"으로 시작하세요.'}
                {empty?.canClear && onClear && (
                  <div style={{ marginTop: 8 }}>
                    <button className="qn-btn" onClick={onClear}>✕ 필터·찾기 해제하고 전체 보기</button>
                  </div>
                )}
              </td></tr>
            )}
            {list.map((r) => (
              <tr key={r.id} style={{ opacity: r.enabled === false ? 0.5 : 1 }}>
                {/* data-sort(v2.425): 셀이 컴포넌트라 STable 이 텍스트를 못 읽는다 — 정렬 값은 storageColumns.cellValue 로 준다. */}
                {cols.map((c) => <Cell key={c.key} col={c} r={r} ctx={ctx} data-sort={sortValue(c.key, r, ctx)} />)}
              </tr>
            ))}
          </tbody>
        </STable>
      </div>
    </div>
  );
}


/**
 * 장비 표(v2.406, 사용자 요구 '각각의 스토리지 전용 컬럼').
 * 스토리지 타입마다 의미 있는 지표가 다르다 — PowerStore 는 Physical/Logical/Data Reduction,
 * Isilon 은 HDD/SSD 풀, VPLEX 는 자체 용량이 없어 디렉터·헬스다. 하나의 고정 컬럼 집합으로는
 * 어떤 타입엔 빈 칸이, 어떤 타입엔 필요한 열이 없다.
 * 그래서 **목록에 여러 타입이 섞여 있으면 타입별로 표를 나눠** 각자의 전용 컬럼으로 그린다.
 * 단일 타입이면 표 하나(제목 없이) — 법인별/타입별 뷰에서 불필요한 머리글이 늘지 않게.
 */
function DeviceTable({ list, ctx, typeLabel, empty, onClear }) {
  const types = [...new Set(list.map((r) => r.type))];
  if (list.length === 0) return <TypedTable list={list} type={null} ctx={ctx} typeLabel={typeLabel} empty={empty} onClear={onClear} />;
  if (types.length === 1) return <TypedTable list={list} type={types[0]} ctx={ctx} typeLabel={typeLabel} />;
  // 여러 타입 — 타입별 표로 나눈다(타입 이름 순서 고정: 화면이 갱신마다 흔들리지 않게).
  const byType = types
    .map((t) => [t, list.filter((r) => r.type === t)])
    .sort((a, b) => String(typeLabel(a[0])).localeCompare(String(typeLabel(b[0]))));
  return <>{byType.map(([t, rows]) => <TypedTable key={t} list={rows} type={t} caption ctx={ctx} typeLabel={typeLabel} />)}</>;
}

function Cell({ col, r, ctx }) {
  const { setDetail, setNodeFault, typeLabel, dcName, busy, busyId, collectNow, setForm, remove } = ctx;
  const s = r.snap;
  const v = cellValue(col.key, r);
  const dash = <span className="muted">—</span>;
  switch (col.key) {
    case 'device': {
      // v2.530(사용자 요청 "'장비' 에 들어가는 데이터를 hostname 에서 획득한 장비 명을 넣어줘"):
      // **장비가 스스로 보고한 이름(`snap.name`)이 먼저**다. Isilon 은 `isi status` 의 클러스터
      // 이름, Unity/PowerStore 는 시스템·클러스터 이름 — 현장 콘솔에 찍히는 그 이름이다.
      //
      // ⚠ **v2.515 와 반대 방향이므로 그때의 불만이 재발하지 않게 해야 한다.** v2.514 까지
      //    스냅샷 이름이 우선이었고, 그래서 '수정' 폼에서 이름을 고쳐 저장해도 표가 그대로라
      //    사용자가 "수정하는데 수정사항이 반영되지 않는다" 고 신고했다(저장은 성공했다).
      //    원인은 순서가 아니라 **고친 값이 화면 어디에도 안 보였던 것**이다. 그래서 이번에는
      //    등록 표시명이 다르면 둘째 줄에 **`등록명` 이라고 라벨을 붙여** 보여준다 —
      //    이름을 고치면 그 줄이 즉시 바뀌므로 '반영이 안 됐다' 로 보이지 않는다.
      //    ⚠ 이 둘째 줄을 지우면 v2.515 결함이 그대로 되살아난다.
      //
      // 장비가 이름을 보고하지 않거나(수집 전·수집 실패) 등록명과 같으면 등록명만 보인다 —
      // 수집기들이 `snap.name = <장비 이름> || device.name` 으로 폴백하므로 빈 칸이 되지 않는다.
      const reported = s?.name || '';
      const differs = !!reported && !!r.name && reported !== r.name;
      return (
        <td>
          {/* ⚠ 첫 줄도 폭을 묶는다 — 장비가 보고한 이름은 길 수 있고(실측: 25자에서 장비 열
              101→195px), 묶지 않으면 표가 오른쪽으로 밀려 '작업' 열이 잘린다(v2.403 재발). */}
          <button className="cell-link" onClick={() => setDetail(r.id)} title={reported || r.name || r.host}
            style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block', textAlign: 'left' }}>
            <b>{reported || r.name || r.host}</b>
          </button>
          {/* ⚠ 둘째 줄에 상한·생략표시를 반드시 둘 것 — 없이 두면 이름이 장비 열을 넓혀
              (A/B 실측 108→136px) 표가 22px 넘치고 오른쪽 '작업' 열이 잘린다(v2.403 이
              고쳤던 문제의 재발). 전체 문자열은 title 로 남긴다. */}
          <div className="muted" title={differs ? `등록 표시명: ${r.name} · 장비가 보고한 이름: ${reported} · ${r.host}` : r.host}
            style={{ fontSize: 11, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {differs ? <>{'등록명 '}{r.name}{' · '}</> : null}
            {hostText(r.host)}
          </div>
        </td>
      );
    }
    case 'type':
      return <td><span className="badge blue">{typeLabel(r.type)}</span></td>;
    case 'dc':
      return <td className="muted">{dcName(r.datacenterId)}</td>;
    case 'collect': {
      /*
       * 수집 주체(중앙/엣지) + 방식 배지.
       * ⚠ v2.542 — **등록값이 주 배지**다. 예전에는 `s.extra.collectMethod`(마지막 수집이
       *   실제로 쓴 방식)를 먼저 봐서, 방식을 고쳐 저장해도 엣지가 다시 수집해 push 할 때까지
       *   옛 방식이 그대로 보였다(사용자 신고 `OC2-unity-01`: "저장했는데 새로고침해도 API").
       *   v2.515 장비 이름 열과 **같은 유형**이고, 해법도 같다 — 둘을 나란히 보여준다.
       *   판정·문구는 `storageMethodText.js` 하나가 갖는다(주기 숫자를 문구에 박지 않는다).
       */
      const mv = collectMethodView({
        registered: r.collectMethod, lastUsed: s?.extra?.collectMethod, hasSnap: !!s, agent: r.agent,
      });
      return (
        <td>{r.agent ? <span className="badge" style={{ background: 'rgba(167,139,250,.2)', color: '#a78bfa' }}>{r.agent}</span> : <span className="muted">중앙</span>}
          <span className={`badge ${mv.tone}`} style={{ marginLeft: 4, fontSize: 10 }} title={mv.title}>{mv.label}</span>
          {mv.pending && (
            <span className="badge amber" style={{ marginLeft: 4, fontSize: 10, whiteSpace: 'nowrap' }} title={mv.pending.title}>{mv.pending.label}</span>
          )}
        </td>
      );
    }
    case 'version':
      /*
       * ⚠ 표시값은 빌드 문자열에서 뽑은 점 버전이다(`5.4.0.0.5.094`). **원문을 title 로 남긴다** —
       * 추출이 다른 장비에서 빗나갈 수 있으므로 사용자가 대조할 수 있어야 한다(v2.544).
       */
      {
        // v2.585 — 빈 값의 **이유**를 열이 말한다(사용자 신고 "Unity 버전명 안나오는거 개선"). 판정·문구는 storageVersionText 하나.
        const vi = versionCellInfo(s);
        return (
          <td className="muted" style={{ fontSize: 12 }} title={vi.title || undefined}>
            {vi.text}
            {vi.mark ? <span style={{ marginLeft: 4, color: vi.kind === 'timeout' ? 'var(--amber)' : 'var(--text-dim)', cursor: 'help' }} aria-label="버전이 비어 있는 이유">{vi.mark}</span> : null}
          </td>
        );
      }
    case 'usage':
      return (
        <td style={{ minWidth: col.minWidth }}>
          {v != null ? <UsageCell pct={v} /> : dash}
          {/* v2.534: 문서화되지 않은 필드로 읽었고 사용 == 전체면 **목록에서도** 알린다 —
              상세를 열어야만 알 수 있으면 사용자는 100% 를 용량 부족으로 읽는다. */}
          {usageTrust(s?.extra).short
            ? <span className="badge amber" style={{ marginLeft: 4, fontSize: 10 }} title={String(usageTrust(s?.extra).text || '').replace(/\*\*/g, '')}>{usageTrust(s?.extra).short}</span>
            : null}
          {s?.capacity?.totalBytes ? <div className="muted" style={{ fontSize: 10.5 }}>{tbFmt(s.capacity.usedBytes)} / {tbFmt(s.capacity.totalBytes)}</div> : null}
        </td>
      );
    case 'hdd': case 'ssd':
      return <td style={{ minWidth: col.minWidth }}><MediaCell m={v} /></td>;
    case 'capTotal': case 'capUsed': case 'capFree': case 'physical': case 'logical':
      return <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{v != null ? tbFmt(v) : dash}</td>;
    case 'dataReduction':
      return <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} title="논리 사용량 ÷ 물리 사용량(중복제거·압축 효과)">{v != null ? `${v.toFixed(2)}:1` : dash}</td>;
    case 'nodes':
      /*
       * ⚠ 장애 표지는 **버튼**이다(v2.523, 사용자 요청 "장애표지 클릭하면 어떤 장애인지 확인하는
       *   팝업 만들어줘"). v2.522 까지 클릭되지 않는 `<b>` 여서 `24 ⚠1` 을 보고도 **어느 노드가
       *   비정상인지 알 방법이 없었다**. 실패 사유를 툴팁에만 두지 않는다는 v2.516 규약과 같다.
       */
      return (
        <td style={{ textAlign: 'right' }}>
          {v == null ? dash : (
            <>
              {s?.nodes?.count ? (
                <button type="button" className="cell-link" title={faultBadgeTitle(s)} onClick={() => setNodeFault(r.id)}>{v}</button>
              ) : v}
              {s?.nodes?.unhealthy
                ? <button type="button" className="badge red fail-badge" style={{ marginLeft: 4 }} title={faultBadgeTitle(s)} onClick={() => setNodeFault(r.id)}>⚠{s.nodes.unhealthy}</button>
                : null}
            </>
          )}
        </td>
      );
    case 'health':
      {
        /*
         * ⚠ v2.586 — 예전 인라인 판정 `/ok|healthy|normal/i` 는 **앵커가 없어** 'Broken'·'Not OK' 의
         *   부분 문자열 'ok' 에 걸려 **초록**으로 칠했고, 'unknown' 은 빨강이었다(색과 글자가 반대말 —
         *   v2.526 이 상세 배지에서 고친 것과 같은 결함이 표 열에 남아 있었다). 판정은 `healthBadge` 하나.
         */
        if (!v) return <td>{dash}</td>;
        const hb = healthBadge(v);
        return <td><span className={`badge ${hb.tone}`} title={hb.title}>{v}</span></td>;
      }
    case 'status':
      return (
        <td>
          {/* ⚠ 실패 사유를 이 칸에 '항상 보이는 한 줄'로 넣지 말 것 — 사유가 길면 상태 열이
              넓어져 표가 컨테이너를 넘고 오른쪽 '작업' 열이 잘린다(v2.403 실측·수정).
              사유는 자리를 차지하지 않는 경로로만: 호버=title, 클릭=상세 창. */}
          {/* MOCK 배지(v2.408) — 수집 노드가 DATA_SOURCE=mock 이면 값이 전부 가짜다.
              예전에는 version 의 '(mock)' 괄호로만 드러나 진짜 수집값처럼 보였다. */}
          {s?.extra?.mock && (
            <span className="badge red" style={{ marginRight: 4 }}
              title={'이 장비의 값은 실제 수집이 아니라 개발용 가짜 데이터입니다.\n'
                + '수집 노드(중앙 또는 엣지)가 DATA_SOURCE=mock 으로 실행 중입니다.\n'
                + 'portal.env 에 DATA_SOURCE=live (또는 EDGE_MODE=all) 를 넣고 재시작하세요.'}>MOCK</span>
          )}
          {/* 부분 실패(v2.422): 접속·구성은 됐지만 용량 등 일부 섹션이 실패한 장비 — 예전에는 '정상 + 0.0 TB' 로
              보여 수집이 되는 줄 알았다(PowerStore 실측). 사유는 실패 배지와 같은 경로(툴팁/상세 창)로. */}
          {!s ? <span className="badge gray">수집 전</span> : s.ok ? (
            partialReason(s)
              ? <button type="button" className="badge amber fail-badge" onClick={() => setDetail(r.id)}
                  title={`부분 실패 — 접속은 됐지만 일부 섹션을 수집하지 못했습니다:\n${partialReason(s)}\n\n(클릭하면 상세 창에서 전체 내용을 봅니다)`}>
                  부분 <span aria-hidden="true">ⓘ</span>
                </button>
              : <span className="badge green" title={s?.nodes?.unhealthy
                  ? `수집 성공 — 이 표지는 수집 성패이고 장비 헬스와 별개입니다. 이 장비는 비정상 노드가 ${s.nodes.unhealthy}대 있습니다(노드 열의 ⚠ 표지를 누르세요).`
                  : '수집 성공 — 이 표지는 수집 성패이고 장비 헬스와 별개입니다(헬스·노드 열을 보세요).'}>정상</span>
          ) : (
            <button type="button" className="badge red fail-badge" onClick={() => setDetail(r.id)}
              title={`실패 사유: ${failReason(s)}\n\n(클릭하면 상세 창에서 전체 내용을 봅니다)`}>
              실패 <span aria-hidden="true">ⓘ</span>
            </button>
          )}
          <div className="muted" style={{ fontSize: 10.5 }}>{ago(s?.collectedAt)}{s?.agent ? ` · ${s.agent}` : ''}</div>
        </td>
      );
    case 'actions':
      return (
        <td className="right" style={{ whiteSpace: 'nowrap' }}>
          {/* ⚠ v2.529(사용자 신고 "이 상태에서 수정 버튼 누르면 수정 창이 안떠"): 예전에는 세 버튼이
              전부 **전역** `busy` 로 잠겼다. 한 장비를 수집하는 동안 **다른 장비의 수정·삭제까지**
              죽었고, Unity 수집이 최대 2분 넘게 걸리게 되면서(v2.526 명령 24개 + v2.528 예산 150초)
              그 창이 몇 초 → 수 분으로 늘었다. 게다가 **왜 안 눌리는지 화면이 말하지 않았다**.
              이제 수집은 **그 장비만**(`busyId`) 잠그고, 수정은 언제나 열린다 —
              401 같은 상황에서 자격증명을 고치는 것이 바로 그 순간 필요한 조치이기 때문이다. */}
          <button className="logout-btn" style={{ padding: '3px 8px', fontSize: 11.5 }} disabled={busy || busyId === r.id}
            onClick={() => collectNow(r.id)}
            title={busyId === r.id ? '이 장비를 수집하는 중입니다 — 끝나면 다시 누를 수 있습니다'
              : busy ? '전체 작업이 진행 중입니다' : (r.agent ? '엣지 수집 장비 — 주기 반영 안내' : '지금 수집(연결 테스트)')}>
            {busyId === r.id ? '수집 중…' : '수집'}
          </button>
          {' '}<button className="logout-btn" style={{ padding: '3px 8px', fontSize: 11.5 }} onClick={() => setForm({ ...r, password: '' })}
            title="등록 정보·자격증명 수정 — 수집 중에도 열립니다">수정</button>
          {' '}<button className="logout-btn" style={{ padding: '3px 8px', fontSize: 11.5, color: 'var(--red)' }}
            disabled={busy || busyId === r.id} onClick={() => remove(r)}
            title={busyId === r.id ? '이 장비를 수집하는 중입니다 — 끝난 뒤 삭제하세요' : '장비 삭제'}>삭제</button>
        </td>
      );
    default:
      return <td style={{ textAlign: col.align === 'right' ? 'right' : undefined }}>{v == null || v === '' ? dash : v}</td>;
  }
}

export default function StorageMonTool() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  // v2.529: '지금 수집' 은 그 장비만 잠근다(전역 busy 는 전체 새로고침·삭제 같은 진짜 전역 작업용).
  const [busyId, setBusyId] = useState(null);
  // 하위 탭을 URL 에 실어 새로고침·북마크·뒤로가기에서 유지한다(v2.438, hooks/useHashTab.js).
  const [view, setView] = useHashTab({ base: ['tools', 'storage-mon'], valid: ['devices', 'dc', 'type', 'trend'], fallback: 'devices' });
  const [detail, setDetail] = useState(null);    // 장비 상세 모달 — id 로 보관(v2.306: load() 후 최신 스냅샷 자동 반영)
  // 노드 장애 팝업(v2.523) — 같은 이유로 **id 로** 보관한다(폴링 후 최신 스냅샷이 자동 반영).
  const [nodeFault, setNodeFault] = useState(null);
  const [form, setForm] = useState(null);        // 등록/수정 폼
  const [importOpen, setImportOpen] = useState(false); // CSV 가져오기 모달(v2.313)
  const [exportOpen, setExportOpen] = useState(false); // CSV 내보내기 모달(v2.317 — 비밀번호 포함 선택)
  // 법인 바로가기(사용자 요구 2026-09-02) — Platform 화면의 vCenter 바로가기와 같은 UX.
  // ⚠ 훅은 아래 조기 return(`if (!d) return <Loading/>`)보다 위에 선언해야 한다 — 렌더 간 훅
  // 개수가 달라지면 React #310 으로 화면 전체가 크래시한다(CLAUDE.md 프론트엔드 회귀 방지).
  const [dcQuery, setDcQuery] = useState('');
  // 용량 표시 단위(v2.406, 사용자 요구 — PowerScale 사용량 추적). 브라우저에 기억한다.
  const [unit, setUnit] = useState(loadUnit);
  ACTIVE_UNIT = unit; // 아래 자식(표 셀·상세 모달·차트)이 그리기 전에 반영된다(tbFmt 주석 참고)
  // 법인·장비 종류 다중 선택 필터(v2.407, 사용자 요구). 빈 Set = 전체(필터 없음).
  // 두 축은 AND 로 결합한다 — 'AZ,WA + PowerScale' 이면 AZ·WA 에 있는 PowerScale 만 보인다.
  const [dcSel, setDcSel] = useState(() => new Set());
  const [typeSel, setTypeSel] = useState(() => new Set());
  const toggleDc = (v) => setDcSel((prev) => toggleSet(prev, v));
  const toggleType = (v) => setTypeSel((prev) => toggleSet(prev, v));
  const clearFacets = () => { setDcSel(new Set()); setTypeSel(new Set()); };

  const load = () => fetchJson('/tools/storage').then((r) => { setD(r); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, []);
  if (err && !d) return <ErrorBox message={err} />;
  if (!d) return <Loading />;

  const rows = d.devices || [];
  const dcName = (id) => ((d.datacenters || []).find((x) => x.id === id)?.name || id || '미지정');
  const typeLabel = (t) => ((d.types || []).find((x) => x.type === t)?.label || t);
  const sum = (list, f) => list.reduce((a, x) => a + (f(x) || 0), 0);
  const withSnap = rows.filter((r) => r.snap);
  // v2.594(감사 R2594-02): 사용률은 사용량을 읽은 장비끼리만 — 결측을 0 으로 더하면 사용률이 과소로 보인다.
  const capAll = capacityTotals(withSnap, (r) => r.snap.capacity);
  const totals = {
    total: capAll.total,
    used: capAll.used,
    usedPct: capAll.pct,
    unknownUsed: capAll.unknownUsed,
    fail: rows.filter((r) => r.snap && !r.snap.ok).length + rows.filter((r) => !r.snap).length,
    alerts: sum(withSnap, (r) => r.snap.alerts?.unresolved),
  };
  /**
   * 빠른 찾기 판정(사용자 요구 2026-09-02) — 검색은 **칩 이름이 아니라 하단 스토리지 목록**을
   * 거른다. 판정 단위는 장비 1대이고, 그 장비의 법인·표시명·host·타입·수집주체(엣지)를 모두
   * 건초더미에 넣는다. 공백 구분 다중 키워드 AND(Platform 빠른 찾기와 같은 규칙).
   * ⚠ 그룹핑은 반드시 '거른 뒤'에 한다 — 먼저 그룹핑하고 그룹명만 비교하면 장비명으로 찾을 수
   * 없고, 매칭된 법인 안에 매칭되지 않은 장비까지 같이 나온다.
   */
  // v2.532: 판정은 공용 순수 모듈이 한다(deviceFacets). 검색 건초더미에 **수집 스냅샷 이름**
  // (`r.snap?.name`)을 더하는 것만 이 화면 고유다 — 장비가 보고한 이름으로도 찾게.
  const { searched, shown, dcChips, typeChips, facetOn } = facetState({
    rows, dcSel, typeSel, query: dcQuery, dcName, typeLabel,
    hay: (r) => [dcName(r.datacenterId), r.name, r.snap?.name, r.host, typeLabel(r.type), r.agent],
  });
  // v2.522: 목록이 비었을 때 **왜** 비었는지(등록 0 / 필터 0 / 검색 0)를 구분한다 —
  // 판정·문구는 순수 모듈(storageListText)에 있고 테스트가 고정한다.
  const emptyInfo = emptyListText({ registered: rows.length, facetOn, query: dcQuery });
  // 칩 목록·개수는 공용 판정이 준다(위 facetState). 그룹핑도 공용 groupBy 를 쓰되,
  // 이 화면의 기존 소비부가 `[key, list]` 튜플 배열을 기대하므로 형태만 맞춰 준다.
  const groupShown = (keyFn) => groupByKey(shown, keyFn).map((g) => [g.key, g.list]);
  // 법인 그룹 1회 계산 — 바로가기 칩과 '법인별' 뷰가 같은 배열을 쓴다(그룹핑 중복 순회 방지).
  // 검색 중이면 매칭 장비만 남은 그룹이므로 칩도 자동으로 같이 좁혀진다(칩/목록 불일치 방지).
  const dcGroups = groupShown((r) => dcName(r.datacenterId));
  /**
   * 법인 그룹 요약(바로가기 칩의 점 색·툴팁). 색 규칙은 화면 다른 곳과 어긋나지 않게 맞춘다:
   *   빨강 = 수집 실패/대기 장비 있음(= KPI '수집 실패/대기' 와 동일 판정)
   *   노랑 = 미해결 경보 있음
   *   그 외 = 사용률 기준 usageColor(75%↑ 노랑 · 90%↑ 빨강, primitives.jsx 공용 임계값)
   * 사용률은 '수집된 장비'만으로 계산한다 — 실패 장비를 0 으로 섞으면 사용률이 낮게 위장된다.
   */
  const dcSummary = (list) => {
    const ok = list.filter((r) => r.snap && r.snap.ok);
    const fail = list.filter((r) => !r.snap || !r.snap.ok).length;
    const cap = capacityTotals(ok, (r) => r.snap.capacity);
    const total = cap.total;
    const used = cap.used;
    const pct = cap.pct ?? 0;   // 점 색 판정용 — 읽은 장비가 없으면 색 기준만 정상으로 둔다
    const alerts = sum(ok, (r) => r.snap.alerts?.unresolved);
    const dot = fail ? 'var(--red)' : alerts ? 'var(--amber)' : usageColor(pct);
    return { fail, total, used, pct, pctKnown: cap.pct, unknownUsed: cap.unknownUsed, alerts, dot };
  };


  const collectNow = async (id) => {
    // 전역 busy 를 켜지 않는다 — 한 장비 수집이 다른 장비의 수정·삭제를 막으면 안 된다(v2.529).
    setBusyId(id); setMsg(null);
    try { const r = await postJson(`/tools/storage/devices/${encodeURIComponent(id)}/collect`, {}); setMsg(r.ok ? '수집 완료 — 갱신됨' : r.reason); await load(); }
    catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusyId(null); }
  };
  const remove = async (r) => {
    if (!window.confirm(`'${r.name}' (${r.host}) 장비를 삭제할까요? (수집 이력 스냅샷도 화면에서 제거)`)) return;
    setBusy(true); try { await delJson(`/tools/storage/devices/${encodeURIComponent(r.id)}`); await load(); } catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusy(false); }
  };
  // 전체 새로고침(v2.315) — 중앙 직접 장비 즉시 재수집 + 화면 갱신. 엣지 장비는 원격 강제 불가라
  // '다음 주기 반영'으로 안내만 한다(서버 collect-all 이 수를 세어 돌려줌 — 과장 없이 정직하게).
  const refreshAll = async () => {
    setBusy(true); setMsg('전체 새로고침 중…');
    try {
      const r = await postJson('/tools/storage/collect-all', {});
      if (r.ok) {
        const res = r.result || {};
        // v2.582 BUG-2: 엣지 위임 장비도 재수집 요청이 등록된다(SAN 스위치와 같은 규약) — '요청 N건' 으로 나눠 말한다.
        const edgeText = r.edge
          ? ` · 엣지 ${r.edge}대는 요청 등록 ${r.requested ?? 0}건${r.alreadyQueued ? `(이미 대기 ${r.alreadyQueued}건)` : ''} — 다음 설정 pull 때 수집·push`
          : '';
        setMsg(res.skipped
          ? `이미 수집이 진행 중입니다 — 잠시 후 반영됩니다${edgeText}`
          : `중앙 ${r.central}대 재수집 완료(성공 ${res.ok || 0}·실패 ${res.fail || 0})${edgeText}`);
      } else setMsg(r.reason || '새로고침 실패');
      await load();
    } catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusy(false); }
  };

  // 셀 렌더 컨텍스트 — Cell 은 최상위 컴포넌트(아래 참조)라 매 렌더 재마운트되지 않는다(v2.417).
  const cellCtx = { setDetail, setNodeFault, typeLabel, dcName, busy, busyId, collectNow, setForm, remove };

  return (
    <div>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 12 }}>
        <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} onClick={() => setForm({ type: 'isilon', name: '', host: '', username: 'root', password: '', agent: '', datacenterId: '', collectMethod: 'ssh', sshPort: 22, enabled: true })}>+ 장비 등록</button>
        {['devices', 'dc', 'type', 'trend'].map((v) => (
          <button key={v} className={view === v ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '7px 13px' }} onClick={() => setView(v)}>
            {v === 'devices' ? '🗄 장비별' : v === 'dc' ? '🏢 법인별' : v === 'type' ? '📦 타입별' : '📈 추이'}
          </button>
        ))}
        {/* CSV 일괄 관리(v2.313, 사용자 요구) — 내보내기·가져오기·샘플. v2.317: 내보내기는
            비밀번호 포함 여부를 고르는 모달로(포함은 소유자 게이트 — 자격증명 덤프). */}
        <span style={{ width: 1, height: 22, background: 'var(--border)', margin: '0 2px' }} />
        <button className="tab" style={{ flex: 'none', padding: '7px 13px' }} title="현재 등록 장비를 CSV 로 내려받기(비밀번호 포함 여부 선택)"
          onClick={() => setExportOpen(true)}>⬇ CSV 내보내기</button>
        {/* v2.513(사용자 요청): CSV + 자유텍스트 대량 등록 — 형식 검증 → 실제 연결 테스트 →
            통과분만 선택 등록 + 실패 행 수정 조언. 샘플·내보내기도 이 모달 안에 있다(두 형식 모두).
            공용 컴포넌트를 SAN 스위치 화면과 **함께** 쓴다(복제 금지 — BulkDeviceIo 헤더 주석). */}
        <button className="tab" style={{ flex: 'none', padding: '7px 13px' }}
          title="CSV 또는 자유텍스트로 장비를 일괄 등록/수정합니다. 샘플 내려받기·형식 검증·실제 연결 테스트·선택 등록을 한 창에서 합니다."
          onClick={() => setImportOpen(true)}>⬆ 대량 등록(CSV·텍스트)</button>
        {/* 전체 새로고침(v2.315, 사용자 요구) — 중앙 직접 장비 즉시 재수집 + 화면 갱신(엣지는 다음 주기). */}
        <span style={{ width: 1, height: 22, background: 'var(--border)', margin: '0 2px' }} />
        <button className="tab" style={{ flex: 'none', padding: '7px 13px' }} disabled={busy}
          title="중앙 직접 수집 장비를 지금 다시 수집하고 화면을 갱신합니다(엣지 위임 장비는 재수집 요청을 등록 — 다음 설정 pull 때 수집)"
          onClick={refreshAll}>🔄 전체 새로고침</button>
        {/* 용량 단위(v2.406, 사용자 요구) — 자동(PB 접기)은 1.30→1.31 PB 처럼 소수 둘째 자리에서만
            움직여 하루치 증가(수 TB)가 묻힌다. TB/GB 로 고정하면 증가가 그대로 드러난다.
            표·상세·추이 차트가 모두 이 선택을 따른다. */}
        <span style={{ width: 1, height: 22, background: 'var(--border)', margin: '0 2px' }} />
        <label className="muted flex gap" style={{ alignItems: 'center', fontSize: 12, gap: 6 }}
          title="용량 표시 단위입니다. 사용량 증가를 추적할 때는 TB 또는 GB 로 고정하면 변화가 잘 보입니다.">
          단위
          <select className="select" style={{ padding: '5px 8px', fontSize: 12 }} value={unit}
            onChange={(e) => setUnit(saveUnit(e.target.value))}>
            {UNIT_OPTIONS.map((u) => <option key={u.value} value={u.value} title={u.hint}>{u.label}</option>)}
          </select>
        </label>
        {msg && <span className="muted" style={{ fontSize: 12.5 }}>{msg}</span>}
      </div>

      {/* 요약 KPI — 전 법인 합산 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 14 }}>
        <Kpi label="장비" value={rows.length} meta={`수집됨 ${withSnap.length}`} />
        <Kpi label="총 용량" value={tbFmt(totals.total)} />
        <Kpi label="사용" value={tbFmt(totals.used)} pct={totals.usedPct ?? undefined}
          meta={totals.unknownUsed ? `사용량 미확인 ${totals.unknownUsed}대 제외` : undefined} />
        <Kpi label="수집 실패/대기" value={totals.fail} accent={totals.fail ? 'var(--red)' : 'var(--green)'} />
        <Kpi label="미해결 경보" value={totals.alerts} accent={totals.alerts ? 'var(--amber)' : undefined} />
      </div>

      {/* 법인 바로가기(사용자 요구 2026-09-02) — Platform 화면의 vCenter 바로가기와 동일한 UX/스타일.
          어느 뷰에서 눌러도 '법인별' 로 전환해 그 법인 블록으로 스크롤한다(칩 자체가 '법인별로
          보기' 단축키). '추이' 뷰는 법인 블록이 없어 바를 감춘다. */}
      {/* ⚠ 표시 조건은 dcGroups(검색 반영)가 아니라 **전체 장비 수**로 판단한다 — 검색 결과가
          0건일 때 바가 통째로 사라지면 그 안의 검색창까지 없어져 사용자가 자기가 친 글자를
          지울 수 없다(무결과 = 영구 빈 화면). 실제로 그 상태를 만들었다가 잡은 결함이다. */}
      {view !== 'trend' && rows.length > 0 && (
        <DeviceFacetBar
          dcChips={dcChips} typeChips={typeChips} dcSel={dcSel} typeSel={typeSel}
          onToggleDc={toggleDc} onToggleType={toggleType} onClear={clearFacets}
          query={dcQuery} onQuery={setDcQuery} typeLabel={typeLabel}
          dcMeta={(list) => {
            const g = dcSummary(list);
            return {
              dot: g.dot,
              bad: !!g.fail,
              title: `${list.length}대 · ${tbFmt(g.used)} / ${tbFmt(g.total)}${g.pctKnown != null ? ` (${g.pctKnown}%)` : ''}${g.unknownUsed ? ` · 사용량 미확인 ${g.unknownUsed}대` : ''}`
                + `${g.fail ? ` · 수집 실패/대기 ${g.fail}` : ''}${g.alerts ? ` · 미해결 경보 ${g.alerts}` : ''}`,
            };
          }} />
      )}

      {/* 선택 요약 — 지금 무엇으로 걸러진 목록인지 한 줄로(빈 화면·부분 목록 오해 방지). */}
      {facetOn && (
        <div className="muted" style={{ fontSize: 12, margin: '0 0 8px 2px' }}>
          {dcSel.size > 0 && <>법인 <b style={{ color: 'var(--text)' }}>{[...dcSel].join(', ')}</b></>}
          {dcSel.size > 0 && typeSel.size > 0 && ' · '}
          {typeSel.size > 0 && <>종류 <b style={{ color: 'var(--text)' }}>{[...typeSel].map(typeLabel).join(', ')}</b></>}
          {' — '}장비 {shown.length}대 (전체 {rows.length}대 중)
          {shown.length === 0 && <span style={{ color: 'var(--amber)' }}> · 조건에 맞는 장비가 없습니다</span>}
        </div>
      )}

      {/* 검색 결과 안내 — 몇 대가 걸렸는지, 없으면 왜 비었는지 알려준다(빈 화면 오해 방지). */}
      {dcQuery.trim().length > 0 && (
        shown.length === 0
          ? <div className="card" style={{ padding: '14px 16px', marginBottom: 12, color: 'var(--text-dim)', fontSize: 12.5 }}>
              "{dcQuery}" 와 일치하는 장비가 없습니다 — 법인명·장비명·host·타입·엣지에서 검색합니다.
            </div>
          : <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              🔎 "{dcQuery}" — 법인 {dcGroups.length}곳 · 장비 {shown.length}대 (전체 {rows.length}대 중)
            </div>
      )}

      {form && <DeviceForm d={d} form={form} setForm={setForm} onSaved={() => { setForm(null); load(); }}
        /* v2.522: 중복으로 막혔을 때 그 장비를 실제로 보여준다 — 필터·찾기를 풀고(시야 밖이었던
           것이 원인) 그 host 로 좁힌 뒤 등록 폼을 닫는다. 'devices' 뷰로 되돌려야 표에 나온다. */
        onShowConflict={(c) => { clearFacets(); setDcQuery(c.host || ''); setView('devices'); setForm(null); }} />}
      {importOpen && (
        <BulkDeviceIo base="/tools/storage" title="스토리지 장비 대량 등록 — CSV · 자유텍스트" keyLabel="host+type"
          onClose={() => setImportOpen(false)} onDone={() => { setImportOpen(false); load(); }} />
      )}
      {exportOpen && <CsvExport onClose={() => setExportOpen(false)} />}

      {view === 'devices' && <DeviceTable list={shown} ctx={cellCtx} typeLabel={typeLabel}
        empty={emptyInfo} onClear={() => { clearFacets(); setDcQuery(''); }} />}
      {/* 통합 추이(v2.380) — 전체 합산 + 장비별 선택. 기간 12시간/24시간/1주 등.
          여기는 검색을 적용하지 않는다(전체 합산 차트라 부분집합이면 '전체'가 거짓이 된다). */}
      {view === 'trend' && <StorageTrendPanel devices={rows} />}
      {view === 'dc' && dcGroups.map(([dc, list]) => {
        const cg = capacityTotals(list.filter((r) => r.snap), (r) => r.snap.capacity);
        const t = cg.total; const u = cg.used;
        return (
          <div key={dc} style={{ marginBottom: 14 }}>
            <div className="section-title" style={{ fontSize: 14 }}>🏢 {dc} <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>— 장비 {list.length} · {tbFmt(u)} / {tbFmt(t)}{cg.pct != null ? ` (${cg.pct}%)` : ''}{cg.unknownUsed ? ` · 사용량 미확인 ${cg.unknownUsed}대 제외` : ''}</span></div>
            <DeviceTable list={list} ctx={cellCtx} typeLabel={typeLabel} />
          </div>
        );
      })}
      {view === 'type' && groupShown((r) => typeLabel(r.type)).map(([ty, list]) => (
        <div key={ty} style={{ marginBottom: 14 }}>
          <div className="section-title" style={{ fontSize: 14 }}>📦 {ty} <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>— 장비 {list.length}</span></div>
          <DeviceTable list={list} ctx={cellCtx} typeLabel={typeLabel} />
        </div>
      ))}

      {/* mock 경고(v2.408, 사용자 신고 '왜 mock 이라고 나와?') — 설정 누락만으로 가짜 데이터가
          중앙까지 흘러올 수 있어(config.js dataSource 기본값이 mock) 화면 상단에 분명히 알린다.
          어느 수집 노드가 문제인지(중앙/엣지 이름)까지 적어야 바로 조치할 수 있다. */}
      {(() => {
        const mocks = rows.filter((r) => r.snap?.extra?.mock);
        if (!mocks.length) return null;
        const nodes = [...new Set(mocks.map((r) => r.snap?.agent || r.agent || '중앙'))];
        return (
          <div className="card" style={{ padding: '10px 13px', marginTop: 8, borderColor: 'var(--red)', fontSize: 12.5 }}>
            <b style={{ color: 'var(--red)' }}>⚠ 가짜(mock) 데이터 {mocks.length}대</b> — 용량·노드·계정이 실제 수집값이 아닙니다.
            {' '}수집 노드: <b>{nodes.join(', ')}</b>.
            {' '}해당 노드의 <code>portal.env</code> 에 <code>DATA_SOURCE=live</code>(또는 <code>EDGE_MODE=all</code>)를 넣고 재시작하세요 —
            {' '}설정이 없으면 기본값이 <code>mock</code> 이라 조용히 가짜 데이터가 수집됩니다.
          </div>
        );
      })()}

      {(d.orphans || []).length > 0 && (
        <div className="card" style={{ padding: '9px 13px', marginTop: 8, borderColor: 'var(--amber)', fontSize: 12 }}>
          ⚠ 등록부에 없는 스냅샷 {d.orphans.length}건(삭제된 장비의 엣지 잔존 push) — 다음 엣지 push 주기에 자연 소멸합니다.
        </div>
      )}
      {/* v2.599(AUTHZ-2599-03): 비-admin 에는 관리 IP·계정이 가려져 온다 — 빈 칸의 이유를 한 번 말한다 */}
      {addressHiddenNote(d) && (
        <div className="card" style={{ padding: '9px 13px', marginTop: 8, fontSize: 12 }}>
          🔒 <BoldText text={addressHiddenNote(d)} />
        </div>
      )}
      {/* v2.591: 엣지가 가져갔지만 결과가 오지 않아 폐기된 '지금 수집' 요청 — 배지만 조용히 꺼지지 않게 */}
      {(() => {
        const t = collectDropNote(d.collectDrops, (id) => (d.devices || []).find((x) => x.id === id)?.name || id);
        return t ? (
          <div className="card" style={{ padding: '9px 13px', marginTop: 8, borderColor: 'var(--amber)', fontSize: 12 }}>
            ⚠ <BoldText text={t} />
          </div>
        ) : null;
      })()}
      {/* v2.581(BUG-D): 엣지가 '장비 0대' 로 상태 전용 보고를 보냈을 때 — 예전에는 아예 POST 가 없어 구분할 수 없었다 */}
      {edgeReportNotes(d.edgeReports).map((n) => (
        <div key={n.agent} className="card" style={{ padding: '9px 13px', marginTop: 8, borderColor: n.tone === 'warn' ? 'var(--amber)' : 'var(--border)', fontSize: 12 }}>
          {n.tone === 'warn' ? '⚠ ' : 'ℹ '}<BoldText text={n.text} />
        </div>
      ))}
      <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
        수집 주기 {Math.round((d.poller?.intervalMs || 0) / 60000)}분 · 엣지 장비는 설정 pull(≤{edgeIntervalText(d.edgeIntervals?.configPull)}) 후 현지 수집 → 중앙 push(≤{edgeIntervalText(d.edgeIntervals?.push)}){d.edgeIntervals && (d.edgeIntervals.configPull?.source === 'default' || d.edgeIntervals.push?.source === 'default') ? ' — 기본값 기준(현장 portal.env 로 바꾼 엣지는 그 값)' : ''}.
        확장 로드맵(카탈로그): {(d.types || []).filter((t) => !t.implemented).map((t) => t.label).join(' · ')} — 수집기 구현 시 이 화면 변경 없이 표시됩니다.
      </div>

      {/* 수집 작업 로그(v2.315 사용자 요구 → v2.516 공용 컴포넌트로 이관).
          SAN 스위치도 같은 패널을 요구받아 `CollectActivity` 로 뽑았다 — 복사하면 폴링 주기·문구·
          표 규약이 갈라진다(CLAUDE.md 복제 금지). 여기서 주입하는 것은 API 경로와 수치 열뿐이다. */}
      <CollectActivity
        path="/tools/storage/activity"
        metricCols={[
          { key: 'nodes', label: '노드', align: 'right', sort: (e) => String(e.nodes ?? ''), render: (e) => (e.nodes ?? '—'),
            detail: (e) => (e.nodes == null ? '' : String(e.nodes)) },
          { key: 'cap', label: '용량', muted: true, sort: (e) => String(e.usedBytes ?? ''),
            render: (e) => (e.totalBytes ? `${tbFmt(e.usedBytes)}/${tbFmt(e.totalBytes)}` : '—'),
            detail: (e) => (e.totalBytes ? `${tbFmt(e.usedBytes)} / ${tbFmt(e.totalBytes)}` : '') },
        ]}
      />

      {detail && (() => {
        const row = rows.find((x) => x.id === detail);
        if (!row) return null; // 새로고침 사이에 삭제된 장비 — 모달 조용히 닫힘 방지 위해 null
        return <DeviceDetail r={row} typeLabel={typeLabel} dcName={dcName} onClose={() => setDetail(null)}
          onRefresh={async () => { const res = await postJson(`/tools/storage/devices/${encodeURIComponent(row.id)}/collect`, {}); await load(); return res; }} />;
      })()}
      {/* 노드 장애 팝업(v2.523) — 표지를 눌렀을 때 '어느 노드가 왜' 를 보여 준다. */}
      {nodeFault && (() => {
        const row = (d?.devices || []).find((x) => x.id === nodeFault);
        if (!row) return null;
        return <NodeFaultModal r={row} typeLabel={typeLabel} onClose={() => setNodeFault(null)} />;
      })()}
    </div>
  );
}

/** 장비 헬스 배지 — 색 판정은 순수 모듈(`storageNodeText.healthBadge`)이 소유한다.
    예전에는 'healthy' 문자열만 초록이라 Unity 의 'OK' 가 **빨간 `Health: OK`** 로 나왔다. */
/**
 * CLI 명령 원문 목록(v2.405 → v2.539 공용화). 연결 테스트(전부)와 장비 상세(실패분만)가 같은 것을 그린다.
 * 소요(ms)·자동응답 횟수(answers)·끊김(truncated/timedOut)을 명령 줄 옆에 적는다 — '형식이 다르다' 와
 * '끊겼다' 는 조치가 다르다(전자는 파서, 후자는 프롬프트/시간).
 */
function CliRawList({ raw, mode, truncated }) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const ok = raw.filter((x) => x.ok).length;
  const ans = (x) => x.answers ? Object.entries(x.answers).filter(([, n]) => n > 0).map(([k, n]) => `${k}×${n}`).join(' ') : '';
  return (
    <details style={{ marginTop: 8 }}>
      <summary style={{ cursor: 'pointer', fontSize: 12 }}>
        CLI 명령 원문 {raw.length}건 — 성공 {ok} · 실패 {raw.length - ok}{mode === 'failed-only' ? ' (주기 수집은 실패한 명령만 남깁니다)' : ''}
        {truncated && Object.keys(truncated).length > 0 && <span style={{ color: 'var(--red)', marginLeft: 6 }}>· 끊긴 명령 {Object.keys(truncated).length}건</span>}
      </summary>
      <div style={{ marginTop: 6, maxHeight: '40vh', overflow: 'auto' }}>
        {raw.map((x, i) => (
          <div key={i} style={{ marginBottom: 8 }}>
            <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, color: x.ok ? 'var(--green)' : 'var(--red)', whiteSpace: 'normal' }}>
              {x.ok ? '✓' : '✗'} [{x.key}] {x.cmd}
              <span className="muted" style={{ marginLeft: 8, fontWeight: 400 }}>
                {x.ms != null ? `${(x.ms / 1000).toFixed(1)}초` : ''}{ans(x) ? ` · 자동응답 ${ans(x)}` : ''}{cliCutText(x)}
              </span>
            </div>
            <pre style={{ margin: '2px 0 0', padding: '6px 8px', background: 'rgba(148,163,184,.08)', borderRadius: 6, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{x.sample || '(빈 출력)'}</pre>
          </div>
        ))}
      </div>
    </details>
  );
}

function HealthBadge({ raw }) {
  const b = healthBadge(raw);
  return <span className={`badge ${b.tone}`} title={b.title}>{b.text}</span>;
}

function DeviceDetail({ r, typeLabel, dcName, onClose, onRefresh }) {
  // v2.540: 용량 산정이 쓰는 추이 점 — `CapacityTrend` 가 이미 불러온 것을 올려받는다(새 API 왕복 0).
  // ⚠ 훅은 조기 return 위에 둔다(React #310 — v2.202 실제 사고).
  const [trendPoints, setTrendPoints] = useState(null);
  const s = r.snap;
  // 수집 방식/타입별 UI 분기(v2.325, 사용자 요구 '가져오는 정보에 맞는 최적 UI·최대한 많은 정보').
  // SSH(isi status): 시리얼 없음 · 클러스터 헬스/감축비/효율/VHS/L3/Critical Events/Job Status +
  //   노드 표에 Ext·처리량·HDD/SSD·L3. API: 시리얼/GUID·스토리지 풀·OneFS 영역수집. 타입별 extra
  //   (PowerStore appliances/state · PowerMax model/ucode/arrays · XtremIO numBricks/healthState ·
  //   VPLEX clusters/용량없음)를 각각 최대치로 노출한다.
  const ex = (s && s.extra) || {};
  const method = ex.collectMethod === 'ssh' ? 'ssh' : 'api';
  const nodeList = (s && s.nodes && s.nodes.list) || [];
  // 풀 표 적응형 열(v2.526, Unity uemcli 가 주는 상세) — 이 스냅샷의 풀이 **실제 값을 가진 열만**
  // 그린다. 전 타입 공용 표라 항상 그리면 다른 장비에서 빈 '—' 열만 늘어난다.
  const poolList = (s && s.pools) || [];
  const poolCols = {
    free: poolList.some((p) => p.freeBytes != null),
    sub: poolList.some((p) => p.subscribedBytes != null || p.subscriptionPct != null),
    raid: poolList.some((p) => p.raid),
    drives: poolList.some((p) => p.drives || p.disks != null),
    dr: poolList.some((p) => p.dataReductionRatio || p.dataReductionSaved),
  };
  // 노드 표 적응형 열 — 이 스냅샷의 노드들이 실제 값을 가진 열만 그린다(항상 빈 '—' 열 제거로 압축).
  const ncol = {
    name: nodeList.some((n) => n.name),
    ext: nodeList.some((n) => n.ext),
    io: nodeList.some((n) => n.inBps != null || n.outBps != null),
    hdd: nodeList.some((n) => n.hdd),
    ssd: nodeList.some((n) => n.ssd || n.l3Bytes > 0),
  };
  // VPLEX/Metro Node — 자체 용량 없음(가상화 계층 — 미디어/추이 숨김).
  // ⚠ v2.526: 예전에는 `!!ex.capacityNote` **존재만** 봤다. 다른 수집기가 같은 키에 '용량을 이렇게
  //   읽으라' 는 안내를 넣는 순간 그 장비의 **용량 추이 차트가 통째로 사라진다**(Unity 에서 실제로
  //   그랬다 — Chromium 판독으로 발견). 수집기가 용량 섹션을 실제로 건너뛴 경우만 가상화 계층이다.
  const isVirt = s?.sections?.capacity === 'skip' && !!ex.capacityNote;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [areaView, setAreaView] = useState(null); // OneFS API 영역 원문 뷰(v2.308) — 배지 클릭
  const refresh = async () => {
    setBusy(true); setMsg(null);
    try {
      const res = await onRefresh();
      setMsg(res?.ok ? '수집 완료 — 최신 상태로 갱신됨' : (res?.reason || '수집 실패'));
    } catch (e) { setMsg(`오류: ${e.message}`); }
    finally { setBusy(false); }
  };
  // 폭 900(v2.310, 사용자 요구 — 실화면 덤프 기준 열 간 공백 과다): v2.306 에서 가로 스크롤
  // 제거를 위해 1100 으로 넓혔으나 실제 렌더 결과 노드 표 열 사이 빈 공간이 커서 압축.
  // 노드 표 실제 콘텐츠 폭(모노스페이스 수치 포함)은 ~700px 이라 900 에서도 가로 스크롤 없음.
  return (
    <Modal title={`${typeLabel(r.type)} — ${s?.name || r.name || r.host}`} onClose={onClose} width={900}>
      {/* 새로고침(v2.306, 사용자 요구) — 중앙 수집 장비는 즉시 재수집, 엣지 장비는 주기 안내(202 사유) */}
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 10 }}>
        <button className="login-btn" style={{ flex: 'none', padding: '6px 14px', fontSize: 12.5 }} disabled={busy} onClick={refresh}>
          {busy ? '수집 중…' : '↻ 새로고침(지금 수집)'}
        </button>
        {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
      </div>
      {!s ? <div className="muted" style={{ padding: 8 }}>아직 수집된 스냅샷이 없습니다(첫 수집 주기 대기).</div> : (
        <>
          {/* 헤더 — 수집 방식/타입이 제공하는 항목만(v2.325). 빈 값은 '—' 대신 칩 자체를 숨긴다
              (예: SSH 는 시리얼/GUID 미제공 → 칩 없음). 수집 방식 배지로 어떤 UI 인지 명확히. */}
          <div className="flex gap wrap" style={{ fontSize: 12.5, marginBottom: 10, alignItems: 'center' }}>
            {/* ⚠ v2.542: 이 배지는 **이 화면의 값을 어떤 방식으로 받았는지**다(아래 패널 구성도 그
                기준으로 갈린다 — 있는 데이터가 그 방식으로 받은 것이므로 바꾸면 빈 칸만 늘어난다).
                등록값이 이미 다른 방식으로 바뀌어 있으면 그 사실을 옆에 밝힌다. */}
            <span className={`badge ${method === 'ssh' ? 'blue' : 'gray'}`} title={method === 'ssh' ? 'SSH(isi status 파싱) 수집 — 시리얼/GUID 미제공, 클러스터 헬스·감축비·이벤트·잡 제공' : 'REST API 수집'}>{method.toUpperCase()} 수집</span>
            {(() => {
              const mv = collectMethodView({ registered: r.collectMethod, lastUsed: ex.collectMethod, hasSnap: !!s, agent: r.agent });
              return mv.pending ? <span className="badge amber" style={{ marginLeft: 4 }} title={mv.pending.title}>등록 {mv.label} · 적용 대기</span> : null;
            })()}
            <span className="muted">호스트 <b style={{ color: 'var(--text)' }}>{hostText(r.host)}</b></span>
            <span className="muted">법인 <b style={{ color: 'var(--text)' }}>{dcName(r.datacenterId)}</b></span>
            {s.version && (
              <span className="muted"
                title={ex.versionRaw ? `원문 ${ex.versionRaw}${ex.versionSource ? ` · 출처 ${ex.versionSource}` : ''}` : undefined}>
                버전 <b style={{ color: 'var(--text)' }}>{s.version}</b>
                {ex.versionSource ? <span style={{ fontSize: 11, marginLeft: 4 }}>({ex.versionSource})</span> : null}
              </span>
            )}
            {s.serial && <span className="muted">시리얼/GUID <b style={{ color: 'var(--text)' }}>{s.serial}</b></span>}
            {ex.model && <span className="muted">모델 <b style={{ color: 'var(--text)' }}>{ex.model}</b></span>}
            {ex.ucode && <span className="muted">ucode <b style={{ color: 'var(--text)' }}>{ex.ucode}</b></span>}
            {ex.state && <span className="muted">상태 <b style={{ color: 'var(--text)' }}>{ex.state}</b></span>}
            {ex.numBricks > 0 && <span className="muted">X-Brick <b style={{ color: 'var(--text)' }}>{ex.numBricks}</b></span>}
            <span className="muted">수집 {new Date(s.collectedAt).toLocaleString('ko-KR')}{s.agent ? ` · 엣지 ${s.agent}` : ' · 중앙'}</span>
          </div>
          {/* 타입 고유 헬스 노출(v2.311 적대적 검증 반영 — 수집·테스트까지 된 장애 신호가 UI 에서
              사장되던 결함 수정): VPLEX/Metro Node 클러스터별 헬스(degraded/critical-failure 가
              디렉터 정상일 때도 보이게), XtremIO 시스템 헬스. */}
          {Array.isArray(s.extra?.clusters) && s.extra.clusters.length > 0 && (
            <div className="flex gap wrap" style={{ fontSize: 12.5, marginBottom: 10 }}>
              {s.extra.clusters.map((c, i) => (
                <span key={i} className={`badge ${c.health === 'ok' ? 'green' : c.health === 'unknown' ? 'gray' : 'red'}`} title={c.operational ? `operational: ${c.operational}` : undefined}>
                  {c.name}: {String(c.health || '?').toUpperCase()}
                </span>
              ))}
            </div>
          )}
          {s.extra?.healthState && !s.extra?.clusterHealth && (
            <div className="flex gap wrap" style={{ fontSize: 12.5, marginBottom: 10 }}>
              <HealthBadge raw={s.extra.healthState} />
              {s.extra.dataReduction && <span className="muted">Data Reduction <b style={{ color: 'var(--text)' }}>{s.extra.dataReduction}</b></span>}
            </div>
          )}
          {/* SSH(isi status) 모드 부가 정보(v2.304) — 사용자 화면 상단 블록과 동일 항목 */}
          {(s.extra?.clusterHealth || s.extra?.dataReduction || s.extra?.vhsBytes > 0) && !s.extra?.healthState && (
            <div className="flex gap wrap" style={{ fontSize: 12.5, marginBottom: 10 }}>
              {s.extra.clusterHealth && <span className={`badge ${s.extra.clusterHealth === 'OK' ? 'green' : 'red'}`}>Cluster Health: {s.extra.clusterHealth}</span>}
              {s.extra.dataReduction && <span className="muted">Data Reduction <b style={{ color: 'var(--text)' }}>{s.extra.dataReduction}</b></span>}
              {s.extra.storageEfficiency && <span className="muted">Storage Efficiency <b style={{ color: 'var(--text)' }}>{s.extra.storageEfficiency}</b></span>}
              {s.extra.vhsBytes > 0 && <span className="muted">VHS <b style={{ color: 'var(--text)' }}>{tbFmt(s.extra.vhsBytes)}</b></span>}
              {s.extra.l3TotalBytes > 0 && <span className="muted">L3 캐시 합계 <b style={{ color: 'var(--text)' }}>{tbFmt(s.extra.l3TotalBytes)}</b></span>}
            </div>
          )}
          {/* 실패 사유 — 목록의 '실패' 배지를 눌러 여기로 오므로, 배지 툴팁과 **같은 문자열**을
              같은 헬퍼로 만든다(error 가 비어도 섹션 오류로 폴백). 여기서는 잘리지 않게 줄바꿈
              허용(whiteSpace: pre-wrap) — 목록과 달리 폭 제약이 없다. */}
          {!s.ok && (
            <div className="card" style={{ borderColor: 'var(--red)', padding: '8px 12px', marginBottom: 10, fontSize: 12.5, color: 'var(--red)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>⛔ {failReason(s)}</div>
          )}

          {/* ── 인증 실패(401) 진단 (v2.528, 사용자 신고 "PS-HG-2 인증 실패 · 등록은 됐고 CSV 로
              내보내면 비밀번호는 정상") ──────────────────────────────────────────────
              엣지 위임 장비는 **엣지가** 장비에 로그인하므로, 401 만으로는 '배포가 상했나' 와
              '장비 비밀번호가 다른가' 를 가릴 수 없다. 엣지가 **실제로 쓴** 자격증명 지문
              (계정·길이·비복원 해시 — 평문 아님)을 보여 중앙 등록값과 대조하게 한다.
              판정·문구는 `storageAuthText.js` 하나가 소유한다(웹 테스트가 node 환경이라 순수 모듈). */}
          {(() => {
            const ai = authFailInfo(s, r);
            if (!ai) return null;
            return (
              <div className="card" style={{ borderColor: 'var(--amber)', padding: '10px 12px', marginBottom: 10, fontSize: 12.5 }}>
                <div style={{ fontWeight: 700, color: 'var(--amber)', marginBottom: 6 }}>
                  🔑 {ai.title}
                  {ai.since && <span className="muted" style={{ fontWeight: 400, marginLeft: 6 }}>— {ai.since}부터 · 시도 {ai.attempts}회</span>}
                </div>
                {ai.fp && (
                  <div style={{ marginBottom: 6 }}>
                    <span className="muted">수집에 쓰인 자격증명</span>{' '}
                    <b style={{ fontFamily: 'ui-monospace, monospace' }}>{ai.fp}</b>
                    {ai.fpSource && <span className="muted"> ({ai.fpSource === 'central' ? '중앙' : `엣지 ${ai.fpSource}`} 기준)</span>}
                  </div>
                )}
                <ul style={{ margin: '0 0 0 16px', padding: 0, lineHeight: 1.7 }}>
                  {ai.causes.map((c, i) => <li key={`c${i}`} style={{ whiteSpace: 'normal' }}><BoldText text={c} /></li>)}
                </ul>
                {ai.notes.length > 0 && (
                  <div className="muted" style={{ marginTop: 6, lineHeight: 1.7, whiteSpace: 'normal' }}>
                    {ai.notes.map((n, i) => <div key={`n${i}`}>· <BoldText text={n} /></div>)}
                  </div>
                )}
              </div>
            );
          })()}

          {/* 가상화 계층(VPLEX/Metro Node) — 자체 용량이 없다는 사유를 명시(용량/미디어/추이 숨김) */}
          {isVirt && (
            <div className="card" style={{ padding: '8px 12px', marginBottom: 10, fontSize: 12, borderColor: 'var(--border)', whiteSpace: 'normal', lineHeight: 1.6 }}>
              ℹ <BoldText text={ex.capacityNote} />
            </div>
          )}

          {/* HDD/SSD 풀 요약(v2.303) — isi status Cluster Storage 와 동일 의미 */}
          {s.media && (
            <div className="flex gap wrap" style={{ marginBottom: 12 }}>
              {[['HDD 풀', s.media.hdd], ['SSD 풀', s.media.ssd]].map(([lb, m]) => (
                <div key={lb} className="card" style={{ padding: '8px 12px', minWidth: 170 }}>
                  <div className="muted" style={{ fontSize: 12 }}>{lb}</div>
                  {m ? <>
                    <div style={{ fontSize: 15, fontWeight: 700 }}>{tbFmt(m.usedBytes)} <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>/ {tbFmt(m.totalBytes)}</span></div>
                    {m.pct != null ? <UsageCell pct={m.pct} /> : <span className="muted">—</span>}
                  </> : <div className="muted">없음</div>}
                </div>
              ))}
            </div>
          )}

          {/* 용량 추이 그래프(v2.318) — 가상화 계층(VPLEX 등 자체 용량 없음)은 추이가 무의미해 숨김 */}
          {!isVirt && <CapacityTrend deviceId={r.id} isEdge={!!r.agent} onPoints={setTrendPoints} />}

          {/* 노드별 상세(v2.303, 사용자 요구 — isi status 노드 표): ID·IP·상태·외부망 처리량·노드별 HDD/SSD
              v2.310 검증 반영: XtremIO 컨트롤러/Unity SP/PowerStore 노드는 name 이 유일 식별자인데
              (id 는 수집기 합성 순번, ip 는 비어 있을 수 있음) 표가 name 을 안 그려 사장됐다 —
              하나라도 name 이 있으면 '이름' 열을 추가한다(isilon 은 name 없음 → 열 미표시로 기존 유지). */}
          {/* 노드/컨트롤러/SP/디렉터 표(v2.303) — v2.325: 이 스냅샷이 실제 값을 가진 열만 그린다.
              SSH isilon 은 Ext·처리량·HDD/SSD·L3 전부, API 타입(PowerStore/Unity/PowerMax/VPLEX)은
              대부분 id·이름·상태만 채워 나머지 열이 항상 '—' 였다 → 빈 열을 숨겨 정보 밀도를 높인다.
              노드 표제도 타입에 맞춘다(컨트롤러/SP/디렉터). */}
          {nodeList.length > 0 && (
            <>
              <div className="section-title" style={{ fontSize: 13 }}>{r.type === 'xtremio' ? '스토리지 컨트롤러' : r.type === 'unity480' ? '스토리지 프로세서(SP)' : (r.type === 'vplex' || r.type === 'metronode') ? '디렉터' : '노드'} {nodeList.length}{s.nodes.count > nodeList.length ? ` (표시 상한 — 전체 ${s.nodes.count})` : ''}</div>
              <div className="table-wrap" style={{ maxHeight: '32vh', marginBottom: 12 }}>
                <STable>
                  <thead><tr>
                    <th style={{ textAlign: 'right', width: 40 }}>ID</th>
                    {ncol.name && <th>이름</th>}
                    <th>IP</th>
                    <th style={{ width: 56 }}>상태</th>
                    {ncol.ext && <th style={{ width: 44 }}>Ext</th>}
                    {ncol.io && <th style={{ textAlign: 'right', width: 84 }}>In(bps)</th>}
                    {ncol.io && <th style={{ textAlign: 'right', width: 84 }}>Out(bps)</th>}
                    {ncol.hdd && <th>HDD Used/Size</th>}
                    {ncol.ssd && <th>SSD Used/Size</th>}
                  </tr></thead>
                  <tbody>
                    {nodeList.map((n) => (
                      <tr key={n.id}>
                        <td style={{ textAlign: 'right' }}>{n.id}</td>
                        {ncol.name && <td style={{ whiteSpace: 'nowrap' }}>{n.name || '—'}</td>}
                        <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{n.ip || '—'}</td>
                        <td><span className={`badge ${/ok|healthy|up|green/.test(n.health) ? 'green' : n.health === 'unknown' ? 'gray' : 'red'}`}>{n.health === 'unknown' ? '?' : n.health.toUpperCase()}</span></td>
                        {ncol.ext && <td>{n.ext ? <span className={`badge ${n.ext === 'C' ? 'green' : 'red'}`} title="C=Connected · N=Not Connected">{n.ext}</span> : <span className="muted">—</span>}</td>}
                        {ncol.io && <td style={{ textAlign: 'right', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{bps(n.inBps)}</td>}
                        {ncol.io && <td style={{ textAlign: 'right', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{bps(n.outBps)}</td>}
                        {/* 'No Storage HDDs' 는 isilon(isi status) 전용 문구 — 타 타입의 hdd null 은 '—' */}
                        {ncol.hdd && <td style={{ whiteSpace: 'nowrap' }}>{n.hdd ? `${tbFmt(n.hdd.usedBytes)}/${tbFmt(n.hdd.totalBytes)}${n.hdd.pct != null ? ` (${n.hdd.pct}%)` : ''}` : <span className="muted">{r.type === 'isilon' ? 'No Storage HDDs' : '—'}</span>}</td>}
                        {ncol.ssd && <td style={{ whiteSpace: 'nowrap' }}>{n.ssd ? `${tbFmt(n.ssd.usedBytes)}/${tbFmt(n.ssd.totalBytes)}${n.ssd.pct != null ? ` (${n.ssd.pct}%)` : ''}` : n.l3Bytes > 0 ? <span className="muted">L3: {tbFmt(n.l3Bytes)}</span> : <span className="muted">—</span>}</td>}
                      </tr>
                    ))}
                  </tbody>
                </STable>
              </div>
            </>
          )}

          {/* PowerStore 물리 사용량 상세(extra.space, v2.404 사용자 요구) — 위 '용량' 막대는
              physical(실제 디스크) 기준이고, 여기서 논리 사용량·데이터 감축률까지 함께 본다.
              감축률이 높으면 논리 > 물리 인 것이 정상이라, 둘을 나란히 보여야 오해가 없다. */}
          {ex.space && (ex.space.physicalTotal > 0 || ex.space.logicalUsed > 0) && (
            <>
              <div className="section-title" style={{ fontSize: 13 }}>물리 사용량 상세</div>
              <div className="flex gap wrap" style={{ marginBottom: 12, gap: 16, fontSize: 12.5 }}>
                <span className="muted">물리 사용/전체 <b style={{ color: 'var(--text)' }}>{tbFmt(ex.space.physicalUsed)} / {tbFmt(ex.space.physicalTotal)}</b></span>
                {ex.space.logicalUsed != null && <span className="muted">논리 사용 <b style={{ color: 'var(--text)' }}>{tbFmt(ex.space.logicalUsed)}</b></span>}
                {ex.space.logicalProvisioned != null && <span className="muted">논리 할당 <b style={{ color: 'var(--text)' }}>{tbFmt(ex.space.logicalProvisioned)}</b></span>}
                {ex.space.dataReduction != null && <span className="muted">데이터 감축 <b style={{ color: 'var(--text)' }}>{ex.space.dataReduction.toFixed(2)}:1</b></span>}
                {ex.space.thinSavings != null && <span className="muted">Thin 절감 <b style={{ color: 'var(--text)' }}>{ex.space.thinSavings.toFixed(2)}:1</b></span>}
                {ex.space.snapshotSavings != null && <span className="muted">스냅샷 절감 <b style={{ color: 'var(--text)' }}>{ex.space.snapshotSavings.toFixed(2)}:1</b></span>}
                {ex.space.at && <span className="muted">기준 {String(ex.space.at).replace('T', ' ').slice(0, 19)}</span>}
              </div>
            </>
          )}

          {/* PowerStore 성능(extra.perf, v2.404) — 최신 1점. 값이 없는 항목은 생략(0 으로 위장 금지). */}
          {ex.perf && (ex.perf.totalIops != null || ex.perf.totalBandwidth != null || ex.perf.latencyUs != null) && (
            <>
              <div className="section-title" style={{ fontSize: 13 }}>성능(최신)</div>
              <div className="flex gap wrap" style={{ marginBottom: 12, gap: 16, fontSize: 12.5 }}>
                {ex.perf.totalIops != null && <span className="muted">IOPS <b style={{ color: 'var(--text)' }}>{Math.round(ex.perf.totalIops).toLocaleString()}</b>{ex.perf.readIops != null ? ` (R ${Math.round(ex.perf.readIops).toLocaleString()} · W ${Math.round(ex.perf.writeIops || 0).toLocaleString()})` : ''}</span>}
                {ex.perf.totalBandwidth != null && <span className="muted">대역폭 <b style={{ color: 'var(--text)' }}>{bps(ex.perf.totalBandwidth * 8)}bps</b></span>}
                {ex.perf.latencyUs != null && <span className="muted">지연 <b style={{ color: 'var(--text)' }}>{(ex.perf.latencyUs / 1000).toFixed(2)} ms</b></span>}
                {ex.perf.at && <span className="muted">기준 {String(ex.perf.at).replace('T', ' ').slice(0, 19)}</span>}
              </div>
            </>
          )}

          {/* PowerStore 인벤토리 요약(extra.inventory, v2.404 '수집할 수 있는 모든 데이터').
              원본 객체가 아니라 개수·합계만 온다(스냅샷이 중앙으로 push 되므로 — 수집기 주석 참고). */}
          {ex.inventory && Object.keys(ex.inventory).length > 0 && (
            <>
              <div className="section-title" style={{ fontSize: 13 }}>인벤토리 요약</div>
              <div className="flex gap wrap" style={{ marginBottom: 12, gap: 16, fontSize: 12.5 }}>
                {ex.inventory.appliances && <span className="muted">어플라이언스 <b style={{ color: 'var(--text)' }}>{ex.inventory.appliances.count}</b></span>}
                {ex.inventory.volumes && (
                  <span className="muted" title={Object.entries(ex.inventory.volumes.byState || {}).map(([k, v]) => `${k} ${v}`).join(' · ')}>
                    볼륨 <b style={{ color: 'var(--text)' }}>{ex.inventory.volumes.count.toLocaleString()}{ex.inventory.volumes.truncated ? '+' : ''}</b>
                    {ex.inventory.volumes.provisionedBytes > 0 ? ` · 할당 ${tbFmt(ex.inventory.volumes.provisionedBytes)}` : ''}
                  </span>
                )}
                {ex.inventory.hosts && <span className="muted">호스트 <b style={{ color: 'var(--text)' }}>{ex.inventory.hosts.count}</b></span>}
                {ex.inventory.hostGroups && <span className="muted">호스트 그룹 <b style={{ color: 'var(--text)' }}>{ex.inventory.hostGroups.count}</b></span>}
                {ex.inventory.fileSystems && <span className="muted">파일시스템 <b style={{ color: 'var(--text)' }}>{ex.inventory.fileSystems.count}</b>{ex.inventory.fileSystems.totalBytes > 0 ? ` · ${tbFmt(ex.inventory.fileSystems.usedBytes)} / ${tbFmt(ex.inventory.fileSystems.totalBytes)}` : ''}</span>}
                {ex.inventory.nasServers && <span className="muted">NAS 서버 <b style={{ color: 'var(--text)' }}>{ex.inventory.nasServers.count}</b></span>}
                {ex.inventory.storageContainers && <span className="muted">스토리지 컨테이너 <b style={{ color: 'var(--text)' }}>{ex.inventory.storageContainers.count}</b></span>}
                {ex.inventory.replicationSessions && (
                  <span className="muted" title={Object.entries(ex.inventory.replicationSessions.byState || {}).map(([k, v]) => `${k} ${v}`).join(' · ')}>
                    복제 세션 <b style={{ color: 'var(--text)' }}>{ex.inventory.replicationSessions.count}</b>
                  </span>
                )}
                {ex.inventory.hardware && (
                  <span className="muted" title={Object.entries(ex.inventory.hardware.byType || {}).map(([k, v]) => `${k} ${v}`).join(' · ')}>
                    하드웨어 <b style={{ color: 'var(--text)' }}>{ex.inventory.hardware.total}</b>
                    {hardwareSummaryParts(ex.inventory.hardware).map((p) => (p.tone === 'red'
                      ? <b key={p.text} style={{ color: 'var(--red)' }}> · {p.text}</b>
                      : <span key={p.text}> · {p.text}</span>))}
                  </span>
                )}
              </div>
            </>
          )}

          {/* PowerStore 어플라이언스(extra.appliances) — 용량 상세가 없어 풀이 아니라 별도 표로(v2.325) */}
          {Array.isArray(ex.appliances) && ex.appliances.length > 0 && (
            <>
              <div className="section-title" style={{ fontSize: 13 }}>어플라이언스 {ex.appliances.length}</div>
              <STable className="data-table" style={{ width: '100%', fontSize: 12.5, marginBottom: 12 }}>
                <thead><tr><th style={{ textAlign: 'left' }}>이름</th><th>모델</th><th>서비스 태그</th></tr></thead>
                <tbody>{ex.appliances.map((a, i) => (
                  <tr key={i}><td>{a.name || '—'}</td><td className="muted">{a.model || '—'}</td><td className="muted" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{a.serviceTag || '—'}</td></tr>
                ))}</tbody>
              </STable>
            </>
          )}

          {/* PowerMax/VMAX Unisphere 관리 어레이(extra.arrays) — 로컬 어레이 목록(v2.325) */}
          {Array.isArray(ex.arrays) && ex.arrays.length > 0 && (
            <>
              <div className="section-title" style={{ fontSize: 13 }}>관리 어레이 {ex.arrays.length}</div>
              <div className="flex gap wrap" style={{ marginBottom: 12 }}>
                {ex.arrays.map((a, i) => <span key={i} className="badge gray" title={a.model || ''}>{a.id}{a.model ? ` · ${a.model}` : ''}</span>)}
              </div>
            </>
          )}

          {/* 풀 표제는 타입에 맞춘다(v2.325): XtremIO=클러스터(전체 플래시), PowerMax=어레이별 용량. */}
          {(s.pools || []).length > 0 && (
            <>
              <div className="section-title" style={{ fontSize: 13 }}>{r.type === 'xtremio' ? '클러스터 용량' : (r.type === 'vmax' || r.type === 'powermax') ? '어레이별 용량' : '스토리지 풀'} {s.pools.length}</div>
              <STable minWidth={1040} className="data-table" style={{ width: '100%', fontSize: 12.5, marginBottom: 12 }}>
                <thead><tr><th style={{ textAlign: 'left' }}>{r.type === 'xtremio' ? '클러스터' : (r.type === 'vmax' || r.type === 'powermax') ? '어레이' : '풀'}</th><th style={{ textAlign: 'right' }}>사용</th><th style={{ textAlign: 'right' }}>전체</th><th>사용률</th>{poolCols.free && <th style={{ textAlign: 'right' }}>여유</th>}{poolCols.sub && <th style={{ textAlign: 'right' }}>구독</th>}{poolCols.sub && <th style={{ textAlign: 'right' }}>구독률</th>}{poolCols.raid && <th>RAID</th>}{poolCols.drives && <th>드라이브</th>}{poolCols.dr && <th>데이터 감축</th>}</tr></thead>
                <tbody>{s.pools.map((p, i) => (
                  <tr key={i}><td>{p.name}</td><td style={{ textAlign: 'right' }}>{tbFmt(p.usedBytes)}</td><td style={{ textAlign: 'right' }}>{tbFmt(p.totalBytes)}</td><td>{p.pct != null ? <UsageCell pct={p.pct} /> : '—'}</td>{poolCols.free && <td style={{ textAlign: 'right' }}>{p.freeBytes != null ? tbFmt(p.freeBytes) : '—'}</td>}{poolCols.sub && <td style={{ textAlign: 'right' }}>{p.subscribedBytes != null ? tbFmt(p.subscribedBytes) : '—'}</td>}{poolCols.sub && <td style={{ textAlign: 'right' }} title={p.subscriptionPctSource === 'calc' ? '장비가 구독률을 주지 않아 구독÷전체로 계산한 값입니다' : '장비가 보고한 값'}>{p.subscriptionPct != null ? `${p.subscriptionPct}%${p.subscriptionPctSource === 'calc' ? '*' : ''}` : '—'}</td>}{poolCols.raid && <td className="muted">{p.raid || '—'}{p.stripeLength ? ` (${p.stripeLength})` : ''}</td>}{poolCols.drives && <td className="muted" style={{ whiteSpace: 'normal' }}>{p.drives || (p.disks != null ? `${p.disks}개` : '—')}</td>}{poolCols.dr && <td className="muted">{p.dataReductionRatio || '—'}{p.dataReductionSaved ? ` · ${tbFmt(p.dataReductionSaved)} 절감` : ''}</td>}</tr>
                ))}</tbody>
              </STable>
              {/* 근거 표기 — `*` 는 장비가 구독률을 주지 않아 우리가 계산한 값이다.
                  툴팁에만 두면 복사·공유가 안 되고 모바일에서 볼 수 없다(v2.516 규약). */}
              {poolCols.sub && poolList.some((p) => p.subscriptionPctSource === 'calc') && (
                <div className="muted" style={{ fontSize: 11, margin: '-6px 0 12px' }}>
                  * 구독률에 별표가 붙은 행은 장비가 값을 주지 않아 <b>구독 ÷ 전체</b>로 계산한 값입니다.
                </div>
              )}
            </>
          )}
          {(s.accounts || []).length > 0 && (
            <>
              <div className="section-title" style={{ fontSize: 13 }}>계정 {s.accounts.length}{s.accounts.length >= 200 ? '+(상한 절단)' : ''}</div>
              <div className="flex gap wrap" style={{ marginBottom: 12 }}>
                {s.accounts.map((a, i) => <span key={i} className={`badge ${a.enabled ? 'gray' : 'red'}`}>{a.name}{a.enabled ? '' : ' (비활성)'}</span>)}
              </div>
            </>
          )}
          {/* Critical Events + Cluster Job Status(v2.307, 사용자 요구 — isi status 꼬리 섹션) */}
          {s.extra?.criticalEvents && (
            <>
              <div className="section-title" style={{ fontSize: 13 }}>Critical Events {s.extra.criticalEvents.length + (s.extra.criticalEventsOmitted || 0)}
                {s.extra.criticalEventsOmitted > 0 && <span className="muted" style={{ fontSize: 11.5, fontWeight: 400 }}> — 목록은 {s.extra.criticalEvents.length}건까지만(나머지 {s.extra.criticalEventsOmitted}건 생략)</span>}</div>
              {/^미수집/.test(String(s.sections?.alerts || ''))
                ? <div className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>{s.sections.alerts}</div>
                : s.extra.criticalEvents.length === 0
                ? <div className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>✅ 미해결 Critical 이벤트 없음</div>
                : (
                  <div className="table-wrap" style={{ maxHeight: '20vh', marginBottom: 12 }}>
                    <STable>
                      <thead><tr><th>시각</th><th style={{ textAlign: 'right' }}>LNN</th><th>이벤트</th></tr></thead>
                      <tbody>{s.extra.criticalEvents.map((e, i) => (
                        <tr key={i}><td style={{ whiteSpace: 'nowrap', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{e.time}</td><td style={{ textAlign: 'right' }}>{e.lnn}</td><td style={{ fontSize: 12.5, color: 'var(--red)' }}>{e.event}</td></tr>
                      ))}</tbody>
                    </STable>
                  </div>
                )}
            </>
          )}
          {s.extra?.jobs && (
            <>
              <div className="section-title" style={{ fontSize: 13 }}>Cluster Job Status
                <span className="muted" style={{ fontSize: 11.5, fontWeight: 400 }}> — 실행 {s.extra.jobs.running.length} · 대기 {s.extra.jobs.paused.length} · 실패 {s.extra.jobs.failed.length}</span>
              </div>
              {(s.extra.jobs.running.length + s.extra.jobs.paused.length + s.extra.jobs.failed.length) === 0
                ? <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>실행/대기/실패 잡 없음</div>
                : (
                  <div className="table-wrap" style={{ maxHeight: '22vh', marginBottom: 8 }}>
                    <STable>
                      <thead><tr><th>잡</th><th>구분</th><th>Impact</th><th style={{ textAlign: 'right' }}>Pri</th><th>Policy</th><th>Phase</th><th>Run Time</th></tr></thead>
                      <tbody>
                        {s.extra.jobs.running.map((j, i) => (
                          <tr key={`r${i}`}><td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{j.job}</td><td><span className="badge amber">실행 중</span></td><td>{j.impact}</td><td style={{ textAlign: 'right' }}>{j.pri}</td><td>{j.policy}</td><td>{j.phase}</td><td style={{ whiteSpace: 'nowrap' }}>{j.runTime}</td></tr>
                        ))}
                        {s.extra.jobs.paused.map((j, i) => (
                          <tr key={`p${i}`}><td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{j.job}</td><td><span className="badge gray">{j.state || '대기'}</span></td><td>{j.impact}</td><td style={{ textAlign: 'right' }}>{j.pri}</td><td>{j.policy}</td><td>{j.phase}</td><td style={{ whiteSpace: 'nowrap' }}>{j.runTime}</td></tr>
                        ))}
                        {s.extra.jobs.failed.map((j, i) => (
                          <tr key={`f${i}`}><td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{j.job}</td><td><span className="badge red">실패</span></td><td colSpan={5} style={{ fontSize: 12 }}>{j.detail}</td></tr>
                        ))}
                      </tbody>
                    </STable>
                  </div>
                )}
              {s.extra.jobs.recent.length > 0 && (
                <>
                  <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>최근 잡 결과 {s.extra.jobs.recent.length}건</div>
                  <div className="table-wrap" style={{ maxHeight: '18vh', marginBottom: 12 }}>
                    <STable>
                      <thead><tr><th>시각</th><th>잡</th><th>결과</th></tr></thead>
                      <tbody>{s.extra.jobs.recent.map((j, i) => (
                        <tr key={i}><td style={{ whiteSpace: 'nowrap', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{j.time}</td><td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{j.job}</td><td><span className={`badge ${/succeeded/i.test(j.event) ? 'green' : 'red'}`}>{j.event}</span></td></tr>
                      ))}</tbody>
                    </STable>
                  </div>
                </>
              )}
            </>
          )}

          {/* OneFS API 전 영역 수집(v2.308, 사용자 40개 표) — 요약은 push 로 전 장비, 원문은
              수집 노드 DB(중앙 수집 장비만 이 화면에서 열람 — 엣지 원문은 엣지 DB, 안내 표시). */}
          {s.extra?.areas && (
            <>
              <div className="section-title" style={{ fontSize: 13 }}>OneFS API 영역 수집 {s.extra.areas.filter((a) => !a.skipped).length}
                <span className="muted" style={{ fontSize: 11, fontWeight: 400 }}> — 엔드포인트 {unitText(s.extra.areasEndpoints, '개')} · {s.extra.areasAt ? new Date(s.extra.areasAt).toLocaleString('ko-KR') : ''} · 원문은 수집 노드 DB 저장</span>
              </div>
              <div className="flex gap wrap" style={{ marginBottom: 8 }}>
                {s.extra.areas.map((a) => (
                  <span key={a.area} className={`badge ${a.notTried ? 'amber' : a.skipped ? 'gray' : a.failed === 0 ? 'green' : a.ok > 0 ? 'amber' : 'red'}`}
                    title={a.error || `성공 ${a.ok} · 실패 ${a.failed}`} style={{ fontSize: 10.5, cursor: !a.skipped && !r.agent ? 'pointer' : 'default' }}
                    onClick={() => { if (!a.skipped && !r.agent) setAreaView(a.area); }}>
                    {a.area}{areaBadgeSuffix(a)}
                  </span>
                ))}
              </div>
              {(() => {
                const st = areasStopNote(s.extra);
                if (!st) return null;
                return (
                  <div style={{ fontSize: 11.5, marginBottom: 8, padding: '6px 10px', borderRadius: 6, lineHeight: 1.6,
                    background: st.tone === 'red' ? 'rgba(255,90,90,.10)' : 'rgba(255,176,32,.10)',
                    border: `1px solid ${st.tone === 'red' ? 'rgba(255,90,90,.35)' : 'rgba(255,176,32,.35)'}` }}>
                    ⚠ <BoldText text={st.text} />{st.fix ? <> {st.fix}</> : null}
                  </div>
                );
              })()}
              {r.agent
                ? <div className="muted" style={{ fontSize: 11, marginBottom: 12 }}>이 장비는 엣지 '{r.agent}' 가 수집 — API 원문은 엣지 포탈의 DB 에 저장됩니다(여기는 요약만).</div>
                : <div className="muted" style={{ fontSize: 11, marginBottom: 12 }}>배지를 클릭하면 저장된 원문(JSON)을 봅니다.</div>}
              {areaView && !r.agent && <AreaJsonViewer deviceId={r.id} area={areaView} onClose={() => setAreaView(null)} />}
            </>
          )}

          <div className="section-title" style={{ fontSize: 13 }}>섹션별 수집 상태 <span className="muted" style={{ fontSize: 11, fontWeight: 400 }}>— 부분 실패를 숨기지 않습니다(버전별 API 차이 진단용)</span></div>
          <div className="flex gap wrap">
            {/* ⚠ v2.542: 색·글자 판정은 `storageNodeText.sectionBadge` 하나가 갖는다. 예전에는
                여기 인라인이었고 ok/skip 이 아니면 전부 빨간 '오류' 라, '이 방식에서는 조회하지
                않는다'(미수집)가 장애처럼 보였다(색과 글자가 반대말을 하는 v2.526 과 같은 유형). */}
            {Object.entries(s.sections || {}).map(([k, v]) => {
              const b = sectionBadge(v);
              return <span key={k} className={`badge ${b.tone}`} title={b.title}>{k}: {b.text}</span>;
            })}
          </div>
          {/* 섹션 오류 원문 + PowerStore 공간 지표 시도 내역(v2.421) — 배지의 툴팁만으로는 복사·공유가 안 된다. */}
          {Object.entries(s.sections || {}).some(([, v]) => /오류/.test(String(v))) && (
            <pre style={{ fontSize: 11.5, whiteSpace: 'pre-wrap', margin: '6px 0 0', color: 'var(--red)' }}>
              {Object.entries(s.sections || {}).filter(([, v]) => /오류/.test(String(v))).map(([k, v]) => `${k}: ${v}`).join('\n')}
            </pre>
          )}
          {/* v2.539: 주기 수집이 남긴 **실패 명령 원문**(cliRawMode=failed-only) — 연결 테스트를 다시 돌리지 않아도
              무엇이 왔는지 본다. 소요·자동응답 횟수·끊김을 함께 보인다(실제 사고: 인증서 프롬프트 에코 루프가
              400회 응답 뒤 명령을 죽였는데 화면은 '형식이 다르다' 고만 했다). */}
          <CliRawList raw={ex.cliRaw} mode={ex.cliRawMode} truncated={ex.cliTruncated} />
          {ex.spaceDebug && (
            <div className="muted" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.6 }}>
              공간 지표 조회 경로: <b>{ex.spaceDebug.source || '—'}</b>{ex.spaceDebug.interval ? ` · 구간 ${ex.spaceDebug.interval}` : ''}
              {(ex.spaceDebug.tried || []).length ? <div>시도 내역: {ex.spaceDebug.tried.join(' → ')}</div> : null}
            </div>
          )}
          {/* skip 사유 노출(v2.311) — VPLEX/Metro Node 의 capacity skip 은 오류가 아니라 제품 특성
              (가상화 계층 — 자체 용량 없음). 사유 없이 '건너뜀'만 보이면 수집 실패로 오해한다. */}
          {/* v2.525: Unity(SSH/uemcli) 구성 정보 — 사용자 요청 "용량 정보 확인 및 장비 구성정보 등
              최대한 많은 정보를 수집해줘". 값이 있을 때만 그린다(다른 타입은 변화 없음). */}
          {/* v2.540: Unity 용량 산정 — 할당 가능량·소진 예상·수용 개수·원시/유효. 값이 없으면 스스로 그리지 않는다. */}
          <UnityCapacityPlanPanel snap={s} points={trendPoints} />
          <UnityConfigPanels ex={ex} fmtBytes={tbFmt} />
          {/* v2.526: 이 문구는 `**강조**` 를 담고 있다 — 그대로 그리면 별표가 그대로 인쇄된다
              (v2.439/2.440/2.505 실제 사고). 반드시 BoldText 로 렌더한다. */}
          {/* v2.534: VMAX/PowerMax 구독·할당·실제 기록 분리 표시(값이 없으면 그리지 않는다). */}
          <PowerMaxCapacityPanel ex={ex} />
          {s.extra?.capacityBasisNote && <div className="muted" style={{ fontSize: 11, marginTop: 6, whiteSpace: 'normal', lineHeight: 1.6 }}>ℹ <BoldText text={s.extra.capacityBasisNote} /></div>}
          {/* 경보 폴백 고지(v2.513) — 장비가 state 필터를 못 받아 '전체를 받아 코드에서 거른' 경우.
              수집은 성공(ok)이지만 **어떻게 센 건수인지**가 다르므로 조용히 넘기지 않는다. */}
          {s.extra?.alertsNote && <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>ℹ 경보: {s.extra.alertsNote}</div>}
        </>
      )}
    </Modal>
  );
}

/** 등록/수정 폼 — 타입(구현/예정 구분)·법인·수집 주체(중앙/엣지)·자격증명. */
/**
 * 연결 테스트 결과 상자(v2.404). 성공/실패만 말하지 않고 **무엇이 되고 무엇이 안 됐는지**를
 * 섹션별로 보여준다 — 부분 성공(예: 인증은 됐는데 용량 API 만 404)을 '성공'으로 뭉뚱그리면
 * 등록 후에야 빈 값을 보게 된다(스토리지 수집기의 sections 규약이 정직 표기인 이유와 같다).
 */
function TestResult({ r }) {
  const okColor = r.ok ? 'var(--green)' : 'var(--red)';
  const sections = Object.entries(r.sections || {});
  const cap = r.capacity && r.capacity.totalBytes ? `${tbFmt(r.capacity.usedBytes)} / ${tbFmt(r.capacity.totalBytes)}` : null;
  return (
    <div className="card" style={{ padding: '10px 12px', marginTop: 10, borderColor: okColor, fontSize: 12.5 }}>
      <div style={{ color: okColor, fontWeight: 700, marginBottom: r.ok || r.error ? 6 : 0 }}>
        {r.ok ? '✅ 연결 성공' : '⛔ 연결 실패'}{r.ms != null ? ` · ${r.ms}ms` : ''}
      </div>
      {!r.ok && r.error && <div style={{ color: 'var(--red)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginBottom: 6 }}>{r.error}</div>}
      {r.ok && (
        <div className="flex gap wrap" style={{ gap: 14, marginBottom: sections.length ? 6 : 0 }}>
          {r.name && <span className="muted">이름 <b style={{ color: 'var(--text)' }}>{r.name}</b></span>}
          {r.version && <span className="muted">버전 <b style={{ color: 'var(--text)' }}>{r.version}</b></span>}
          {r.serial && <span className="muted">시리얼 <b style={{ color: 'var(--text)' }}>{r.serial}</b></span>}
          {cap && <span className="muted">용량 <b style={{ color: 'var(--text)' }}>{cap}</b></span>}
          {r.counts && <span className="muted">노드 {r.counts.nodes} · 풀 {r.counts.pools} · 계정 {r.counts.accounts} · 경보 {r.counts.alerts}</span>}
        </div>
      )}
      {sections.length > 0 && (
        <div className="flex gap wrap" style={{ gap: 6 }}>
          {sections.map(([k, v]) => (
            <span key={k} className={`badge ${v === 'ok' ? 'green' : v === 'skip' ? 'gray' : 'red'}`}
              title={v === 'ok' ? '수집됨' : v === 'skip' ? '이 타입은 해당 섹션이 없거나 건너뜀' : String(v)}>
              {k} {v === 'ok' ? '✓' : v === 'skip' ? '–' : '✗'}
            </span>
          ))}
        </div>
      )}
      {/* SSH CLI 수집(pstcli·uemcli·xmcli·vplexcli)의 명령별 원문(v2.405).
          이 CLI 들은 버전마다 출력 형식이 달라 파싱이 빗나갈 수 있다. 원문을 접어서 보여주면
          '어떤 명령이 무엇을 돌려줬는지'를 바로 확인해 교정할 수 있다(추측 제거). */}
      <CliRawList raw={r.cliRaw} />
      {r.ok && <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>테스트 결과는 저장되지 않습니다 — 목록/추이/작업 로그에 반영하려면 '저장' 후 수집하세요.</div>}
    </div>
  );
}

function DeviceForm({ d, form, setForm, onSaved, onShowConflict }) {
  // 충돌 장비 표기용 — 서버는 법인 id·타입 키만 준다(이름은 이 응답이 갖고 있다).
  // ⚠ 아래 `typeLabel` 은 **지금 폼에서 고른 타입의 라벨**이라 이름이 겹친다. 섞지 말 것.
  const dcNameOf = (id) => ((d.datacenters || []).find((x) => x.id === id)?.name || id || '미지정');
  const typeLabelOf = (t) => ((d.types || []).find((x) => x.type === t)?.label || t);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  // 중복 등록으로 거부됐을 때 서버가 지목한 충돌 장비(v2.522). ⚠ 훅은 조기 return 위에서만
  // 선언한다(CLAUDE.md — React #310 크래시 재발 방지).
  const [conflict, setConflict] = useState(null);
  // 연결 테스트 결과(v2.404, 사용자 요구 — Unity 등 API 장비를 등록하기 전에 실제로 도는지 확인).
  // null=아직 안 함, {ok,...}=결과. 입력이 바뀌면 낡은 결과를 지운다(다른 설정의 성공을 새 설정의
  // 성공으로 오해하는 것이 이런 UI 의 대표적 사고다).
  const [test, setTest] = useState(null);
  const [testing, setTesting] = useState(false);
  const edit = (patch) => { setTest(null); setForm({ ...form, ...patch }); };
  // 현재 타입이 지원하는 수집 방식(서버 카탈로그). 알 수 없는 타입이면 API 단일로 본다.
  const typeEntry = (d.types || []).find((t) => t.type === form.type);
  const methods = (typeEntry?.methods?.length ? typeEntry.methods : [{ value: 'api', label: 'REST API' }]);
  const typeLabel = typeEntry?.label || '';
  // 저장값이 그 타입에서 허용되지 않으면(타입을 바꾼 직후 등) 첫 항목으로 보정 — 서버의
  // normalizeCollectMethod 와 같은 규칙이라 화면과 저장 결과가 어긋나지 않는다.
  const method = methods.some((m) => m.value === form.collectMethod) ? form.collectMethod : methods[0].value;
  const methodHint = methods.find((m) => m.value === method)?.hint || '';
  const save = async () => {
    setBusy(true); setErr(null);
    // v2.522: 중복 거부는 서버가 **충돌 장비**(conflict)를 함께 준다 — 사유만 보여주면
    // 13개 법인·42대에서 사용자가 그 장비를 찾을 수 없다(실제 신고). 아래 상자가 지목한다.
    setConflict(null);
    try {
      const r = await postJson('/tools/storage/devices', form);
      if (r.ok === false) { setErr(r.reason); setConflict(r.conflict || null); } else onSaved();
    } catch (e) {
      // ⚠ 400 은 api.js 가 HttpError 로 **던진다** — 여기서 conflict 를 읽지 않으면 사유
      //   한 줄만 남고 '어느 장비인지' 가 다시 사라진다(v2.522 실측으로 잡은 경로).
      setErr(e.message); setConflict(e.body?.conflict || null);
    } finally { setBusy(false); }
  };
  const runTest = async () => {
    setTesting(true); setTest(null); setErr(null);
    try {
      const r = await postJson('/tools/storage/test', form);
      // 400(검증 실패)은 reason 만 오고 ok:false — 그대로 결과 상자에 보여준다.
      setTest({ ...r, ok: !!r.ok, error: r.error || r.reason || '' });
    } catch (e) { setTest({ ok: false, error: e.message }); } finally { setTesting(false); }
  };
  return (
    <div className="card" style={{ padding: 14, marginBottom: 12, background: 'rgba(96,165,250,.05)' }}>
      <div className="flex between" style={{ marginBottom: 8 }}>
        <b style={{ fontSize: 13 }}>{form.id ? `장비 수정 — ${form.name}` : '장비 등록'}</b>
        <button className="logout-btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setForm(null)}>닫기</button>
      </div>
      <div className="flex gap wrap" style={{ alignItems: 'flex-end' }}>
        <label style={{ fontSize: 12 }}>타입<br />
          <select className="select" value={form.type}
            onChange={(e) => {
              // 타입을 바꾸면 그 타입의 기본 수집 방식으로 함께 맞춘다 — 이전 타입의 방식(예: ssh)이
              // 남아 있으면 서버가 보정해 버려 화면에 보이던 값과 실제 저장값이 달라진다.
              const nt = e.target.value;
              const list = (d.types || []).find((t) => t.type === nt)?.methods || [{ value: 'api' }];
              edit({ type: nt, collectMethod: list[0].value });
            }}>
            {(d.types || []).map((t) => <option key={t.type} value={t.type} disabled={!t.implemented}>{t.label}{t.implemented ? '' : ' (예정)'}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12 }}>표시명<br /><input className="input" style={{ width: 160 }} value={form.name} onChange={(e) => edit({ name: e.target.value })} placeholder="WA-Isilon-01" /></label>
        <label style={{ fontSize: 12 }}>host(IP/FQDN)<br /><input className="input" style={{ width: 180 }} value={form.host} onChange={(e) => edit({ host: e.target.value })} placeholder="10.20.0.50" /></label>
        {/* 수집 방식(v2.405, 사용자 요구 '장비별로 특화된 수집 방법을 메뉴에 표시').
            예전에는 isilon 일 때만 메뉴를 띄우고 나머지는 서버가 조용히 api 로 고정해, 사용자가
            PowerStore/Unity 가 무엇으로 수집되는지 화면에서 알 수 없었다. 이제 서버가 내려주는
            타입별 methods 목록을 그대로 그린다 — 선택지가 하나뿐이면 고정임을 보이도록 비활성
            표시한다('숨김'이 아니라 '고정'). 목록 자체는 서버(types.js COLLECT_METHODS)가 단일 소스. */}
        <label style={{ fontSize: 12 }} title={methodHint || '이 장비 타입이 지원하는 수집 방식입니다.'}>
          수집 방식{typeLabel ? ` (${typeLabel})` : ''}<br />
          <select className="select" value={method} disabled={methods.length < 2}
            onChange={(e) => edit({ collectMethod: e.target.value })}>
            {methods.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>
        {methods.length < 2 && (
          <span className="muted" style={{ fontSize: 11, paddingBottom: 8 }}>이 타입은 이 방식만 지원합니다.</span>
        )}
        {/* SSH 포트는 SSH 방식일 때만(REST 는 443 을 쓰고 환경변수로 조정한다). */}
        {method === 'ssh' && (
          <label style={{ fontSize: 12 }}>SSH 포트<br /><input className="input" type="number" min={1} max={65535} style={{ width: 80 }} value={form.sshPort || 22} onChange={(e) => edit({ sshPort: Number(e.target.value) || 22 })} /></label>
        )}
        <label style={{ fontSize: 12 }}>계정<br /><input className="input" style={{ width: 110 }} value={form.username} onChange={(e) => edit({ username: e.target.value })} /></label>
        <label style={{ fontSize: 12 }}>비밀번호{form.id ? '(변경 시만)' : ''}<br /><input className="input" type="password" style={{ width: 140 }} value={form.password} onChange={(e) => edit({ password: e.target.value })} placeholder={form.hasPassword ? '•••• (유지)' : ''} /></label>
        <label style={{ fontSize: 12 }}>법인(DataCenter)<br />
          <select className="select" value={form.datacenterId || ''} onChange={(e) => setForm({ ...form, datacenterId: e.target.value })}>
            <option value="">(미지정)</option>
            {(d.datacenters || []).map((x) => <option key={x.id} value={x.id}>{x.name || x.id}</option>)}
            {/* v2.515: 저장된 값이 목록에 없으면 **그 값을 옵션으로 추가**한다. 없으면 브라우저가
                첫 옵션('(미지정)')을 표시해 **폼이 사실과 다른 값을 보여준다** — 실제로 법인이
                'ST' 인 장비를 열었을 때 '(미지정)' 으로 보였다(v2.515 스크린샷 판독에서 발견).
                그 상태로 다른 칸만 고쳐 저장하면 사용자가 본 것(미지정)과 저장된 것(ST)이 다르다.
                목록에 없는 이유(법인 삭제·엣지가 보낸 낡은 id)를 단정하지 않고 사실만 적는다. */}
            {form.datacenterId && !(d.datacenters || []).some((x) => x.id === form.datacenterId)
              ? <option value={form.datacenterId}>{form.datacenterId} — 법인 목록에 없는 값</option>
              : null}
          </select>
        </label>
        {/* 수집 주체(v2.312 개선): 알려진 엣지 목록을 제안하되 **직접 입력도 허용**(datalist).
            엣지가 아직 중앙에 한 번도 보고하지 않은 부트스트랩(토큰 미발급·최초 구성) 상황에서도
            위임을 걸 수 있어야 한다(select 만이면 목록이 비어 위임 자체가 불가능했던 것이 원인).
            빈 값 = 중앙에서 직접 수집. */}
        <label style={{ fontSize: 12 }} title="중앙이 직접 못 닿는 폐쇄망 장비는 그 법인의 엣지 포탈이 현지에서 수집합니다(iDRAC 위임과 동일). 목록에 없으면 엣지 이름(AGENT_NAME)을 직접 입력하세요.">수집 주체(비우면 중앙 직접)<br />
          <input className="input" list="storage-agent-list" style={{ width: 200 }} value={form.agent || ''}
            onChange={(e) => setForm({ ...form, agent: e.target.value })} placeholder="🖥️ 중앙에서 직접 (또는 엣지 이름)" />
          <datalist id="storage-agent-list">
            {(d.agents || []).map((a) => <option key={a} value={a}>엣지 {a}</option>)}
          </datalist>
        </label>
        <label className="muted flex gap" style={{ alignItems: 'center', fontSize: 12, padding: '6px 0' }}>
          <input type="checkbox" checked={form.enabled !== false} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> 활성
        </label>
        {/* 연결 테스트 — 저장하지 않고 수집기를 1회 돌려 API 가 실제로 도는지 확인(v2.404).
            서버가 ssrfBlockReason 을 그대로 태우므로 임의 host 프로브로 쓰이지 않는다. */}
        <button className="tab" style={{ flex: 'none', padding: '8px 14px' }}
          disabled={testing || busy || !form.name || !form.host || !form.username}
          title="저장하지 않고 지금 입력한 값으로 장비 API 에 접속해 봅니다(수집 1회 실행)."
          onClick={runTest}>{testing ? '테스트 중…' : '🔌 연결 테스트'}</button>
        <button className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} disabled={busy || !form.name || !form.host} onClick={save}>{busy ? '저장 중…' : '저장'}</button>
      </div>
      {test && <TestResult r={test} />}
      {/* 중복 거부 안내(v2.522) — 사유 한 줄이 아니라 **어느 장비인지**를 지목하고 데려간다. */}
      {conflict ? (() => {
        const ct = conflictText(conflict, { dcName: dcNameOf, typeLabel: typeLabelOf });
        return (
          <div className="card" style={{ padding: '12px 14px', marginTop: 8, borderLeft: '3px solid var(--amber)' }}>
            <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--amber)' }}>⚠ {ct.head}</div>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{ct.where}</div>
            <div className="muted" style={{ fontSize: 11.5, marginTop: 6, whiteSpace: 'normal' }}>{ct.hint}</div>
            {onShowConflict && (
              <div style={{ marginTop: 8 }}>
                <button className="qn-btn" onClick={() => onShowConflict(conflict)}>🔎 그 장비 보기</button>
              </div>
            )}
          </div>
        );
      })() : (err && <div style={{ color: 'var(--red)', fontSize: 12.5, marginTop: 8 }}>⚠ {err}</div>)}
      <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>비밀번호는 '설정 › 자격증명 저장 방식'의 정책(평문/암호화)에 따라 저장됩니다. host 변경 시 기존 비밀번호는 이월되지 않습니다(재입력 필요 — 보안 규칙).</div>
    </div>
  );
}


/**
 * 추이 기간 프리셋(v2.380) — 서버 storageMon.js USAGE_RANGES 와 키가 일치해야 한다.
 * 12시간·24시간을 사용자 요구로 추가했다(수집 주기 10분이라 12h=72점·24h=144점으로 가볍다).
 */
const TREND_RANGES = [
  ['12h', '12시간'], ['24h', '24시간'], ['7d', '1주'], ['30d', '1달'], ['90d', '3달'], ['400d', '400일'],
];
/** 기간에 맞춘 축 라벨 — 단기는 시:분, 장기는 날짜(과밀 방지). */
function fmtTrendTs(ts, range) {
  const dt = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  if (range === '12h' || range === '24h') return `${p(dt.getHours())}:${p(dt.getMinutes())}`;
  if (range === '7d') return `${p(dt.getMonth() + 1)}.${p(dt.getDate())} ${p(dt.getHours())}시`;
  if (range === '400d') return `${String(dt.getFullYear()).slice(2)}.${p(dt.getMonth() + 1)}.${p(dt.getDate())}`;
  return `${p(dt.getMonth() + 1)}.${p(dt.getDate())}`;
}

/**
 * 통합 추이 패널(v2.380) — 목록 화면에서 모달을 열지 않고 바로 보는 용량 추이.
 * '전체 합계'는 모든 장비를 버킷 평균 후 합산한다(서버 /tools/storage/history).
 * 장비마다 수집 시각이 다르므로 각 점의 devices(그 시각에 데이터가 있던 장비 수)를 함께
 * 보여준다 — 일부 장비만 수집된 구간을 '전체 용량 급감'으로 오독하지 않게 하기 위함이다.
 * 데이터는 스토리지 전용 독립 DB(storage-history.db capacity_history)에서 온다.
 */
function StorageTrendPanel({ devices }) {
  // ⚠ 훅은 조기 return 위에서 전부 선언(CLAUDE.md — React #310 방지).
  const [range, setRange] = useState('24h');
  const [target, setTarget] = useState('');      // '' = 전체 합계, 그 외 = deviceId
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let live = true;
    setD(null); setErr(null);
    const url = target
      ? `/tools/storage/devices/${encodeURIComponent(target)}/history?range=${range}`
      : `/tools/storage/history?range=${range}`;
    fetchJson(url).then((r) => { if (live) setD(r); }).catch((e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [target, range]);

  const pts = (d?.points || []).map((p) => ({
    t: fmtTrendTs(p.ts, range),
    used: p.used_bytes, total: p.total_bytes,
    hddUsed: p.hdd_used, ssdUsed: p.ssd_used, devices: p.devices, usedUnknown: p.used_unknown || 0,
  }));
  // v2.594: 사용량을 못 읽은 장비가 있던 구간은 서버가 사용량을 비운다(부분 합은 거짓 하락이다).
  const usedGapPts = pts.filter((p) => p.usedUnknown > 0).length;
  const hasHdd = pts.some((p) => p.hddUsed != null && p.hddUsed > 0);
  const hasSsd = pts.some((p) => p.ssdUsed != null && p.ssdUsed > 0);
  // 부분 수집 구간 경고 — 점마다 장비 수가 다르면 합산선이 계단처럼 보인다(데이터 특성).
  const devCounts = [...new Set(pts.map((p) => p.devices).filter((x) => x != null))];
  const partial = !target && devCounts.length > 1;
  const last = pts.length ? pts[pts.length - 1] : null;

  return (
    <div className="card" style={{ padding: 14 }}>
      <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 10 }}>
        <div className="flex gap wrap" style={{ gap: 6, alignItems: 'center' }}>
          <div className="section-title" style={{ fontSize: 13, margin: 0 }}>용량 추이</div>
          {TREND_RANGES.map(([v, l]) => (
            <button key={v} className={range === v ? 'login-btn' : 'logout-btn'}
              style={{ flex: 'none', padding: '4px 10px', fontSize: 11.5 }} onClick={() => setRange(v)}>{l}</button>
          ))}
        </div>
        <select className="select" value={target} onChange={(e) => setTarget(e.target.value)} style={{ minWidth: 200 }}>
          <option value="">전체 합계({(devices || []).length}대)</option>
          {(devices || []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>

      {last && (
        <div className="flex gap wrap" style={{ fontSize: 12.5, marginBottom: 8 }}>
          <span className="muted">최근 사용 <b style={{ color: 'var(--text)' }}>{tbFmt(last.used)}</b></span>
          <span className="muted">전체 <b style={{ color: 'var(--text)' }}>{tbFmt(last.total)}</b></span>
          {last.total > 0 && <span className="muted">사용률 <b style={{ color: 'var(--text)' }}>{last.used != null ? `${Math.round((last.used / last.total) * 100)}%` : '—'}</b>{last.used == null && last.usedUnknown ? ` (사용량 미확인 ${last.usedUnknown}대)` : ''}</span>}
          {!target && last.devices != null && <span className="muted">수집 장비 <b style={{ color: 'var(--text)' }}>{last.devices}</b>대</span>}
        </div>
      )}

      {err ? <div className="muted" style={{ fontSize: 12 }}>추이 조회 오류: {err}</div>
        : !d ? <div className="muted" style={{ fontSize: 12 }}>불러오는 중…</div>
          : pts.length === 0 ? (
            <div className="muted" style={{ fontSize: 12.5, padding: 20, textAlign: 'center', lineHeight: 1.8 }}>
              이 기간에 시계열 데이터가 없습니다.<br />
              용량 추이는 <b>수집이 누적된 시점부터</b> 표시됩니다(수집 주기 10분).
              {d.db === false ? <><br /><b>이 서버에서 시계열 DB(SQLite)를 사용할 수 없습니다</b> — 최신 스냅샷만 동작합니다.</> : null}
            </div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={pts} margin={{ top: 6, right: 12, left: 4, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.08)" />
                  <XAxis dataKey="t" tick={{ fontSize: 11 }} minTickGap={44} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => tbFmt(v)} width={74} />
                  <Tooltip contentStyle={{ background: '#0b1220', border: '1px solid #243049', fontSize: 12 }} formatter={(v) => tbFmt(v)} />
                  <Legend wrapperStyle={{ fontSize: 11.5 }} />
                  {/* '전체'는 계열이 아니라 한계선(컨텍스트) — 중립 회색 점선(기존 모달 추이와 동일 규약) */}
                  <Line type="monotone" dataKey="total" name="전체" stroke="#8b9bb4" strokeDasharray="4 3" dot={false} strokeWidth={1.4} connectNulls={false} />
                  <Line type="monotone" dataKey="used" name="사용" stroke="#3987e5" dot={false} strokeWidth={1.8} connectNulls={false} />
                  {hasHdd && <Line type="monotone" dataKey="hddUsed" name="HDD 사용" stroke="#d95926" dot={false} strokeWidth={1.5} connectNulls={false} />}
                  {hasSsd && <Line type="monotone" dataKey="ssdUsed" name="SSD 사용" stroke="#199e70" dot={false} strokeWidth={1.5} connectNulls={false} />}
                </LineChart>
              </ResponsiveContainer>
              <div className="muted" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.7 }}>
                점선(회색) = 전체 용량 · 실선 = 사용량. 데이터는 스토리지 전용 DB(storage-history.db)에 적재됩니다.
                {(d.bucketMs || 0) > 0 ? ` 집계 단위 ${(d.bucketMs >= 86_400_000 ? `${Math.round(d.bucketMs / 86_400_000)}일` : `${Math.round(d.bucketMs / 60_000)}분`)} 평균 ·` : ' 원본 값 ·'} 표본 {pts.length}점
                {usedGapPts ? <><br /><b style={{ color: 'var(--amber)' }}>주의</b> {usedGapPts}개 구간은 사용량을 읽지 못한 장비가 있어 사용량 선을 비웠습니다(부분 합을 전체처럼 그리지 않습니다).</> : null}
                {partial ? <><br /><b style={{ color: 'var(--amber)' }}>주의</b> 구간에 따라 수집된 장비 수가 다릅니다({devCounts.sort((a, b) => a - b).join('·')}대) — 합계선의 급변이 실제 용량 변화가 아닐 수 있습니다. 장비를 선택해 개별 추이로 확인하세요.</> : null}
              </div>
            </>
          )}
    </div>
  );
}

/**
 * 용량 추이 그래프(v2.318, 사용자 백로그) — 장비 상세 모달의 시계열 라인 차트.
 *
 * 데이터: GET /tools/storage/devices/:id/history (v2.308 capacity_history — 중앙 직접 수집분 +
 * v2.318 부터 엣지 push 수신분도 중앙 DB 에 적재). 7일 초과 구간은 서버가 버킷 평균으로
 * 다운샘플(~800점) — 원시 그대로면 장기 구간에서 최근이 잘려 나갔다.
 *
 * 색(dataviz 검증기 통과 — 다크 서피스 #0b1220 기준 전 체크 PASS):
 *   사용 #3987e5(파랑) · HDD 사용 #d95926(오렌지) · SSD 사용 #199e70(아쿠아).
 *   '전체'는 정체성 시리즈가 아니라 한계선(컨텍스트)이라 중립 회색 **점선**(점선=보조 인코딩 —
 *   회색은 계열 색으로는 검증 FAIL 이지만 참조선으로는 의도된 중립). 시리즈 ≥2 라 범례 표시.
 */
function CapacityTrend({ deviceId, isEdge, onPoints }) {
  // 기간 프리셋(v2.380): 12시간·24시간을 사용자 요구로 추가. 서버 range 파라미터를 쓴다
  // (days 도 계속 지원되지만 12시간은 정수 days 로 표현할 수 없다).
  const [range, setRange] = useState('7d');
  const [d, setD] = useState(null);      // { db, points } — null = 로딩 전
  const [err, setErr] = useState(null);
  useEffect(() => {
    let live = true;
    setD(null); setErr(null);
    fetchJson(`/tools/storage/devices/${encodeURIComponent(deviceId)}/history?range=${range}`)
      .then((r) => { if (live) { setD(r); onPoints?.(r?.points || []); } })
      .catch((e) => { if (live) setErr(e.message); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, range]);

  const fmtT = (ts) => fmtTrendTs(ts, range);
  const pts = (d?.points || []).map((p) => ({
    t: fmtT(p.ts),
    used: p.used_bytes, total: p.total_bytes,
    hddUsed: p.hdd_used, ssdUsed: p.ssd_used,
  }));
  const hasHdd = pts.some((p) => p.hddUsed != null && p.hddUsed > 0);
  const hasSsd = pts.some((p) => p.ssdUsed != null && p.ssdUsed > 0);
  return (
    <>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 6 }}>
        <div className="section-title" style={{ fontSize: 13, margin: 0 }}>용량 추이</div>
        {TREND_RANGES.map(([v, l]) => (
          <button key={v} className={range === v ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '4px 10px', fontSize: 11.5 }} onClick={() => setRange(v)}>{l}</button>
        ))}
      </div>
      {err ? <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>추이 조회 오류: {err}</div>
        : !d ? <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>불러오는 중…</div>
          : pts.length === 0 ? (
            <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
              해당 기간 시계열 데이터가 없습니다(수집 누적 후 표시{isEdge ? ' — 엣지 장비는 v2.318 이후 push 수신분부터 중앙에 적재' : ''}).
            </div>
          ) : (
            <div style={{ marginBottom: 12 }}>
              <ResponsiveContainer width="100%" height={230}>
                <LineChart data={pts} margin={{ top: 6, right: 12, left: 4, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.08)" />
                  <XAxis dataKey="t" tick={{ fontSize: 11 }} minTickGap={44} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => tbFmt(v)} width={74} />
                  <Tooltip contentStyle={{ background: '#0b1220', border: '1px solid #243049', fontSize: 12 }} formatter={(v) => tbFmt(v)} />
                  <Legend wrapperStyle={{ fontSize: 11.5 }} />
                  <Line type="monotone" dataKey="total" stroke="#8b93a7" strokeDasharray="5 4" dot={false} name="전체(한계)" isAnimationActive={false} />
                  <Line type="monotone" dataKey="used" stroke="#3987e5" strokeWidth={2} dot={false} name="사용" isAnimationActive={false} />
                  {hasHdd && <Line type="monotone" dataKey="hddUsed" stroke="#d95926" dot={false} name="HDD 사용" isAnimationActive={false} />}
                  {hasSsd && <Line type="monotone" dataKey="ssdUsed" stroke="#199e70" dot={false} name="SSD 사용" isAnimationActive={false} />}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
    </>
  );
}

/**
 * CSV 내보내기 모달(v2.317, 사용자 요구 '패스워드 포함 여부 선택').
 * 비밀번호 포함은 평문 자격증명 덤프 — 서버가 requireSettingsOwner(백업과 동일 게이트)로
 * 추가 검사하므로 admin 이어도 소유자가 아니면 403 이 뜬다(사유 그대로 표시).
 */
function CsvExport({ onClose }) {
  const [withPw, setWithPw] = useState(false);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true); setErr(null);
    try { await downloadFile(`/tools/storage/devices/export.csv${withPw ? '?passwords=1' : ''}`); onClose(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal title="스토리지 장비 CSV 내보내기" onClose={onClose} width={480}>
      <label className="flex gap" style={{ alignItems: 'center', fontSize: 13, marginBottom: 8 }}>
        <input type="checkbox" checked={withPw} onChange={(e) => setWithPw(e.target.checked)} />
        비밀번호 포함(평문)
      </label>
      {withPw && (
        <div className="card" style={{ borderColor: 'var(--amber)', padding: '8px 12px', fontSize: 12, marginBottom: 8 }}>
          ⚠ 내려받는 CSV 에 장비 접속 비밀번호가 <b>평문</b>으로 들어갑니다 — 파일 취급에 주의하세요.
          설정 소유자 계정만 가능하며 감사로그에 기록됩니다.
        </div>
      )}
      {err && <div style={{ color: 'var(--red)', fontSize: 12.5, marginBottom: 8 }}>⚠ {err}</div>}
      <div className="flex gap" style={{ justifyContent: 'flex-end' }}>
        <button className="login-btn" style={{ padding: '8px 18px' }} disabled={busy} onClick={run}>{busy ? '내려받는 중…' : '⬇ 내려받기'}</button>
      </div>
    </Modal>
  );
}

/** OneFS API 영역 원문 뷰어(v2.308) — 이 노드 DB(api_latest)의 엔드포인트별 최신 JSON. */
function AreaJsonViewer({ deviceId, area, onClose }) {
  const [rows, setRows] = useState(null);   // 영역의 엔드포인트 목록
  const [sel, setSel] = useState(null);     // 선택한 엔드포인트 원문
  const [err, setErr] = useState(null);
  const run = useLatest();   // v2.447: 장비/영역을 바꾸면 이전 응답을 버린다(감사 B16)
  useEffect(() => {
    run(fetchJson(`/tools/storage/devices/${encodeURIComponent(deviceId)}/areas`),
      (r) => setRows((r.rows || []).filter((x) => x.area === area)), (e) => setErr(e.message));
  }, [deviceId, area, run]);
  const open = (ep) => fetchJson(`/tools/storage/devices/${encodeURIComponent(deviceId)}/areas/json`, { endpoint: ep })
    .then((r) => setSel({ ep, ...r })).catch((e) => setSel({ ep, error: e.message }));
  return (
    <div className="card" style={{ padding: 12, marginBottom: 12, background: 'rgba(96,165,250,.05)' }}>
      <div className="flex between" style={{ marginBottom: 6 }}>
        <b style={{ fontSize: 12.5 }}>영역 원문 — {area}</b>
        <button className="logout-btn" style={{ padding: '3px 9px', fontSize: 11.5 }} onClick={onClose}>닫기</button>
      </div>
      {err ? <ErrorBox message={err} /> : !rows ? <Loading /> : rows.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>저장된 원문 없음(다음 영역 수집 주기 대기 — 기본 60분)</div> : (
        <>
          <div className="flex gap wrap" style={{ marginBottom: 6 }}>
            {rows.map((x) => (
              <button key={x.endpoint} className="tab" style={{ padding: '3px 9px', fontSize: 11, color: x.ok ? undefined : 'var(--red)' }}
                title={x.error || `${Math.round(x.bytes / 1024)}KB · ${new Date(x.ts).toLocaleString('ko-KR')}${x.truncated ? ' · 512KB 절단' : ''}`}
                onClick={() => open(x.endpoint)}>{x.endpoint.split('?')[0]}{x.ok ? '' : ' ⛔'}</button>
            ))}
          </div>
          {sel && (
            sel.error ? <div style={{ color: 'var(--red)', fontSize: 12 }}>⛔ {sel.error}</div> : (
              <>
                {sel.truncated ? <div className="muted" style={{ fontSize: 11, color: 'var(--amber)' }}>⚠ 원문이 512KB 를 넘어 절단 저장됨(뒷부분 생략)</div> : null}
                <pre style={{ maxHeight: '30vh', overflow: 'auto', fontSize: 11, background: 'rgba(0,0,0,.25)', padding: 8, borderRadius: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{(() => { try { return JSON.stringify(JSON.parse(sel.json), null, 2); } catch { return sel.json; } })()}</pre>
              </>
            )
          )}
        </>
      )}
    </div>
  );
}
