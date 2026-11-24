import React, { useCallback, useEffect, useRef, useState } from 'react';
import BoldText from '../../components/boldText.jsx';
import { fetchJson, postJson, delJson, getCurrentUser } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import { canCollect } from './cvpText.js';
import { NOTE, MONO, ROW, GRID1, Tiles, CvpSelect, Pill } from './CvpNetParts.jsx';
import { CHANGE_KIND, changeLabel, changeValue, naText, COMPARE_NOTE, bytesText, numText, TONE } from './cvpNetText.js';

/**
 * CVP › 작업 전후 비교(v3.38 ⑬). 스냅샷 = 그 시각 중앙 DB 최신값 복사(장비 접속 0). 찍기 · 지우기는 운영자 이상(서버가 다시 검사한다).
 * 목록은 마운트 1회 + 찍은 뒤 · 지운 뒤 다시. 비교는 버튼을 누를 때만(늦게 온 이전 응답은 버린다).
 */
const tsText = (ms) => { if (ms == null) return '—'; const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const STATE = { changed: ['바뀜', TONE.amber], removed: ['사라짐', TONE.red], added: ['새로 생김', TONE.blue], na: ['비교 못 함만', 'var(--text-dim)'] };

export default function CvpCompareView({ servers = [] }) {
  const mayWrite = canCollect(getCurrentUser());
  const [list, setList] = useState(null);
  const [listErr, setListErr] = useState(null);
  const [label, setLabel] = useState('');
  const [cvpId, setCvpId] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [writeErr, setWriteErr] = useState(null);
  const [a, setA] = useState('');
  const [b, setB] = useState('now');
  const [res, setRes] = useState(null);
  const [resErr, setResErr] = useState(null);
  const [cmpBusy, setCmpBusy] = useState(false);
  const [kind, setKind] = useState('all');
  const seq = useRef(0);
  const load = useCallback(() => {
    setListErr(null);
    fetchJson('/tools/cvp/snapshots').then((x) => {
      setList(x);
      const done = (x.snapshots || []).filter((s) => s.done);
      setA((cur) => (cur && done.some((s) => String(s.id) === cur) ? cur : done[0] ? String(done[0].id) : ''));
    }).catch((e) => setListErr(e));
  }, []);
  useEffect(() => { load(); }, [load]);
  const take = async () => {
    setBusy(true); setMsg(null); setWriteErr(null);
    try { const x = await postJson('/tools/cvp/snapshots', { label, ...(cvpId ? { cvpId } : {}) }); setMsg(`스냅샷 #${x.id} 저장 — 장비 ${x.devices}대 · ${bytesText(x.bytes)}${x.truncated ? ' · ⚠ 상한을 넘어 일부 장비만' : ''}`); setLabel(''); load(); }
    catch (e) { setWriteErr(e); }
    finally { setBusy(false); }
  };
  const remove = async (id) => {
    if (!window.confirm(`스냅샷 #${id} 를 지울까요? 되돌릴 수 없습니다.`)) return;
    setWriteErr(null);
    try { await delJson(`/tools/cvp/snapshots/${id}`); if (String(id) === a) setRes(null); load(); } catch (e) { setWriteErr(e); }
  };
  const compare = async () => {
    if (!a) return;
    const my = ++seq.current;
    setCmpBusy(true); setResErr(null);
    try { const x = await fetchJson('/tools/cvp/compare', { a, b }); if (my === seq.current) { setRes(x); setKind('all'); } }
    catch (e) { if (my === seq.current) { setResErr(e); setRes(null); } }
    finally { if (my === seq.current) setCmpBusy(false); }
  };
  const snaps = list && Array.isArray(list.snapshots) ? list.snapshots : [];
  const done = snaps.filter((s) => s.done);
  const c = res?.counts || {};
  const devs = res && Array.isArray(res.devices) ? res.devices : [];
  const shownDevs = kind === 'all' ? devs : devs.map((d) => ({ ...d, changes: d.changes.filter((x) => x.kind === kind) })).filter((d) => d.changes.length);
  return (
    <div style={GRID1}>
      <div className="card" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <b style={{ fontSize: 15 }}>작업 전후 비교</b>
        <div style={NOTE}><BoldText text={COMPARE_NOTE} /></div>
        {mayWrite ? (
          <div style={ROW}>
            <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="이름(예: 11/25 코어 교체 전)" maxLength={120} aria-label="스냅샷 이름" style={{ flex: '1 1 220px', minWidth: 0, maxWidth: 360 }} />
            <CvpSelect servers={servers} value={cvpId} onChange={setCvpId} />
            <button type="button" className="btn" onClick={take} disabled={busy}>{busy ? '저장 중…' : '지금 스냅샷 찍기'}</button>
          </div>
        ) : <div style={NOTE}>스냅샷 찍기 · 지우기는 운영자 이상만 할 수 있습니다. 비교는 누구나 할 수 있습니다.</div>}
        {msg && <div className="banner" style={{ borderColor: 'var(--green)' }}>{msg}</div>}
        {writeErr && <ErrorBox error={writeErr} />}
      </div>
      <div className="card" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={ROW}><b>스냅샷</b>{list && <span style={NOTE}>최근 {list.max}개 · {list.retentionDays}일 보관(넘으면 오래된 것부터 지웁니다)</span>}</div>
        {listErr && <ErrorBox error={listErr} />}
        {!list && !listErr && <Loading />}
        {list && (
          <STable className="v3-table" minWidth={820}>
            <thead><tr><th>번호</th><th>시각</th><th>이름</th><th>범위</th><th>장비</th><th>크기</th><th>찍은 사람</th>{mayWrite && <th data-nosort></th>}</tr></thead>
            <tbody>
              {snaps.map((s) => (
                <tr key={s.id}>
                  <td data-sort={s.id} style={MONO}>#{s.id}</td>
                  <td data-sort={s.at} style={MONO}>{tsText(s.at)}</td>
                  <td style={{ whiteSpace: 'normal', minWidth: 140 }}>{s.label || <span style={NOTE}>(이름 없음)</span>}{s.done ? null : <span style={{ color: TONE.amber, marginLeft: 6 }}>저장 중 · 중단됨</span>}</td>
                  <td>{s.cvpId ? s.cvpName : '모든 CVP'}</td>
                  <td data-sort={s.devices} style={{ ...MONO, textAlign: 'right' }}>{s.devices}</td>
                  <td data-sort={s.bytes} style={{ ...MONO, textAlign: 'right' }}>{bytesText(s.bytes)}</td>
                  <td>{s.by || '—'}</td>
                  {mayWrite && <td><button type="button" className="btn" onClick={() => remove(s.id)}>지우기</button></td>}
                </tr>
              ))}
            </tbody>
          </STable>
        )}
        {list && !snaps.length && <div style={NOTE}>아직 스냅샷이 없습니다 — 작업 전에 하나 찍어 두고, 작업 뒤 ‘지금’ 과 비교하세요.</div>}
      </div>
      <div className="card" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={ROW}>
          <b>비교</b>
          <Select className="input" value={a} onChange={(e) => setA(e.target.value)} aria-label="전(기준)" style={{ maxWidth: 260 }}>
            {!done.length && <option value="">스냅샷 없음</option>}
            {done.map((s) => <option key={s.id} value={String(s.id)}>#{s.id} {tsText(s.at)}{s.label ? ` · ${s.label}` : ''}</option>)}
          </Select>
          <span style={NOTE}>→</span>
          <Select className="input" value={b} onChange={(e) => setB(e.target.value)} aria-label="후" style={{ maxWidth: 260 }}>
            <option value="now">지금(중앙 DB 최신값)</option>
            {done.filter((s) => String(s.id) !== a).map((s) => <option key={s.id} value={String(s.id)}>#{s.id} {tsText(s.at)}{s.label ? ` · ${s.label}` : ''}</option>)}
          </Select>
          <button type="button" className="btn" onClick={compare} disabled={!a || cmpBusy}>{cmpBusy ? '비교 중…' : '비교'}</button>
        </div>
        {resErr && <ErrorBox error={resErr} />}
        {res && (<>
          <Tiles tiles={[
            ['바뀐 장비', c.devicesChanged ?? 0, `그대로 ${numText(res.unchanged)}대`, TONE.amber],
            ['사라진 장비', c.removed ?? 0, '', TONE.red],
            ['새로 생긴 장비', c.added ?? 0, '', TONE.blue],
            ['비교 못 한 장비', c.naDevices ?? 0, '한쪽이 못 읽은 묶음이 있음', 'var(--text-dim)'],
          ]} />
          <div style={ROW}>
            <button type="button" className={`tab${kind === 'all' ? ' active' : ''}`} onClick={() => setKind('all')}>전체</button>
            {Object.entries(CHANGE_KIND).map(([k, l]) => <button key={k} type="button" className={`tab${kind === k ? ' active' : ''}`} onClick={() => setKind(k)}>{l} <b style={MONO}>{c[k] ?? 0}</b></button>)}
          </div>
          {shownDevs.map((d) => (
            <div key={d.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
              <div style={ROW}><b style={MONO}>{d.hostname || d.id.split('\u0000')[2]}</b><Pill color={(STATE[d.state] || STATE.na)[1]}>{(STATE[d.state] || STATE.na)[0]}</Pill>{d.changes.length ? <span style={NOTE}>{d.changes.length}건</span> : null}</div>
              {d.na?.length ? <div style={NOTE}>{naText(d.na)}</div> : null}
              {d.changes.length > 0 && (
                <STable className="v3-table" minWidth={620}>
                  <thead><tr><th>종류</th><th>항목</th><th>전</th><th>후</th></tr></thead>
                  <tbody>
                    {d.changes.map((x, i) => (
                      <tr key={i}>
                        <td>{CHANGE_KIND[x.kind] || x.kind}</td>
                        <td style={{ whiteSpace: 'normal', minWidth: 180 }}>{changeLabel(x)}</td>
                        <td style={{ ...MONO, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{changeValue(x, 'before')}</td>
                        <td style={{ ...MONO, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{changeValue(x, 'after')}</td>
                      </tr>
                    ))}
                  </tbody>
                </STable>
              )}
            </div>
          ))}
          {!shownDevs.length && <div style={NOTE}>{devs.length ? '이 종류의 변화가 없습니다.' : '바뀐 것이 없습니다.'}</div>}
          <div style={NOTE}>#{res.a?.id} {tsText(res.a?.at)} → {res.b?.now ? '지금' : `#${res.b?.id} ${tsText(res.b?.at)}`}{res.scopeCvpId ? ` · ${servers.find((s) => String(s.id) === String(res.scopeCvpId))?.name || res.scopeCvpId} 만 비교(한쪽이 그 CVP 만 찍음)` : ''}{res.omitted ? ` · ⚠ 장비 ${res.omitted}대는 상한으로 생략` : ''}</div>
        </>)}
      </div>
    </div>
  );
}
