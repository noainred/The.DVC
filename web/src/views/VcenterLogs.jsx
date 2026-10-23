import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, putJson, postJson, usePolling, downloadFile, canCsv } from '../api.js'; // v2.643 canCsv: CSV 내보내기 게이팅
import { requireChanged } from './changeResult.js';
import { downloadFailText } from './downloadFailText.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import { STable } from '../components/STable.jsx';
import { vcLogTotalText, vcLogCanLoadMore } from './vcLogPaging.js'; // v2.607: vclogs 상한 COUNT(totalCapped)
import { notCollectedNote } from './eventCoverageText.js'; // v2.733(C1-01): 이 포탈이 지금 이벤트를 수집하지 않는 vCenter
import { vcLogCollectRows, vcLogStateText, vcLogStateClass, vcLogLagText, vcLogLagWarn, vcLogCappedText, vcLogReadStoredText, vcLogDurText, vcLogMaxPerPollText, vcLogHintText } from './vcLogCollect.js'; // v2.764: vCenter 별 수집 상태 표(+ 시한 안내 — 2-c)

/** v2.590 P11: 연합 조회가 끝나지 않은 사유 — 결과 0건('로그 없음')과 구분해 말한다(조치가 다르다). */
export function fedExpiredText(why) {
  if (why === 'not-taken') return '담당 엣지가 조회 요청을 가져가지 않았습니다(엣지 포탈이 꺼졌거나 이 vCenter 를 담당하지 않습니다). 로그가 없다는 뜻이 아닙니다.';
  if (why === 'no-result') return '담당 엣지가 조회를 가져갔지만 결과를 보내지 않았습니다(엣지의 로그 DB 오류·결과 전송 실패 — 엣지 로그 화면의 logquery-worker 줄을 보세요). 로그가 없다는 뜻이 아닙니다.';
  return '엣지 조회가 만료됐습니다. 로그가 없다는 뜻이 아닙니다.';
}
export function fedTimeoutText(lastState) {
  return lastState === 'running'
    ? '엣지가 조회 중인데 화면 대기 한도를 넘었습니다 — 잠시 뒤 다시 조회하세요. 로그가 없다는 뜻이 아닙니다.'
    : '엣지가 아직 조회 요청을 가져가지 않았습니다 — 잠시 뒤 다시 조회하세요. 로그가 없다는 뜻이 아닙니다.';
}

const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString('ko-KR') : '—');
const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString());
const fmtMB = (b) => (b == null ? '—' : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);
const SEV = { error: ['위험', 'red'], warning: ['경고', 'amber'], info: ['정보', 'gray'] };

/** 설정 → vCenter 로그 보관 — 보관 정책 + 장기 보관된 이벤트 뷰어. */
/**
 * v2.733(점검 3회차 C1-01): 수집 상태 줄 — 범위 계정은 서버가 전 vCenter 합계(collected)를 null 로 준다('0건' 이 아니라 '—').
 */
export function vcLogRunText(lastRun, fmt = (ts) => new Date(ts).toLocaleString('ko-KR')) {
  if (!lastRun) return '아직 수집 안 함';
  if (lastRun.skipped) return `최근 확인 ${fmt(lastRun.at)} · 수집 꺼짐`;
  const n = lastRun.collected;
  return `최근 수집 ${fmt(lastRun.at)} · ${Number.isFinite(n) ? `${n.toLocaleString()}건` : '—'}`;
}

/**
 * v2.743(감사 WEB-04): '지금 수집' 결과 문구(순수 — vitest 고정). 예전에는 응답과 무관하게 '수집 완료: N건' 만 썼다 —
 *   진행 중(busy)이면 서버가 직전 결과를 돌려줘 그 건수를 이번 결과로 말했고, 꺼짐(skipped)은 '수집 완료: 0건', 전부 실패해도 '0건' 이었다.
 *   판정: busy(새로 수집하지 않음) → skipped(꺼짐 — 수집하지 않음) → 적재 건수 + 로그인 거부·인증 정지·수집 실패·수집 대상 아님을 각각.
 *   문제가 하나라도 있으면 '수집 완료' 라고 말하지 않는다. 건수를 모르면 '—'(0 아님).
 */
