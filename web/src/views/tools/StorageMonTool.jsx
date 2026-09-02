import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import { fetchJson, postJson, delJson, downloadFile } from '../../api.js';
import { Loading, ErrorBox, Kpi, UsageCell, Modal, SearchBox, usageColor } from '../../components/ui.jsx';
import { columnsFor, cellValue } from './storageColumns.js';
import { UNIT_OPTIONS, formatBytes, loadUnit, saveUnit } from './storageUnits.js';

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
const MediaCell = ({ m }) => (m ? <span title={`${tbFmt(m.usedBytes)} / ${tbFmt(m.totalBytes)}`}><UsageCell pct={m.pct ?? 0} /><span className="muted" style={{ fontSize: 10.5, display: 'block' }}>{tbFmt(m.usedBytes)}/{tbFmt(m.totalBytes)}</span></span> : <span className="muted">—</span>);
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
function failReason(s) {
  if (!s) return '수집 기록 없음';
  return s.error
    || Object.entries(s.sections || {}).filter(([, v]) => /오류/.test(String(v))).map(([k, v]) => `${k} ${v}`).join(' · ')
    || '사유 미상(장비 상세에서 섹션별 결과를 확인하세요)';
}

export default function StorageMonTool() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState('devices');   // devices | dc | type
  const [detail, setDetail] = useState(null);    // 장비 상세 모달 — id 로 보관(v2.306: load() 후 최신 스냅샷 자동 반영)
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
  const dcRefs = useRef({});                      // 법인명 → 그룹 DOM(스크롤/반짝용)
  const [jumpTo, setJumpTo] = useState(null);     // 다른 뷰에서 눌렀을 때 '법인별'로 전환 후 이동할 대상
  // 대상 블록으로 스크롤 + 반짝임(VCenters.jsx gotoCard 와 동일 절차). dcRefs 만 쓰므로 조기
  // return 위에 둘 수 있고, 아래 useEffect 에서도 쓴다. 타이머는 fire-and-forget —
  // 언마운트 후 실행돼도 분리된 DOM 노드의 클래스를 지우는 것뿐이라 부작용이 없다.
  const flashDc = (dc) => {
    const el = dcRefs.current[dc];
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.remove('qn-flash');
    void el.offsetWidth;               // 리플로우로 애니메이션 재시작 보장(같은 칩 연타 대응)
    el.classList.add('qn-flash');
    setTimeout(() => el.classList.remove('qn-flash'), 3200); // CSS 3s 보다 살짝 길게
  };

  const load = () => fetchJson('/tools/storage').then((r) => { setD(r); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, []);
  // 뷰 전환(→ 법인별) 후 실제로 DOM 이 생긴 다음 스크롤한다 — setView 직후에는 대상이 아직 없다.
  useEffect(() => {
    if (!jumpTo || view !== 'dc') return;
    setJumpTo(null);
    flashDc(jumpTo);
  }, [jumpTo, view]);
  if (err && !d) return <ErrorBox message={err} />;
  if (!d) return <Loading />;

  const rows = d.devices || [];
  const dcName = (id) => ((d.datacenters || []).find((x) => x.id === id)?.name || id || '미지정');
  const typeLabel = (t) => ((d.types || []).find((x) => x.type === t)?.label || t);
  const sum = (list, f) => list.reduce((a, x) => a + (f(x) || 0), 0);
  const withSnap = rows.filter((r) => r.snap);
  const totals = {
    total: sum(withSnap, (r) => r.snap.capacity?.totalBytes),
    used: sum(withSnap, (r) => r.snap.capacity?.usedBytes),
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
  const kws = dcQuery.toLowerCase().split(/\s+/).filter(Boolean);
  const matchDevice = (r) => {
    if (!kws.length) return true;
    const hay = [dcName(r.datacenterId), r.name, r.snap?.name, r.host, typeLabel(r.type), r.agent]
      .filter(Boolean).join(' ').toLowerCase();
    return kws.every((kw) => hay.includes(kw));
  };
  const shown = rows.filter(matchDevice);          // 하단 목록·그룹의 원천(검색 반영)
  // 그룹핑(법인별/타입별) — 서버 평탄 목록을 프론트에서 묶는다(뷰 확장에 서버 변경 불필요).
  const groupShown = (keyFn) => {
    const m = new Map();
    for (const r of shown) { const k = keyFn(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return [...m.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  };
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
    const total = sum(ok, (r) => r.snap.capacity?.totalBytes);
    const used = sum(ok, (r) => r.snap.capacity?.usedBytes);
    const pct = total ? Math.round((used / total) * 100) : 0;
    const alerts = sum(ok, (r) => r.snap.alerts?.unresolved);
    const dot = fail ? 'var(--red)' : alerts ? 'var(--amber)' : usageColor(pct);
    return { fail, total, used, pct, alerts, dot };
  };

  // 바로가기 칩 클릭 — '법인별' 뷰가 아니면 전환을 예약하고(위 useEffect 가 렌더 후 이동),
  // 이미 그 뷰면 대상이 이미 DOM 에 있으므로 즉시 이동한다.
  const gotoDc = (dc) => {
    if (view !== 'dc') { setView('dc'); setJumpTo(dc); return; }
    flashDc(dc);
  };

  const collectNow = async (id) => {
    setBusy(true); setMsg(null);
    try { const r = await postJson(`/tools/storage/devices/${encodeURIComponent(id)}/collect`, {}); setMsg(r.ok ? '수집 완료 — 갱신됨' : r.reason); await load(); }
    catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusy(false); }
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
        setMsg(res.skipped
          ? `이미 수집이 진행 중입니다 — 잠시 후 반영됩니다 (엣지 ${r.edge}대는 다음 주기)`
          : `중앙 ${r.central}대 재수집 완료(성공 ${res.ok || 0}·실패 ${res.fail || 0}) · 엣지 ${r.edge}대는 다음 주기 반영`);
      } else setMsg(r.reason || '새로고침 실패');
      await load();
    } catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusy(false); }
  };

  /**
   * 한 칸 렌더(v2.406) — 값 계산은 storageColumns.cellValue(순수, 테스트로 고정)가 하고
   * 여기서는 '어떻게 보일지'만 정한다. 값이 null 이면 '—'(0 으로 위장 금지).
   */
  const Cell = ({ col, r }) => {
    const s = r.snap;
    const v = cellValue(col.key, r);
    const dash = <span className="muted">—</span>;
    switch (col.key) {
      case 'device':
        return <td><button className="cell-link" onClick={() => setDetail(r.id)}><b>{s?.name || r.name}</b></button><div className="muted" style={{ fontSize: 11 }}>{r.host}</div></td>;
      case 'type':
        return <td><span className="badge blue">{typeLabel(r.type)}</span></td>;
      case 'dc':
        return <td className="muted">{dcName(r.datacenterId)}</td>;
      case 'collect': {
        // 수집 주체(중앙/엣지) + 방식 배지. 실제 수집된 스냅샷의 방식이 진실이고, 없으면 등록값
        // (saveDevice 가 타입별 허용 목록으로 보정해 저장한다 — types.js COLLECT_METHODS).
        const m = s?.extra?.collectMethod || r.collectMethod || 'api';
        return (
          <td>{r.agent ? <span className="badge" style={{ background: 'rgba(167,139,250,.2)', color: '#a78bfa' }}>{r.agent}</span> : <span className="muted">중앙</span>}
            <span className={`badge ${m === 'ssh' ? 'blue' : 'gray'}`} style={{ marginLeft: 4, fontSize: 10 }} title={`모니터링(수집) 방식: ${m.toUpperCase()} — 등록/수정에서 변경`}>{m.toUpperCase()}</span>
          </td>
        );
      }
      case 'version':
        return <td className="muted" style={{ fontSize: 12 }}>{s?.version || '—'}</td>;
      case 'usage':
        return (
          <td style={{ minWidth: col.minWidth }}>
            {v != null ? <UsageCell pct={v} /> : dash}
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
        return <td style={{ textAlign: 'right' }}>{v == null ? dash : <>{v}{s?.nodes?.unhealthy ? <b style={{ color: 'var(--red)' }}> ⚠{s.nodes.unhealthy}</b> : null}</>}</td>;
      case 'health':
        return <td>{v ? <span className={`badge ${/ok|healthy|normal/i.test(String(v)) ? 'green' : 'red'}`}>{v}</span> : dash}</td>;
      case 'status':
        return (
          <td>
            {/* ⚠ 실패 사유를 이 칸에 '항상 보이는 한 줄'로 넣지 말 것 — 사유가 길면 상태 열이
                넓어져 표가 컨테이너를 넘고 오른쪽 '작업' 열이 잘린다(v2.403 실측·수정).
                사유는 자리를 차지하지 않는 경로로만: 호버=title, 클릭=상세 창. */}
            {!s ? <span className="badge gray">수집 전</span> : s.ok ? <span className="badge green">정상</span> : (
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
            <button className="logout-btn" style={{ padding: '3px 8px', fontSize: 11.5 }} disabled={busy} onClick={() => collectNow(r.id)} title={r.agent ? '엣지 수집 장비 — 주기 반영 안내' : '지금 수집(연결 테스트)'}>수집</button>
            {' '}<button className="logout-btn" style={{ padding: '3px 8px', fontSize: 11.5 }} disabled={busy} onClick={() => setForm({ ...r, password: '' })}>수정</button>
            {' '}<button className="logout-btn" style={{ padding: '3px 8px', fontSize: 11.5, color: 'var(--red)' }} disabled={busy} onClick={() => remove(r)}>삭제</button>
          </td>
        );
      default:
        return <td style={{ textAlign: col.align === 'right' ? 'right' : undefined }}>{v == null || v === '' ? dash : v}</td>;
    }
  };

  /** 한 타입만 담긴 표(컬럼이 그 타입 전용). */
  const TypedTable = ({ list, type, caption }) => {
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
          <table>
            <thead><tr>{cols.map((c) => <th key={c.key} className={c.align === 'right' ? 'right' : undefined} style={c.align === 'right' ? { textAlign: 'right' } : undefined}>{c.label}</th>)}</tr></thead>
            <tbody>
              {list.length === 0 && <tr><td colSpan={cols.length} className="center muted" style={{ padding: 20 }}>등록된 장비가 없습니다 — "+ 장비 등록"으로 시작하세요.</td></tr>}
              {list.map((r) => (
                <tr key={r.id} style={{ opacity: r.enabled === false ? 0.5 : 1 }}>
                  {cols.map((c) => <Cell key={c.key} col={c} r={r} />)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  /**
   * 장비 표(v2.406, 사용자 요구 '각각의 스토리지 전용 컬럼').
   * 스토리지 타입마다 의미 있는 지표가 다르다 — PowerStore 는 Physical/Logical/Data Reduction,
   * Isilon 은 HDD/SSD 풀, VPLEX 는 자체 용량이 없어 디렉터·헬스다. 하나의 고정 컬럼 집합으로는
   * 어떤 타입엔 빈 칸이, 어떤 타입엔 필요한 열이 없다.
   * 그래서 **목록에 여러 타입이 섞여 있으면 타입별로 표를 나눠** 각자의 전용 컬럼으로 그린다.
   * 단일 타입이면 표 하나(제목 없이) — 법인별/타입별 뷰에서 불필요한 머리글이 늘지 않게.
   */
  const DeviceTable = ({ list }) => {
    const types = [...new Set(list.map((r) => r.type))];
    if (list.length === 0) return <TypedTable list={list} type={null} />;
    if (types.length === 1) return <TypedTable list={list} type={types[0]} />;
    // 여러 타입 — 타입별 표로 나눈다(타입 이름 순서 고정: 화면이 갱신마다 흔들리지 않게).
    const byType = types
      .map((t) => [t, list.filter((r) => r.type === t)])
      .sort((a, b) => String(typeLabel(a[0])).localeCompare(String(typeLabel(b[0]))));
    return <>{byType.map(([t, rows]) => <TypedTable key={t} list={rows} type={t} caption />)}</>;
  };

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
        <button className="tab" style={{ flex: 'none', padding: '7px 13px' }} title="CSV 파일로 장비를 일괄 등록/수정" onClick={() => setImportOpen(true)}>⬆ CSV 가져오기</button>
        <button className="tab" style={{ flex: 'none', padding: '7px 13px' }} title="양식·예시가 담긴 샘플 CSV 내려받기"
          onClick={() => downloadFile('/tools/storage/devices/sample.csv').catch((e) => setMsg(`샘플 오류: ${e.message}`))}>📄 샘플 CSV</button>
        {/* 전체 새로고침(v2.315, 사용자 요구) — 중앙 직접 장비 즉시 재수집 + 화면 갱신(엣지는 다음 주기). */}
        <span style={{ width: 1, height: 22, background: 'var(--border)', margin: '0 2px' }} />
        <button className="tab" style={{ flex: 'none', padding: '7px 13px' }} disabled={busy}
          title="중앙 직접 수집 장비를 지금 다시 수집하고 화면을 갱신합니다(엣지 위임 장비는 다음 주기에 반영)"
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
        <Kpi label="사용" value={tbFmt(totals.used)} pct={totals.total ? Math.round((totals.used / totals.total) * 100) : 0} />
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
        <div className="vc-quicknav">
          <span className="qn-label">⚡ 법인 바로가기</span>
          {/* 칩에 별도 필터를 걸지 않는다 — dcGroups 가 이미 검색이 반영된 목록이라 칩과 하단
              목록이 항상 같은 집합을 가리킨다(따로 거르면 둘이 어긋난다). */}
          {dcGroups.map(([dc, list]) => {
              const g = dcSummary(list);
              return (
                <button key={dc} className={`qn-btn${g.fail ? ' down' : ''}`} onClick={() => gotoDc(dc)}
                  title={`${dc} — 장비 ${list.length}대 · ${tbFmt(g.used)} / ${tbFmt(g.total)}${g.total ? ` (${g.pct}%)` : ''}`
                    + `${g.fail ? ` · 수집 실패/대기 ${g.fail}` : ''}${g.alerts ? ` · 미해결 경보 ${g.alerts}` : ''}`}>
                  <span className="qn-dot" style={{ background: g.dot }} />{dc}
              </button>
            );
          })}
          {/* 빠른 찾기 — 아래 목록을 거른다. 무결과여도 박스가 남아야 입력을 지울 수 있다. */}
          <SearchBox className="input" style={{ marginLeft: 'auto', maxWidth: 250, minWidth: 180 }}
            value={dcQuery} onChange={setDcQuery} placeholder="법인·장비 찾기 (목록 필터)"
            title="입력한 글자가 포함된 법인·장비만 아래 목록에 표시합니다(법인명·장비명·host·타입·엣지에서 검색)." />
        </div>
      )}

      {/* 검색 결과 안내 — 몇 대가 걸렸는지, 없으면 왜 비었는지 알려준다(빈 화면 오해 방지). */}
      {kws.length > 0 && (
        shown.length === 0
          ? <div className="card" style={{ padding: '14px 16px', marginBottom: 12, color: 'var(--text-dim)', fontSize: 12.5 }}>
              "{dcQuery}" 와 일치하는 장비가 없습니다 — 법인명·장비명·host·타입·엣지에서 검색합니다.
            </div>
          : <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              🔎 "{dcQuery}" — 법인 {dcGroups.length}곳 · 장비 {shown.length}대 (전체 {rows.length}대 중)
            </div>
      )}

      {form && <DeviceForm d={d} form={form} setForm={setForm} onSaved={() => { setForm(null); load(); }} />}
      {importOpen && <CsvImport onClose={() => setImportOpen(false)} onDone={() => { setImportOpen(false); load(); }} />}
      {exportOpen && <CsvExport onClose={() => setExportOpen(false)} />}

      {view === 'devices' && <DeviceTable list={shown} />}
      {/* 통합 추이(v2.380) — 전체 합산 + 장비별 선택. 기간 12시간/24시간/1주 등.
          여기는 검색을 적용하지 않는다(전체 합산 차트라 부분집합이면 '전체'가 거짓이 된다). */}
      {view === 'trend' && <StorageTrendPanel devices={rows} />}
      {view === 'dc' && dcGroups.map(([dc, list]) => {
        const t = sum(list.filter((r) => r.snap), (r) => r.snap.capacity?.totalBytes);
        const u = sum(list.filter((r) => r.snap), (r) => r.snap.capacity?.usedBytes);
        return (
          // ref/qn-anchor: 위 '법인 바로가기' 칩의 스크롤·반짝 대상.
          <div key={dc} className="qn-anchor" ref={(el) => { dcRefs.current[dc] = el; }} style={{ marginBottom: 14 }}>
            <div className="section-title" style={{ fontSize: 14 }}>🏢 {dc} <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>— 장비 {list.length} · {tbFmt(u)} / {tbFmt(t)}{t ? ` (${Math.round((u / t) * 100)}%)` : ''}</span></div>
            <DeviceTable list={list} />
          </div>
        );
      })}
      {view === 'type' && groupShown((r) => typeLabel(r.type)).map(([ty, list]) => (
        <div key={ty} style={{ marginBottom: 14 }}>
          <div className="section-title" style={{ fontSize: 14 }}>📦 {ty} <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>— 장비 {list.length}</span></div>
          <DeviceTable list={list} />
        </div>
      ))}

      {(d.orphans || []).length > 0 && (
        <div className="card" style={{ padding: '9px 13px', marginTop: 8, borderColor: 'var(--amber)', fontSize: 12 }}>
          ⚠ 등록부에 없는 스냅샷 {d.orphans.length}건(삭제된 장비의 엣지 잔존 push) — 다음 엣지 push 주기에 자연 소멸합니다.
        </div>
      )}
      <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
        수집 주기 {Math.round((d.poller?.intervalMs || 0) / 60000)}분 · 엣지 장비는 config pull(≤5분) 후 현지 수집 → 중앙 push(≤5분).
        확장 로드맵(카탈로그): {(d.types || []).filter((t) => !t.implemented).map((t) => t.label).join(' · ')} — 수집기 구현 시 이 화면 변경 없이 표시됩니다.
      </div>

      {/* 수집 작업 로그(v2.315, 사용자 요구) — 진행중 + 완료. 자체 폴링(5초)이라 별도 컴포넌트. */}
      <ActivityPanel />

      {detail && (() => {
        const row = rows.find((x) => x.id === detail);
        if (!row) return null; // 새로고침 사이에 삭제된 장비 — 모달 조용히 닫힘 방지 위해 null
        return <DeviceDetail r={row} typeLabel={typeLabel} dcName={dcName} onClose={() => setDetail(null)}
          onRefresh={async () => { const res = await postJson(`/tools/storage/devices/${encodeURIComponent(row.id)}/collect`, {}); await load(); return res; }} />;
      })()}
    </div>
  );
}

/**
 * 수집 작업 로그 패널(v2.315, 사용자 요구 '진행중/완료 창').
 * '진행중' = poller.inFlight(지금 수집 중인 장비), '완료' = 최근 완료 이벤트(newest-first).
 * 표(장비 목록)와 독립적으로 5초마다 폴링한다(수집은 초 단위라 빠른 갱신이 유용).
 * ⚠ 훅은 이 컴포넌트 최상단에만 — 조기 return 은 훅 선언 뒤(#310 회귀 방지, CLAUDE.md).
 */
function ActivityPanel() {
  const [a, setA] = useState(null);
  useEffect(() => {
    let live = true;
    const load = () => fetchJson('/tools/storage/activity').then((r) => { if (live) setA(r); }).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => { live = false; clearInterval(t); };
  }, []);
  if (!a) return null;
  const inFlight = a.poller?.inFlight || [];
  const events = a.events || [];
  const hms = (ts) => { try { return new Date(ts).toLocaleTimeString('ko-KR', { hour12: false }); } catch { return '—'; } };
  return (
    <div className="card" style={{ padding: 14, marginTop: 14 }}>
      <div className="flex between" style={{ alignItems: 'center', marginBottom: 10 }}>
        <b style={{ fontSize: 14 }}>📋 수집 작업</b>
        <span className="muted" style={{ fontSize: 11 }}>⟳ 5초 자동갱신 · 주기 {a.poller?.intervalMs ? `${Math.round(a.poller.intervalMs / 60000)}분` : '—'}</span>
      </div>

      {/* 진행중 */}
      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-dim)', marginBottom: inFlight.length ? 6 : 10 }}>
        ▸ 진행중{' '}
        {inFlight.length
          ? <span className="badge" style={{ background: 'rgba(245,158,11,.2)', color: 'var(--amber)' }}>수집 중 {inFlight.length}건</span>
          : <span className="muted" style={{ fontWeight: 400 }}>— 진행 중인 수집 없음</span>}
      </div>
      {inFlight.length > 0 && (
        <div style={{ marginBottom: 12, fontSize: 12 }}>
          {inFlight.map((f) => (
            <div key={f.id} className="muted" style={{ padding: '2px 0' }}>
              <span style={{ color: 'var(--text)' }}>{f.name}</span> — 수집 중… <span style={{ fontSize: 11 }}>({ago(f.at)})</span>
            </div>
          ))}
        </div>
      )}

      {/* 완료(최근) */}
      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-dim)', margin: '4px 0 6px' }}>▸ 완료 <span className="muted" style={{ fontWeight: 400 }}>(최근 {events.length}건)</span></div>
      <div className="table-wrap" style={{ maxHeight: '32vh' }}>
        <table>
          <thead><tr><th>시각</th><th>장비</th><th>출처</th><th>결과</th><th style={{ textAlign: 'right' }}>노드</th><th>용량</th><th style={{ textAlign: 'right' }}>소요</th><th>비고</th></tr></thead>
          <tbody>
            {events.length === 0 && <tr><td colSpan={8} className="center muted" style={{ padding: 16 }}>아직 수집 기록이 없습니다.</td></tr>}
            {events.map((e, i) => (
              <tr key={`${e.deviceId}-${e.at}-${i}`}>
                <td className="muted" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>{hms(e.at)}</td>
                <td><b>{e.name}</b>{e.host ? <div className="muted" style={{ fontSize: 10.5 }}>{e.host}</div> : null}</td>
                <td>{e.source === 'central'
                  ? <span className="muted">중앙</span>
                  : <span className="badge" style={{ background: 'rgba(167,139,250,.2)', color: '#a78bfa' }}>{e.source}</span>}</td>
                <td>{e.ok ? <span className="badge green">정상</span> : <span className="badge red" title={e.error || ''}>실패</span>}</td>
                <td style={{ textAlign: 'right' }}>{e.nodes ?? '—'}</td>
                <td className="muted" style={{ fontSize: 11.5 }}>{e.totalBytes ? `${tbFmt(e.usedBytes)}/${tbFmt(e.totalBytes)}` : '—'}</td>
                <td style={{ textAlign: 'right' }} className="muted">{e.durationMs != null ? `${(e.durationMs / 1000).toFixed(1)}s` : '—'}</td>
                <td className="muted" style={{ fontSize: 11, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.error || ''}>{e.error || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 장비 상세 모달 — 정규화 스냅샷 전부(풀·계정·섹션별 수집 상태·경보). */
function DeviceDetail({ r, typeLabel, dcName, onClose, onRefresh }) {
  const s = r.snap;
  // 수집 방식/타입별 UI 분기(v2.325, 사용자 요구 '가져오는 정보에 맞는 최적 UI·최대한 많은 정보').
  // SSH(isi status): 시리얼 없음 · 클러스터 헬스/감축비/효율/VHS/L3/Critical Events/Job Status +
  //   노드 표에 Ext·처리량·HDD/SSD·L3. API: 시리얼/GUID·스토리지 풀·OneFS 영역수집. 타입별 extra
  //   (PowerStore appliances/state · PowerMax model/ucode/arrays · XtremIO numBricks/healthState ·
  //   VPLEX clusters/용량없음)를 각각 최대치로 노출한다.
  const ex = (s && s.extra) || {};
  const method = ex.collectMethod === 'ssh' ? 'ssh' : 'api';
  const nodeList = (s && s.nodes && s.nodes.list) || [];
  // 노드 표 적응형 열 — 이 스냅샷의 노드들이 실제 값을 가진 열만 그린다(항상 빈 '—' 열 제거로 압축).
  const ncol = {
    name: nodeList.some((n) => n.name),
    ext: nodeList.some((n) => n.ext),
    io: nodeList.some((n) => n.inBps != null || n.outBps != null),
    hdd: nodeList.some((n) => n.hdd),
    ssd: nodeList.some((n) => n.ssd || n.l3Bytes > 0),
  };
  const isVirt = !!ex.capacityNote; // VPLEX/Metro Node — 자체 용량 없음(가상화 계층 — 풀/미디어/추이 숨김)
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
    <Modal title={`${typeLabel(r.type)} — ${s?.name || r.name}`} onClose={onClose} width={900}>
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
            <span className={`badge ${method === 'ssh' ? 'blue' : 'gray'}`} title={method === 'ssh' ? 'SSH(isi status 파싱) 수집 — 시리얼/GUID 미제공, 클러스터 헬스·감축비·이벤트·잡 제공' : 'REST API 수집'}>{method.toUpperCase()} 수집</span>
            <span className="muted">호스트 <b style={{ color: 'var(--text)' }}>{r.host}</b></span>
            <span className="muted">법인 <b style={{ color: 'var(--text)' }}>{dcName(r.datacenterId)}</b></span>
            {s.version && <span className="muted">버전 <b style={{ color: 'var(--text)' }}>{s.version}</b></span>}
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
              <span className={`badge ${String(s.extra.healthState).toLowerCase() === 'healthy' ? 'green' : 'red'}`}>Health: {s.extra.healthState}</span>
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

          {/* 가상화 계층(VPLEX/Metro Node) — 자체 용량이 없다는 사유를 명시(용량/미디어/추이 숨김) */}
          {isVirt && (
            <div className="card" style={{ padding: '8px 12px', marginBottom: 10, fontSize: 12, borderColor: 'var(--border)' }}>
              ℹ {ex.capacityNote}
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
                    <UsageCell pct={m.pct ?? 0} />
                  </> : <div className="muted">없음</div>}
                </div>
              ))}
            </div>
          )}

          {/* 용량 추이 그래프(v2.318) — 가상화 계층(VPLEX 등 자체 용량 없음)은 추이가 무의미해 숨김 */}
          {!isVirt && <CapacityTrend deviceId={r.id} isEdge={!!r.agent} />}

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
                <table>
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
                        {ncol.hdd && <td style={{ whiteSpace: 'nowrap' }}>{n.hdd ? `${tbFmt(n.hdd.usedBytes)}/${tbFmt(n.hdd.totalBytes)} (${n.hdd.pct}%)` : <span className="muted">{r.type === 'isilon' ? 'No Storage HDDs' : '—'}</span>}</td>}
                        {ncol.ssd && <td style={{ whiteSpace: 'nowrap' }}>{n.ssd ? `${tbFmt(n.ssd.usedBytes)}/${tbFmt(n.ssd.totalBytes)} (${n.ssd.pct}%)` : n.l3Bytes > 0 ? <span className="muted">L3: {tbFmt(n.l3Bytes)}</span> : <span className="muted">—</span>}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
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
                    {ex.inventory.hardware.unhealthy > 0 ? <b style={{ color: 'var(--red)' }}> · 이상 {ex.inventory.hardware.unhealthy}</b> : ' · 이상 없음'}
                  </span>
                )}
              </div>
            </>
          )}

          {/* PowerStore 어플라이언스(extra.appliances) — 용량 상세가 없어 풀이 아니라 별도 표로(v2.325) */}
          {Array.isArray(ex.appliances) && ex.appliances.length > 0 && (
            <>
              <div className="section-title" style={{ fontSize: 13 }}>어플라이언스 {ex.appliances.length}</div>
              <table className="data-table" style={{ width: '100%', fontSize: 12.5, marginBottom: 12 }}>
                <thead><tr><th style={{ textAlign: 'left' }}>이름</th><th>모델</th><th>서비스 태그</th></tr></thead>
                <tbody>{ex.appliances.map((a, i) => (
                  <tr key={i}><td>{a.name || '—'}</td><td className="muted">{a.model || '—'}</td><td className="muted" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{a.serviceTag || '—'}</td></tr>
                ))}</tbody>
              </table>
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
              <table className="data-table" style={{ width: '100%', fontSize: 12.5, marginBottom: 12 }}>
                <thead><tr><th style={{ textAlign: 'left' }}>{r.type === 'xtremio' ? '클러스터' : (r.type === 'vmax' || r.type === 'powermax') ? '어레이' : '풀'}</th><th style={{ textAlign: 'right' }}>사용</th><th style={{ textAlign: 'right' }}>전체</th><th>사용률</th></tr></thead>
                <tbody>{s.pools.map((p, i) => (
                  <tr key={i}><td>{p.name}</td><td style={{ textAlign: 'right' }}>{tbFmt(p.usedBytes)}</td><td style={{ textAlign: 'right' }}>{tbFmt(p.totalBytes)}</td><td>{p.pct != null ? <UsageCell pct={p.pct} /> : '—'}</td></tr>
                ))}</tbody>
              </table>
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
              <div className="section-title" style={{ fontSize: 13 }}>Critical Events {s.extra.criticalEvents.length}</div>
              {s.extra.criticalEvents.length === 0
                ? <div className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>✅ 미해결 Critical 이벤트 없음</div>
                : (
                  <div className="table-wrap" style={{ maxHeight: '20vh', marginBottom: 12 }}>
                    <table>
                      <thead><tr><th>시각</th><th style={{ textAlign: 'right' }}>LNN</th><th>이벤트</th></tr></thead>
                      <tbody>{s.extra.criticalEvents.map((e, i) => (
                        <tr key={i}><td style={{ whiteSpace: 'nowrap', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{e.time}</td><td style={{ textAlign: 'right' }}>{e.lnn}</td><td style={{ fontSize: 12.5, color: 'var(--red)' }}>{e.event}</td></tr>
                      ))}</tbody>
                    </table>
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
                    <table>
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
                    </table>
                  </div>
                )}
              {s.extra.jobs.recent.length > 0 && (
                <>
                  <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>최근 잡 결과 {s.extra.jobs.recent.length}건</div>
                  <div className="table-wrap" style={{ maxHeight: '18vh', marginBottom: 12 }}>
                    <table>
                      <thead><tr><th>시각</th><th>잡</th><th>결과</th></tr></thead>
                      <tbody>{s.extra.jobs.recent.map((j, i) => (
                        <tr key={i}><td style={{ whiteSpace: 'nowrap', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{j.time}</td><td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{j.job}</td><td><span className={`badge ${/succeeded/i.test(j.event) ? 'green' : 'red'}`}>{j.event}</span></td></tr>
                      ))}</tbody>
                    </table>
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
                <span className="muted" style={{ fontSize: 11, fontWeight: 400 }}> — 엔드포인트 {s.extra.areasEndpoints ?? '—'}개 · {s.extra.areasAt ? new Date(s.extra.areasAt).toLocaleString('ko-KR') : ''} · 원문은 수집 노드 DB 저장</span>
              </div>
              <div className="flex gap wrap" style={{ marginBottom: 8 }}>
                {s.extra.areas.map((a) => (
                  <span key={a.area} className={`badge ${a.skipped ? 'gray' : a.failed === 0 ? 'green' : a.ok > 0 ? 'amber' : 'red'}`}
                    title={a.error || `성공 ${a.ok} · 실패 ${a.failed}`} style={{ fontSize: 10.5, cursor: !a.skipped && !r.agent ? 'pointer' : 'default' }}
                    onClick={() => { if (!a.skipped && !r.agent) setAreaView(a.area); }}>
                    {a.area}{a.skipped ? ' (비활성)' : a.failed ? ` ${a.ok}/${a.ok + a.failed}` : ''}
                  </span>
                ))}
              </div>
              {r.agent
                ? <div className="muted" style={{ fontSize: 11, marginBottom: 12 }}>이 장비는 엣지 '{r.agent}' 가 수집 — API 원문은 엣지 포탈의 DB 에 저장됩니다(여기는 요약만).</div>
                : <div className="muted" style={{ fontSize: 11, marginBottom: 12 }}>배지를 클릭하면 저장된 원문(JSON)을 봅니다.</div>}
              {areaView && !r.agent && <AreaJsonViewer deviceId={r.id} area={areaView} onClose={() => setAreaView(null)} />}
            </>
          )}

          <div className="section-title" style={{ fontSize: 13 }}>섹션별 수집 상태 <span className="muted" style={{ fontSize: 11, fontWeight: 400 }}>— 부분 실패를 숨기지 않습니다(버전별 API 차이 진단용)</span></div>
          <div className="flex gap wrap">
            {Object.entries(s.sections || {}).map(([k, v]) => (
              <span key={k} className={`badge ${v === 'ok' ? 'green' : v === 'skip' ? 'gray' : 'red'}`} title={String(v)}>{k}: {v === 'ok' ? 'OK' : v === 'skip' ? '건너뜀' : '오류'}</span>
            ))}
          </div>
          {/* skip 사유 노출(v2.311) — VPLEX/Metro Node 의 capacity skip 은 오류가 아니라 제품 특성
              (가상화 계층 — 자체 용량 없음). 사유 없이 '건너뜀'만 보이면 수집 실패로 오해한다. */}
          {s.extra?.capacityNote && <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>ℹ {s.extra.capacityNote}</div>}
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
      {Array.isArray(r.cliRaw) && r.cliRaw.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12 }}>
            CLI 명령 원문 {r.cliRaw.length}건 — 성공 {r.cliRaw.filter((x) => x.ok).length} · 실패 {r.cliRaw.filter((x) => !x.ok).length}
          </summary>
          <div style={{ marginTop: 6, maxHeight: '40vh', overflow: 'auto' }}>
            {r.cliRaw.map((x, i) => (
              <div key={i} style={{ marginBottom: 8 }}>
                <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, color: x.ok ? 'var(--green)' : 'var(--red)' }}>
                  {x.ok ? '✓' : '✗'} [{x.key}] {x.cmd}
                </div>
                <pre style={{ margin: '2px 0 0', padding: '6px 8px', background: 'rgba(148,163,184,.08)', borderRadius: 6, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{x.sample || '(빈 출력)'}</pre>
              </div>
            ))}
          </div>
        </details>
      )}
      {r.ok && <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>테스트 결과는 저장되지 않습니다 — 목록/추이/작업 로그에 반영하려면 '저장' 후 수집하세요.</div>}
    </div>
  );
}

function DeviceForm({ d, form, setForm, onSaved }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
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
    try { const r = await postJson('/tools/storage/devices', form); if (r.ok === false) setErr(r.reason); else onSaved(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
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
      {err && <div style={{ color: 'var(--red)', fontSize: 12.5, marginTop: 8 }}>⚠ {err}</div>}
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
    hddUsed: p.hdd_used, ssdUsed: p.ssd_used, devices: p.devices,
  }));
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
          {last.total > 0 && <span className="muted">사용률 <b style={{ color: 'var(--text)' }}>{Math.round((last.used / last.total) * 100)}%</b></span>}
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
function CapacityTrend({ deviceId, isEdge }) {
  // 기간 프리셋(v2.380): 12시간·24시간을 사용자 요구로 추가. 서버 range 파라미터를 쓴다
  // (days 도 계속 지원되지만 12시간은 정수 days 로 표현할 수 없다).
  const [range, setRange] = useState('7d');
  const [d, setD] = useState(null);      // { db, points } — null = 로딩 전
  const [err, setErr] = useState(null);
  useEffect(() => {
    let live = true;
    setD(null); setErr(null);
    fetchJson(`/tools/storage/devices/${encodeURIComponent(deviceId)}/history?range=${range}`)
      .then((r) => { if (live) setD(r); })
      .catch((e) => { if (live) setErr(e.message); });
    return () => { live = false; };
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

/**
 * CSV 일괄 가져오기 모달(v2.313, 사용자 요구) — 파일 선택 또는 붙여넣기 → 무결성 검증 → 저장.
 * v2.317: '무결성 검증'(드라이런 — 저장 없이 행별 추가/수정/오류 판정, 실제 저장과 같은 규칙)을
 * 먼저 통과해야 실행 버튼이 활성화된다. CSV 내용을 고치면 재검증 필요(검증본과 실행본 불일치 방지).
 * 비밀번호 열이 있으면 그대로 가져와 저장한다(비우면 기존 유지).
 */
function CsvImport({ onClose, onDone }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [check, setCheck] = useState(null);        // 드라이런 결과 { report, summary }
  const [checkedText, setCheckedText] = useState(null); // 검증 당시 CSV 원문(변경 감지)
  const [err, setErr] = useState(null);
  const fileRef = useRef(null);

  const onFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { setText(String(r.result || '')); setCheck(null); setCheckedText(null); };
    r.readAsText(f);
  };
  const verify = async () => {
    setBusy(true); setErr(null); setResult(null); setCheck(null);
    try {
      const r = await postJson('/tools/storage/devices/import', { csv: text, dryRun: true });
      if (r.ok === false) setErr(r.reason);
      else { setCheck(r); setCheckedText(text); }
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const run = async () => {
    setBusy(true); setErr(null); setResult(null);
    try {
      const r = await postJson('/tools/storage/devices/import', { csv: text });
      if (r.ok === false) setErr(r.reason);
      else setResult(r);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const verified = check && checkedText === text; // 검증 후 내용이 바뀌면 재검증 요구
  const actLabel = { add: '추가', update: '수정', error: '오류' };
  return (
    <Modal title="스토리지 장비 CSV 가져오기" onClose={onClose} width={760}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        헤더 행 필수(<code>name</code>·<code>host</code>는 필수). <b>host+type</b>이 같은 장비는 수정, 없으면 추가됩니다.
        비밀번호 열은 값이 있으면 저장하고, 비우면 기존 값을 유지합니다. 양식은 <b>📄 샘플 CSV</b>로 받으세요.
      </div>
      <div className="flex gap wrap" style={{ marginBottom: 8 }}>
        <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain" style={{ display: 'none' }} onChange={onFile} />
        <button className="tab" style={{ padding: '6px 12px', fontSize: 12 }} onClick={() => fileRef.current?.click()}>📁 CSV 파일 선택</button>
        <button className="tab" style={{ padding: '6px 12px', fontSize: 12 }}
          onClick={() => downloadFile('/tools/storage/devices/sample.csv').catch((e) => setErr(e.message))}>📄 샘플 CSV</button>
      </div>
      <textarea className="input" style={{ width: '100%', minHeight: 140, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
        value={text} onChange={(e) => { setText(e.target.value); setResult(null); }} placeholder="여기에 CSV 를 붙여넣거나 위에서 파일을 선택하세요." />
      {err && <div style={{ color: 'var(--red)', fontSize: 12.5, marginTop: 8 }}>⚠ {err}</div>}

      {/* 무결성 검증 결과(드라이런) — 행별 추가/수정/오류 판정 표 */}
      {check && (
        <div className="card" style={{ padding: 10, marginTop: 10, fontSize: 12.5 }}>
          <div style={{ marginBottom: 6 }}>
            검증 결과: 총 {check.total}행 — <span style={{ color: 'var(--green)' }}>추가 {check.summary.add}</span>
            {' · '}<span style={{ color: 'var(--blue)' }}>수정 {check.summary.update}</span>
            {' · '}<span style={{ color: check.summary.error ? 'var(--red)' : 'var(--text-dim)' }}>오류 {check.summary.error}</span>
            {' · '}비밀번호 반영 {check.summary.withPassword}건
            {!verified && <b style={{ color: 'var(--amber)', marginLeft: 8 }}>⚠ 내용이 변경됨 — 재검증 필요</b>}
          </div>
          <div className="table-wrap" style={{ maxHeight: '26vh' }}>
            <table>
              <thead><tr><th style={{ textAlign: 'right' }}>행</th><th>장비</th><th>host</th><th>타입</th><th>동작</th><th>비밀번호</th><th>문제</th></tr></thead>
              <tbody>
                {check.report.map((r, i) => (
                  <tr key={i}>
                    <td style={{ textAlign: 'right' }} className="muted">{r.line}</td>
                    <td><b>{r.name}</b></td>
                    <td className="muted" style={{ fontSize: 11.5 }}>{r.host}</td>
                    <td className="muted" style={{ fontSize: 11.5 }}>{r.type}</td>
                    <td><span className={`badge ${r.action === 'add' ? 'green' : r.action === 'update' ? 'blue' : 'red'}`}>{actLabel[r.action] || r.action}</span></td>
                    <td className="muted" style={{ fontSize: 11.5 }}>{r.hasPassword ? '반영' : '유지'}</td>
                    <td style={{ color: 'var(--red)', fontSize: 11.5 }}>{r.reason || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {result && (
        <div className="card" style={{ padding: 10, marginTop: 10, fontSize: 12.5 }}>
          <div>총 {result.total}행 — <span style={{ color: 'var(--green)' }}>추가 {result.added}</span> · <span style={{ color: 'var(--blue)' }}>수정 {result.updated}</span>{result.failed?.length ? <> · <span style={{ color: 'var(--red)' }}>실패 {result.failed.length}</span></> : ''}</div>
          {result.failed?.length > 0 && (
            <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: 'var(--red)' }}>
              {result.failed.map((f, i) => <li key={i}>행 {f.line} ({f.name}): {f.reason}</li>)}
            </ul>
          )}
        </div>
      )}
      <div className="flex gap" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
        {result
          ? <button className="login-btn" style={{ padding: '8px 18px' }} onClick={onDone}>완료(목록 새로고침)</button>
          : <>
            <button className="tab" style={{ padding: '8px 16px' }} disabled={busy || !text.trim()} onClick={verify}>{busy ? '검사 중…' : '1) 무결성 검증'}</button>
            <button className="login-btn" style={{ padding: '8px 18px' }} disabled={busy || !verified}
              title={verified ? (check.summary.error ? '오류 행은 건너뛰고 정상 행만 저장됩니다' : '') : '먼저 무결성 검증을 통과하세요'}
              onClick={run}>{busy ? '가져오는 중…' : '2) 가져오기 실행'}</button>
          </>}
      </div>
    </Modal>
  );
}

/** OneFS API 영역 원문 뷰어(v2.308) — 이 노드 DB(api_latest)의 엔드포인트별 최신 JSON. */
function AreaJsonViewer({ deviceId, area, onClose }) {
  const [rows, setRows] = useState(null);   // 영역의 엔드포인트 목록
  const [sel, setSel] = useState(null);     // 선택한 엔드포인트 원문
  const [err, setErr] = useState(null);
  useEffect(() => {
    fetchJson(`/tools/storage/devices/${encodeURIComponent(deviceId)}/areas`)
      .then((r) => setRows((r.rows || []).filter((x) => x.area === area)))
      .catch((e) => setErr(e.message));
  }, [deviceId, area]);
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
