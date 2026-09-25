/**
 * 포탈 점검 — 첫 항목은 **토큰 점검**(v2.560).
 *
 * 사용자 요청(2026-09-18): "특수기능에 '포탈 점검' 이라는 메뉴를 만들고 첫번째 서브메뉴로
 * '토큰 점검' 이라는 메뉴를 만들어줘 — ① 등록된 모든 엣지/수집 서버의 모든 토큰을 수집해서
 * **중복**된 것이 있는지 ② 중앙에서 저장된 토큰과 엣지에서 저장된 토큰을 사용해서 **통신이
 * 되는지** ③ 중앙에 등록된 엣지의 토큰과 엣지에 저장된 토큰이 **동일한지** ④ 점검하는 기능".
 * 선택: 엣지 보고 엔드포인트를 **이 릴리스에 만든다** · 공유 토큰은 **전용 '주의' 칸** ·
 * 배포 대상 토큰은 **저장소 대조만**(찔러보지 않는다).
 *
 * 화면 설계 의도:
 *  1. 배너가 '지금 보이는 것이 무엇인가' 를 **한 번만** 말한다(점검 전에는 저장값 대조뿐이다).
 *  2. KPI 다섯 칸은 **겹치지 않는다** — 합계 = 정상 + 결함 + 주의 + 확인 불가.
 *  3. 표는 요구 ①②③ 을 **열로** 나눈다. 긴 설명은 행이 아니라 표 아래 각주 1회(v2.509).
 *  4. 판정은 서버가 소유하고(`portalcheck/tokenScan.js`) 문구는 `tokenCheckText.js` 가 만든다.
 *     이 파일은 조립만 한다.
 *
 * ⚠ **폴링하지 않는다** — 마운트 1회 + 버튼(v2.508 V4 규약). 점검은 엣지로 나가는 요청이다.
 * ⚠ 표는 **가로 스크롤 컨테이너**로 감싼다(열이 8개 — 감싸지 않으면 400px 에서 페이지를 밀어낸다).
 * ⚠ 문구는 **BoldText** 로 렌더한다(`**강조**` 가 별표로 새는 사고 — v2.439·2.440·2.505·2.545).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson, postJson } from '../../api.js';
import { useHashTab } from '../../hooks/useHashTab.js'; // v2.613 CATALOG2613-06: 서브메뉴를 URL 에 싣는다
import { Loading, ErrorBox, SearchBox, Kpi } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import {
  ROW_LABEL, ROW_TONE, rowState, PROBE_LABEL, PROBE_TONE, EDGE_FACT_LABEL, EDGE_FACT_TONE,
  DUP_LABEL, dupText, scopeLabel, findingGroupLine, fpText, bannerText, okRateText,
  tableFootnotes, runSummary, evidenceText, centralAxisText, mergeRunResult, limitsText, edgeReportCell,
} from './tokenCheckText.js';
import {
  INV_STATE_LABEL, INV_STATE_TONE, invRowState, ageText, rowExplain, agentRowExplain,
  findingGroupLine as invFindingGroupLine, bannerText as invBannerText, freshRateText,
  tableFootnotes as invTableFootnotes,
} from './invCheckText.js';

const VIEWS = [['tokens', '토큰 점검'], ['inventory', '인벤토리 점검']];

const TONE = Object.freeze({
  green: 'var(--ok, #35c46a)', red: 'var(--bad, #ef5a5a)',
  amber: 'var(--warn, #e8b23a)', gray: 'var(--muted)',
});

function Badge({ text, tone }) {
  return <span style={{ color: TONE[tone] || TONE.gray, fontWeight: 600, whiteSpace: 'nowrap' }}>{text}</span>;
}

const ago = (ts) => {
  if (ts == null || ts === '') return '—';
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const s = Math.max(0, Math.round((Date.now() - n) / 1000));
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  if (s < 86400) return `${Math.round(s / 3600)}시간 전`;
  return `${Math.round(s / 86400)}일 전`;
};

/** 토큰 점검 서브메뉴 — 기존 컴포넌트(v2.560), 자기 데이터·상태를 갖는다. */
function TokenCheckView() {
  // ⚠ 훅은 전부 조기 return 위에(조기 반환 뒤 훅 추가는 React #310 크래시 — v2.202 실제 사고).
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [q, setQ] = useState('');
  const [onlyBad, setOnlyBad] = useState(false);
  const [detail, setDetail] = useState(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try { setData(await fetchJson('/tools/portal-check/tokens')); setError(''); }
    catch (e) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => {
    const all = data?.rows || [];
    const needle = String(q || '').trim().toLowerCase();
    return all.filter((r) => {
      if (onlyBad && !['fault', 'warn'].includes(rowState(r))) return false;
      if (!needle) return true;
      return [r.agent, r.id, r.url, r.version, r.edge?.said].some((v) => String(v || '').toLowerCase().includes(needle));
    });
  }, [data, q, onlyBad]);

  const banner = useMemo(() => bannerText(data), [data]);
  const foots = useMemo(() => tableFootnotes(data, data?.limits), [data]);

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} />;

  const run = async (path, label) => {
    setBusy(label);
    try {
      const r = await postJson(path, {});
      setNote(runSummary(r));
      /*
       * v2.600 WEB2600-03: 점검·인출 응답은 **스캔 결과만** 싣는다 — `limits`·`centralAuth`·`vocab`·
       *   `running` 은 GET 만 준다. 통째로 바꾸면 '동시 ?곳 · 요청 시한 0초' 가 되고 중복 설명이
       *   `requireAgentToken` 을 잃는다. 이전 값 위에 덮는다.
       */
      setData((d) => mergeRunResult(d, r));
    } catch (e) { setNote(`${label} 실패: ${e?.message || e}`); }
    finally { setBusy(''); }
  };

  const kpi = data?.kpis || {};
  const dups = data?.duplicates || [];
  const findings = data?.findings || [];
  /*
   * ⚠ 화면은 **묶은 것**을 그린다 — 엣지 28곳이 전부 공유 토큰인 현장에서 같은 문장이 28줄
   *   반복되면 화면을 덮는다(v2.509 규약. 스크린샷을 읽어야 보인다 — 수치로는 안 잡혔다).
   *   구버전 서버가 `findingGroups` 를 주지 않으면 원본을 그대로 쓴다.
   */
  const groups = data?.findingGroups || findings.map((f) => ({ ...f, count: 1, agents: f.agent ? [f.agent] : [] }));

  return (
    <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0 }}>
      {error && <div className="banner">{error}</div>}

      {/* 배너 — 긴 설명은 여기 한 번만(v2.509) */}
      <div className="card" style={{ borderLeft: `3px solid ${TONE[banner.tone] || TONE.gray}` }}>
        <div style={{ fontSize: 12, lineHeight: 1.6 }}><BoldText text={banner.text} /></div>
      </div>

      {/* ⚠ 다섯 칸이 겹치지 않는다 — 합계 = 정상 + 결함 + 주의 + 확인 불가.
          '공유 토큰'·'중복 결함' 은 **별도 축**이라 이 합에 더하지 않는다(따로 보여준다). */}
      <div className="kpis">
        <Kpi label="엣지 합계" value={kpi.total ?? '—'} />
        <Kpi label="정상" value={kpi.ok ?? '—'} />
        <Kpi label="결함" value={kpi.fault ?? '—'} />
        <Kpi label="주의" value={kpi.warn ?? '—'} />
        <Kpi label="확인 불가" value={kpi.unknown ?? '—'} />
        {/* ⚠ 분모는 **응답을 받은 행**이다(값 위생만으로 warn 이 된 행은 측정이 아니다 —
            `tokenScan.js kpisOf` 머리말). 라벨이 그 사실을 말한다. */}
        <Kpi label="통신 성공률(응답분)" value={okRateText(kpi)} meta={kpi.measured != null ? `응답 ${kpi.measured}곳` : undefined} />
      </div>
      <div className="kpis">
        <Kpi label="공유 토큰 사용" value={kpi.sharedToken ?? '—'} />
        <Kpi label="중복 결함" value={kpi.dupFault ?? '—'} />
        <Kpi label="발견(결함)" value={data?.findingCounts?.fault ?? '—'} />
        <Kpi label="발견(주의)" value={data?.findingCounts?.warn ?? '—'} />
      </div>

      <div className="card" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn" onClick={() => run('/tools/portal-check/tokens/probe', '지금 점검')} disabled={!!busy}>
          {busy === '지금 점검' ? '점검 중…' : '지금 점검'}
        </button>
        <button className="btn" onClick={() => run('/tools/portal-check/tokens/edge-pull', '엣지 값 가져오기')} disabled={!!busy}>
          {busy === '엣지 값 가져오기' ? '가져오는 중…' : '엣지 값 가져오기'}
        </button>
        <button className="btn" onClick={load} disabled={!!busy}>새로고침</button>
        <SearchBox value={q} onChange={setQ} placeholder="엣지 이름·주소 검색" />
        <label style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}>
          <input type="checkbox" checked={onlyBad} onChange={(e) => setOnlyBad(e.target.checked)} /> 결함·주의만
        </label>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>
          {/* ⚠ 숫자를 문구에 박지 않는다 — 서버가 준 값만 쓴다. */}
          {/* 값이 없으면 단위를 붙이지 않는다(0초·?곳 은 0 처럼 읽힌다 — v2.575 unitText 규약). */}
          {limitsText(data?.limits)}
        </span>
      </div>

      {note && <div className="card" style={{ fontSize: 12 }}><BoldText text={note} /></div>}

      {/* ① 중복 — 위험한 것이 위다(서버가 정렬해 준다). */}
      {dups.length > 0 && (
        <div className="card" style={{ display: 'grid', gap: 6 }}>
          <div style={{ fontWeight: 600 }}>① 중복된 토큰 {dups.length}건</div>
          <div style={{ overflowX: 'auto' }}>
            <STable className="v3-table">
              <thead><tr><th>등급</th><th>종류</th><th>지문</th><th data-nosort>설명</th></tr></thead>
              <tbody>
                {dups.map((d, i) => (
                  <tr key={`${d.short}-${i}`}>
                    <td data-sort={d.grade}><Badge text={d.grade === 'fault' ? '결함' : d.grade === 'warn' ? '주의' : '정보'}
                      tone={d.grade === 'fault' ? 'red' : d.grade === 'warn' ? 'amber' : 'gray'} /></td>
                    <td>{DUP_LABEL[d.kind] || d.kind}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{d.short} · {d.len}자</td>
                    <td style={{ whiteSpace: 'normal', fontSize: 12, lineHeight: 1.6 }}><BoldText text={dupText(d, { requireAgentToken: !!data?.centralAuth?.requireAgentToken })} /></td>
                  </tr>
                ))}
              </tbody>
            </STable>
          </div>
        </div>
      )}

      {/* 엣지 표 — 요구 ②③ */}
      <div className="card" style={{ display: 'grid', gap: 6 }}>
        <div style={{ fontWeight: 600 }}>
          엣지 · 수집 서버 {rows.length}곳{rows.length !== (data?.rows || []).length ? ` (전체 ${(data?.rows || []).length}곳 중)` : ''}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <STable className="v3-table" minWidth={980} wrap={false}>
            <thead>
              <tr>
                <th>엣지</th><th>등록</th><th>주소</th>
                <th>수집 토큰 지문</th><th>② 통신</th><th>③ 수집 토큰 동일성</th>
                <th>③ 중앙 토큰</th><th>배포 대상</th><th>엣지 보고</th><th>상태</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const st = rowState(r);
                const pst = r.probe?.state || 'not-run';
                const fact = r.edge?.fact || (r.edge ? 'unknown' : '');
                return (
                  <tr key={r.agent || r.id} style={{ cursor: 'pointer' }} onClick={() => setDetail(r)}
                    title="클릭하면 근거와 조치를 봅니다">
                    <td style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.agent || '—'}</td>
                    <td>{r.registered ? '등록됨' : <Badge text="등록부 없음" tone="amber" />}</td>
                    <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.url || ''}>{r.url || '—'}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: 11, whiteSpace: 'nowrap' }}>{fpText(r.collector)}</td>
                    <td data-sort={pst}><Badge text={PROBE_LABEL[pst] || pst} tone={PROBE_TONE[pst] || 'gray'} /></td>
                    {/* ⚠ '증명' 이라는 말은 200 일 때만 — 지문 대조와 근거 강도가 다르다. */}
                    <td>{pst === 'ok' ? <Badge text="같음(증명)" tone="green" />
                      : pst === 'token-mismatch' ? <Badge text="다름" tone="red" />
                        : <Badge text="확인 불가" tone="gray" />}</td>
                    <td data-sort={fact}>{fact ? <Badge text={EDGE_FACT_LABEL[fact] || fact} tone={EDGE_FACT_TONE[fact] || 'gray'} /> : <span style={{ color: 'var(--muted)' }}>보고 없음</span>}</td>
                    <td style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                      {!r.deploy?.present ? '—'
                        : r.deploy.collectorMatchesRegistry === true ? <Badge text="등록값과 같음" tone="green" />
                          : r.deploy.collectorMatchesRegistry === false ? <Badge text="등록값과 다름" tone="amber" />
                            : <Badge text="비교 불가" tone="gray" />}
                    </td>
                    {(() => {
                      // v2.601 WEB2601-03: 받지 못한 보고를 'N초 전' 으로 쓰지 않는다(edgeReportCell).
                      const ec = edgeReportCell(r.edge, r.capability, ago);
                      return (
                        <td style={{ fontSize: 11, whiteSpace: 'nowrap' }} data-sort={ec.sortAt} title={ec.title || undefined}>
                          {ec.tone === 'gray' ? ec.text : <Badge text={ec.text} tone={ec.tone} />}
                        </td>
                      );
                    })()}
                    <td data-sort={st}><Badge text={ROW_LABEL[st]} tone={ROW_TONE[st]} /></td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={10} style={{ color: 'var(--muted)', whiteSpace: 'normal' }}>
                  표시할 엣지가 없습니다{q || onlyBad ? ' — 검색·필터를 지워 보세요.' : ' — 설정 › 수집 서버에 엣지를 등록하세요.'}
                </td></tr>
              )}
            </tbody>
          </STable>
        </div>
        {/* 각주 — 해당 종류가 있을 때만(행마다 반복하면 같은 문단이 화면을 덮는다 — v2.509) */}
        {foots.length > 0 && (
          <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.7, display: 'grid', gap: 3 }}>
            {foots.map((f, i) => <div key={i}><BoldText text={f} /></div>)}
          </div>
        )}
      </div>

      {/* ④ 발견 목록 — 위험한 것이 위다. */}
      <div className="card" style={{ display: 'grid', gap: 6 }}>
        <div style={{ fontWeight: 600 }}>
          ④ 점검 결과 {findings.length}건{groups.length !== findings.length ? ` (같은 항목을 묶어 ${groups.length}줄)` : ''}
        </div>
        {findings.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'normal' }}>
            <BoldText text={(data?.kpis?.measured || 0) > 0
              ? '발견된 항목이 없습니다 — 다만 **확인하지 못한 항목은 여기 나오지 않습니다**(표의 ‘확인 불가’ 칸을 보세요).'
              : '아직 점검하지 않았습니다 — ‘지금 점검’ 과 ‘엣지 값 가져오기’ 를 누르세요.'} />
          </div>
        )}
        {findings.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <STable className="v3-table">
              <thead><tr><th>등급</th><th className="right">건수</th><th data-nosort>내용과 조치</th></tr></thead>
              <tbody>
                {groups.map((g, i) => (
                  <tr key={`${g.code}-${g.facts?.where || ''}-${i}`}>
                    <td data-sort={g.grade}><Badge
                      text={{ fault: '결함', warn: '주의', unknown: '확인 불가', info: '정보' }[g.grade] || g.grade}
                      tone={{ fault: 'red', warn: 'amber', unknown: 'gray', info: 'gray' }[g.grade] || 'gray'} /></td>
                    <td className="right tabular" data-sort={g.count}>{g.count}</td>
                    {/* ⚠ 조언은 문장이라 길다 — `whiteSpace:'normal'` 이 없으면 오른쪽에서 잘린다(v2.513). */}
                    <td style={{ whiteSpace: 'normal', fontSize: 12, lineHeight: 1.6 }}><BoldText text={findingGroupLine(g)} /></td>
                  </tr>
                ))}
              </tbody>
            </STable>
          </div>
        )}
      </div>

      {detail && (
        <div className="modal-backdrop" onClick={() => setDetail(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div className="card" onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 720, width: '100%', maxHeight: '80vh', overflow: 'auto', display: 'grid', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <div style={{ fontWeight: 600 }}>{detail.agent || '(이름 없음)'} — 토큰 점검 근거</div>
              <button className="btn" onClick={() => setDetail(null)}>닫기</button>
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.7, display: 'grid', gap: 8 }}>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 2 }}>② 중앙 저장 토큰으로 통신</div>
                <Badge text={PROBE_LABEL[detail.probe?.state || 'not-run']} tone={PROBE_TONE[detail.probe?.state || 'not-run']} />
                {detail.probe?.httpStatus ? <span style={{ color: 'var(--muted)' }}> · HTTP {detail.probe.httpStatus}</span> : null}
                {detail.probe?.ms ? <span style={{ color: 'var(--muted)' }}> · {detail.probe.ms}ms</span> : null}
                {detail.probe?.reason && <div style={{ color: 'var(--muted)', whiteSpace: 'pre-wrap' }}>{detail.probe.reason}</div>}
              </div>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 2 }}>③ 수집 토큰(중앙 → 엣지) 동일성</div>
                <BoldText text={evidenceText(detail)} />
              </div>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 2 }}>③ 중앙 토큰(엣지 → 중앙) 동일성</div>
                <BoldText text={centralAxisText(detail)} />
              </div>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 2 }}>토큰 지문</div>
                <div style={{ fontFamily: 'monospace', fontSize: 11 }}>
                  중앙 등록값: {fpText(detail.collector)}<br />
                  엣지 수집 토큰: {fpText(detail.edge?.tokens?.collector)}<br />
                  엣지가 중앙에 보내는 토큰: {fpText(detail.edge?.tokens?.centralSend)}<br />
                  엣지 자신의 중앙 게이트: {fpText(detail.edge?.tokens?.centralGate)}
                </div>
              </div>
              {detail.nameFrom?.length > 0 && (
                <div style={{ color: 'var(--muted)' }}>이 이름을 본 곳: {detail.nameFrom.join(' · ')}</div>
              )}
              {detail.edge?.nameMismatch && (
                <div><BoldText text={`**중앙이 아는 이름과 엣지가 말한 이름이 다릅니다** — 중앙 ‘${detail.agent}’ · 엣지 ‘${detail.edge.said}’.`} /></div>
              )}
              {(detail.edge?.centralRole?.enabled || detail.centralRole?.kind === 'central-enabled') && (
                <div><BoldText text="**이 엣지가 또 다른 중앙으로 동작합니다** — 그 엣지의 CENTRAL_TOKEN 을 지우고 EDGE_TOKEN 을 쓰세요." /></div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 인벤토리 점검 서브메뉴(v2.570) — 위임(site) vCenter 의 push 가 실제로 들어오는지.
 *
 * 사용자 요청(2026-09-20): 에이전트 수신 트래픽 진단에서 최근 페이로드가 전부 `—` 인 것을 보고
 * "여기서 수집되는 데이터가 없으면 어떤 문제가 발생하는지 확인하고 오류를 점검하려면 어떻게
 * 해야 하는지" → "점검할 수 있는 기능 만들어줘".
 *
 * ⚠ **왕복이 없다** — 토큰 점검과 달리 '지금 점검' 버튼이 없다. 이미 중앙이 가진 값(위임
 *   vCenter 캐시·수신 통계·거부 기록·엣지 정체)을 조합해 보여줄 뿐이라 새로고침이면 충분하다.
 * ⚠ **폴링하지 않는다**(마운트 1회 + 새로고침 버튼 — v2.508 V4 규약).
 */
function InventoryCheckView() {
  // ⚠ 훅은 조기 return 위에(React #310 — v2.202 실제 사고).
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [onlyBad, setOnlyBad] = useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try { setData(await fetchJson('/tools/portal-check/inventory')); setError(''); }
    catch (e) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => {
    const all = data?.rows || [];
    const needle = String(q || '').trim().toLowerCase();
    return all.filter((r) => {
      if (onlyBad && !['rejected', 'stale', 'never'].includes(invRowState(r))) return false;
      if (!needle) return true;
      return [r.vcenterId, r.name, r.owner].some((v) => String(v || '').toLowerCase().includes(needle));
    });
  }, [data, q, onlyBad]);

  const agents = useMemo(() => {
    const all = data?.agents || [];
    const needle = String(q || '').trim().toLowerCase();
    return all.filter((a) => {
      if (onlyBad && (a.sentInventory || !a.knownOwner) && !a.mockReported && !a.rejectedOnly) return false;
      if (!needle) return true;
      return String(a.agent || '').toLowerCase().includes(needle);
    });
  }, [data, q, onlyBad]);

  const banner = useMemo(() => invBannerText(data), [data]);
  const foots = useMemo(() => invTableFootnotes(data), [data]);

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} />;

  const kpi = data?.kpis || {};
  const findings = data?.findings || [];
  const groups = data?.findingGroups || findings.map((f) => ({ ...f, count: 1, targets: f.target ? [f.target] : [] }));

  return (
    <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0 }}>
      {error && <div className="banner">{error}</div>}

      <div className="card" style={{ borderLeft: `3px solid ${TONE[banner.tone] || TONE.gray}` }}>
        <div style={{ fontSize: 12, lineHeight: 1.6 }}><BoldText text={banner.text} /></div>
      </div>

      {/* ⚠ 다섯 칸이 겹치지 않는다 — 합계 = 정상+낡음+미수신+거부됨+확인불가. emptyPush 는 별도 축. */}
      <div className="kpis">
        <Kpi label="위임 vCenter" value={kpi.total ?? '—'} />
        <Kpi label="정상 수신" value={kpi.ok ?? '—'} />
        <Kpi label="낡음" value={kpi.stale ?? '—'} />
        <Kpi label="수신 이력 없음" value={kpi.never ?? '—'} />
        <Kpi label="거부됨" value={kpi.rejected ?? '—'} />
        <Kpi label="확인 불가" value={kpi.unknown ?? '—'} />
        <Kpi label="신선율(측정분)" value={freshRateText(kpi)} meta={kpi.measured != null ? `측정 ${kpi.measured}곳` : undefined} />
      </div>
      {kpi.emptyPush > 0 && (
        <div className="card" style={{ fontSize: 12 }}>
          <BoldText text={`수신은 정상인데 호스트·VM 이 0인 vCenter **${kpi.emptyPush}곳** — 신규 구축·철거 직후라면 정상입니다.`} />
        </div>
      )}

      <div className="card" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn" onClick={load} disabled={loading}>{loading ? '불러오는 중…' : '새로고침'}</button>
        <SearchBox value={q} onChange={setQ} placeholder="vCenter·담당 엣지 검색" />
        <label style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}>
          <input type="checkbox" checked={onlyBad} onChange={(e) => setOnlyBad(e.target.checked)} /> 문제 있는 것만
        </label>
      </div>

      {/* 위임 vCenter 표 */}
      <div className="card" style={{ display: 'grid', gap: 6 }}>
        <div style={{ fontWeight: 600 }}>
          위임 vCenter {rows.length}곳{rows.length !== (data?.rows || []).length ? ` (전체 ${(data?.rows || []).length}곳 중)` : ''}
        </div>
        {/* ⚠ overflowX 만으로는 부족하다 — minWidth 가 없으면 400px 에서 스크롤 대신 셀이
            줄바꿈되며 행이 세로로 크게 늘어난다(v2.562 규약). */}
        <div style={{ overflowX: 'auto' }}>
          <STable className="v3-table" style={{ minWidth: 820 }}>
            <thead><tr><th>vCenter</th><th>담당 엣지</th><th>마지막 수신</th><th>호스트·VM</th><th>상태</th><th data-nosort>설명</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const st = invRowState(r);
                return (
                  <tr key={r.vcenterId}>
                    <td style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.vcenterId}>{r.name}</td>
                    <td>{r.owner || <span style={{ color: 'var(--muted)' }}>미상</span>}</td>
                    <td data-sort={r.lastAt || 0} style={{ whiteSpace: 'nowrap', fontSize: 11.5 }}>{ageText(r.ageMs)}</td>
                    <td className="tabular" style={{ whiteSpace: 'nowrap' }}>{r.hosts == null ? '—' : `${r.hosts}·${r.vms}`}</td>
                    <td data-sort={st}><Badge text={INV_STATE_LABEL[st]} tone={INV_STATE_TONE[st]} /></td>
                    <td style={{ whiteSpace: 'normal', fontSize: 12, lineHeight: 1.6 }}><BoldText text={rowExplain(r)} /></td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={6} style={{ color: 'var(--muted)', whiteSpace: 'normal' }}>
                  {(data?.rows || []).length === 0
                    ? '엣지 위임(collectMode=site) vCenter 가 없습니다.'
                    : '표시할 항목이 없습니다 — 검색·필터를 지워 보세요.'}
                </td></tr>
              )}
            </tbody>
          </STable>
        </div>
      </div>

      {/* 엣지 축 — 수신 트래픽 표의 '—' 를 설명한다 */}
      <div className="card" style={{ display: 'grid', gap: 6 }}>
        <div style={{ fontWeight: 600 }}>
          엣지별 인벤토리 전송 여부 {agents.length}곳{agents.length !== (data?.agents || []).length ? ` (전체 ${(data?.agents || []).length}곳 중)` : ''}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <STable className="v3-table" style={{ minWidth: 760 }}>
            <thead><tr><th>에이전트</th><th>인벤토리 전송</th><th>위임 담당</th><th className="right">거부 횟수</th><th data-nosort>설명</th></tr></thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.agent}>
                  <td style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.verified === false ? `${a.agent} — 요청이 주장한 이름(미검증)` : a.agent}>
                    {a.agent}{a.verified === false && <span style={{ color: 'var(--muted)', fontSize: 11 }}> (미검증)</span>}
                  </td>
                  <td data-sort={a.sentInventory ? 1 : 0}>
                    {a.mockReported ? <Badge text="mock" tone="red" />
                      : a.rejectedOnly ? <Badge text="전부 거부됨" tone="red" />
                      : a.sentInventory ? <Badge text="전송 중" tone="green" />
                        : <Badge text="미전송" tone={a.knownOwner ? 'red' : 'gray'} />}
                  </td>
                  <td>{a.knownOwner ? '예' : '아니오'}</td>
                  <td className="right tabular" data-sort={a.rejects?.total || 0}>{a.rejects?.total ?? 0}</td>
                  <td style={{ whiteSpace: 'normal', fontSize: 12, lineHeight: 1.6 }}><BoldText text={agentRowExplain(a)} /></td>
                </tr>
              ))}
              {agents.length === 0 && (
                <tr><td colSpan={5} style={{ color: 'var(--muted)', whiteSpace: 'normal' }}>
                  아직 수신된 push 가 없습니다{q || onlyBad ? ' — 검색·필터를 지워 보세요.' : '.'}
                </td></tr>
              )}
            </tbody>
          </STable>
        </div>
        {foots.length > 0 && (
          <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.7, display: 'grid', gap: 3 }}>
            {foots.map((f, i) => <div key={i}><BoldText text={f} /></div>)}
          </div>
        )}
      </div>

      {/* 발견 목록 — 위험한 것이 위다(서버가 정렬). */}
      <div className="card" style={{ display: 'grid', gap: 6 }}>
        <div style={{ fontWeight: 600 }}>
          점검 결과 {findings.length}건{groups.length !== findings.length ? ` (같은 항목을 묶어 ${groups.length}줄)` : ''}
        </div>
        {findings.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'normal' }}>발견된 문제가 없습니다.</div>
        )}
        {findings.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <STable className="v3-table" style={{ minWidth: 640 }}>
              <thead><tr><th>등급</th><th className="right">건수</th><th data-nosort>내용과 조치</th></tr></thead>
              <tbody>
                {groups.map((g, i) => (
                  <tr key={`${g.code}-${i}`}>
                    <td data-sort={g.grade}><Badge
                      text={{ fault: '결함', warn: '주의', info: '정보' }[g.grade] || g.grade}
                      tone={{ fault: 'red', warn: 'amber', info: 'gray' }[g.grade] || 'gray'} /></td>
                    <td className="right tabular" data-sort={g.count}>{g.count}</td>
                    <td style={{ whiteSpace: 'normal', fontSize: 12, lineHeight: 1.6 }}><BoldText text={invFindingGroupLine(g)} /></td>
                  </tr>
                ))}
              </tbody>
            </STable>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 포탈 점검 — 서브메뉴 셸(v2.570). 각 서브메뉴는 자기 데이터·상태를 갖는 독립 컴포넌트다
 * (한 도구 안의 탭이다 — 셸을 더 만들지 않는다, v2.508 규약). 셸을 바꿔 태우면 안 되는 상태
 * (검색어·필터·모달)가 서브메뉴 사이에 새는 것을 막기 위해 컴포넌트 자체를 스위치한다.
 */
export function PortalCheck() {
  // v2.613(CATALOG2613-06 / WEB2613-04): 서브메뉴를 해시(#/tools/portal-check/<view>)에 싣는다 — 새로고침·북마크·다른 화면에서의
  //   딥링크(예: 인벤토리 점검)가 첫 탭으로 되돌아가지 않는다(v2.438 규약, 형제 13개 도구와 같은 훅). 훅은 조기 return 위에.
  const [view, setView] = useHashTab({ base: ['tools', 'portal-check'], valid: VIEWS.map(([k]) => k), fallback: 'tokens' });
  return (
    <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0 }}>
      <div className="card" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {VIEWS.map(([k, label]) => (
          <button key={k} className="btn" onClick={() => setView(k)}
            style={view === k ? { background: 'var(--accent, #2b6cb0)', color: '#fff' } : undefined}>
            {label}
          </button>
        ))}
      </div>
      {view === 'inventory' ? <InventoryCheckView /> : <TokenCheckView />}
    </div>
  );
}

export default PortalCheck;