export function vcLogCollectText(r, fmt = (ts) => new Date(ts).toLocaleString('ko-KR')) {
  if (!r || typeof r !== 'object') return '수집 결과를 읽지 못했습니다.';
  if (r.ok === false) return `오류: ${typeof r.reason === 'string' && r.reason ? r.reason : '수집하지 못했습니다.'}`;
  if (r.busy) return `이전 수집이 아직 진행 중입니다${Number.isFinite(r.runningSince) ? `(${fmt(r.runningSince)} 시작)` : ''} — 이번 요청으로 새로 수집하지 않았습니다. 끝나면 상태 줄이 바뀝니다.`;
  if (r.skipped) return '로그 수집이 꺼져 있어 수집하지 않았습니다 — 위에서 켜고 정책을 저장하세요.';
  const len = (v) => (Array.isArray(v) ? v.length : 0);
  const n = r.collected;
  const nTxt = Number.isFinite(n) ? `${n.toLocaleString()}건` : '—';
  const rejected = len(r.authRejected), stopped = len(r.authStopped), failed = len(r.failed) + (Number.isFinite(r.failedOmitted) ? r.failedOmitted : 0), skippedVc = len(r.notCollected);
  const extra = [];
  if (rejected) extra.push(`로그인 거부 ${rejected}곳(계정·비밀번호를 확인하세요 — 그 vCenter 의 주기 수집은 멈춥니다)`);
  if (stopped) extra.push(`인증 실패로 멈춘 vCenter ${stopped}곳 건너뜀`);
  if (failed) {
    const first = Array.isArray(r.failed) && r.failed[0] ? `${r.failed[0].vcenterId}: ${r.failed[0].error || '알 수 없는 오류'}` : '';
    extra.push(`수집 실패 ${failed}곳${first ? `(${first}${failed > 1 ? ' 외' : ''})` : ''}`);
  }
  if (skippedVc) extra.push(`수집 대상이 아닌 vCenter ${skippedVc}곳(아래 안내)`);
  const problem = rejected || stopped || failed;
  return `${problem ? '수집 끝(일부 실패)' : '수집 완료'}: ${nTxt} 적재${extra.length ? ` · ${extra.join(' · ')}` : ''}`;
}

/** v2.733(C1-01): 로그 폴러가 이번 주기에 건너뛴 vCenter(엣지 위임·비활성·점검중) — 범위 계정에서 뺀 개수도 말한다. 없으면 ''. */
export function vcLogNotCollectedText(lastRun) {
  const base = notCollectedNote(lastRun?.notCollected, { tail: '이 포탈은 그 vCenter 에 로그인하지 않아 이벤트가 쌓이지 않습니다(엣지 위임 vCenter 의 로그는 아래 조회가 엣지에서 가져옵니다)' });
  const omitted = Number(lastRun?.notCollectedOmitted);
  const omitTxt = Number.isFinite(omitted) && omitted > 0 ? ` 범위 밖 ${omitted.toLocaleString()}곳은 표시하지 않았습니다.` : '';
  return base ? `${base}${omitTxt}` : '';
}

/**
 * v2.741(감사 DB-01): 로그 조회 기간. 예전 화면은 기간을 보내지 않아 검색어·심각도 조회가 보관분 전체(기본 365일)를 훑었다
 * (합성 180만 행에서 무일치 검색 한 번이 포탈 전체를 7초 넘게 멈췄다). 기본은 최근 7일이고 사용자가 넓힐 수 있다.
 * 'all' 은 전체 보관분이다 — 서버가 조각으로 나눠 읽어 멈추지는 않지만 오래 걸릴 수 있다.
 * ⚠ v2.742(감사 DB-01): 엣지 보관 vCenter(연합 조회)는 엣지가 같은 조각 읽기를 한다 — 엣지가 2.742 이상일 때만이다(그 전 엣지는 검색어·심각도
 *   조회를 한 문장 COUNT·조회로 돌려 '전체 보관분' 이면 엣지 포탈이 멈출 수 있다). CSV 내보내기도 v2.742(DB-03)부터 조각으로 읽는다.
 */
