import React, { useEffect, useState } from 'react';
import { fetchJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';

/**
 * 성능점검 로그 분석 — CSV 로그를 기간·버킷(시간/일/주/월/분기/반기/연간)으로 집계해 본다.
 *
 * 원천은 화면 결과(인메모리 최신 1건)가 아니라 **CSV 로그 파일**이다 — 과거 기록은 로그에만
 * 있다. 일 2GB 규모라 서버가 스트리밍으로 읽고 행 수·시간 예산을 지키며, 예산에 걸리면
 * 어디까지 봤는지(truncated)를 그대로 보여준다. 조용히 자른 결과를 완전한 것처럼 보여주지
 * 않는다.
 */

const BUCKETS = [
  ['hour', '시간별'], ['day', '일별'], ['week', '주별'], ['month', '월별'],
  ['quarter', '분기별'], ['half', '반기별'], ['year', '연간'],
];

/** 기간 프리셋 — from 계산. */
const RANGES = [
  ['24h', '최근 24시간', 24 * 3600e3],
  ['7d', '최근 7일', 7 * 86400e3],
  ['30d', '최근 30일', 30 * 86400e3],
  ['90d', '최근 분기', 91 * 86400e3],
  ['180d', '최근 반기', 182 * 86400e3],
  ['365d', '최근 1년', 365 * 86400e3],
];

const pct = (n, d) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—');

export default function AnalyzeTab() {
  const [form, setForm] = useState({ range: '7d', bucket: 'day', path: '', target: '', test: '', type: '' });
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [windows, setWindows] = useState(null);

  useEffect(() => {
    // 조회 가능 범위(로그 파일 목록) — 사용자가 없는 기간을 헛조회하지 않게 먼저 보여준다.
    fetchJson('/svcmon/log/windows').then(setWindows).catch(() => setWindows(null));
  }, []);

  const run = async () => {
    setBusy(true); setErr('');
    try {
      const spanMs = (RANGES.find(([k]) => k === form.range) || RANGES[1])[2];
      const r = await fetchJson('/svcmon/log/analyze', {
        from: Date.now() - spanMs, to: Date.now(), bucket: form.bucket,
        path: form.path.trim(), target: form.target.trim(), test: form.test.trim(), type: form.type.trim(),
      });
      if (r.error) { setErr(r.error); return; }
      setData(r);
    } catch (e) { setErr(e.message); setData(null); } finally { setBusy(false); }
  };

  const buckets = data?.buckets || [];
  const maxRows = Math.max(1, ...buckets.map((b) => b.rows || 0));

  return (
    <div className="flex col gap">
      {err && <ErrorBox message={err} />}

      <div className="card" style={{ padding: 14 }}>
        <b>조회 조건</b>
        <div className="flex gap wrap" style={{ alignItems: 'flex-end', marginTop: 10 }}>
          <label className="flex col" style={{ gap: 4 }}>
            <span className="muted" style={{ fontSize: 11 }}>기간</span>
            <select className="select" value={form.range} onChange={(e) => setForm({ ...form, range: e.target.value })}>
              {RANGES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </label>
          <label className="flex col" style={{ gap: 4 }}>
            <span className="muted" style={{ fontSize: 11 }}>묶음 단위</span>
            <select className="select" value={form.bucket} onChange={(e) => setForm({ ...form, bucket: e.target.value })}>
              {BUCKETS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </label>
          <label className="flex col" style={{ gap: 4, minWidth: 180 }}>
            <span className="muted" style={{ fontSize: 11 }}>경로 (앞부분 일치)</span>
            <input className="input" value={form.path} onChange={(e) => setForm({ ...form, path: e.target.value })} placeholder={'예: A.Infra\\OC2'} />
          </label>
          <label className="flex col" style={{ gap: 4, minWidth: 140 }}>
            <span className="muted" style={{ fontSize: 11 }}>대상 이름</span>
            <input className="input" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} placeholder="정확 일치" />
          </label>
          <label className="flex col" style={{ gap: 4, minWidth: 140 }}>
            <span className="muted" style={{ fontSize: 11 }}>점검명</span>
            <input className="input" value={form.test} onChange={(e) => setForm({ ...form, test: e.target.value })} placeholder="정확 일치" />
          </label>
          <label className="flex col" style={{ gap: 4, width: 110 }}>
            <span className="muted" style={{ fontSize: 11 }}>유형</span>
            <input className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} placeholder="ping/tcp…" />
          </label>
          <button className="login-btn" disabled={busy} onClick={run}>{busy ? '집계 중…' : '조회'}</button>
        </div>
        {windows?.files?.length > 0 && (
          <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
            로그 보유: 파일 {windows.files.length}개
            {windows.from ? ` · ${new Date(windows.from).toLocaleDateString('ko-KR')} ~ ${new Date(windows.to).toLocaleDateString('ko-KR')}` : ''}
            {' '}— 이 범위 밖 기간은 조회해도 데이터가 없습니다.
          </div>
        )}
      </div>

      {busy && <Loading />}

      {data && !busy && (
        <>
          {data.truncated && (
            <div className="svc-warn">
              예산에 걸려 <b>일부만 집계</b>했습니다 — 스캔 {data.scannedRows?.toLocaleString()}행 ·
              소요 {data.elapsedMs}ms. 아래 수치는 완전한 합계가 아닙니다. 기간을 좁히거나
              필터(경로·대상)를 지정해 다시 조회하세요.
            </div>
          )}
          <div className="card" style={{ padding: 14 }}>
            <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 8 }}>
              <b>합계</b>
              <span className="muted" style={{ fontSize: 11 }}>
                파일 {data.files?.scanned}개 스캔 · {data.files?.skipped}개 기간 밖 제외 ·
                {data.scannedRows?.toLocaleString()}행 · {data.elapsedMs}ms
                {data.badRows ? ` · 형식 오류 ${data.badRows}행` : ''}
              </span>
            </div>
            <div className="flex gap wrap" style={{ fontSize: 13 }}>
              <span>기록 <b>{(data.totals?.rows || 0).toLocaleString()}</b></span>
              <span className="pc-ok">정상 {(data.totals?.ok || 0).toLocaleString()} ({pct(data.totals?.ok, data.totals?.rows)})</span>
              <span className="pc-warn">주의 {(data.totals?.warn || 0).toLocaleString()}</span>
              <span className="pc-bad">실패 {(data.totals?.bad || 0).toLocaleString()} ({pct(data.totals?.bad, data.totals?.rows)})</span>
              <span className="muted">평균 {data.totals?.avgMs != null ? `${Math.round(data.totals.avgMs)} ms` : '—'} · 최대 {data.totals?.maxMs ?? '—'} ms</span>
            </div>
          </div>

          <div className="card" style={{ padding: 14 }}>
            <b>구간별 ({buckets.length})</b>
            <div className="table-wrap" style={{ maxHeight: '52vh', marginTop: 8 }}>
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 120 }}>구간</th>
                    <th>분포</th>
                    <th style={{ width: 90, textAlign: 'right' }}>기록</th>
                    <th style={{ width: 80, textAlign: 'right' }}>정상</th>
                    <th style={{ width: 70, textAlign: 'right' }}>주의</th>
                    <th style={{ width: 70, textAlign: 'right' }}>실패</th>
                    <th style={{ width: 90, textAlign: 'right' }}>가용률</th>
                    <th style={{ width: 90, textAlign: 'right' }}>평균 ms</th>
                    <th style={{ width: 110, textAlign: 'right' }}>p95 ms{data.approx || buckets.some((b) => b.approx) ? ' (근사)' : ''}</th>
                  </tr>
                </thead>
                <tbody>
                  {buckets.length === 0 && <tr><td colSpan={9} className="center muted" style={{ padding: 22 }}>해당 기간에 기록이 없습니다.</td></tr>}
                  {buckets.map((b) => {
                    const okPct = b.rows ? (b.ok / b.rows) * 100 : 0;
                    const badPct = b.rows ? (b.bad / b.rows) * 100 : 0;
                    return (
                      <tr key={b.key}>
                        <td><code>{b.key}</code></td>
                        <td>
                          {/* 구간 크기(행 수) 대비 정상/실패 비율 막대 — 값은 옆 셀에 수치로 있다 */}
                          <div className="svc-anal-bar" title={`정상 ${okPct.toFixed(1)}% · 실패 ${badPct.toFixed(1)}%`}>
                            <i className="ok" style={{ width: `${(b.rows / maxRows) * okPct}%` }} />
                            <i className="bad" style={{ width: `${(b.rows / maxRows) * badPct}%` }} />
                          </div>
                        </td>
                        <td style={{ textAlign: 'right' }}>{(b.rows || 0).toLocaleString()}</td>
                        <td style={{ textAlign: 'right' }} className="pc-ok">{(b.ok || 0).toLocaleString()}</td>
                        <td style={{ textAlign: 'right' }} className="pc-warn">{(b.warn || 0).toLocaleString()}</td>
                        <td style={{ textAlign: 'right' }} className="pc-bad">{(b.bad || 0).toLocaleString()}</td>
                        <td style={{ textAlign: 'right' }}>{pct(b.ok, b.rows)}</td>
                        <td style={{ textAlign: 'right' }}>{b.avgMs != null ? Math.round(b.avgMs) : '—'}</td>
                        <td style={{ textAlign: 'right' }}>{b.p95Ms != null ? b.p95Ms : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              가용률 = 정상 ÷ 기록. '상태 변화만 기록' 모드 구간은 기록 자체가 전이 시점뿐이라
              이 비율이 실제 가용률과 다릅니다. p95 는 히스토그램 근사값입니다.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
