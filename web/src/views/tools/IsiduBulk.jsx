/**
 * 수집 대상 설정 창의 '일괄 변경' 탭(v2.739) — 등록된 대상을 골라 설정 항목을 한꺼번에 바꾸고, 지금 수집·연결 시험·결과 메일·목록에서 빼기를 한꺼번에 한다.
 *
 *  · 판정은 서버(`POST /tools/isilon-dirusage/bulk`)가 한다. '적용' 은 먼저 미리보기(dryRun)를 받아 무엇이 바뀌는지 보여 준 뒤 확인을 받고 저장한다.
 *  · 저장값(이 창을 열 때 읽은 판 — rev)을 기준으로 한다. 그 사이 다른 곳에서 바뀌었으면 서버가 409 로 막는다(덮어쓰지 않는다).
 *  · 개별 편집 탭에 저장하지 않은 변경이 있으면 적용·빼기를 잠근다(적용이 목록을 새로 읽어 그 변경을 지우기 때문이다).
 *  · 연결 시험·결과 메일은 **차례로** 하나씩 한다(동시에 여러 장비에 접속하지 않는다 — 자동 재시도도 하지 않는다). '멈춤' 으로 다음 것부터 안 한다.
 */
import React, { useMemo, useRef, useState } from 'react';
import { postJson } from '../../api.js';
import Select from '../../components/Select.jsx';
import { STable } from '../../components/STable.jsx';
import {
  INTERVAL_CHOICES, TIMEOUT_CHOICES, everyText, nodeText, formFromTarget, targetBody, testResultText, runResultText, nudgeLines, mailStateText,
} from './isiduText.js';
import {
  BULK_FIELDS, BOOL_CHOICES, MAIL_MODES, RUN_FOLLOW, RUN_MAIN, DC_NONE, USER_REGISTRY, SELECT_PRESETS,
  blankBulk, bulkPatchFrom, patchSummary, bulkResultText, presetIds, seqProgressText,
} from './isiduBulkText.js';

const lo = (s) => String(s || '').toLowerCase();