export const VCLOG_PERIODS = [
  { key: '1d', days: 1, label: '최근 24시간' },
  { key: '7d', days: 7, label: '최근 7일' },
  { key: '30d', days: 30, label: '최근 30일' },
  { key: '90d', days: 90, label: '최근 90일' },
  { key: 'all', days: null, label: '전체 보관분' },
];
export const VCLOG_DEFAULT_PERIOD = '7d';
/** 기간 키 → since(ms). 'all' 은 0(기간 하한 없음). 모르는 키는 기본 기간으로 본다 — 하한 없음으로 넓히지 않는다. */
export function vcLogSinceOf(key, now = Date.now()) {
  const p = VCLOG_PERIODS.find((x) => x.key === key) || VCLOG_PERIODS.find((x) => x.key === VCLOG_DEFAULT_PERIOD);
  return p.days == null ? 0 : now - p.days * 86_400_000;
}
/** 빈 표 문구 — 기간을 좁혀 본 것이면 '없다' 가 아니라 '이 기간에 없다' 고 말한다. */
export function vcLogEmptyText(key) {
  const p = VCLOG_PERIODS.find((x) => x.key === key);
  if (!p || p.days == null) return '보관된 로그가 없습니다.';
  return `${p.label} 안에 맞는 로그가 없습니다 — 기간을 넓혀 보세요.`;
}
/**
 * v2.741(감사 DB-03): 보관 크기 문구 — 용량 제한은 **사용 중 크기**로 판정하고 지운 자리는 새 로그가 다시 쓰므로 파일은 줄지 않는다.
 * 사용 중 크기를 모르면(구버전 서버) 파일 크기만.
 */
export function vcLogSizeText(st, fmt) {
  const file = fmt(st?.dbSizeBytes);
  if (!Number.isFinite(st?.dbUsedBytes)) return file;
  const free = Number.isFinite(st?.dbFreeBytes) && st.dbFreeBytes > 0 ? ` · 빈 공간 ${fmt(st.dbFreeBytes)}(새 로그가 다시 씁니다)` : '';
  return `사용 중 ${fmt(st.dbUsedBytes)} · 파일 ${file}${free}`;
}

