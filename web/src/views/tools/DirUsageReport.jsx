import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson, postJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';

/**
 * 특수 기능 › 폴더 사용량 Top-N (v2.454, admin 전용).
 *
 * 설정(설정 › 폴더 사용량 리포트)에서 등록한 대상의 수집 결과를 본다. 메일로 나가는 것과
 * **같은 데이터**이며, 여기서는 정렬·이력 비교가 가능하다.
 *
 * 집계 단위는 하위 폴더 이름이다(`/mnt/share/hong` → 사용자 `hong`).
 * ⚠️ 훅은 전부 최상단 — 조기 return 뒤 useState 는 React #310 크래시를 만든다.
 */
export function DirUsageReport() {
  const [d, setD] = useState(null);          // { settings, status, latest, agents }
  const [err, setErr] = useState(null);
  const [sel, setSel] = useState('');        // 선택한 대상 id
  const [detail, setDetail] = useState(null); // { scan, prev }
  const [history, setHistory] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = async () => {
    try { setD(await fetchJson('/admin/dir-usage')); setErr(null); }
    catch (e) { setErr(e.message); }
  };
  useEffect(() => { load(); const t = setInterval(load, 20_000); return () => clearInterval(t); }, []);

  // 대상이 정해지면 최신 스캔 + 이력을 가져온다.
  useEffect(() => {
    if (!sel) { setDetail(null); setHistory([]); return; }
    let alive = true;
    (async () => {
      try {
        const h = await fetchJson(`/admin/dir-usage/history/${encodeURIComponent(sel)}`, { limit: 30 });
        if (!alive) return;
        setHistory(h.scans || []);
        const newest = (h.scans || [])[0];
        if (newest) {
          const one = await fetchJson(`/admin/dir-usage/scan/${newest.id}`);
          if (alive) setDetail(one);
        } else setDetail(null);
      } catch (e) { if (alive) setErr(e.message); }
    })();
    return () => { alive = false; };
  }, [sel]);

  const targets = d?.settings?.targets || [];
  // 첫 로드에서 대상이 하나뿐이면 자동 선택(클릭 한 번을 아낀다).
  useEffect(() => { if (!sel && targets.length) setSel(targets[0].id); }, [targets.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => {
    const scan = detail?.scan;
    if (!scan) return [];
    const prevMap = new Map((detail?.prev?.entries || []).map((e) => [e.name, e.bytes]));
    const hasPrev = (detail?.prev?.entries || []).length > 0;
    const denom = scan.total_bytes || scan.sum_bytes || 0;
    return (scan.entries || []).map((e, i) => {
      const p = prevMap.get(e.name);
      return {
        rank: i + 1,
        name: e.name,
        bytes: e.bytes,
        pct: denom > 0 ? Math.round((e.bytes / denom) * 1000) / 10 : null,
        // 기준선 원칙: 직전 관측이 없으면 증감을 만들지 않는다(0 으로 채우지 않는다).
        delta: !hasPrev ? null : (p == null ? null : e.bytes - p),
        isNew: hasPrev && p == null,
      };
    });
  }, [detail]);

  const runNow = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/admin/dir-usage/run', { targetId: sel });
      setMsg(r.ok ? r.queued.map((q) => `${q.path}: ${q.state}`).join(' · ') : `오류: ${r.reason}`);
    } catch (e) { setMsg(`오류: ${e.message}`); }
    finally { setBusy(false); }
  };

  if (err && !d) return <ErrorBox message={err} />;
  if (!d) return <Loading />;

  const scan = detail?.scan;
  const target = targets.find((t) => t.id === sel);

  return (
    <div className="card" style={{ padding: 16 }}>
      <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
        <h3 style={{ margin: 0 }}>폴더 사용량 Top-N</h3>
        {targets.length > 0 && (
          <select className="input" style={{ width: 280 }} value={sel} onChange={(e) => setSel(e.target.value)}>
            {targets.map((t) => <option key={t.id} value={t.id}>{t.label ? `${t.label} — ` : ''}{t.agent} : {t.path}</option>)}
          </select>
        )}
        {sel && <button className="logout-btn" style={{ padding: '4px 12px', fontSize: 12 }} disabled={busy} onClick={runNow}>지금 스캔</button>}
      </div>
      <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.7, marginTop: 4 }}>
        하위 폴더 이름을 사용자로 보고 사용량을 집계합니다. 대상·주기·메일 수신자는
        <b> 설정 › 폴더 사용량 리포트</b> 에서 지정합니다.
      </p>
      {err && <div className="muted" style={{ color: '#f0a', fontSize: 12, marginBottom: 8 }}>폴링 오류: {err}</div>}
      {msg && <div className="muted" style={{ fontSize: 12.5, marginBottom: 8, color: msg.startsWith('오류') ? '#f0a' : undefined }}>{msg}</div>}

      {targets.length === 0 && (
        <div className="muted" style={{ fontSize: 13, padding: '18px 0' }}>
          등록된 대상이 없습니다 — <b>설정 › 폴더 사용량 리포트</b> 에서 엣지와 경로를 먼저 추가하세요.
        </div>
      )}

      {targets.length > 0 && !scan && (
        <div className="muted" style={{ fontSize: 13, padding: '18px 0' }}>
          아직 수집 결과가 없습니다. '지금 스캔'을 누르거나 설정한 주기를 기다리세요.
          {target && <> (엣지 <b>{target.agent}</b> 의 RMA 가 온라인이어야 합니다)</>}
        </div>
      )}

      {scan && (
        <>
          <div className="flex gap" style={{ flexWrap: 'wrap', gap: 18, margin: '10px 0 14px', fontSize: 12.5 }}>
            <Stat label="전체 사용량" value={human(scan.total_bytes ?? scan.sum_bytes)} />
            <Stat label="하위 폴더" value={`${scan.count}개`} />
            <Stat label="상위 합계" value={human((scan.entries || []).reduce((s, e) => s + e.bytes, 0))} />
            <Stat label="수집 시각" value={new Date(scan.ts).toLocaleString()} />
            {detail?.prev && <Stat label="직전 수집" value={new Date(detail.prev.ts).toLocaleString()} />}
          </div>

          {(scan.skipped > 0 || scan.truncated) && (
            <div className="muted" style={{ fontSize: 12, marginBottom: 10, color: '#fb0' }}>
              {scan.skipped > 0 && `⚠ 해석하지 못한 줄 ${scan.skipped}개(권한 없는 폴더이거나 이름에 개행이 있는 경우) — 그만큼 합계에서 빠집니다. `}
              {scan.truncated && '⚠ 하위 폴더가 매우 많아 일부만 집계했습니다.'}
            </div>
          )}

          <STable minWidth={720} style={{ width: '100%', fontSize: 12.5 }}>
            <thead>
              <tr>
                <th>#</th><th>폴더(사용자)</th><th>사용량</th><th>비율</th><th data-nosort>분포</th><th>증감</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name}>
                  <td data-sort={r.rank} className="muted">{r.rank}</td>
                  <td style={{ wordBreak: 'break-all' }}>{r.name}</td>
                  <td data-sort={r.bytes} style={{ textAlign: 'right', fontWeight: 600 }}>{human(r.bytes)}</td>
                  <td data-sort={r.pct ?? -1} style={{ textAlign: 'right' }} className="muted">{r.pct == null ? '—' : `${r.pct}%`}</td>
                  <td>
                    <div style={{ height: 8, width: 90, background: 'rgba(255,255,255,.08)', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${Math.max(1, r.pct || 0)}%`, background: '#2e90fa' }} />
                    </div>
                  </td>
                  <td data-sort={r.delta ?? 0} style={{ textAlign: 'right', color: r.isNew ? '#a78bfa' : r.delta > 0 ? '#f97066' : r.delta < 0 ? '#32d583' : undefined }}>
                    {r.isNew ? '신규' : r.delta == null ? '—' : `${r.delta > 0 ? '+' : ''}${human(r.delta)}`}
                  </td>
                </tr>
              ))}
              {scan.others_count > 0 && (
                <tr>
                  <td className="muted">·</td>
                  <td className="muted">그 외 {scan.others_count}개 폴더</td>
                  <td data-sort={scan.others_bytes} style={{ textAlign: 'right' }} className="muted">{human(scan.others_bytes)}</td>
                  <td colSpan={3} />
                </tr>
              )}
            </tbody>
          </STable>

          {history.length > 1 && (
            <>
              <h4 style={{ margin: '20px 0 8px', fontSize: 14 }}>수집 이력</h4>
              <STable style={{ width: '100%', fontSize: 12.5 }}>
                <thead><tr><th>수집 시각</th><th>전체 사용량</th><th>하위 폴더</th><th>메일</th><th data-nosort></th></tr></thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td data-sort={h.ts}>{new Date(h.ts).toLocaleString()}</td>
                      <td data-sort={h.total_bytes ?? h.sum_bytes} style={{ textAlign: 'right' }}>{human(h.total_bytes ?? h.sum_bytes)}</td>
                      <td data-sort={h.count} style={{ textAlign: 'right' }}>{h.count}개</td>
                      <td className="muted">{h.mailed === 1 ? `발송(${h.mail_note || ''})` : h.mailed === 2 ? `실패: ${h.mail_note || ''}` : h.mail_note || '—'}</td>
                      <td>
                        <button className="logout-btn" style={{ padding: '2px 8px', fontSize: 11 }}
                          onClick={() => fetchJson(`/admin/dir-usage/scan/${h.id}`).then(setDetail).catch((e) => setErr(e.message))}>보기</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </STable>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 11.5 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

/** 서버 scan.js humanBytes 와 같은 표기 — 화면과 메일의 숫자가 어긋나지 않게 규칙을 맞춘다. */
function human(b) {
  if (b == null || !Number.isFinite(Number(b))) return '—';
  const neg = b < 0;
  let v = Math.abs(Number(b));
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  const s = i === 0 ? String(Math.round(v)) : v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2);
  return `${neg ? '-' : ''}${s} ${u[i]}`;
}