export default function IsiduBulk({ srv, rows = [], dirty = false, locked = false, onApplied }) {
  const saved = useMemo(() => srv?.settings?.targets || [], [srv]);
  const choices = useMemo(() => srv?.choices || { devices: [], agents: [], datacenters: [] }, [srv]);
  const dcName = useMemo(() => { const m = new Map((choices.datacenters || []).map((d) => [d.id, d.name])); return (id) => m.get(id) || id; }, [choices]);
  const rowById = useMemo(() => new Map((rows || []).map((r) => [r.id, r])), [rows]);
  const devById = useMemo(() => new Map((choices.devices || []).map((d) => [d.id, d])), [choices]);
  const [sel, setSel] = useState(() => new Set());
  const [corp, setCorp] = useState('');
  const [node, setNode] = useState('');
  const [ed, setEd] = useState(blankBulk);
  const [userSet, setUserSet] = useState(false); // 접속 계정 '계정 지정' 을 고른 상태(입력 전 빈 칸은 여전히 '그대로')
  const [res, setRes] = useState(null);       // 미리보기·적용 결과
  const [working, setWorking] = useState(false);
  const [seq, setSeq] = useState(null);       // { kind, total, results:[{id, ok, text}], running, stopping }
  const [runMsg, setRunMsg] = useState(null);
  const stopRef = useRef(false);

  // 화면 행 — 저장값 + 목록 응답(법인·장비 이름·상태). 목록 응답에 아직 없으면(새로 추가한 대상) 저장값만.
  const items = useMemo(() => saved.map((s) => {
    const r = rowById.get(s.id) || null;
    const dev = s.deviceId ? devById.get(s.deviceId) : null;
    const corpName = r?.corp || (s.datacenterId ? dcName(s.datacenterId) : (dev?.datacenterId ? dcName(dev.datacenterId) : ''));
    const agent = r ? (r.agent || '') : (s.deviceId && s.runVia !== 'node' ? (dev?.agent || '') : (s.agent || ''));
    return { s, r, corp: corpName, agent, name: s.label || r?.deviceName || dev?.name || s.host || s.id };
  }), [saved, rowById, devById, dcName]);
  const corps = useMemo(() => [...new Set(items.map((x) => x.corp))].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true })), [items]);
  const nodes = useMemo(() => [...new Set(items.map((x) => x.agent))].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true })), [items]);
  const shown = items.filter((x) => (!corp || x.corp === (corp === '(none)' ? '' : corp)) && (!node || lo(x.agent) === lo(node === '(main)' ? '' : node)));
  const ids = [...sel].filter((id) => saved.some((s) => s.id === id));
  const nameOf = (id) => items.find((x) => x.s.id === id)?.name || id;

  const toggle = (id) => setSel((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const preset = (p) => {
    const rowsForPreset = shown.map((x) => x.r || { id: x.s.id, enabled: x.s.enabled });
    const pick = presetIds(rowsForPreset, p);
    setSel((cur) => {
      if (p === 'none') { const n = new Set(cur); for (const x of shown) n.delete(x.s.id); return n; }
      const n = new Set(cur); for (const id of pick) n.add(id); return n;
    });
  };
  const setField = (key, v) => { setEd((s) => ({ ...s, [key]: v })); setRes(null); };

  const { patch, issues } = bulkPatchFrom(ed);
  const patchKeys = Object.keys(patch);
  const applyBlocked = locked ? '설정 파일을 읽지 못해 잠갔습니다.' : dirty ? "‘개별 편집’ 에 저장하지 않은 변경이 있습니다 — 먼저 저장하거나 창을 닫았다 다시 여세요(적용하면 목록을 새로 읽어 그 변경이 사라집니다)." : '';

  const callBulk = async (body) => {
    try { return await postJson('/tools/isilon-dirusage/bulk', { ...body, rev: srv?.rev }); } catch (e) { return { ok: false, reason: e?.message || String(e) }; }
  };
  const apply = async () => {
    if (!ids.length || !patchKeys.length || issues.length || applyBlocked) return;
    setWorking(true); setRes(null);
    try {
      const pre = await callBulk({ ids, patch, dryRun: true });
      setRes(pre);
      if (pre?.ok === false) return;
      const v = bulkResultText(pre, nameOf);
      if (!(pre.changed || []).length) return;
      if (!window.confirm(`선택한 ${ids.length}개에 적용할까요?\n\n바꿀 항목: ${patchSummary(patch, { dcName })}\n${v.head}${v.lines.length ? `\n\n${v.lines.slice(0, 12).join('\n')}` : ''}`)) return;
      const r = await callBulk({ ids, patch });
      setRes(r);
      if (r?.ok !== false && r.saved) onApplied?.(r);
    } finally { setWorking(false); }
  };
  const removeSel = async () => {
    if (!ids.length || applyBlocked) return;
    if (!window.confirm(`선택한 ${ids.length}개를 목록에서 뺄까요?\n${ids.slice(0, 15).map(nameOf).join(', ')}${ids.length > 15 ? ' …' : ''}\n\n이미 쌓인 수집 기록은 보존 기간 동안 남습니다.`)) return;
    setWorking(true);
    try {
      const r = await callBulk({ ids, remove: true });
      setRes(r);
      if (r?.ok !== false && r.saved) { setSel(new Set()); onApplied?.(r); }
    } finally { setWorking(false); }
  };
  const runSel = async () => {
    if (!ids.length) return;
    setWorking(true); setRunMsg(null);
    try {
      const r = await postJson('/tools/isilon-dirusage/run', { ids });
      const lines = r?.ok === false ? [] : nudgeLines(r);
      setRunMsg({ tone: r?.ok === false ? 'bad' : (lines.some((x) => !x.ok) ? 'warn' : 'ok'), text: r?.ok === false ? (r.reason || '요청하지 못했습니다.') : runResultText(r), lines });
    } catch (e) { setRunMsg({ tone: 'bad', text: e?.message || String(e), lines: [] }); } finally { setWorking(false); }
  };
  /** 차례로 — 연결 시험(저장값으로) · 결과 메일(저장된 받는 사람에게). */
  const runSeq = async (kind) => {
    if (!ids.length || seq?.running) return;
    stopRef.current = false;
    const list = ids.slice();
    const results = [];
    setSeq({ kind, total: list.length, results: [], running: true, stopping: false });
    for (const id of list) {
      if (stopRef.current) break;
      const s = saved.find((x) => x.id === id);
      let one;
      try {
        if (kind === 'test') {
          const { mail: _m, ...body } = targetBody(formFromTarget(s));
          const r = await postJson('/tools/isilon-dirusage/test', body);
          const v = testResultText(r);
          one = { id, ok: v.tone === 'ok', text: v.text };
        } else {
          const r = await postJson('/tools/isilon-dirusage/mail-now', { id });
          const v = (r?.at ? mailStateText(r) : null) || { tone: r?.ok ? 'ok' : 'bad', text: r?.reason || (r?.ok ? '보냈습니다' : '보내지 못했습니다') };
          one = { id, ok: !!r?.ok, text: v.text };
        }
      } catch (e) { one = { id, ok: false, text: e?.message || String(e) }; }
      results.push(one);
      setSeq({ kind, total: list.length, results: results.slice(), running: true, stopping: stopRef.current });
    }
    setSeq({ kind, total: list.length, results: results.slice(), running: false, stopping: false });
  };

  const rv = res ? bulkResultText(res, nameOf) : null;
  const timeouts = TIMEOUT_CHOICES;

  const fieldControl = (f) => {
    const v = ed[f.key];
    if (f.kind === 'bool') {
      return (
        <Select value={v} onChange={(e) => setField(f.key, e.target.value)} sort={false} disabled={locked}>
          {BOOL_CHOICES.map(([k, l]) => <option key={k} value={k}>{k === 'on' ? f.on : k === 'off' ? f.off : l}</option>)}
        </Select>
      );
    }
    if (f.key === 'username') {
      const mode = v === USER_REGISTRY ? 'registry' : userSet ? 'set' : '';
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Select value={mode} sort={false} disabled={locked} onChange={(e) => {
            const m = e.target.value;
            setUserSet(m === 'set');
            setField('username', m === 'registry' ? USER_REGISTRY : '');
          }}>
            <option value="">그대로</option>
            <option value="set">계정 지정</option>
            <option value="registry">등록부 계정으로(등록부 장비만)</option>
          </Select>
          {mode === 'set' ? <input type="text" className="mono" value={v} maxLength={64} placeholder="접속 계정" onChange={(e) => setField('username', e.target.value)} disabled={locked} /> : null}
        </div>
      );
    }
    if (f.kind === 'num' || f.kind === 'text') {
      return <input type={f.kind === 'num' ? 'number' : 'text'} className="mono" value={v} min={f.min} max={f.max} maxLength={f.kind === 'text' ? 64 : undefined} placeholder={f.placeholder} onChange={(e) => setField(f.key, e.target.value)} disabled={locked} />;
    }
    if (f.kind === 'mail') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Select value={ed.mailMode} onChange={(e) => setField('mailMode', e.target.value)} sort={false} disabled={locked}>
            {MAIL_MODES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
          {ed.mailMode && ed.mailMode !== 'clear' ? <textarea className="mono" rows={2} value={ed.mailList} onChange={(e) => setField('mailList', e.target.value)} placeholder="owner@corp.example (한 줄에 하나)" disabled={locked} /> : null}
        </div>
      );
    }
    let opts = [];
    if (f.key === 'intervalHours') opts = INTERVAL_CHOICES.map((h) => [String(h), everyText(h)]);
    else if (f.key === 'timeoutMin') opts = timeouts.map((m) => [String(m), `${m}분`]);
    else if (f.key === 'sizeMode') opts = [['h', '-h (사람용 · 반올림)'], ['k', '-k (KB · 정확)']];
    else if (f.key === 'auth') opts = [['key', 'SSH 키(비밀번호 없음)'], ['device', '스토리지 등록부 계정(등록부 장비만)']];
    else if (f.key === 'runNode') opts = [[RUN_FOLLOW, '장비 담당 노드 따름(등록부 장비만)'], [RUN_MAIN, '메인(이 서버)'], ...(choices.agents || []).map((a) => [a, `엣지 ${a}`])];
    else if (f.key === 'datacenterId') opts = [[DC_NONE, '(지정 안 함)'], ...(choices.datacenters || []).map((d) => [d.id, d.name])];
    return (
      <Select value={v} onChange={(e) => setField(f.key, e.target.value)} sort={f.key === 'runNode' || f.key === 'datacenterId'} disabled={locked}>
        <option value="">그대로</option>
        {opts.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </Select>
    );
  };

  return (
    <div className="isd-form isd-bulk">
      <div className="hint">등록된 대상을 골라 아래 항목을 한꺼번에 바꿉니다. 바꾸지 않을 항목은 ‘그대로’ 로 두세요. 적용하면 먼저 무엇이 바뀌는지 보여 드린 뒤 저장합니다. 대상에 맞지 않는 항목(예: DataCenter 는 직접 입력 대상만)은 그 대상에서만 빼고 알려 드립니다.</div>
      {applyBlocked ? <div className="result warn">{applyBlocked}</div> : null}

      <div className="row" style={{ flexWrap: 'wrap' }}>
        <label className="fld" style={{ minWidth: 160 }}>법인
          <Select value={corp} onChange={(e) => setCorp(e.target.value)} sort={false}>
            <option value="">전체</option>
            {corps.map((c) => <option key={c || '(none)'} value={c || '(none)'}>{c || '법인 미지정'}</option>)}
          </Select>
        </label>
        <label className="fld" style={{ minWidth: 160 }}>실행 노드
          <Select value={node} onChange={(e) => setNode(e.target.value)} sort={false}>
            <option value="">전체</option>
            {nodes.map((n) => <option key={n || '(main)'} value={n || '(main)'}>{nodeText(n)}</option>)}
          </Select>
        </label>
        <div className="row" style={{ flexWrap: 'wrap', alignSelf: 'flex-end' }}>
          {SELECT_PRESETS.map(([k, l]) => <button key={k} type="button" className="btn2" onClick={() => preset(k)}>{l}</button>)}
          <span className="hint">선택 {ids.length}개 / 전체 {saved.length}개{shown.length !== items.length ? ` · 보이는 ${shown.length}개` : ''}</span>
        </div>
      </div>

      <STable className="v3-table" minWidth={760}>
        <thead><tr><th data-nosort>선택</th><th>대상</th><th>법인</th><th>실행 노드</th><th>주기</th><th>시한</th><th>수집</th><th>분리 실행</th><th>메일</th></tr></thead>
        <tbody>
          {shown.map((x) => (
            <tr key={x.s.id} onClick={() => toggle(x.s.id)} style={{ cursor: 'pointer' }}>
              <td><input type="checkbox" checked={sel.has(x.s.id)} onChange={() => toggle(x.s.id)} onClick={(e) => e.stopPropagation()} aria-label={`${x.name} 선택`} /></td>
              <td><b>{x.name}</b><div className="hint isd-mono">{x.s.path}</div></td>
              <td>{x.corp || '—'}</td>
              <td><span className={`isd-node${x.agent ? ' edge' : ''}`}>{nodeText(x.agent)}{x.s.deviceId && x.s.runVia === 'node' ? ' · 지정' : ''}</span></td>
              <td data-sort={x.s.intervalHours}>{everyText(x.s.intervalHours)}</td>
              <td data-sort={x.s.timeoutMin}>{x.s.timeoutMin}분</td>
              <td>{x.s.enabled === false ? <span className="isd-tag muted">꺼짐</span> : <span className="isd-tag ok">켜짐</span>}</td>
              <td>{x.s.detach === false ? '끔' : '켬'}</td>
              <td data-sort={x.s.mail?.to?.length || 0}>{x.s.mail?.to?.length ? `${x.s.mail.to.length}명` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </STable>

      <fieldset>
        <legend>바꿀 항목</legend>
        <div className="isd-bulkgrid">
          {BULK_FIELDS.map((f) => (
            <label key={f.key} className={`fld${(f.kind === 'mail') ? ' wide' : ''}`}>{f.label}
              {fieldControl(f)}
              {f.key === 'username' && userSet && !ed.username ? <span className="hint">계정을 입력하지 않으면 바꾸지 않습니다.</span> : null}
              {f.key === 'timeoutMin' ? <span className="hint">du 를 기다리는 최대 시간 — 기본 2시간 · 최대 3시간.</span> : null}
            </label>
          ))}
        </div>
        {issues.length ? <div className="hint bad" role="alert">{issues.map((x) => x.text).join(' · ')}</div> : null}
        <div className="hint">{patchKeys.length ? `바꿀 항목: ${patchSummary(patch, { dcName })}` : '바꿀 항목을 하나 이상 고르세요.'}</div>
        <div className="row">
          <button type="button" className="btn2 primary" onClick={apply} disabled={working || !ids.length || !patchKeys.length || issues.length > 0 || !!applyBlocked}>{working ? '처리 중…' : `선택 ${ids.length}개에 적용`}</button>
          <button type="button" className="btn2" onClick={() => { setEd(blankBulk()); setUserSet(false); setRes(null); }} disabled={working}>항목 비우기</button>
        </div>
        {rv && (rv.head || rv.lines.length) ? (
          <div className={`result ${rv.tone === 'muted' ? '' : rv.tone}`}>
            <div>{rv.head}</div>
            {rv.lines.length ? <ul className="isd-bulklines">{rv.lines.map((l, i) => <li key={i}>{l}</li>)}</ul> : null}
          </div>
        ) : null}
      </fieldset>

      <fieldset>
        <legend>선택 대상에 한꺼번에</legend>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button type="button" className="btn2" onClick={runSel} disabled={working || !ids.length} title="저장된 설정으로 지금 du 를 시작합니다(엣지 담당은 그 엣지에 요청합니다)">지금 수집({ids.length})</button>
          <button type="button" className="btn2" onClick={() => runSeq('test')} disabled={!ids.length || seq?.running} title="저장된 설정으로 하나씩 경로를 확인합니다(du 는 돌리지 않습니다)">연결 시험 — 차례로({ids.length})</button>
          <button type="button" className="btn2" onClick={() => runSeq('mail')} disabled={!ids.length || seq?.running} title="저장된 받는 사람에게 마지막 성공 결과를 하나씩 보냅니다">결과 메일 지금 보내기 — 차례로({ids.length})</button>
          {seq?.running ? <button type="button" className="btn2" onClick={() => { stopRef.current = true; setSeq((s) => (s ? { ...s, stopping: true } : s)); }}>멈춤</button> : null}
          <button type="button" className="btn2 danger" onClick={removeSel} disabled={working || !ids.length || !!applyBlocked}>목록에서 빼기({ids.length})</button>
        </div>
        <div className="hint">연결 시험과 메일은 한 번에 하나씩 합니다(여러 장비에 동시에 접속하지 않고, 실패해도 다시 시도하지 않습니다). 지금 수집은 du 결과를 기다리지 않습니다 — 끝나면 목록이 갱신됩니다.</div>
        {runMsg ? (
          <div className={`result ${runMsg.tone}`}>
            <div>{runMsg.text}</div>
            {runMsg.lines?.length ? <ul className="isd-bulklines">{runMsg.lines.map((x) => <li key={x.agent} className={x.ok ? '' : 'bad'}>{x.text}</li>)}</ul> : null}
          </div>
        ) : null}
        {seq ? (
          <div className={`result ${seq.running ? '' : seq.results.every((x) => x.ok) ? 'ok' : 'warn'}`}>
            <div>{seqProgressText(seq)}</div>
            {seq.results.length ? <ul className="isd-bulklines">{seq.results.map((x) => <li key={x.id} className={x.ok ? '' : 'bad'}>{nameOf(x.id)} — {x.text}</li>)}</ul> : null}
          </div>
        ) : null}
      </fieldset>
    </div>
  );
}