export default function VcenterLogs() {
  const [st, setSt] = useState(null);
  const [s, setS] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);

  const loadStatus = () => fetchJson('/admin/vclogs/status').then((r) => { setSt(r); setS((c) => c || r.settings); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => { loadStatus(); const t = setInterval(loadStatus, 30_000); return () => clearInterval(t); }, []);

  if (err) return <ErrorBox message={err} />;
  if (!st || !s) return <Loading />;

  // v2.731(A5-01): putJson 은 400(저장 경로 검사 실패 {ok:false,reason})을 던지지 않는다 — 판정 없이 setS(r) 하면 설정 폼이 오류 객체가 되고 '저장됨' 이 떴다.
  const save = async () => { setBusy('save'); setMsg(null); try { const r = requireChanged(await putJson('/admin/vclogs/settings', s)); setS(r); setMsg('저장됨'); await loadStatus(); } catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusy(''); } };
  const collect = async () => { setBusy('collect'); setMsg(null); try { const r = await postJson('/admin/vclogs/collect', {}); setMsg(vcLogCollectText(r, fmtTime)); await loadStatus(); } catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusy(''); } };

  return (
    <div style={{ maxWidth: 1080 }}>
      <div className="section-title" style={{ marginTop: 0 }}>🗂 vCenter 로그 보관</div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        vCenter는 이벤트를 단기간만 보관합니다. 포탈이 주기적으로 수집해 <b>장기 보관</b>합니다.
        데이터는 <b>중앙 집중 저장이 아니라, 이 포탈(해당 지역 엣지)에 로컬 보관</b>됩니다 — 각 지역 로그는 그 지역 엣지 포탈에서 보세요.
        <br />현재 보관 <b>{fmtNum(st.store?.count)}</b>건 · {st.dbKind === 'sqlite' ? 'SQLite' : 'NDJSON'} · {vcLogSizeText(st, fmtMB)}
        {st.store?.firstTs && ` · ${fmtTime(st.store.firstTs)} ~ ${fmtTime(st.store.lastTs)}`}
        {st.dbPath && <><br /><span style={{ fontSize: 11 }}>경로: <code>{st.dbPath}</code></span></>}
      </p>

      {/* 보관 정책 */}
      <div className="card" style={{ padding: 16, marginBottom: 14 }}>
        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 18 }}>
          <label className="flex gap" style={{ alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /> <b>로그 수집·보관</b>
          </label>
          <span className="muted">수집 주기</span>
          <input className="input" type="number" min="1" style={{ width: 80 }} value={s.pollIntervalMin} onChange={(e) => setS({ ...s, pollIntervalMin: e.target.value })} /> <span className="muted">분</span>
          <span className="muted" style={{ marginLeft: 8 }}><b>보관 기간</b></span>
          <input className="input" type="number" min="0" style={{ width: 90 }} value={s.retentionDays} onChange={(e) => setS({ ...s, retentionDays: e.target.value })} /> <span className="muted">일 (0=무제한)</span>
          <span className="muted" style={{ marginLeft: 8 }}><b>용량 제한</b></span>
          <input className="input" type="number" min="0" style={{ width: 90 }} value={s.maxSizeMB} onChange={(e) => setS({ ...s, maxSizeMB: e.target.value })} /> <span className="muted" title="DB 의 사용 중 크기로 판정합니다. 넘으면 오래된 로그부터 지우고, 지운 자리는 새 로그가 다시 씁니다(파일 크기는 줄지 않습니다).">MB (0=무제한 · 사용 중 크기 기준)</span>
          <span className="muted" style={{ marginLeft: 8 }}>최소 심각도</span>
          <Select sort={false} className="select" value={s.minSeverity} onChange={(e) => setS({ ...s, minSeverity: e.target.value })}>
            <option value="info">정보 이상(전체)</option><option value="warning">경고 이상</option><option value="error">위험만</option>
          </Select>
        </div>
        {vcLogMaxPerPollText(st) && <div className="muted" style={{ fontSize: 11, marginTop: 6, whiteSpace: 'normal' }}>{vcLogMaxPerPollText(st)}</div>}
        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 12, marginTop: 12 }}>
          <span className="muted"><b>저장 경로</b></span>
          <input className="input" placeholder="비우면 기본(CONFIG_DIR)" style={{ flex: 1, minWidth: 280 }} value={s.storagePath || ''} onChange={(e) => setS({ ...s, storagePath: e.target.value })} />
          <span className="muted" style={{ fontSize: 11 }}>서버의 디렉터리 경로. 변경 시 새 위치에 저장(기존 파일은 이동되지 않음).</span>
        </div>
        <div className="flex gap" style={{ marginTop: 12, alignItems: 'center' }}>
          <button className="login-btn" style={{ padding: '8px 16px' }} disabled={busy === 'save'} onClick={save}>{busy === 'save' ? '저장 중…' : '정책 저장'}</button>
          <button className="logout-btn" style={{ padding: '8px 16px' }} disabled={busy === 'collect'} onClick={collect}>{busy === 'collect' ? '수집 중…' : '⟳ 지금 수집'}</button>
          <span className="muted" style={{ fontSize: 12 }}>{vcLogRunText(st.lastRun, fmtTime)}{msg ? ` · ${msg}` : ''}</span>
        </div>
        {vcLogNotCollectedText(st.lastRun) && <div className="muted" style={{ fontSize: 12, marginTop: 6, whiteSpace: 'normal' }}>{vcLogNotCollectedText(st.lastRun)}</div>}
        <VcLogCollectTable st={st} />
      </div>

      <LogViewer />
    </div>
  );
}

/**
 * v2.764: vCenter 별 수집 상태 표(예전 배지 묶음 대체) — 보관 건수·마지막 저장·온전한 시각·지연(1일 넘으면 호박색)·이번 주기 읽음/저장·상한·소요/시한·상태.
 * 서버 collect 가 없으면(구버전) 건수·마지막 저장만 채우고 나머지는 '—'. STable 이 minWidth 와 가로 스크롤 래퍼를 함께 만든다(400px 넘침 방지).
 */
