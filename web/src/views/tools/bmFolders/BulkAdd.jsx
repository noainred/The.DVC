/**
 * 물리서버 폴더 — 서버 찾아 한 번에 등록(v2.984). 글자가 들어간 서버를 찾아(서버가 판정 — 가린 이름 기준) 고른 뒤
 * 각 서버의 **자기 법인** 아래 같은 이름 폴더로 넣는다(없는 법인에는 만든다). 이미 다른 폴더에 있는 서버는 기본으로 건드리지 않는다.
 * ⚠ 찾기는 입력이 멈춘 뒤 한 번(400ms) · 늦게 온 이전 응답은 버린다. 결과는 서버가 상한까지 준다(상한은 응답의 shown/total 로 밝힌다).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson } from '../../../api.js';
import { Modal } from '../../../components/Modal.jsx';
import { STable } from '../../../components/STable.jsx';
import Select from '../../../components/Select.jsx';
import DataList from '../../../components/DataList.jsx';
import { SrcBadge, StatusDot } from './parts.jsx';
import { SRC_LABEL, parseQuery, highlight, previewAssign, pathText, opErrorText, trimPath } from '../bmFoldersText.js';
import { pickAll, pickNotInFolder, pickNote } from './whyText.js'; // v2.994: 고르기 버튼

const btn = { padding: '6px 12px', flex: 'none' };
const ON_LABEL = { name: '이름', tag: '서비스 태그', model: '모델', addr: '관리 주소' };

export default function BulkAdd({ init, d, corpName, op, busy, onClose }) {
  const [text, setText] = useState(init.text || '');
  const [scope, setScope] = useState(init.corp ? 'corp' : 'all');
  const [corp, setCorp] = useState(init.corp || '');
  const [kinds, setKinds] = useState('bm');
  const [onlyUn, setOnlyUn] = useState(!!init.unassigned);
  const [fields, setFields] = useState({ name: true, model: false, tag: false });
  const [res, setRes] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [off, setOff] = useState({ corp: new Set(), src: new Set(), state: new Set(), model: new Set() });
  const [checked, setChecked] = useState(() => new Set());
  const [pickMsg, setPickMsg] = useState('');   // v2.994: 고르기 버튼 결과 문장
  const [path, setPath] = useState(init.path || '');
  const [moveExisting, setMoveExisting] = useState(false);
  const [saveRule, setSaveRule] = useState(false);
  const seq = useRef(0);

  const tokens = useMemo(() => parseQuery(text), [text]);
  const qKey = JSON.stringify([tokens, scope, corp, kinds, onlyUn, fields]);
  useEffect(() => {
    if (!tokens.include.length) { setRes(null); setErr(''); setLoading(false); return undefined; }
    const my = ++seq.current;
    setLoading(true);
    const tm = setTimeout(async () => {
      try {
        const r = await fetchJson('/tools/bm-folders/search', {
          inc: tokens.include.join(','), exc: tokens.exclude.join(','),
          fields: Object.entries(fields).filter(([, v]) => v).map(([k]) => k).join(','), kinds: kinds === 'all' ? 'bm,esxi' : 'bm',
          corp: scope === 'corp' ? corp : '', unassigned: onlyUn ? '1' : '',
        });
        if (my !== seq.current) return;   // 늦게 온 이전 응답은 버린다
        setRes(r); setErr('');
        setOff({ corp: new Set(), src: new Set(), state: new Set(), model: new Set() });
        // 기본 선택 — 이미 손 등록된 서버(다른 폴더)는 고르지 않는다(옮기기는 아래 체크로 명시)
        setChecked(new Set((r.rows || []).filter((x) => x.place !== 'manual').map((x) => x.key)));
        setPickMsg('');
      } catch (e) { if (my === seq.current) { setErr(opErrorText(e)); setRes(null); } }
      finally { if (my === seq.current) setLoading(false); }
    }, 400);
    return () => clearTimeout(tm);
    // qKey 가 바뀌는 입력을 모두 담는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qKey]);

  const rows = useMemo(() => (res?.rows || []).filter((x) => !off.corp.has(x.corp) && !off.src.has(x.src) && !off.state.has(x.place ? 'foldered' : 'unassigned') && !off.model.has(x.model || '(모름)')), [res, off]);
  const pickedRows = useMemo(() => rows.filter((x) => checked.has(x.key)), [rows, checked]);
  const target = trimPath(path);
  const pv = useMemo(() => previewAssign(pickedRows, target, d.corps || [], d.servers || [], { moveExisting }), [pickedRows, target, d, moveExisting]);
  const pathOptions = useMemo(() => {
    const set = new Set();
    for (const c of d.corps || []) if (scope !== 'corp' || c.vcenterId === corp) for (const f of c.folders) set.add(f.path);
    return [...set].sort((a, b) => a.localeCompare(b, 'ko'));
  }, [d, scope, corp]);
  const inOther = rows.filter((x) => x.place === 'manual').length;
  const canRule = tokens.include.length > 0 && (scope === 'corp' ? !!(d.corps || []).find((c) => c.vcenterId === corp)?.writable : !!d.canFleet);

  const toggleOff = (k, v) => setOff((o) => { const n = { ...o, [k]: new Set(o[k]) }; if (n[k].has(v)) n[k].delete(v); else n[k].add(v); return n; });
  const submit = async () => {
    const keys = pickedRows.filter((x) => moveExisting || x.place !== 'manual').map((x) => x.key);
    const r = await op({ op: 'assign', path: target, keys, moveExisting, createMissing: true }, `${pv.total}대를 각 법인의 ‘${pathText(target)}’ 에 등록했습니다${pv.newFolders ? ` · 새 폴더 ${pv.newFolders}개` : ''}.`);
    if (!r) return;
    if (saveRule && canRule) {
      for (const v of tokens.include) {
        // 규칙 하나 실패가 등록을 되돌리지는 않는다 — 결과 알림으로 밝힌다(op 가 알림을 띄운다)
        await op({ op: 'rule.add', corp: scope === 'corp' ? corp : '*', value: v, path: target }, `등록했고 규칙 ‘${v} → ${pathText(target)}’ 도 저장했습니다${d.settings?.autoRules ? '' : '(자동 규칙이 꺼져 있어 켜야 적용됩니다)'}.`);
      }
    }
    onClose();
  };

  const f = res?.facets;
  return (
    <Modal title="서버 찾아 등록" onClose={onClose} width={1140}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
        <div className="muted" style={{ fontSize: 12 }}>iDRAC 으로 인식된 서버(엣지 · 수집 서버가 보고한 서버 포함)에서 글자가 들어간 것을 찾습니다 — 쉼표로 여러 개(하나라도 들어가면 일치) · 앞에 - 를 붙이면 제외 · 정규식이 아니라 ‘포함’(대소문자 무시).</div>
        <div className="flex wrap gap" style={{ alignItems: 'center' }}>
          <input className="input" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="예: db, ora, -bak" aria-label="찾을 글자" style={{ flex: '1 1 260px', minWidth: 0 }} />
          <div className="tabs" style={{ marginLeft: 0 }} role="group" aria-label="찾는 범위">
            {init.corp || corp ? <button type="button" className={`tab${scope === 'corp' ? ' active' : ''}`} onClick={() => setScope('corp')}>이 법인</button> : null}
            <button type="button" className={`tab${scope === 'all' ? ' active' : ''}`} onClick={() => setScope('all')}>전 법인{d.scoped ? '(범위 안)' : '(엣지 포함)'}</button>
          </div>
          <div className="tabs" style={{ marginLeft: 0 }} role="group" aria-label="대상">
            <button type="button" className={`tab${kinds === 'bm' ? ' active' : ''}`} onClick={() => setKinds('bm')}>베어메탈</button>
            <button type="button" className={`tab${kinds === 'all' ? ' active' : ''}`} onClick={() => setKinds('all')}>＋ ESXi 호스트</button>
          </div>
        </div>
        <div className="flex wrap gap" style={{ alignItems: 'center', fontSize: 12 }}>
          {tokens.include.map((v) => <span key={`i${v}`} className="bmf-tok"><span>포함</span><b>{v}</b></span>)}
          {tokens.exclude.map((v) => <span key={`e${v}`} className="bmf-tok neg"><span>제외</span><b>{v}</b></span>)}
          <span className="muted">찾는 곳</span>
          <label className="bmf-lbl"><input type="checkbox" checked={fields.name} onChange={(e) => setFields({ ...fields, name: e.target.checked })} />이름</label>
          <label className="bmf-lbl"><input type="checkbox" checked={fields.model} onChange={(e) => setFields({ ...fields, model: e.target.checked })} />모델</label>
          {!d.scoped ? <label className="bmf-lbl"><input type="checkbox" checked={fields.tag} onChange={(e) => setFields({ ...fields, tag: e.target.checked })} />서비스 태그</label> : null}
          {d.admin && !d.scoped ? <label className="bmf-lbl" title="관리 주소(iDRAC) — 전체 범위 관리자만"><input type="checkbox" checked={!!fields.addr} onChange={(e) => setFields({ ...fields, addr: e.target.checked })} />관리 주소</label> : null}
          <label className="bmf-lbl"><input type="checkbox" checked={onlyUn} onChange={(e) => setOnlyUn(e.target.checked)} />미분류만</label>
          {scope === 'corp' ? (
            <Select className="select" value={corp} onChange={(e) => setCorp(e.target.value)} aria-label="법인" style={{ maxWidth: 220 }}>
              {(d.corps || []).map((c) => <option key={c.vcenterId} value={c.vcenterId}>{c.name}</option>)}
            </Select>
          ) : null}
        </div>

        {!tokens.include.length ? <div className="muted" style={{ padding: '12px 0' }}>찾을 글자를 넣으십시오(포함 글자가 하나도 없으면 아무것도 찾지 않습니다).</div> : err ? <div style={{ color: 'var(--red)' }}>{err}</div> : !res ? <div className="muted">찾는 중…</div> : (
          <div className="bmf-bulk">
            {f ? (
              <div className="bmf-facets" role="group" aria-label="조건별 개수">
                <Facet title="법인" map={f.corp} label={corpName} offSet={off.corp} toggle={(v) => toggleOff('corp', v)} />
                <Facet title="받는 길" map={f.src} label={(k) => SRC_LABEL[k] || k} offSet={off.src} toggle={(v) => toggleOff('src', v)} />
                <Facet title="지금 폴더" map={f.state} label={(k) => (k === 'unassigned' ? '(미분류)' : '폴더에 있음')} offSet={off.state} toggle={(v) => toggleOff('state', v)} />
                <Facet title="모델" map={f.model} label={(k) => k} offSet={off.model} toggle={(v) => toggleOff('model', v)} />
                <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>일치한 곳: {Object.entries(f.on || {}).filter(([, n]) => n).map(([k, n]) => `${ON_LABEL[k]} ${n}`).join(' · ') || '—'}</div>
              </div>
            ) : null}
            <div style={{ flex: '1 1 520px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="flex wrap gap" style={{ alignItems: 'center', fontSize: 13 }}>
                <b>일치 {res.total}대</b>{rows.length !== (res.rows || []).length ? <span className="muted">(조건으로 {rows.length}대)</span> : null}
                <span className="badge blue">선택 {pickedRows.length}대</span>
                {inOther ? <span className="badge amber">다른 폴더에 있는 {inOther}대{moveExisting ? ' — 옮김' : ' — 고르지 않음'}</span> : null}
                {loading ? <span className="muted">다시 찾는 중…</span> : null}
                {res.shown < res.total ? <span className="muted">앞 {res.shown}대만 받았습니다 — 글자를 더 넣어 좁히십시오</span> : null}
              </div>
              {rows.length ? (
                // v2.994(설계 §12 ⑤): 고르기 버튼 셋 — 찾은 서버 전부(표에 보이지 않는 줄 포함 · 왼쪽 조건으로 뺀 줄은 제외)에 적용하고 결과를 문장으로 말한다
                <div className="flex wrap gap" role="group" aria-label="고르기" style={{ alignItems: 'center' }}>
                  <button type="button" className="bmf-chip" onClick={() => { const n = pickAll(rows); setChecked(n); setPickMsg(pickNote('all', rows, n)); }}>전체 선택 {rows.length}</button>
                  <button type="button" className="bmf-chip" onClick={() => { const n = pickNotInFolder(rows); setChecked(n); setPickMsg(pickNote('notin', rows, n)); }}>폴더에 없는 서버만 선택 {rows.filter((x) => x.place !== 'manual').length}</button>
                  <button type="button" className="bmf-chip" disabled={!checked.size} onClick={() => { setChecked(new Set()); setPickMsg(pickNote('none')); }}>선택 해제</button>
                  {pickMsg ? <span className="muted" role="status" style={{ fontSize: 12 }}>{pickMsg}</span> : null}
                </div>
              ) : null}
              {!rows.length ? <div className="muted" style={{ padding: 12 }}>‘{tokens.include.join(', ')}’ 이(가) 들어간 서버가 없습니다{onlyUn ? '(미분류만)' : ''}. 찾는 곳을 넓히거나(모델{d.scoped ? '' : ' · 서비스 태그'}) ESXi 호스트를 포함해 보십시오.</div> : (
                <STable className="table bmf-t" minWidth={760} limit={300}>
                  <thead>
                    <tr>
                      <th data-nosort style={{ width: 30 }}><input type="checkbox" aria-label="보이는 서버 전체 선택" checked={rows.length > 0 && rows.every((x) => checked.has(x.key))} onChange={(e) => setChecked(e.target.checked ? new Set(rows.map((x) => x.key)) : new Set())} /></th>
                      <th>이름</th><th>법인</th><th>받는 길</th>{!d.scoped ? <th>서비스 태그</th> : null}<th>모델</th><th>지금 폴더</th><th>일치한 곳</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((x) => (
                      <tr key={x.key} className={checked.has(x.key) ? 'bmf-picked' : undefined}>
                        <td data-nosort><input type="checkbox" aria-label={`${x.name} 선택`} checked={checked.has(x.key)} onChange={(e) => setChecked((s) => { const n = new Set(s); if (e.target.checked) n.add(x.key); else n.delete(x.key); return n; })} /></td>
                        <td data-sort={x.name}><span className="bmf-nm"><StatusDot tone={x.faults > 0 ? 'red' : x.cpu == null && x.mem == null ? 'none' : 'green'} /><span>{highlight(x.name, x.on === 'name' ? tokens.include : []).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <React.Fragment key={i}>{p.text}</React.Fragment>))}</span>{x.kind === 'esxi' ? <span className="badge gray" style={{ marginLeft: 4 }}>ESXi</span> : null}</span></td>
                        <td>{corpName(x.corp)}</td>
                        <td><SrcBadge src={x.src} />{x.agent ? <span className="muted mono" style={{ fontSize: 11, marginLeft: 4 }}>{x.agent}</span> : null}</td>
                        {!d.scoped ? <td className="mono" style={{ fontSize: 12 }}>{x.serviceTag || '—'}</td> : null}
                        <td>{x.model || '—'}</td>
                        <td data-sort={x.place ? x.path : ''}>{x.place ? <span className="badge amber">{pathText(x.path)}</span> : <span className="muted">(미분류)</span>}</td>
                        <td className="muted">{ON_LABEL[x.on] || x.on}</td>
                      </tr>
                    ))}
                  </tbody>
                </STable>
              )}
              {rows.length > 300 ? <div className="muted" style={{ fontSize: 12 }}>표에는 300대까지 그립니다 — 선택은 안 보이는 행에도 그대로 적용됩니다({pickedRows.length}대).</div> : null}
            </div>
          </div>
        )}

        <div className="bmf-mini">
          <div className="flex wrap gap" style={{ alignItems: 'center' }}>
            <b>넣을 폴더</b><span className="muted" style={{ fontSize: 12 }}>각 서버의 법인 아래</span>
            <input className="input" list="bmf-paths" value={path} onChange={(e) => setPath(e.target.value)} placeholder="예: DB\Oracle RAC" aria-label="넣을 폴더" style={{ flex: '1 1 220px', minWidth: 0, maxWidth: 320 }} />
            <DataList id="bmf-paths">{pathOptions.map((p) => <option key={p} value={p} />)}</DataList>
            <span className="muted" style={{ fontSize: 12 }}>그 폴더가 없는 법인에는 같은 이름으로 새로 만듭니다</span>
          </div>
          {target && pv.list.length ? (
            <div className="flex wrap" style={{ gap: '4px 14px', fontSize: 12 }}>
              {pv.list.slice(0, 8).map((x) => (
                <span key={x.corp} className="bmf-lg"><span className="bmf-tag">{corpName(x.corp)} › {pathText(target)}</span>{x.newFolder ? <span className="badge gray">새 폴더</span> : null} {x.before} → <b>{x.before + x.add}</b></span>
              ))}
              {pv.list.length > 8 ? <span className="muted">외 {pv.list.length - 8}곳</span> : null}
              <span className="muted" style={{ marginLeft: 'auto' }}>합 +{pv.total}대{pv.newFolders ? ` · 폴더 ${pv.newFolders}개 생성` : ''}{pv.skipped.readOnly ? ` · 조회 전용 법인 ${pv.skipped.readOnly}대 건너뜀` : ''}</span>
            </div>
          ) : null}
        </div>

        <div className="flex wrap gap" style={{ alignItems: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 380px', minWidth: 0, fontSize: 13 }}>
            <label className="bmf-lbl"><input type="checkbox" checked={moveExisting} onChange={(e) => { setMoveExisting(e.target.checked); if (e.target.checked && res) setChecked((s) => new Set([...s, ...rows.filter((x) => x.place === 'manual').map((x) => x.key)])); }} />이미 다른 폴더에 있는 서버도 이 폴더로 옮기기<span className="muted">(끄면 그대로 둡니다)</span></label>
            <label className="bmf-lbl" style={canRule ? undefined : { opacity: 0.55 }} title={canRule ? undefined : (scope === 'all' ? '전 법인 규칙은 전체 범위 관리자만 저장합니다' : '이 법인에 쓸 수 없습니다')}>
              <input type="checkbox" disabled={!canRule} checked={saveRule && canRule} onChange={(e) => setSaveRule(e.target.checked)} />
              이 조건을 자동 규칙으로 저장<span className="muted">— 새로 인식되는 서버도 이름에 ‘{tokens.include.join('’ · ‘') || '…'}’ 가 있으면 {scope === 'corp' ? '이 법인' : '각 법인'}의 이 폴더로{d.settings?.autoRules ? '' : '(자동 규칙이 꺼져 있어 켜야 적용)'}</span>
            </label>
          </div>
          <button type="button" className="logout-btn" style={btn} onClick={onClose}>취소</button>
          <button type="button" className="login-btn" style={{ ...btn, padding: '8px 16px' }} disabled={busy || !target || !pv.total} onClick={submit}>{pv.total ? `${pv.total}대 등록` : '등록'}</button>
        </div>
      </div>
    </Modal>
  );
}

function Facet({ title, map = {}, label, offSet, toggle }) {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span className="muted" style={{ fontSize: 11, fontWeight: 600, padding: '6px 0 2px' }}>{title}</span>
      {entries.map(([k, n]) => (
        <label key={k} className="bmf-fc">
          <input type="checkbox" checked={!offSet.has(k)} onChange={() => toggle(k)} />
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label(k)}</span>
          <span className="n">{n}</span>
        </label>
      ))}
    </div>
  );
}
