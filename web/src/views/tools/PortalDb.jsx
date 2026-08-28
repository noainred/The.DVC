// PortalDb.jsx — SpecialTools.jsx(구 5,070줄)에서 분리(v2.282 대형 파일 분할). 본문은 원본 그대로 이동.
import React, { useState } from 'react';
import { fetchJson, usePolling } from '../../api.js';
import { DataTable, Loading, ErrorBox, Modal } from '../../components/ui.jsx';
import { Card } from './shared.jsx';


// 바이트를 사람이 읽는 단위로.
function fmtBytes(b) {
  if (b == null || !Number.isFinite(Number(b))) return '—';
  const n = Number(b);
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

const DB_TYPE_BADGE = { sqlite: 'blue', json: 'green', ndjson: 'amber', file: 'gray' };
const DB_TYPE_LABEL = { sqlite: 'SQLite', json: 'JSON', ndjson: 'ndjson', file: '파일' };

// 증가 추이 미니 스파크라인(크기 샘플). 값이 1개 이하면 '—'.
function Sparkline({ samples, w = 110, h = 26 }) {
  const pts = (samples || []).map((s) => s.bytes);
  if (pts.length < 2) return <span className="muted" style={{ fontSize: 12 }}>표본 부족</span>;
  const min = Math.min(...pts); const max = Math.max(...pts);
  const span = max - min || 1;
  const step = w / (pts.length - 1);
  const path = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`).join(' ');
  const up = pts[pts.length - 1] >= pts[0];
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <path d={path} fill="none" stroke={up ? 'var(--green)' : 'var(--red)'} strokeWidth="1.5" />
    </svg>
  );
}


const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString('ko-KR') : '—');
const fmtSpan = (ms) => {
  if (!ms) return '—';
  const h = ms / 3_600_000;
  return h < 24 ? `${h.toFixed(1)}시간` : `${(h / 24).toFixed(1)}일`;
};
const CONF_LABEL = { high: '높음(7일+ 관측)', medium: '보통(1일+ 관측)', low: '낮음(관측 짧음)' };

/**
 * DB 상세 패널(v2.378) — "이 DB 가 무엇을 보관하는가"를 구체적으로 보여준다.
 * 서버 detail(보관내용·writer·보존정책·주의)과, 정합성 점검에서 얻은 테이블/행수/기간/스키마를 합쳐 표시.
 */
function DbDetailModal({ f, health, onClose, onCheck, checking }) {
  const d = f.detail;
  const h = health;   // inspectSqlite 결과(있으면)
  return (
    <Modal title={`DB 상세 — ${f.file}`} onClose={onClose} width={900} resizable minWidth={560} minHeight={400}>
      <div className="flex gap wrap" style={{ marginBottom: 12 }}>
        <Card label="크기" value={fmtBytes(f.sizeBytes)} meta={f.type === 'sqlite' ? 'WAL/SHM 합산' : ''} />
        <Card label="증가/일(추정)" value={f.trend?.perDayBytes ? `${f.trend.perDayBytes > 0 ? '+' : ''}${fmtBytes(f.trend.perDayBytes)}` : '—'} meta={`관측 ${fmtSpan(f.trend?.spanMs)}`} />
        <Card label="1년 후(추정)" value={f.trend?.forecast?.available ? fmtBytes(f.trend.forecast.in1y) : '—'} meta={f.trend?.forecast?.available ? `신뢰도 ${CONF_LABEL[f.trend.forecast.confidence] || '—'}` : (f.trend?.forecast?.reason || '표본 부족')} />
      </div>

      <div className="card" style={{ padding: 14, marginBottom: 12 }}>
        <b style={{ fontSize: 13 }}>보관하는 데이터</b>
        <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.75 }}>{d?.keeps || f.purpose}</div>
        {d && (
          <div className="muted" style={{ fontSize: 12.5, marginTop: 10, lineHeight: 1.8 }}>
            <div>· <b>기록 주체</b>: {d.writer}</div>
            <div>· <b>보존 정책</b>: {d.retention}</div>
            {d.note ? <div>· <b>주의</b>: {d.note}</div> : null}
          </div>
        )}
        <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}><code>{f.path}</code></div>
      </div>

      {f.type === 'sqlite' && (
        <div className="card" style={{ padding: 14 }}>
          <div className="flex between wrap" style={{ alignItems: 'center', marginBottom: 8 }}>
            <b style={{ fontSize: 13 }}>스키마 · 행 수 · 데이터 기간</b>
            <button className="tab" style={{ padding: '5px 12px' }} disabled={checking} onClick={() => onCheck(f.file)}>
              {checking ? '점검 중…' : (h ? '↻ 다시 점검' : '🔍 이 DB 점검')}
            </button>
          </div>
          {!h ? (
            <div className="muted" style={{ fontSize: 12.5 }}>‘이 DB 점검’을 누르면 테이블·행 수·데이터 기간·인덱스·정합성을 읽기 전용으로 조회합니다.</div>
          ) : h.error ? <ErrorBox message={h.error} /> : (
            <>
              <div className="flex gap wrap" style={{ fontSize: 12.5, marginBottom: 8 }}>
                <span className={`badge ${h.checks?.integrity?.ok ? 'green' : 'red'}`}>정합성 {h.checks?.integrity?.ok ? '정상' : '이상'}</span>
                <span className={`badge ${h.checks?.foreignKeys?.ok ? 'green' : 'red'}`}>FK {h.checks?.foreignKeys?.detail || '—'}</span>
                <span className="badge blue">저널 {h.pragmas?.journalMode || '—'}</span>
                <span className={`badge ${(h.pragmas?.fragmentationPct || 0) >= 25 ? 'amber' : 'gray'}`}>빈 페이지 {h.pragmas?.fragmentationPct ?? 0}%</span>
              </div>
              {h.warnings?.length > 0 && (
                <ul className="muted" style={{ fontSize: 12.5, margin: '0 0 10px 18px', lineHeight: 1.7 }}>
                  {h.warnings.map((w, i) => <li key={i} style={{ color: 'var(--amber)' }}>{w}</li>)}
                </ul>
              )}
              {h.skipped?.length > 0 && (
                <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{h.skipped.join(' · ')}</div>
              )}
              <div className="table-wrap" style={{ maxHeight: 260 }}>
                <table>
                  <thead><tr><th>테이블</th><th style={{ textAlign: 'right' }}>행 수</th><th style={{ textAlign: 'right' }}>인덱스</th><th>데이터 기간</th></tr></thead>
                  <tbody>
                    {(h.tables || []).map((t) => (
                      <tr key={t.name}>
                        <td><b>{t.name}</b><div className="muted" style={{ fontSize: 11 }}>{(t.columns || []).join(', ')}</div></td>
                        <td style={{ textAlign: 'right' }}>{t.rowCount == null ? <span className="muted">—</span> : t.rowCount.toLocaleString()}</td>
                        <td style={{ textAlign: 'right' }}>{t.indexCount}</td>
                        <td className="muted" style={{ fontSize: 12 }}>
                          {t.range ? <>{fmtDate(t.range.firstTs)} ~ {fmtDate(t.range.lastTs)}</> : '—'}
                        </td>
                      </tr>
                    ))}
                    {(h.tables || []).length === 0 && <tr><td colSpan={4} className="muted" style={{ padding: 12 }}>테이블 없음</td></tr>}
                  </tbody>
                </table>
              </div>
              <details style={{ marginTop: 10 }}>
                <summary className="muted" style={{ fontSize: 12, cursor: 'pointer' }}>스키마(DDL) 보기</summary>
                <pre style={{ fontSize: 11, overflow: 'auto', maxHeight: 240, background: 'var(--panel-2)', padding: 10, borderRadius: 6 }}>
                  {(h.tables || []).map((t) => t.sql).filter(Boolean).join(';\n\n')}
                </pre>
              </details>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

/** 정합성 점검 결과 요약 표(v2.378). */
function HealthPanel({ report, busy, onRun }) {
  return (
    <div className="card" style={{ padding: 14, marginTop: 14 }}>
      <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 8 }}>
        <b style={{ fontSize: 14 }}>DB 정합성·일관성 점검</b>
        <div className="flex gap">
          <button className="logout-btn" style={{ flex: 'none', padding: '6px 12px', fontSize: 12 }} disabled={busy} onClick={() => onRun(false)}>
            {busy ? '점검 중…' : '빠른 점검(quick_check)'}
          </button>
          <button className="tab" style={{ padding: '6px 12px', fontSize: 12 }} disabled={busy} onClick={() => onRun(true)}>
            전체 점검(integrity_check)
          </button>
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.7 }}>
        SQLite 파일을 <b>읽기 전용</b>으로 열어 손상·FK 위반·저널 설정·단편화를 확인합니다(데이터를 변경하지 않아 서비스 중단이 필요 없습니다).
        전체 점검은 모든 페이지를 읽으므로 대용량 DB 에서 <b>수 초 이상</b> 걸릴 수 있습니다.
      </div>
      {!report ? <div className="muted" style={{ fontSize: 12.5 }}>아직 점검하지 않았습니다.</div> : (
        <>
          <div className="flex gap wrap" style={{ marginBottom: 10 }}>
            <Card label="점검 DB" value={report.count} meta={report.mode === 'full' ? '전체 점검' : '빠른 점검'} />
            <Card label="정상" value={report.okCount} accent="var(--green)" />
            <Card label="이상" value={report.failCount} accent={report.failCount ? 'var(--red)' : undefined} />
            <Card label="경고" value={report.warningCount} accent={report.warningCount ? 'var(--amber)' : undefined} />
          </div>
          <div className="table-wrap" style={{ maxHeight: 320 }}>
            <table>
              <thead><tr><th>DB</th><th>정합성</th><th>FK</th><th>저널</th><th style={{ textAlign: 'right' }}>빈 페이지</th><th>경고</th></tr></thead>
              <tbody>
                {(report.results || []).map((r) => (
                  <tr key={r.path}>
                    <td><b>{r.file}</b></td>
                    <td>{r.error ? <span className="badge red">오류</span>
                      : <span className={`badge ${r.checks?.integrity?.ok ? 'green' : 'red'}`}>{r.checks?.integrity?.ok ? 'ok' : String(r.checks?.integrity?.detail || '이상').slice(0, 40)}</span>}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{r.checks?.foreignKeys?.detail || '—'}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{r.pragmas?.journalMode || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{r.pragmas?.fragmentationPct != null ? `${r.pragmas.fragmentationPct}%` : '—'}</td>
                    <td style={{ fontSize: 12, color: r.warnings?.length ? 'var(--amber)' : undefined }}>
                      {r.error ? r.error : (r.warnings?.length ? r.warnings.join(' · ') : '없음')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/** 포탈 DB — 포탈이 사용하는 모든 데이터 파일(SQLite·JSON·ndjson)의 경로·용도·크기·증가 추이. */
export function PortalDb() {
  const { data, error } = usePolling('/admin/portal-db', {}, 30_000);
  // ⚠ 훅은 전부 조기 return 위에서 선언한다(CLAUDE.md — 조기 return 뒤에 두면 렌더 간 훅
  // 개수가 달라져 React #310 으로 화면이 크래시한다. v2.375 에서 실제 발생).
  const [sel, setSel] = useState(null);            // 상세 모달 대상 파일
  const [health, setHealth] = useState(null);      // 전체 점검 리포트
  const [oneHealth, setOneHealth] = useState({});  // 파일별 점검 결과 { file: result }
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);

  const runHealth = async (full) => {
    setBusy(true);
    try { setHealth(await fetchJson('/admin/portal-db/health', full ? { mode: 'full' } : {})); }
    catch (e) { setHealth({ count: 0, okCount: 0, failCount: 0, warningCount: 0, results: [], _err: e.message }); }
    finally { setBusy(false); }
  };
  const checkOne = async (file) => {
    setChecking(true);
    try {
      const r = await fetchJson('/admin/portal-db/health', { file, mode: 'full' });
      setOneHealth((cur) => ({ ...cur, [file]: (r.results || [])[0] || { error: '결과 없음' } }));
    } catch (e) { setOneHealth((cur) => ({ ...cur, [file]: { error: e.message } })); }
    finally { setChecking(false); }
  };

  // 데이터 보유 중 일시 폴링 오류 1회로 화면 전체를 오류 박스로 갈아치우지 않는다(CLAUDE.md
  // 회귀 방지) — 데이터가 없을 때만 전체 오류, 있으면 아래 배너로만 알린다.
  if (error && !data) return <ErrorBox message={error} />;
  if (!data) return <Loading />;
  const files = data.files || [];
  const existing = files.filter((f) => f.exists);
  const sqliteN = existing.filter((f) => f.type === 'sqlite').length;
  const cols = [
    { key: 'file', label: '파일명', render: (f) => <b style={{ opacity: f.exists ? 1 : 0.5 }}>{f.file}</b> },
    { key: 'type', label: '종류', sortValue: (f) => f.type, render: (f) => <span className={`badge ${DB_TYPE_BADGE[f.type] || 'gray'}`}>{DB_TYPE_LABEL[f.type] || f.type}</span> },
    { key: 'purpose', label: '용도', render: (f) => <span style={{ fontSize: 13 }}>{f.purpose}</span> },
    { key: 'sizeBytes', label: '크기', align: 'right', sortValue: (f) => f.sizeBytes || -1, render: (f) => (f.exists ? <span>{fmtBytes(f.sizeBytes)}</span> : <span className="badge gray">미생성</span>) },
    { key: 'growth', label: '증가/일(추정)', align: 'right', sortValue: (f) => f.trend?.perDayBytes || 0, render: (f) => {
      const g = f.trend?.perDayBytes || 0;
      if (!f.exists || (f.trend?.samples?.length || 0) < 2) return <span className="muted">—</span>;
      if (g === 0) return <span className="muted">변화 없음</span>;
      return <span style={{ color: g > 0 ? 'var(--green)' : 'var(--red)' }}>{g > 0 ? '+' : ''}{fmtBytes(g)}/일</span>;
    } },
    { key: 'trend', label: '추이', render: (f) => <Sparkline samples={f.trend?.samples} /> },
    { key: 'forecast', label: '1년 후(추정)', align: 'right', sortValue: (f) => (f.trend?.forecast?.available ? f.trend.forecast.in1y : -1), render: (f) => {
      const fc = f.trend?.forecast;
      if (!f.exists) return <span className="muted">—</span>;
      if (!fc?.available) return <span className="muted" title={fc?.reason || '표본 부족'}>—</span>;
      return <span title={`1개월 ${fmtBytes(fc.in1m)} · 6개월 ${fmtBytes(fc.in6m)} · 신뢰도 ${CONF_LABEL[fc.confidence] || '—'}`}>{fmtBytes(fc.in1y)}</span>;
    } },
    { key: 'detail', label: '상세', render: (f) => (
      <button className="cell-link" onClick={() => setSel(f)} title="보관 데이터·스키마·행 수·데이터 기간·정합성">🔍 보기</button>
    ) },
    { key: 'path', label: '경로', render: (f) => <code style={{ fontSize: 11, color: 'var(--muted)' }}>{f.path}</code> },
  ];
  return (
    <>
      {error && <div className="badge amber" style={{ marginBottom: 10, display: 'inline-block' }}>업데이트 실패(이전 데이터 표시 중): {String(error)}</div>}
      <div className="flex gap wrap" style={{ marginBottom: 14 }}>
        <Card label="데이터 파일" value={existing.length} meta={`정의 ${files.length}개`} />
        <Card label="SQLite DB" value={sqliteN} accent="var(--blue,#2563eb)" />
        <Card label="총 용량" value={fmtBytes(data.totalBytes)} accent="var(--green)" />
        <Card label="설정 디렉터리" value={<code style={{ fontSize: 12 }}>{data.configDir}</code>} meta={`추이 샘플 ${Math.round((data.sampleIntervalMs || 0) / 60000)}분 간격`} />
        {/* 용량 예측(v2.378) — 관측 구간의 일 증가량을 선형 연장한 추정. 표본이 짧으면 표시하지 않는다. */}
        <Card label="1개월 후(추정)" value={data.totalForecast?.available ? fmtBytes(data.totalForecast.in1m) : '—'}
          meta={data.totalForecast?.available ? `일 증가 ${data.perDayTotalBytes > 0 ? '+' : ''}${fmtBytes(data.perDayTotalBytes)}` : (data.totalForecast?.reason || '표본 부족')} />
        <Card label="6개월 후(추정)" value={data.totalForecast?.available ? fmtBytes(data.totalForecast.in6m) : '—'} />
        <Card label="1년 후(추정)" value={data.totalForecast?.available ? fmtBytes(data.totalForecast.in1y) : '—'}
          meta={data.totalForecast?.available ? `신뢰도 ${CONF_LABEL[data.totalForecast.confidence] || '—'}` : ''}
          accent={data.totalForecast?.available && data.disk && data.totalForecast.in1y > data.disk.freeBytes ? 'var(--red)' : undefined} />
        {data.disk && (
          <Card label="디스크 여유" value={fmtBytes(data.disk.freeBytes)}
            meta={data.daysUntilFull != null ? `현 증가율 유지 시 약 ${data.daysUntilFull.toLocaleString()}일 후 소진` : '증가 없음/표본 부족'}
            accent={data.daysUntilFull != null && data.daysUntilFull < 180 ? 'var(--amber)' : undefined} />
        )}
      </div>
      <DataTable columns={cols} rows={files} initialSort={{ key: 'sizeBytes', dir: 'desc' }} />
      <div className="muted" style={{ marginTop: 10, fontSize: 12, lineHeight: 1.7 }}>
        · <b>증가 추이</b>는 서버 기동 후 {Math.round((data.sampleIntervalMs || 0) / 60000)}분 간격으로 측정한 크기 표본으로 추정합니다(재시작 시 표본 초기화).
        · SQLite는 <code>-wal</code>/<code>-shm</code> 사이드카 크기를 합산해 표시합니다.
        · <code>미생성</code>은 해당 기능을 아직 쓰지 않아 파일이 만들어지지 않은 상태입니다.
        · <b>용량 예측</b>은 관측 구간의 일 증가량을 그대로 연장한 <b>단순 선형 추정</b>입니다(관측 1시간 미만이면 표시하지 않습니다). 수집 주기·보존기간·vCenter 수가 바뀌면 실제와 달라집니다.
      </div>

      {/* DB 정합성·일관성 점검(v2.378) — 읽기 전용이라 서비스 중단 불필요 */}
      <HealthPanel report={health} busy={busy} onRun={runHealth} />
      {health?._err && <div className="badge red" style={{ marginTop: 8, display: 'inline-block' }}>점검 실패: {health._err}</div>}

      {sel && (
        <DbDetailModal f={sel} health={oneHealth[sel.file]} checking={checking}
          onCheck={checkOne} onClose={() => setSel(null)} />
      )}
    </>
  );
}
