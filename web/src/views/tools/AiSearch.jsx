// AiSearch.jsx — SpecialTools.jsx(구 5,070줄)에서 분리(v2.282 대형 파일 분할). 본문은 원본 그대로 이동.
import React, { useState } from 'react';
import { postJson } from '../../api.js';
import { DataTable, ErrorBox, StateBadge, UsageCell } from '../../components/ui.jsx';


const AICOLS = {
  vm: [
    { key: 'name', label: '이름', render: (r) => <b>{r.name}</b> },
    { key: 'vcenterId', label: 'vCenter' },
    { key: 'powerState', label: '전원', render: (r) => <StateBadge state={r.powerState} /> },
    { key: 'guestOS', label: 'OS' },
    { key: 'cpuUsagePct', label: 'CPU', render: (r) => <UsageCell pct={r.cpuUsagePct} /> },
    { key: 'memUsagePct', label: '메모리', render: (r) => <UsageCell pct={r.memUsagePct} /> },
    { key: 'ip', label: 'IP', render: (r) => (r.ipAddresses?.length ? r.ipAddresses.join(', ') : (r.ipAddress || '—')) },
  ],
  host: [
    { key: 'name', label: '이름', render: (r) => <b>{r.name}</b> },
    { key: 'vcenterId', label: 'vCenter' },
    { key: 'connectionState', label: '상태', render: (r) => <StateBadge state={r.connectionState} /> },
    { key: 'cpuUsagePct', label: 'CPU', render: (r) => <UsageCell pct={r.cpuUsagePct} /> },
    { key: 'memUsagePct', label: '메모리', render: (r) => <UsageCell pct={r.memUsagePct} /> },
    { key: 'version', label: 'ESXi' },
    { key: 'model', label: '모델', render: (r) => `${r.vendor || ''} ${r.model || ''}`.trim() || '—' },
    { key: 'vmCount', label: 'VM', align: 'right' },
  ],
  datastore: [
    { key: 'name', label: '이름', render: (r) => <b>{r.name}</b> },
    { key: 'vcenterId', label: 'vCenter' },
    { key: 'type', label: '유형', render: (r) => <span className="badge blue">{r.type}</span> },
    { key: 'capacityGB', label: '용량(GB)', align: 'right' },
    { key: 'freeGB', label: '여유(GB)', align: 'right' },
    { key: 'usagePct', label: '사용률', render: (r) => <UsageCell pct={r.usagePct} /> },
  ],
  network: [
    { key: 'name', label: '이름', render: (r) => <b>{r.name}</b> },
    { key: 'vcenterId', label: 'vCenter' },
    { key: 'type', label: '유형' },
    { key: 'vlan', label: 'VLAN' },
  ],
};

const AI_EXAMPLES = ['북미 메모리 90% 넘는 호스트', '스냅샷 있는 꺼진 가상머신', 'CPU 80% 넘는 호스트', 'Dell 호스트', '점검 중인 호스트', '사용률 85% 넘는 데이터스토어'];

export function AiSearch() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const run = async (query) => {
    const text = (query ?? q).trim();
    if (!text) return;
    setQ(text); setBusy(true); setError(null);
    try { setRes(await postJson('/search/nl', { query: text })); }
    catch (e) { setError(e.message); setRes(null); }
    setBusy(false);
  };

  const cols = res ? (AICOLS[res.entity] || AICOLS.vm) : null;

  return (
    <>
      <div className="flex gap" style={{ marginBottom: 10 }}>
        <input className="input" style={{ flex: 1 }} value={q} autoFocus
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()}
          placeholder="예: 북미에서 메모리 90% 넘는 호스트, 스냅샷 있는 꺼진 VM" />
        <button className="login-btn" style={{ flex: 'none', padding: '9px 20px' }} disabled={busy || !q.trim()} onClick={() => run()}>{busy ? '검색 중…' : '검색'}</button>
      </div>
      <div className="flex gap wrap" style={{ marginBottom: 12 }}>
        {AI_EXAMPLES.map((ex) => <button key={ex} className="badge gray" style={{ cursor: 'pointer', fontSize: 12, padding: '4px 10px', border: 'none' }} onClick={() => run(ex)}>{ex}</button>)}
      </div>

      {error && <ErrorBox message={error} />}
      {res && (
        <>
          <div className="card" style={{ marginBottom: 12, padding: '10px 12px' }}>
            <div className="flex between wrap" style={{ alignItems: 'center' }}>
              <span style={{ fontSize: 13 }}><b>{res.summary}</b></span>
              <span className={`badge ${res.source === 'llm' ? 'green' : 'amber'}`} title={res.llmError || ''}>{res.source === 'llm' ? 'LLM 해석' : '규칙기반(폴백)'}</span>
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              해석: <b>{res.label || res.entity}</b>
              {(res.query?.filters || []).map((f, i) => <span key={i}> · {f.field} {f.op} {String(f.value)}</span>)}
              {res.query?.match === 'any' && <span> · (OR)</span>}
            </div>
            {res.llmError && <div className="muted" style={{ fontSize: 11, marginTop: 4, color: 'var(--amber)' }}>LLM 미사용/오류로 규칙기반 검색: {res.llmError}</div>}
          </div>
          <DataTable columns={cols} rows={res.results} />
        </>
      )}

      <div className="muted" style={{ fontSize: 12, marginTop: 12, lineHeight: 1.7 }}>
        로컬 LLM(Ollama)이 질문을 검색조건으로 해석하고, 실제 검색은 포탈 내부 데이터에서 수행됩니다(데이터 외부 유출 없음).
        LLM 미설정 시 규칙기반으로 동작합니다. 설정 → AI 검색에서 Ollama 주소/모델을 지정하세요.
      </div>
    </>
  );
}
