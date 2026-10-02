// 베어메탈 스토리지(v2.340, 사용자 요구) — 서버들의 로컬 디스크(지정 마운트 포인트) 용량을
// SSH(df)로 주기 수집해 전체/그룹/서버 순으로 총·사용·가용을 합산해 보여준다.
// 서버는 표(컬럼) 형식 폼으로 등록하고, 그룹을 지정하면 그룹 합산 카드가 생긴다.
// 수집 주체: 중앙 직접(기본) 또는 글로벌 엣지 위임(중앙→엣지 PUSH — 수집 서버(원격) URL 필요).
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, delJson, canCsv } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import EscClose from '../../components/EscClose.jsx';
import { CsvExportModal, CsvImportModal } from '../../components/CsvBulkModals.jsx'; // CSV 일괄 관리(v2.341)
import { fmtAgo } from '../../util/fmt.js';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { authStopSummary } from './storageAuthText.js'; // v2.590: 인증 실패 정지 안내(도구 공통)
import { droppedSecretNote } from '../droppedSecretText.js';
import { missingChoice } from '../idrac/scanRangeFormText.js'; // v2.630 WEB2630-03: 목록에 없는 저장값을 그대로 보인다
import BmStorHistoryPanel from './BmStorHistoryPanel.jsx'; // v2.635: 디스크 사용량 12시간 이력 차트(v2.688: 세 보기)
import {
  seriesMap, changeOf, daysTo90, daysText, changeText, pctText, watchList, sortGroupsByUsed, sortServers,
  groupColors, groupKeyOf, NO_GROUP, WARN_PCT,
} from './bmStorHistoryText.js';

// 바이트 → 사람이 읽는 용량(TB/GB). 합산값이 크므로 TB 우선.
const fmtBytes = (b) => {
  // v2.620(WEB2620-08): 못 읽은 값(null·빈 값)을 '0 B' 로 보이지 않는다.
  if (b == null || b === '' || !Number.isFinite(Number(b))) return '—';
  const n = Number(b);
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toLocaleString(undefined, { maximumFractionDigits: 1 })} TB`;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2).toLocaleString()} MB`;
  return `${n.toLocaleString()} B`;
};
const pctColor = (p) => (p >= 90 ? 'var(--red)' : p >= 75 ? 'var(--amber)' : 'var(--green)');

const Dot = ({ c }) => <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: c, marginRight: 4, verticalAlign: 'middle' }} />;
/** 그룹 카드가 이보다 많으면 접는다(시안 ⚠ — 그룹이 수십 개면 화면을 덮는다). */
const GROUP_FOLD = 12;
const SORTS = [{ key: 'pct', label: '사용률 높은 순' }, { key: 'avail', label: '여유 적은 순' }, { key: 'name', label: '이름순' }];

const EMPTY = { id: '', name: '', host: '', port: 22, username: 'root', password: '', agent: '', dispatch: 'poll', groups: '', mounts: '/', enabled: true };

