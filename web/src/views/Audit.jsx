import React, { useEffect, useState } from 'react';
import { fetchJson } from '../api.js';
import { Loading, ErrorBox, SearchBox } from '../components/ui.jsx';
import { STable } from '../components/STable.jsx';

/** 설정 → 감사 로그: 누가 언제 무엇을 했는지(쓰기/로그인) 기록 조회. */
export default function Audit() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [user, setUser] = useState('');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(100);

  const load = () => {
    const p = new URLSearchParams({ limit: String(limit) });
    if (user) p.set('user', user);
    if (q) p.set('q', q);
    fetchJson(`/admin/audit?${p.toString()}`).then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [user, q, limit]);

  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  return (
    <>
      <div className="section-title" style={{ margin: '6px 0' }}>감사 로그 (Audit)</div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>VM 생성·원격접속·설정 변경·로그인 등 쓰기/인증 행위를 기록합니다. (서버 <code>$CONFIG_DIR/audit.ndjson</code>)</div>
      <div className="flex gap wrap" style={{ marginBottom: 8, alignItems: 'center' }}>
        <select className="select" style={{ maxWidth: 200 }} value={user} onChange={(e) => setUser(e.target.value)}>
          <option value="">전체 사용자</option>
          {(data.users || []).map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
        <SearchBox className="input" style={{ maxWidth: 260 }} placeholder="작업/대상 검색" value={q} onChange={setQ} />
        <span className="muted" style={{ fontSize: 12 }}>{data.total}건</span>
      </div>
      <div className="table-wrap" style={{ maxHeight: '60vh' }}>
        <STable>
          <thead><tr><th>시각</th><th>사용자</th><th>작업</th><th>대상</th><th>IP</th></tr></thead>
          <tbody>
            {data.items.length === 0 && <tr><td colSpan={5} className="center muted" style={{ padding: 22 }}>기록이 없습니다.</td></tr>}
            {data.items.map((e, i) => (
              <tr key={i}>
                <td className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{new Date(e.at).toLocaleString()}</td>
                <td><b>{e.user}</b></td>
                {/* ⚠ `action` 이 빈 줄은 v2.568 이전 `logAudit(req, …)` 오용으로 **기록 자체가 소실**된 것이다.
                    빈칸으로 두면 화면 결함처럼 읽히므로 소실 사실을 말한다 — 값을 지어내지 않는다. */}
                <td>
                  {e.action
                    ? (/실패|거부/.test(e.action) ? <span className="badge red">{e.action}</span> : e.action)
                    : <span className="muted" title="이 줄은 작업 이름이 기록되지 않았습니다(v2.568 이전 기록 결함). 사용자·시각·IP 는 유효합니다.">작업 미기록</span>}
                  {e.detail ? <span className="muted" style={{ fontSize: 11 }}> · {e.detail}</span> : ''}
                </td>
                <td className="muted" style={{ fontSize: 12 }}>{e.target || '—'}</td>
                <td className="muted" style={{ fontSize: 12 }}>{e.ip || '—'}</td>
              </tr>
            ))}
          </tbody>
        </STable>
      </div>
      {data.total > data.items.length && (
        <div style={{ marginTop: 8, textAlign: 'center' }}>
          <button className="logout-btn" style={{ padding: '8px 18px' }} onClick={() => setLimit((l) => l + 200)}>더 보기 ({data.items.length}/{data.total})</button>
        </div>
      )}
    </>
  );
}
