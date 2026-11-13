/**
 * 물리서버 폴더 — **엣지 포탈** 화면(v2.994 · 설계 docs/design/bm-folders §11 묶음 D · 결정 기본값).
 * 중앙 사본(그 엣지 법인 것만)을 읽기 전용으로 보이고, 값(사용률 · 전력 · 부품 장애)은 이 엣지의 지금 값이다(서버 값이 WAN 을 왕복하지 않는다).
 * 편집은 중앙 포탈에서 — 10분마다(또는 '지금 받기') 사본이 온다. 끊겨도 사본을 지우지 않고 나이를 보인다.
 */
import React, { useMemo, useState } from 'react';
import { postJson, canCsv, downloadFile } from '../../../api.js';
import { STable } from '../../../components/STable.jsx';
import { UsagePair, StatusDot } from './parts.jsx';
import { ageText, wattsText, csvNameOf, opErrorText } from '../bmFoldersText.js';
import { edgeFolderRows, edgeRowsOf, edgeCopyNote } from './edgeViewText.js';

export default function EdgeView({ d, reload }) {
  const [sel, setSel] = useState({ corp: '', path: '' });
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const now = Date.now();
  const tree = useMemo(() => edgeFolderRows(d.corps || [], d.servers || []), [d]);
  const rows = useMemo(() => edgeRowsOf(d.servers || [], sel, q), [d, sel, q]);
  const copyNote = edgeCopyNote(d, now);
  const pullNow = async () => {
    setBusy(true); setMsg(null);
    try { const r = await postJson('/tools/bm-folders/edge/pull', {}); setMsg({ ok: true, text: `사본을 받았습니다 — 법인 ${r.corps ?? 0} · 배치 ${r.place ?? 0}` }); reload(); }
    catch (e) { setMsg({ ok: false, text: `받지 못했습니다 — 지난 사본은 그대로입니다(${opErrorText(e)})` }); } finally { setBusy(false); }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div className="card" style={{ padding: '10px 14px', borderLeft: '3px solid var(--accent-2)' }}>
        <div className="flex wrap gap" style={{ alignItems: 'center' }}>
          <b>물리서버 폴더 — 중앙 사본(읽기 전용)</b>
          <span className="badge gray">엣지 포탈</span>
          <span className="muted" style={{ fontSize: 12 }}>{copyNote.text}</span>
          <span style={{ marginLeft: 'auto' }} className="flex wrap gap">
            {d.canPull ? <button type="button" className="logout-btn" style={{ flex: 'none', padding: '5px 12px', fontSize: 12 }} disabled={busy} onClick={pullNow}>{busy ? '받는 중…' : '지금 받기'}</button> : null}
            <button type="button" className="logout-btn" style={{ flex: 'none', padding: '5px 12px', fontSize: 12 }} onClick={() => reload()}>새로고침</button>
          </span>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          폴더 · 등록은 <b>중앙 포탈의 물리서버 폴더</b>에서 편집합니다 — 바꾸면 {Math.round((d.pull?.intervalMs || 600000) / 60000)}분 안에 이 엣지로 옵니다. 사용률 · 전력 · 부품 장애는 이 엣지가 지금 읽은 값입니다.
        </div>
        {/* 방금 누른 '지금 받기' 결과가 있으면 그것만(마지막 받기 실패 줄과 같은 내용을 두 번 말하지 않게 — Chromium 판독) */}
        {msg ? <div style={{ fontSize: 12, marginTop: 4, color: msg.ok ? 'var(--green)' : 'var(--amber)' }} role="status">{msg.text}</div>
          : copyNote.warn ? <div style={{ fontSize: 12, marginTop: 4, color: 'var(--amber)' }}>{copyNote.warn}</div> : null}
      </div>
      {d.usageOff ? <div className="bmf-offbar" role="status"><b>이 엣지의 베어메탈 사용률 수집이 꺼져 있습니다</b> — CPU · 메모리가 비어 있는 이유입니다(중앙 설정 › 베어메탈 사용률에서 이 엣지 법인을 켜면 다음 주기부터).</div> : null}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 260px) minmax(0, 1fr)', gap: 12 }} className="bmf-edge-grid">
        <div className="card" style={{ minWidth: 0, padding: 8 }}>
          <button type="button" className={`bmf-tn${!sel.corp ? ' on' : ''}`} onClick={() => setSel({ corp: '', path: '' })}>전체 <span className="muted">{(d.servers || []).length}</span></button>
          {!tree.length ? <div className="muted" style={{ padding: 8, fontSize: 12 }}>{d.copy ? '이 엣지 법인에 중앙 폴더가 없습니다.' : '사본을 아직 받지 않았습니다.'}</div> : null}
          {tree.map((c) => (
            <div key={c.vcenterId} style={{ marginTop: 6 }}>
              <button type="button" className={`bmf-tn${sel.corp === c.vcenterId && !sel.path ? ' on' : ''}`} onClick={() => setSel({ corp: c.vcenterId, path: '' })}><b>{c.name}</b> <span className="muted">{c.n}</span></button>
              {c.folders.map((f) => (
                <button key={f.path} type="button" className={`bmf-tn${sel.corp === c.vcenterId && sel.path === f.path ? ' on' : ''}`} style={{ paddingLeft: 10 + f.depth * 14 }} onClick={() => setSel({ corp: c.vcenterId, path: f.path })} title={f.service ? `서비스: ${f.service}` : undefined}>
                  {f.label} <span className="muted">{f.n}</span>{f.service ? <span className="badge blue" style={{ marginLeft: 4, fontSize: 10 }}>{f.service}</span> : null}
                </button>
              ))}
              {c.unplaced ? <button type="button" className={`bmf-tn${sel.corp === c.vcenterId && sel.path === '\u0000' ? ' on' : ''}`} style={{ paddingLeft: 10 }} onClick={() => setSel({ corp: c.vcenterId, path: '\u0000' })}>(미분류) <span className="muted">{c.unplaced}</span></button> : null}
            </div>
          ))}
        </div>
        <div className="card" style={{ minWidth: 0 }}>
          <div className="flex wrap gap" style={{ padding: '8px 14px', alignItems: 'center', borderBottom: '1px solid var(--border)' }}>
            <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="이 목록에서 거르기(이름 · 모델)" aria-label="목록 거르기" style={{ flex: '1 1 220px', minWidth: 0, maxWidth: 360 }} />
            <span className="muted" style={{ fontSize: 12 }}>{rows.length}대</span>
          </div>
          {!rows.length ? <div className="muted" style={{ padding: 16 }}>서버가 없습니다.</div> : (
            <STable className="table bmf-t" minWidth={640} limit={300}>
              <thead><tr><th>이름</th><th>폴더</th><th>모델</th><th title="CPU · 메모리 사용률">사용률</th><th>전력</th><th>부품 장애</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td data-sort={r.name}><span className="bmf-nm"><StatusDot tone={r.faults > 0 ? 'red' : r.cpu == null && r.mem == null ? 'none' : r.powered === false ? 'gray' : 'green'} />{r.name}{r.tmpKey ? <span className="badge gray" style={{ marginLeft: 4, fontSize: 10.5 }}>태그 없음</span> : null}</span></td>
                    <td data-sort={r.path || ''}>{r.path ? <span>{r.path.split('\\').join(' › ')}{r.place === 'rule' ? <span className="muted" style={{ fontSize: 11 }}> (자동 규칙)</span> : null}</span> : <span className="muted">(미분류)</span>}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{r.model || '—'}</td>
                    <td data-sort={r.cpu ?? ''}><UsagePair cpu={r.cpu} mem={r.mem} usrc={r.usrc} why={r.why} /></td>
                    <td data-sort={r.watts ?? ''}>{wattsText(r.watts)}</td>
                    <td data-sort={r.faults ?? ''}>{r.faults == null ? <span className="muted">모름</span> : r.faults ? <span className="badge red">{r.faults}</span> : 0}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
          )}
        </div>
      </div>
      {d.outsideCount ? (
        <div className="card" style={{ padding: '10px 14px' }}>
          <b>이 엣지 밖 등록 {d.outsideCount}대</b>
          <span className="muted" style={{ fontSize: 12, marginLeft: 6 }}>같은 법인 폴더에 등록됐지만 이 엣지가 수집하지 않는 서버(중앙 직접 · 수집 서버 · 다른 엣지) — 합계 · 평균에 넣지 않습니다.</span>
          {Array.isArray(d.outside) && d.outside.length ? (
            <div className="table-wrap" style={{ marginTop: 6, maxHeight: 260 }}>
              <STable className="table" minWidth={480} limit={200}>
                <thead><tr><th>이름</th><th>폴더</th><th>받는 길</th></tr></thead>
                <tbody>{d.outside.map((o, i) => <tr key={`${o.corp}|${o.path}|${o.name}|${i}`}><td>{o.name}</td><td>{o.path.split('\\').join(' › ')}</td><td className="muted">{o.via === 'collector' ? '수집 서버' : o.via === 'other-edge' ? '다른 엣지' : '중앙'}</td></tr>)}</tbody>
              </STable>
            </div>
          ) : null}
        </div>
      ) : null}
      {d.local && (d.local.folders || d.local.regs || d.local.error) ? (
        <div className="card muted" style={{ padding: '10px 14px', fontSize: 12 }}>
          {d.local.error ? '이 엣지에서 예전에 만든 폴더 저장소를 읽지 못했습니다(지우지 않았습니다).' : <>이 엣지에서 예전에 만든 폴더 {d.local.folders}개 · 등록 {d.local.regs}건이 남아 있습니다 — 지우지 않았고 쓰지도 않습니다(편집은 중앙 하나).</>}
          {canCsv() && !d.local.error ? <button type="button" className="logout-btn" style={{ flex: 'none', padding: '3px 10px', fontSize: 12, marginLeft: 8 }} onClick={() => downloadFile('/tools/bm-folders.csv', csvNameOf()).catch((e) => setMsg({ ok: false, text: opErrorText(e) }))}>예전 폴더 CSV</button> : null}
        </div>
      ) : null}
      <div className="muted" style={{ fontSize: 11.5 }}>값이 없는 칸은 '—' 아래 이유를 누르면 자세히 보입니다 · {d.copy ? `사본 ${ageText(d.copy.savedAt, now)} 받음` : '사본 없음'}</div>
    </div>
  );
}