export default function BmStorageTool() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null); // 서버 추가/수정 폼 | null
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [ivEdit, setIvEdit] = useState(null); // 주기 편집값(분) | null
  const [csvModal, setCsvModal] = useState(null); // 'export' | 'import' | null — CSV 일괄 관리(v2.341)
  // v2.688(시안 'BM Storage v2'): 7일 이력(추이 카드가 받은 것) · 추이 보기 요청 · 그룹 필터 · 정렬 · 검색 · 그룹 카드 펼침
  const [seven, setSeven] = useState(null);
  const [trendReq, setTrendReq] = useState(null);
  const [gsel, setGsel] = useState(null);
  const [sortBy, setSortBy] = useState('pct');
  const [q, setQ] = useState('');
  const [groupsOpen, setGroupsOpen] = useState(false);

  // 수동 로드 + 15초 재조회(저장/수집 직후 즉시 refresh 가 필요해 usePolling 대신 직접 관리).
  // v2.629 WEB2629-03: 403(전체 범위 관리자 전용)은 다시 물어도 같다 — 15초 폴링을 멈추고, 오류는 객체째 들어 ErrorBox 가 권한 안내로 바꾸게 한다.
  const denied = useRef(false);
  const refresh = () => fetchJson('/tools/bm-storage').then((d) => { setData(d); setError(null); })
    .catch((e) => { if (e?.status === 403) denied.current = true; setError(e || new Error('조회 실패')); });
  useEffect(() => { refresh(); const t = setInterval(() => { if (!denied.current) refresh(); }, 15_000); return () => clearInterval(t); }, []);

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const { total, groups, servers, config: cfgs, settings, status, agents } = data;
  const cfgOf = (id) => (cfgs || []).find((c) => c.id === id);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/tools/bm-storage/servers', { ...form, port: Number(form.port) || 22 });
      const dropNote = r.ok ? droppedSecretNote(r) : ''; // v2.607 WEB2607-03: 주소·포트·계정 변경으로 저장 비밀번호 폐기 — 폼 유지
      if (r.ok && dropNote) { setForm((f) => ({ ...f, password: '' })); refresh(); setMsg(dropNote); }
      else if (r.ok) { setForm(null); refresh(); }
      else setMsg(r.reason);
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  };
  const del = async (s) => {
    if (!window.confirm(`'${s.name}' (${s.host}) 서버를 목록에서 삭제할까요?`)) return;
    try { await delJson(`/tools/bm-storage/servers/${encodeURIComponent(s.id)}`); refresh(); }
    catch (e) { setMsg(e.message); }
  };
  const collectNow = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/tools/bm-storage/collect', {});
      if (!r.ok) setMsg(r.reason || '수집이 이미 진행 중입니다.');
      else setMsg(`수집 완료 — 성공 ${r.okCount} · 오류 ${r.errors}${r.queued ? ` · 폴링 위임 대기 ${r.queued}(엣지 회신 후 반영)` : ''} (${Math.round(r.ms / 1000)}초)`);
      refresh();
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  };
  const saveInterval = async () => {
    try {
      const r = await putJson('/tools/bm-storage/settings', { intervalMinutes: Number(ivEdit) });
      if (r.ok) { setIvEdit(null); refresh(); } else setMsg(r.reason);
    } catch (e) { setMsg(e.message); }
  };
  const edit = (s) => {
    const c = cfgOf(s.id);
    setForm({ ...EMPTY, ...c, password: '', mounts: (c?.mounts || []).join('\n'), groups: (c?.groups || []).join(', ') });
  };
  // v2.599(C2599-09): 사용률은 서버가 df 와 같은 정의로 주고, 분모 0(마운트 미수집)이면 null 이다 — 'null%'·0% 로 그리지 않는다.
  const pctCell = (p) => (p == null ? <span className="muted">—</span> : <span style={{ whiteSpace: 'nowrap' }}>{bar(p)} <b style={{ fontSize: 12, color: pctColor(p) }}>{p}%</b></span>);
  const bar = (p) => (
    <span style={{ display: 'inline-block', position: 'relative', width: 80, height: 5, borderRadius: 5, background: 'rgba(148,163,184,.15)', overflow: 'hidden', verticalAlign: 'middle' }}>
      <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.min(100, p)}%`, background: pctColor(p), borderRadius: 5 }} />
    </span>
  );

  // ── v2.688(시안 'BM Storage v2'): 7일 이력(추이 카드가 받은 것을 같이 쓴다 — 따로 부르지 않는다) ──
  const totalSeries = seven ? seriesMap(seven.series, 'total').get('') || null : null;
  const groupSeries = seven ? seriesMap(seven.series, 'group') : new Map();
  const totalChange = totalSeries ? changeOf(totalSeries) : null;
  const totalDays90 = totalSeries ? daysTo90(totalSeries) : null;
  const colors = groupColors(groups.map((g) => g.name));
  const sortedGroups = sortGroupsByUsed(groups);            // ⚠ 사용량 많은 순(사용자 선택)
  const watch = watchList(groups, groupSeries);
  const shownGroups = groupsOpen ? sortedGroups : sortedGroups.slice(0, GROUP_FOLD);
  const mountTotal = servers.reduce((a, s) => a + (s.enabled ? (s.mountCount || 0) : 0), 0);
  const realGroups = groups.filter((g) => g.name !== NO_GROUP).length;
  const dotColor = total.errors ? 'var(--red)' : total.pending ? 'var(--amber)' : 'var(--green)';
  const ql = q.trim().toLowerCase();
  const listed = sortServers(servers.filter((s) => {
    if (gsel != null && !((s.groups || []).length ? s.groups : [NO_GROUP]).includes(gsel)) return false;
    if (!ql) return true;
    return [s.name, s.host, ...(s.groups || [])].some((v) => String(v || '').toLowerCase().includes(ql));
  }), sortBy);
  const warnCount = listed.filter((s) => s.ok && s.usedPct != null && s.usedPct >= WARN_PCT).length;
  const showTrend = (key) => setTrendReq({ mode: 'group', key, n: Date.now() });
  const authNote = authStopSummary(servers.filter((s) => s.authStopped), { unit: '대', what: '베어메탈 서버' });

  return (
    <div className="bm2">
      <div className="flex between wrap" style={{ alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
        <div style={{ minWidth: 0, flex: '1 1 420px' }}>
          <div className="muted" style={{ fontSize: 13.5, lineHeight: 1.6 }}>
            서버에 SSH 로 접속해 df 로 지정한 마운트 포인트의 로컬 디스크 용량을 모읍니다 — 전체·그룹·서버별 총·사용·가용.
            엣지 위임 서버는 그 엣지가 수집합니다(폴링 또는 중앙→엣지 PUSH).
          </div>
          <div className="bm2-status">
            <span style={{ color: dotColor }}>●</span> {total.ok}대 수집 정상
            {total.errors ? <span style={{ color: 'var(--red)' }}> · 오류 {total.errors}</span> : null}
            {total.pending ? <span style={{ color: 'var(--amber)' }}> · 미수집 {total.pending}</span> : null}
            {' · 수집 주기 '}
            {ivEdit === null
              ? <><b style={{ color: 'var(--text)' }}>{settings.intervalMinutes}분</b> <button type="button" className="bm2-icon" title="수집 주기 바꾸기" onClick={() => setIvEdit(settings.intervalMinutes)}>✎</button></>
              : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input className="input" type="number" min={1} max={1440} value={ivEdit} onChange={(e) => setIvEdit(e.target.value)} style={{ width: 70, padding: '3px 8px', fontSize: 12, minWidth: 0 }} />
                <button className="login-btn" style={{ flex: 'none', padding: '3px 10px', fontSize: 12 }} onClick={saveInterval}>저장</button>
                <button className="logout-btn" style={{ padding: '3px 8px', fontSize: 12 }} onClick={() => setIvEdit(null)}>취소</button>
              </span>}
            {status.lastRunAt ? <> · 최근 수집 {fmtAgo(status.lastRunAt)}</> : ' · 아직 수집 전'}
            {' · 추이 기록 12시간마다'}
          </div>
        </div>
        <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="logout-btn" style={{ padding: '8px 14px' }} disabled={busy || status.running} onClick={collectNow}>{status.running ? '수집 중…' : '⚡ 지금 수집'}</button>
          {canCsv() && <button className="logout-btn" style={{ padding: '8px 14px' }} title="서버 목록을 CSV 로 내려받기(기본 비밀번호 제외)" onClick={() => setCsvModal('export')}>⤓ CSV</button>}
          {canCsv() && <button className="logout-btn" style={{ padding: '8px 14px' }} title="CSV 로 다수 서버 일괄 등록/수정 — 검증(드라이런) 후 덮어쓰기 확인" onClick={() => setCsvModal('import')}>⤒ CSV 가져오기</button>}
          <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} onClick={() => setForm({ ...EMPTY })}>+ 서버 추가</button>
        </div>
      </div>
      {canCsv() && csvModal === 'export' && (
        <CsvExportModal title="베어메탈 스토리지 서버 CSV 내보내기" exportPath="/tools/bm-storage/export.csv"
          secretsLabel="비밀번호 포함(SSH 계정)"
          description={<>등록 서버(이름·호스트·포트·계정·그룹·엣지·방식·마운트·활성)를 CSV 로 내려받습니다. 마운트 여러 개는 한 셀에 세미콜론(;) 구분. 기본은 <b>비밀번호 제외</b>이며, 가져오기에서 비우면 기존 값이 유지됩니다.</>}
          onClose={() => setCsvModal(null)} />
      )}
      {canCsv() && csvModal === 'import' && (
        <CsvImportModal title="베어메탈 스토리지 서버 CSV 가져오기" importPath="/tools/bm-storage/import"
          samplePath="/tools/bm-storage/sample.csv"
          description={<>헤더 행 필수(<code>host</code>·<code>mounts</code>는 필수 — 마운트는 세미콜론(;) 구분 절대경로). <b>host+포트+계정</b>이 같은 서버는 <b>덮어쓰기</b>로 판정되며 아래에서 명시적으로 허용해야 적용됩니다. <b>agent 는 등록된 수집 서버(원격) 이름만</b> 허용됩니다(오타 시 오류). 양식은 <b>📄 샘플 CSV</b>로 받으세요.</>}
          columns={[
            { key: 'name', label: '이름', render: (r) => <b style={{ color: 'var(--text)' }}>{r.name}</b> },
            { key: 'host', label: 'host' },
            { key: 'username', label: '계정' },
            { key: 'agent', label: '엣지', render: (r) => r.agent || '중앙' },
            { key: 'mountCount', label: '마운트', align: 'right' },
            { key: 'hasPassword', label: '비밀번호', render: (r) => (r.hasPassword ? '교체' : '유지') },
          ]}
          overwriteLabel={(n) => <>기존 서버 <b>{n}건 덮어쓰기 허용</b> — 체크하지 않으면 해당 행은 건너뜁니다(그룹·마운트·방식이 CSV 값으로 교체됨)</>}
          nameOf={(f) => f.host || ''}
          onClose={() => setCsvModal(null)} onDone={() => { setCsvModal(null); refresh(); }} />
      )}
      {msg && <div className="muted" style={{ fontSize: 12.5, marginBottom: 8, color: '#93c5fd' }}>{msg}</div>}
      {error && <div className="muted" style={{ fontSize: 12, marginBottom: 8, color: 'var(--amber)' }}>⚠ 일시 조회 오류: {String(error?.message || error)}</div>}

      {/* v2.590(감사 F2): 인증 실패로 **주기 수집을 멈춘** 서버 — 조용히 멈추지 않는다(authGuard 규칙 1). */}
      {authNote && (
        <div className="card" style={{ padding: 10, marginBottom: 12, fontSize: 13, borderColor: 'var(--red)' }}>
          <BoldText text={authNote} />
          <span className="muted"> 위의 지금 수집 버튼은 정지와 무관하게 1회 시도하고, 성공하면 정지가 풀립니다.</span>
        </div>
      )}


      {/* 맨 위 요약 — 전체 사용률(크게) + 2×2 칸. 사용률은 df 정의(used/(used+avail)), 분모 0 이면 '—'. */}
      {servers.length > 0 && (
        <div className="card bm2-card bm2-summary">
          <div style={{ flex: '2 1 460px', minWidth: 0 }}>
            <div className="bm2-label">▸ 전체 디스크 사용률 · {total.servers}대 합산</div>
            <div className="flex wrap" style={{ alignItems: 'baseline', gap: '6px 16px', marginTop: 8 }}>
              <span style={{ fontSize: 56, fontWeight: 700, lineHeight: 1, color: total.usedPct == null ? 'var(--text-dim)' : total.usedPct >= 90 ? 'var(--red)' : total.usedPct >= WARN_PCT ? 'var(--amber)' : 'var(--text)' }}>
                {total.usedPct == null ? '—' : total.usedPct.toFixed(1)}<span style={{ fontSize: 24, color: 'var(--text-dim)', fontWeight: 600 }}>{total.usedPct == null ? '' : '%'}</span>
              </span>
              <span style={{ fontSize: 14 }}>{fmtBytes(total.usedBytes)} <span className="muted">/ {fmtBytes(total.totalBytes)}</span></span>
              {totalChange != null && <span style={{ fontFamily: 'var(--mono)', fontSize: 13, color: totalChange > 0 ? 'var(--amber)' : 'var(--text-dim)' }}>{changeText(totalChange)} · 7일</span>}
            </div>
            <div className="bm2-bar" style={{ height: 12, marginTop: 14 }}>
              {total.usedPct != null && <span style={{ width: `${Math.min(100, total.usedPct)}%`, background: 'linear-gradient(90deg, var(--accent), var(--accent-2))' }} />}
            </div>
            <div className="muted flex wrap" style={{ gap: '4px 16px', fontSize: 12, marginTop: 8 }}>
              <span><Dot c="var(--accent)" /> 사용 {fmtBytes(total.usedBytes)}</span>
              <span><Dot c="var(--border-soft)" /> 사용 가능 {fmtBytes(total.availBytes)}</span>
              {totalDays90 != null && totalDays90 > 0 && <span>90% 도달까지 {daysText(totalDays90)} (7일 증가 추세 · 선형 추정)</span>}
              {totalDays90 === 0 && <span style={{ color: 'var(--red)' }}>전체가 이미 90% 이상입니다</span>}
            </div>
          </div>
          <div className="bm2-quad" style={{ flex: '1 1 320px' }}>
            <div><div className="bm2-qlabel">서버</div><div className="bm2-qval">{total.servers}대</div>
              <div className="bm2-qsub" style={total.errors ? { color: 'var(--red)' } : undefined}>정상 {total.ok} · 오류 {total.errors}{total.pending ? ` · 미수집 ${total.pending}` : ''}</div></div>
            <div><div className="bm2-qlabel">총 용량</div><div className="bm2-qval">{fmtBytes(total.totalBytes)}</div>
              <div className="bm2-qsub">그룹 {realGroups}개 · 마운트 {mountTotal}개</div></div>
            <div><div className="bm2-qlabel">사용량</div><div className="bm2-qval">{fmtBytes(total.usedBytes)}</div>
              <div className="bm2-qsub">{totalChange == null ? '7일 변화 —' : `${changeText(totalChange)} · 7일`}</div></div>
            <div><div className="bm2-qlabel">사용 가능</div><div className="bm2-qval">{fmtBytes(total.availBytes)}</div>
              <div className="bm2-qsub">{total.usedPct == null ? '—' : `${(100 - total.usedPct).toFixed(1)}% 여유`}</div></div>
          </div>
        </div>
      )}

      {/* 주의 카드 — 그룹 사용률 75% 이상 또는 90% 도달 30일 이내(선형 추정). 위험도 순. */}
      {watch.length > 0 && (
        <div className="flex wrap" style={{ gap: 12, marginBottom: 14 }}>
          {watch.map((w) => (
            <button key={w.key} type="button" className="card bm2-watch" style={{ borderColor: w.level === 'crit' ? 'var(--red)' : 'var(--amber)' }} onClick={() => showTrend(w.key)}>
              <span className={`badge ${w.level === 'crit' ? 'red' : 'amber'}`}>{w.level === 'crit' ? '용량 임박' : '용량 주의'}</span>
              <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                <b style={{ display: 'block', fontSize: 14 }}>{w.name} 사용률 {pctText(w.pct)} · 여유 {fmtBytes(w.availBytes)}</b>
                <span className="muted" style={{ fontSize: 12 }}>{w.days == null ? '7일 증가 추세가 없어 90% 도달은 추정하지 않습니다.' : w.days <= 0 ? '이미 90% 이상입니다.' : `지금 증가 추세면 ${daysText(w.days)} 후 90%에 도달합니다(선형 추정).`}</span>
              </span>
              <span style={{ color: 'var(--mint)', fontSize: 12.5, flex: 'none' }}>추이 보기 →</span>
            </button>
          ))}
        </div>
      )}

      {/* 디스크 사용량 추이 — 전체 합계 / 그룹별 합산 / 전체 서버. 폴링하지 않는다(12시간마다 쌓이는 이력). */}
      {servers.length > 0 && <BmStorHistoryPanel groups={groups} servers={servers} request={trendReq} onSeven={setSeven} />}

      {/* 그룹별 합산 — 카드 격자. ⚠ 사용량 많은 순(사용자 선택). 누르면 아래 서버 목록을 그 그룹으로 거른다. */}
      {groups.length > 0 && servers.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div className="flex between wrap" style={{ alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
            <div className="bm2-label">▸ 그룹별 합산 <span style={{ letterSpacing: 0, textTransform: 'none' }}>· 사용량 많은 순 · {groups.length}개</span></div>
            <span className="muted" style={{ fontSize: 11.5 }}>서버가 여러 그룹(최대 3개)에 속하면 각 그룹에 모두 더해집니다 — 그룹 합은 전체보다 클 수 있습니다. 카드를 누르면 서버 목록을 그 그룹으로 거릅니다.</span>
          </div>
          <div className="bm2-ggrid">
            {shownGroups.map((g) => {
              const key = groupKeyOf(g.name);
              const ch = groupSeries.get(key) ? changeOf(groupSeries.get(key)) : null;
              const p = g.usedPct;
              const on = gsel === g.name;
              const edge = p != null && p >= 90 ? 'var(--red)' : p != null && p >= WARN_PCT ? 'var(--amber)' : null;
              return (
                <button key={g.name} type="button" className={`card bm2-gcard${on ? ' on' : ''}`} style={edge ? { boxShadow: `inset 3px 0 0 ${edge}` } : undefined}
                  onClick={() => setGsel(on ? null : g.name)} title={on ? '다시 누르면 필터 해제' : '서버 목록을 이 그룹으로 거르기'}>
                  <span className="flex" style={{ alignItems: 'center', gap: 8, width: '100%' }}>
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: colors.get(g.name), flex: 'none' }} />
                    <b style={{ fontSize: 15, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>{g.name}</b>
                    <span className="muted" style={{ fontSize: 12, flex: 'none' }}>서버 {g.servers}대{g.errors ? <span style={{ color: 'var(--red)' }}> (오류 {g.errors})</span> : ''}</span>
                  </span>
                  <span className="flex between" style={{ alignItems: 'baseline', width: '100%', marginTop: 6 }}>
                    <span style={{ fontSize: 30, fontWeight: 700, color: p == null ? 'var(--text-dim)' : p >= 90 ? 'var(--red)' : p >= WARN_PCT ? 'var(--amber)' : 'var(--text)' }}>{pctText(p)}</span>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: ch > 0 ? 'var(--amber)' : 'var(--text-dim)' }}>{ch == null ? '—' : `${changeText(ch)} · 7일`}</span>
                  </span>
                  <span className="bm2-bar" style={{ height: 6, marginTop: 8, width: '100%' }}>{p != null && <span style={{ width: `${Math.min(100, p)}%`, background: pctColor(p) }} />}</span>
                  <span className="flex between muted" style={{ fontSize: 12, width: '100%', marginTop: 8 }}>
                    <span>{fmtBytes(g.usedBytes)} / {fmtBytes(g.totalBytes)}</span><span>여유 {fmtBytes(g.availBytes)}</span>
                  </span>
                  <span style={{ alignSelf: 'flex-end', fontSize: 11.5, color: 'var(--mint)', marginTop: 6 }}
                    role="link" tabIndex={0} onClick={(e) => { e.stopPropagation(); showTrend(key); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); showTrend(key); } }}>추이 보기 →</span>
                </button>
              );
            })}
          </div>
          {sortedGroups.length > GROUP_FOLD && (
            <button type="button" className="tab" style={{ marginTop: 10, padding: '5px 12px', fontSize: 12.5 }} onClick={() => setGroupsOpen((o) => !o)}>
              {groupsOpen ? '접기' : `+ ${sortedGroups.length - GROUP_FOLD}개 더 보기`}
            </button>
          )}
        </div>
      )}

      {/* 서버 목록 — 서버별(자기 마운트 합) 용량 + 마운트 상세 툴팁 + 오류 사유 */}
      <div className="card bm2-card">
        <div className="flex between wrap" style={{ alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <div className="flex wrap" style={{ alignItems: 'center', gap: 8 }}>
            <span className="bm2-label">▸ 서버 목록</span>
            <span className="muted" style={{ fontSize: 12 }}>{listed.length}대 표시 · 75% 이상 {warnCount}대</span>
            {gsel != null && <button type="button" className="bm2-chip on" onClick={() => setGsel(null)} title="그룹 필터 해제">{gsel} ✕</button>}
          </div>
          <div className="flex wrap" style={{ alignItems: 'center', gap: 8 }}>
            <span style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', background: 'var(--panel-deep)' }}>
              {SORTS.map((o) => (
                <button key={o.key} type="button" onClick={() => setSortBy(o.key)} style={{ fontSize: 12, padding: '4px 10px', border: 'none', cursor: 'pointer', fontFamily: 'inherit', background: sortBy === o.key ? 'color-mix(in srgb, var(--accent) 22%, transparent)' : 'transparent', color: sortBy === o.key ? 'var(--accent)' : 'var(--text-dim)', fontWeight: sortBy === o.key ? 700 : 500 }}>{o.label}</button>
              ))}
            </span>
            <input className="input" style={{ width: 220, minWidth: 0, padding: '5px 10px', fontSize: 12.5 }} placeholder="이름·호스트·그룹 검색" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
        {servers.length === 0
          ? <div className="muted" style={{ fontSize: 13 }}>등록된 서버가 없습니다. '+ 서버 추가'로 SSH 접속 정보와 측정할 마운트 포인트를 등록하세요.</div>
          : <STable minWidth={1100}>
              <thead><tr><th>서버</th><th>그룹</th><th>수집 주체</th><th style={{ textAlign: 'right' }}>마운트</th><th style={{ textAlign: 'right' }}>총 용량</th><th style={{ textAlign: 'right' }}>사용량</th><th style={{ textAlign: 'right' }}>사용 가능</th><th>사용률</th><th>최근 수집</th><th data-nosort>작업</th></tr></thead>
              <tbody>
                {listed.map((s) => {
                  const p = s.ok ? s.usedPct : null;
                  const edge = p != null && p >= 90 ? 'var(--red)' : p != null && p >= WARN_PCT ? 'var(--amber)' : null;
                  return (
                    <tr key={s.id} style={{ ...(s.enabled ? {} : { opacity: 0.5 }), ...(edge ? { boxShadow: `inset 2px 0 0 ${edge}` } : {}) }}>
                      <td data-sort={s.name}><b>{s.name}</b>{!s.enabled && <span className="badge gray" style={{ marginLeft: 6 }}>비활성</span>}
                        <div className="muted" style={{ fontSize: 11.5, fontFamily: 'var(--mono)' }}>{s.host}</div></td>
                      <td style={{ fontSize: 12 }}>{(s.groups || []).length ? (s.groups || []).map((g) => (
                        <span key={g} className="bm2-gchip"><span style={{ width: 7, height: 7, borderRadius: 7, background: colors.get(g) || 'var(--text-faint)', display: 'inline-block' }} /> {g}</span>
                      )) : <span className="muted">—</span>}</td>
                      <td className="muted" style={{ fontSize: 12 }}>{s.agent
                        ? <><span className="badge blue">{s.agent}</span> <span className={`badge ${cfgOf(s.id)?.dispatch === 'push' ? 'green' : 'purple'}`} style={{ fontSize: 10 }}>{cfgOf(s.id)?.dispatch === 'push' ? 'PUSH' : '폴링'}</span></>
                        : '중앙 직접'}</td>
                      <td style={{ textAlign: 'right' }} data-sort={s.mountCount} title={(s.mounts || []).map((m) => `${m.mount}: ${fmtBytes(m.usedBytes)}/${fmtBytes(m.totalBytes)}`).join('\n') || '아직 수집 전'}>
                        {s.mountCount}{s.missing?.length ? <span style={{ color: 'var(--amber)', fontSize: 11 }} title={`미발견 마운트: ${s.missing.join(', ')}`}> (미발견 {s.missing.length})</span> : ''}
                      </td>
                      <td style={{ textAlign: 'right' }} data-sort={s.ok ? s.totalBytes : ''}>{s.ok ? fmtBytes(s.totalBytes) : '—'}</td>
                      <td style={{ textAlign: 'right' }} data-sort={s.ok ? s.usedBytes : ''}>{s.ok ? fmtBytes(s.usedBytes) : '—'}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }} data-sort={s.ok ? s.availBytes : ''}>{s.ok ? fmtBytes(s.availBytes) : '—'}</td>
                      <td data-sort={p ?? ''}>{s.ok ? pctCell(s.usedPct)
                        : s.authStopped ? <span className="badge red" style={{ fontSize: 11 }} title={s.error || ''}>인증 실패 정지{s.authStopped.attempts != null ? ` · ${s.authStopped.attempts}회` : ''}</span>
                        : s.error ? <span style={{ color: 'var(--red)', fontSize: 11.5 }} title={s.error}>⚠ {s.error.slice(0, 40)}{s.error.length > 40 ? '…' : ''}</span>
                          : <span className="muted" style={{ fontSize: 12 }}>수집 대기</span>}</td>
                      <td className="muted" style={{ fontSize: 11.5 }} data-sort={s.at || ''}>{s.at ? fmtAgo(s.at) : '—'}</td>
                      <td>
                        <span className="flex gap">
                          <button className="tab" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => edit(s)}>수정</button>
                          <button className="tab" style={{ padding: '4px 10px', fontSize: 12, color: 'var(--red)' }} onClick={() => del(s)}>삭제</button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </STable>}
        {servers.length > 0 && !listed.length && <div className="muted" style={{ fontSize: 12.5, padding: 10 }}>조건에 맞는 서버가 없습니다{gsel != null ? ` — 그룹 필터 '${gsel}' 를 풀어 보세요` : ''}.</div>}
      </div>

      {/* 서버 추가/수정 — 컬럼 형식 접속 정보 + 마운트 포인트 목록(줄바꿈 구분) */}
      {form && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !busy) setForm(null); }}>
          <EscClose onClose={() => { if (!busy) setForm(null); }} />
          <div className="modal card" style={{ maxWidth: 620 }}>
            <h3 style={{ marginTop: 0 }}>{form.id ? `서버 수정 — ${form.name || form.host}` : '서버 추가'}</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: 13 }}>
              <label>이름<input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="표시 이름(비우면 host)" /></label>
              <label>그룹 <span className="muted" style={{ fontSize: 11 }}>(최대 3개 — 쉼표/세미콜론 구분)</span>
                <input className="input" value={form.groups} onChange={(e) => setForm({ ...form, groups: e.target.value })}
                  placeholder="예: WA-백업, 전사-아카이브" title={`기존 그룹: ${groups.filter((g) => g.name !== '(그룹 없음)').map((g) => g.name).join(', ') || '(없음)'}`} /></label>
              <label>호스트(IP/FQDN) *<input className="input" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="192.168.10.5" /></label>
              <label>SSH 포트<input className="input" type="number" min={1} max={65535} value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} /></label>
              <label>계정<input className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
              <label>비밀번호<input className="input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={form.id ? '비우면 기존 유지' : ''} autoComplete="new-password" /></label>
              <label>수집 주체 <span className="muted" style={{ fontSize: 11 }}>(등록된 수집 서버(원격)에서 선택)</span>
                <select className="input" value={form.agent} onChange={(e) => setForm({ ...form, agent: e.target.value })}>
                  <option value="">중앙 직접(SSH)</option>
                  {(() => { const m = missingChoice(agents || [], form.agent); return m ? <option value={m.value}>엣지 위임 — {m.label}</option> : null; })()}
                  {(agents || []).map((a) => <option key={a} value={a}>엣지 위임 — {a}</option>)}
                </select>
              </label>
              {form.agent
                ? <label>전달 방식 <span className="muted" style={{ fontSize: 11 }}>(iDRAC 스캔과 동일)</span>
                  <select className="input" value={form.dispatch === 'push' ? 'push' : 'poll'} onChange={(e) => setForm({ ...form, dispatch: e.target.value })}
                    title="폴링: 엣지가 중앙으로 폴링해 잡 인출(NAT 뒤 엣지 표준 — CENTRAL_URL 필요) · PUSH: 중앙이 수집 서버 URL 로 직접 전송">
                    <option value="poll">에이전트 폴링(기본)</option>
                    <option value="push">중앙→엣지 직접(PUSH)</option>
                  </select>
                </label>
                : <span />}
              <label className="flex gap" style={{ alignItems: 'center', marginTop: 18, cursor: 'pointer' }}>
                <input type="checkbox" checked={form.enabled !== false} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> 수집 활성
              </label>
            </div>
            <label style={{ display: 'block', fontSize: 13, marginTop: 10 }}>측정할 마운트 포인트 * <span className="muted" style={{ fontSize: 11.5 }}>(줄바꿈/쉼표 구분 · 절대경로 · 예: / , /data , /var/log)</span>
              <textarea className="input" style={{ width: '100%', minHeight: 80, fontFamily: 'ui-monospace, monospace', fontSize: 12.5, marginTop: 4 }}
                value={form.mounts} onChange={(e) => setForm({ ...form, mounts: e.target.value })} placeholder={'/\n/data'} />
            </label>
            {msg && <div style={{ color: 'var(--red)', fontSize: 12.5, marginTop: 6 }}>⚠ {msg}</div>}
            <div className="flex gap" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button className="tab" style={{ padding: '8px 16px' }} disabled={busy} onClick={() => setForm(null)}>취소</button>
              <button className="login-btn" style={{ padding: '8px 18px' }} disabled={busy || !form.host.trim()} onClick={save}>{busy ? '저장 중…' : '저장'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