export function VcLogCollectTable({ st }) {
  const rows = vcLogCollectRows(st);
  if (!rows.length) return null;
  const omitted = Number(st?.collectOmitted);
  return (
    <div style={{ marginTop: 10 }}>
      <STable minWidth={980} style={{ fontSize: 12 }}>
        <thead><tr>
          <th>vCenter</th><th>보관 건수</th><th>마지막 저장</th><th title="이 시각까지의 이벤트는 전부 모았습니다(상한에 걸리면 마지막으로 읽은 이벤트 시각)">온전한 시각</th>
          <th title="지금 − 온전한 시각(없으면 마지막 저장). 1일을 넘으면 호박색">지연</th><th title="이번 주기에 읽은 수 / 저장한 수(회차)">이번 주기 읽음/저장</th>
          <th title="이번 주기가 끝까지 읽지 못한 이유 — 예산(시간 예산 소진)·시한(데드라인)·중단(묶음 사이 실패)·상한·쪽 수 한도">상한</th><th title="이번 주기 소요 / 데드라인(시간 예산 + 요청 시한×2)">소요/시한</th><th>상태</th>
        </tr></thead>
        <tbody>
          {rows.map((r) => {
            const warn = vcLogLagWarn(r.lagMs);
            return (
              <tr key={r.vcenterId}>
                <td style={{ whiteSpace: 'nowrap' }}>{r.vcenterId}</td>
                <td data-sort={r.count ?? ''} className="right">{fmtNum(r.count)}</td>
                <td data-sort={r.lastStoredTs ?? ''} className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtTime(r.lastStoredTs)}</td>
                <td data-sort={r.okAt ?? ''} className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtTime(r.okAt)}</td>
                <td data-sort={r.lagMs ?? ''} style={{ whiteSpace: 'nowrap', color: warn ? 'var(--amber)' : undefined, fontWeight: warn ? 600 : undefined }}>{vcLogLagText(r.lagMs)}</td>
                <td data-sort={r.read ?? ''} style={{ whiteSpace: 'nowrap' }}>{vcLogReadStoredText(r, fmtNum)}</td>
                <td data-sort={r.capped == null ? '' : r.capped ? 1 : 0}>{vcLogCappedText(r)}</td>
                <td data-sort={r.ms ?? ''} style={{ whiteSpace: 'nowrap' }}>{vcLogDurText(r)}</td>
                <td data-sort={r.state ?? ''}><span className={`badge ${vcLogStateClass(r.state)}`} title={r.error || (r.errorHidden ? '오류 원문은 전체 범위 관리자만 봅니다' : undefined)}>{vcLogStateText(r.state)}</span>{vcLogHintText(r) && <span className="muted" style={{ marginLeft: 6, whiteSpace: 'normal' }}>{vcLogHintText(r)}</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </STable>
      {Number.isFinite(omitted) && omitted > 0 && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>범위 밖 vCenter {omitted.toLocaleString()}곳은 표시하지 않았습니다.</div>}
    </div>
  );
}

function LogViewer() {
  const { data: vcs } = usePolling('/vcenters', {}, 60_000);
  const [f, setF] = useState({ vcenterId: '', severity: '', q: '' });
  const [period, setPeriod] = useState(VCLOG_DEFAULT_PERIOD);   // v2.741(DB-01): 기본 최근 7일
  const sinceRef = useRef(0);   // 첫 페이지를 읽은 순간의 since — '더 보기'·CSV 가 같은 기간을 쓴다(밀리지 않게)
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalInfo, setTotalInfo] = useState({ totalCapped: false, totalCap: null, lastBatch: 0 }); // v2.607: 상한 COUNT 표시·더 보기 판정
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [sources, setSources] = useState({ local: [], remote: [] });
  // 'local' | 'edge' — 사용자가 고르는 탭이 아니라 **조회 로직이 정하는 파생 상태**다(load() 가
  // 선택한 vCenter 의 보관 위치를 보고 설정). URL 에 실으면 조회할 때마다 해시가 덮여 무의미하므로
  // v2.438 하위 탭 URL 유지 대상에서 제외한다.
  const [mode, setMode] = useState('local');
  // v2.590 P11: 엣지 연합 조회가 끝나지 않은 이유 — 예전에는 13초 뒤 조용히 빈 표로 끝나 '로그가 없다' 처럼 보였다.
  const [fedNote, setFedNote] = useState('');
  const [dlMsg, setDlMsg] = useState('');   // v2.602 WEB2602-01: CSV 내려받기 실패 사유
  const LIMIT = 200;
  const remoteAgent = (id) => sources.remote.find((r) => r.vcenterId === id)?.agent;

  useEffect(() => { fetchJson('/tools/vclogs/sources').then(setSources).catch(() => {}); }, []);

  // 엣지 보관 vCenter면 연합 조회(요청 큐잉 → 폴링). 데이터는 엣지에 남고 결과만 중계.
  // 세대 가드: 폴링 중 다른 vCenter로 전환/재조회하면 옛 루프 결과가 새 화면을 덮지 않게 무효화.
  const fedGen = useRef(0);
  const federate = async () => {
    const gen = ++fedGen.current;
    setMode('edge'); setLoading(true); setRows([]); setFedNote('');
    try {
      sinceRef.current = vcLogSinceOf(period);
      const { reqId } = await postJson('/tools/vclogs/federate', { vcenterId: f.vcenterId, severity: f.severity, q: f.q, limit: LIMIT, ...(sinceRef.current ? { since: sinceRef.current } : {}) });
      let last = 'pending';
      for (let i = 0; i < 9; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        if (gen !== fedGen.current) return; // 다른 조회로 대체됨 → 이 루프 폐기
        const d = await fetchJson(`/tools/vclogs/federate?reqId=${encodeURIComponent(reqId)}`);
        if (gen !== fedGen.current) return;
        // v2.742(감사 DB-01): 엣지도 검색어·심각도 조회의 건수를 상한까지만 센다 — totalCapped 가 오면 'N건 이상' 으로 말한다(구버전 엣지·중앙은 필드가 없다 = 정확한 수).
        if (d.state === 'done') { setRows(d.rows || []); setTotal(d.total || 0); setTotalInfo({ totalCapped: d.totalCapped === true, totalCap: Number.isFinite(d.totalCap) ? d.totalCap : null, lastBatch: (d.rows || []).length }); setLoading(false); return; }
        if (d.state === 'expired') { setFedNote(fedExpiredText(d.why)); setLoading(false); return; }
        last = d.state;
      }
      if (gen === fedGen.current) { setLoading(false); setFedNote(fedTimeoutText(last)); } // 화면 대기 한도(엣지 미응답)
    } catch (e) { if (gen === fedGen.current) { setLoading(false); setFedNote(`엣지 조회 요청 실패: ${e.message || e}`); } }
  };

  const load = (reset = true) => {
    if (f.vcenterId && remoteAgent(f.vcenterId)) return federate(); // 엣지 보관 → 연합 조회
    const gen = ++fedGen.current; // 진행 중이던 연합 폴링 무효화 + 이 로컬 조회의 세대
    setMode('local'); setLoading(true); setFedNote('');
    const off = reset ? 0 : offset;
    if (reset) sinceRef.current = vcLogSinceOf(period);
    const qs = new URLSearchParams({ limit: String(LIMIT), offset: String(off) });
    if (sinceRef.current) qs.set('since', String(sinceRef.current));
    if (f.vcenterId) qs.set('vcenterId', f.vcenterId);
    if (f.severity) qs.set('severity', f.severity);
    if (f.q) qs.set('q', f.q);
    fetchJson(`/tools/vclogs?${qs}`).then((d) => {
      if (gen !== fedGen.current) return; // 더 새 조회로 대체됨
      setTotal(d.total); setTotalInfo({ totalCapped: d.totalCapped === true, totalCap: Number.isFinite(d.totalCap) ? d.totalCap : null, lastBatch: d.rows.length });
      setRows((prev) => (reset ? d.rows : [...prev, ...d.rows])); setOffset(off + d.rows.length);
    }).catch(() => {}).finally(() => { if (gen === fedGen.current) setLoading(false); });
  };
  useEffect(() => { load(true); /* eslint-disable-next-line */ }, [f.vcenterId, f.severity, period, sources]);

  const exportCsv = async () => {
    const qs = new URLSearchParams();
    if (sinceRef.current) qs.set('since', String(sinceRef.current));   // v2.741(DB-01): 화면에 보이는 기간과 같은 범위를 내보낸다
    if (f.vcenterId) qs.set('vcenterId', f.vcenterId);
    if (f.severity) qs.set('severity', f.severity);
    if (f.q) qs.set('q', f.q);
    // v2.602(감사 WEB2602-01): downloadFile 이 res.ok 를 본다 — 실패(409·403·5xx)의 오류 JSON 을 파일로 저장하지 않고 사유를 화면에 말한다.
    setDlMsg('');
    try { await downloadFile(`/tools/vclogs/export.csv?${qs}`, 'vcenter-logs.csv'); } catch (e) { setDlMsg(downloadFailText(e)); }
  };

  return (
    <div className="card" style={{ padding: 14 }}>
      <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 8 }}>
        <div className="flex gap wrap" style={{ alignItems: 'center' }}>
          <Select className="select" value={f.vcenterId} onChange={(e) => setF({ ...f, vcenterId: e.target.value })}>
            <option value="">전체 vCenter</option>
            {(vcs || []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </Select>
          <Select sort={false} className="select" value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>
            <option value="">전체 심각도</option><option value="error">위험</option><option value="warning">경고</option><option value="info">정보</option>
          </Select>
          <Select sort={false} className="select" value={period} onChange={(e) => setPeriod(e.target.value)} title="조회 기간 — 넓을수록 검색이 오래 걸립니다">
            {VCLOG_PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </Select>
          <input className="input" placeholder="메시지/엔티티/사용자 검색…" style={{ width: 220 }} value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && load(true)} />
          <button className="tab" style={{ padding: '6px 12px' }} onClick={() => load(true)}>검색</button>
        </div>
        <div className="flex gap" style={{ alignItems: 'center' }}>
          {mode === 'edge' && <span className="badge amber" title="데이터는 엣지에 보관, 조회만 중계">엣지 조회: {remoteAgent(f.vcenterId) || '?'}</span>}
          <span className="muted" style={{ fontSize: 12 }} title={totalInfo.totalCapped ? '검색어·심각도 필터가 있으면 건수를 상한까지만 셉니다 — 실제로는 더 있을 수 있습니다' : undefined}>{vcLogTotalText({ total, ...totalInfo }, fmtNum)}</span>
          {canCsv() && <button className="logout-btn" style={{ padding: '6px 12px' }} onClick={exportCsv} disabled={mode === 'edge'} title={mode === 'edge' ? '엣지 조회는 CSV 미지원(엣지 포탈에서 받으세요)' : ''}>⬇ CSV</button>}
        </div>
      </div>
      {dlMsg && <div className="banner error" role="alert" style={{ marginBottom: 8 }}>{dlMsg}</div>}
      <div className="table-wrap" style={{ maxHeight: '52vh' }}>
        <STable><thead><tr><th>시각</th><th>vCenter</th><th>심각도</th><th>유형</th><th>대상</th><th>사용자</th><th>메시지</th></tr></thead>
          <tbody>
            {rows.length === 0 && !loading && <tr><td colSpan={7} className="center muted" style={{ padding: 20, whiteSpace: 'normal' }}>{vcLogEmptyText(period)}</td></tr>}
            {rows.map((r, i) => {
              const [lbl, cls] = SEV[r.severity] || ['정보', 'gray'];
              return (
                <tr key={i}>
                  <td className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{fmtTime(r.ts)}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{r.vcenterId}</td>
                  <td><span className={`badge ${cls}`}>{lbl}</span></td>
                  <td style={{ fontSize: 12 }}>{r.type}</td>
                  <td style={{ fontSize: 12 }}>{r.entity || '—'}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{r.user || '—'}</td>
                  <td style={{ fontSize: 12 }}>{r.message}</td>
                </tr>
              );
            })}
          </tbody></STable>
      </div>
      {mode === 'local' && vcLogCanLoadMore({ loaded: rows.length, total, totalCapped: totalInfo.totalCapped, lastBatch: totalInfo.lastBatch, limit: LIMIT }) && <button className="tab" style={{ marginTop: 10, padding: '7px 16px' }} disabled={loading} onClick={() => load(false)}>{loading ? '불러오는 중…' : `더 보기 (${rows.length}/${vcLogTotalText({ total, ...totalInfo }, fmtNum)})`}</button>}
      {mode === 'edge' && loading && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>엣지 포탈에 조회 중… (응답 대기)</div>}
      {mode === 'edge' && !loading && fedNote && <div style={{ fontSize: 12, marginTop: 8, color: 'var(--amber)' }}>{fedNote}</div>}
    </div>
  );
}

import Select from '../components/Select.jsx';