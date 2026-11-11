/**
 * 서버 집중 모니터링 ‘대상 · 키’ 탭의 v2.978 조각 — CSV 대량 등록(미리보기 → 적용 → 일괄 시험) · 엣지 노드 카드(연결 진단 · 다시 깨우기 · 서버 옮기기) ·
 * 노드별 공개키 설치 명령(계정별 묶음). 사용자 요청(2026-11-12) "Csv 대량 서버 등록 / Edge 통한 연결 기능 강화".
 *
 *  · 판정은 서버(planCsv · bulkProgress · edgeUpgradeNeed · cleanDiag)가 한다 — 여기는 문구(focusMonText.js)와 배치만.
 *  · 적용은 미리보기를 다시 보내지 않고 **본문을 서버가 다시 계획**한다. 글을 고치면 미리보기를 지워 옛 계획을 보고 누르지 않게 한다.
 *  · 숫자(최대 줄 수 · 글자 수 · 쉬는 주기 · 판 번호)는 응답에서 읽는다.
 */
import React, { useState } from 'react';
import { postJson, downloadFile, canCsv, CSV_DENIED_NOTE } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import {
  DASH, CSV_ACTION_TEXT, csvChangeText, decodeCsvBytes, WAKE_TEXT, wakeFallbackText, upgradeText, diagItems, installGroups, installCommand, INSTALL_NOTE,
  nodeText, agoShort, KEY_FILE_NOTE,
} from './focusMonText.js';

export function Seg({ value, options, onChange, label }) {
  return (
    <div className="fm-seg" role="group" aria-label={label}>
      {options.map(([k, t]) => <button key={k} type="button" className={value === k ? 'on' : ''} onClick={() => onChange(k)}>{t}</button>)}
    </div>
  );
}
export function Badge({ b }) { return b ? <span className={`fm-badge ${b.tone || 'off'}`}>{b.label}</span> : null; }
export function copyText(t) { try { navigator.clipboard?.writeText(t); return true; } catch { return false; } }

/* ── CSV 대량 등록 ─────────────────────────────────────────────────────────── */
export function CsvPanel({ main, busy, run, onClose }) {
  const lim = main.csv || { maxRows: main.limits.maxTargets, maxBytes: 200_000 };
  const [text, setText] = useState('');
  const [plan, setPlan] = useState(null);
  const [mode, setMode] = useState('valid');
  const [update, setUpdate] = useState(true);
  const [autoTest, setAutoTest] = useState(true);
  const [fileNote, setFileNote] = useState('');
  const edit = (v) => { setText(v.slice(0, lim.maxBytes)); setPlan(null); };
  const onFile = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > lim.maxBytes * 3) { setFileNote(`파일이 너무 큽니다 — 한 번에 ${lim.maxRows}줄까지 가져옵니다.`); return; }
    const { text: t, encoding } = decodeCsvBytes(await f.arrayBuffer());
    if (t.length > lim.maxBytes) { setFileNote(`파일이 너무 큽니다 — 한 번에 ${lim.maxRows}줄까지 가져옵니다.`); return; }
    edit(t);
    setFileNote(`${f.name} — ${encoding === 'euc-kr' ? 'EUC-KR(엑셀 기본 저장)로 읽었습니다' : 'UTF-8 로 읽었습니다'}. 미리보기를 누르세요.`);
  };
  const preview = () => run('csv-plan', async () => { const r = await postJson('/tools/focus-mon/targets/import/preview', { text }); setPlan(r); return null; });
  const apply = () => run('csv-apply', async () => {
    const r = await postJson('/tools/focus-mon/targets/import', { text, mode, update });
    const head = `새로 ${r.added}대 · 갱신 ${r.updated}대 · 그대로 ${r.same}대${r.skipped ? ` · 건너뜀 ${r.skipped}줄` : ''}${r.moved?.length ? ` · 접속처가 바뀐 ${r.moved.length}대는 새 공개키 · 시험이 필요합니다` : ''}.`;
    setPlan(null); setText('');
    if (!autoTest || !r.ids?.length) return { ok: true, reason: head };
    try {
      const b = await postJson('/tools/focus-mon/targets/test-bulk', { ids: r.ids });
      return { ok: true, reason: `${head} 넣은 ${b.job.total}대의 연결 시험을 시작했습니다 — 진행은 위 띠에 나옵니다.` };
    } catch (e) { return { ok: false, reason: `${head} 연결 시험은 시작하지 못했습니다(${e?.body?.reason || e?.message}).` }; }
  });
  const c = plan?.counts;
  const willAdd = c ? (mode === 'all' && c.error ? 0 : c.add) : 0;
  const willUpd = c ? (mode === 'all' && c.error ? 0 : update ? c.update : 0) : 0;
  return (
    <div className="fm-col fm-csv">
      <div className="fm-row fm-between">
        <span className="fm-row">
          <label className="fm-btn fm-file">파일 고르기<input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" onChange={onFile} /></label>
          <button type="button" className="fm-btn" disabled={!canCsv()} title={canCsv() ? '' : CSV_DENIED_NOTE} onClick={() => downloadFile('/tools/focus-mon/targets/export.csv?template=1').catch(() => {})}>빈 양식 받기</button>
          <button type="button" className="fm-btn" disabled={!canCsv()} title={canCsv() ? '' : CSV_DENIED_NOTE} onClick={() => downloadFile('/tools/focus-mon/targets/export.csv').catch(() => {})}>지금 등록부 내보내기</button>
        </span>
        <span className="fm-dim">최대 {lim.maxRows}줄 · 쉼표 또는 탭 · 따옴표 칸 가능 · 머리글이 있으면 열 순서 무관</span>
      </div>
      {fileNote ? <span className="fm-dim">{fileNote}</span> : null}
      <textarea className="fm-input fm-ta" value={text} onChange={(e) => edit(e.target.value)} placeholder={'이름,IP,포트,계정,담당 노드\nweb-01,10.10.22.31,22,dvcmon,중앙\nweb-02,10.10.22.32,22,dvcmon,엣지 이름'} aria-label="CSV 붙여 넣기" />
      <div className="fm-row">
        <button type="button" className="fm-btn pri" disabled={!!busy || !text.trim()} onClick={preview}>미리보기</button>
        <button type="button" className="fm-btn" onClick={onClose}>닫기</button>
        <span className="fm-dim">담당 노드 칸이 비었거나 ‘중앙’ 이면 중앙이 맡습니다. 같은 IP · 포트가 이미 있으면 그 대상을 고칩니다.</span>
      </div>
      {plan ? (
        <>
          <div className="fm-row">
            {Object.entries(CSV_ACTION_TEXT).map(([k, b]) => <span key={k} className={`fm-badge ${b.tone}`}>{b.label} {c[k]}</span>)}
            <span className="fm-dim">{plan.header ? '머리글을 읽어 열을 찾았습니다' : '머리글이 없어 이름, IP, 포트, 계정, 담당 노드 순서로 읽었습니다'} · 지금 {plan.registered}대 등록 / 상한 {plan.max}대</span>
          </div>
          {plan.overCap ? <div className="fm-ban w">새로 넣을 {c.add}대를 더하면 상한 {plan.max}대를 넘습니다 — 줄을 줄이세요.</div> : null}
          <div className="fm-scroll">
            <STable className="fm-table" minWidth={760}>
              <thead><tr><th>줄</th><th>처리</th><th>이름</th><th>주소 · 계정</th><th>담당 노드</th><th>내용</th></tr></thead>
              <tbody>{plan.rows.map((r) => {
                const v = r.value || r.input || {};
                const b = CSV_ACTION_TEXT[r.action];
                return (
                  <tr key={r.line}>
                    <td className="fm-num">{r.line}</td>
                    <td data-sort={r.action}><Badge b={b} /></td>
                    <td style={{ fontWeight: 600 }}>{v.name || DASH}</td>
                    <td data-sort={v.host || null}><span className="fm-mono fm-num">{v.host || DASH}{v.port ? `:${v.port}` : ''}</span> <small className="fm-mono">{v.username || ''}</small></td>
                    <td>{r.action === 'error' ? (v.agent || '중앙') : nodeText(v.agent)}</td>
                    <td className={r.action === 'error' ? 'fm-why' : 'fm-dim'}>{r.action === 'error' ? r.reason : r.action === 'update' ? csvChangeText(r) : r.action === 'same' ? '바뀐 것 없음' : '새로 등록'}</td>
                  </tr>
                );
              })}</tbody>
            </STable>
          </div>
          <div className="fm-row">
            <span className="fm-lbl">적용 방식</span>
            <Seg label="적용 방식" value={mode} onChange={setMode} options={[['valid', '맞는 줄만 넣기'], ['all', '모두 맞을 때만 넣기']]} />
            <label className="fm-chk"><input type="checkbox" checked={update} onChange={(e) => setUpdate(e.target.checked)} /> 같은 IP · 포트는 고치기</label>
            <label className="fm-chk"><input type="checkbox" checked={autoTest} onChange={(e) => setAutoTest(e.target.checked)} /> 넣은 서버 바로 연결 시험</label>
            <button type="button" className="fm-btn pri" disabled={!!busy || plan.overCap || (willAdd + willUpd === 0)} onClick={apply}>적용 — 새로 {willAdd} · 고침 {willUpd}</button>
          </div>
          {mode === 'all' && c.error ? <span className="fm-dim">오류 줄이 {c.error}개라 ‘모두 맞을 때만’ 으로는 아무것도 넣지 않습니다.</span> : null}
        </>
      ) : null}
    </div>
  );
}

/* ── 노드 카드(공개키 · 연결 진단 · 깨우기 · 옮기기) ───────────────────────────── */
export function NodeCard({ x, main, busy, run, setMsg, count, onInstall, installOn }) {
  const [moveTo, setMoveTo] = useState(null);
  const now = main.now || Date.now();
  const edge = x.kind === 'edge';
  const w = x.wake ? WAKE_TEXT[x.wake.kind] || { label: x.wake.kind, tone: 'warn' } : null;
  const up = edge ? upgradeText(x, main) : '';
  const items = edge ? diagItems(x.diag, now) : [];
  const others = main.nodes.filter((n) => (n.agent || '') !== (x.agent || '') && (n.kind === 'central' || n.known !== false));
  const doMove = () => {
    const to = moveTo || '';
    if (!window.confirm(`${nodeText(x.agent)} 이(가) 맡은 서버 ${count}대를 ${nodeText(to)}(으)로 옮길까요? 옮긴 서버에는 ${nodeText(to)} 의 공개키를 넣어야 접속됩니다.`)) return;
    run('move', async () => {
      const r = await postJson('/tools/focus-mon/targets/move', { from: x.agent || '', to });
      setMoveTo(null);
      return { ok: true, reason: `${r.moved.length}대를 ${nodeText(to)}(으)로 옮겼습니다${r.skipped ? ` · 같은 접속처가 이미 있어 ${r.skipped}대는 건너뛰었습니다` : ''}. 그 노드의 공개키를 넣은 뒤 연결 시험을 누르세요.` };
    });
  };
  return (
    <div className={`fm-key ${x.key?.publicKey ? '' : 'dash'}`}>
      <div className="fm-row fm-between">
        <span><b>{nodeText(x.agent)}</b> <span className="fm-dim">· 서버 {count}대{edge ? ` · ${x.online ? '연결됨' : x.at ? `마지막 동기화 ${agoShort(x.at, now)}` : '동기화 기록 없음'}${x.version ? ` · v${x.version}` : ''}` : ''}</span></span>
        <span className="fm-row">
          {x.key?.publicKey ? <button type="button" className="fm-btn sm" onClick={() => setMsg(copyText(x.key.publicKey) ? { tone: 'ok', text: '공개키를 복사했습니다.' } : { tone: 'bad', text: '복사하지 못했습니다 — 글을 직접 선택해 복사하세요.' })}>공개키 복사</button> : null}
          {x.key?.publicKey ? <button type="button" className={`fm-btn sm ${installOn ? 'pri' : ''}`} onClick={onInstall}>설치 명령</button> : null}
          {!x.key?.publicKey && x.kind === 'central' ? <button type="button" className="fm-btn sm" disabled={!!busy} onClick={() => run('key', () => postJson('/tools/focus-mon/key', {}).then((r) => ({ ok: r?.ok !== false, reason: r?.created ? '중앙 키를 만들었습니다.' : r?.reason || '이미 키가 있습니다.' })))}>키 만들기</button> : null}
          {!x.key?.publicKey && edge ? <span className="fm-badge off">키 없음</span> : null}
          {edge && x.known !== false ? <button type="button" className="fm-btn sm" disabled={!!busy} onClick={() => run('wake', async () => { const r = await postJson(`/tools/focus-mon/edges/${encodeURIComponent(x.agent)}/wake`, {}); const k = WAKE_TEXT[r.wake?.kind]; return { ok: !!r.wake?.ok, reason: `엣지 ${x.agent}: ${k?.label || r.wake?.kind || DASH}${r.wake?.ms != null ? ` · ${r.wake.ms} ms` : ''}${r.wake?.ok ? '' : ` — ${k?.hint || r.wake?.reason || ''}`}` }; })}>다시 깨우기</button> : null}
          {count > 0 ? <button type="button" className="fm-btn sm" disabled={!!busy} onClick={() => setMoveTo(moveTo == null ? (others[0]?.agent || '') : null)}>서버 옮기기</button> : null}
        </span>
      </div>
      {x.key?.publicKey ? <><span className="fm-mono fm-key-pub">{x.key.publicKey}</span><span className="fm-mono fm-dim">지문 {x.key.fingerprint}</span></>
        : <span className="fm-dim">{x.kind === 'central' ? '중앙 키가 없습니다 — 키 만들기를 누르세요.' : '이 엣지에 서버를 처음 등록하면 엣지가 키를 만들어 공개키를 올립니다(다음 동기화 때).'}</span>}
      {x.key?.error ? <span className="fm-ban w">{x.key.error}</span> : null}
      {up ? <span className="fm-ban w">{up}</span> : null}
      {edge && x.known === false ? <span className="fm-ban w">수집 서버 등록부에 없는 이름입니다 — 이 노드의 서버는 수집하지 않습니다. 옮기거나 수집 서버를 등록하세요.</span> : null}
      {edge ? (
        <div className="fm-diag">
          <span className="fm-row"><span className="fm-lbl">깨우기</span>{w ? <><Badge b={w} /><span className="fm-dim">{x.wake.ms != null ? `${x.wake.ms} ms · ` : ''}{agoShort(x.wake.at, now)}{x.wake.by === 'manual' ? ' · 직접 누름' : ''}</span></> : <span className="fm-dim">아직 깨운 적 없음(수집 시작 · 시험 때 깨웁니다)</span>}</span>
          {w && !x.wake.ok ? <span className="fm-dim">{w.hint || x.wake.reason || ''} {wakeFallbackText(x)}</span> : null}
          {items.length ? <span className="fm-row">{items.map(([k, v]) => <span key={k} className="fm-dim"><span className="fm-lbl">{k}</span> {v}</span>)}</span>
            : x.at ? <span className="fm-dim">{x.upgrade === 'diag' ? '이 엣지는 연결 진단을 보내지 않는 판입니다.' : '진단 정보가 아직 없습니다(다음 동기화 때 옵니다).'}</span> : null}
        </div>
      ) : null}
      {moveTo != null ? (
        <div className="fm-row">
          <span className="fm-lbl">받을 노드</span>
          <Select sort={false} className="fm-input fm-sel-sm" value={moveTo} onChange={(e) => setMoveTo(e.target.value)} aria-label="받을 노드">
            {others.map((n) => <option key={n.agent || 'central'} value={n.agent || ''}>{nodeText(n.agent)}</option>)}
          </Select>
          <button type="button" className="fm-btn pri sm" disabled={!!busy || !others.length} onClick={doMove}>{count}대 옮기기</button>
          <button type="button" className="fm-btn sm" onClick={() => setMoveTo(null)}>취소</button>
        </div>
      ) : null}
    </div>
  );
}

/* ── 설치 명령(노드 · 계정별) ──────────────────────────────────────────────── */
export function InstallCard({ node, main, setMsg, defaultUser }) {
  if (!node?.key?.publicKey) return null;
  const groups = installGroups(main.targets, node.agent);
  const list = groups.length ? groups : [{ user: defaultUser || 'dvcmon', hosts: [] }];
  const copy = (t, what) => setMsg(copyText(t) ? { tone: 'ok', text: `${what}을(를) 복사했습니다.` } : { tone: 'bad', text: '복사하지 못했습니다 — 글을 직접 선택해 복사하세요.' });
  return (
    <div className="fm-card">
      <h3 className="fm-h3">대상 서버에 넣는 방법 — {nodeText(node.agent)} 키</h3>
      <span className="fm-dim">{groups.length ? `이 노드가 맡은 서버 ${groups.reduce((a, g) => a + g.hosts.length, 0)}대를 계정별로 묶었습니다 — 계정마다 같은 명령을 그 서버들에서 한 번씩 실행합니다.` : '이 노드가 맡은 서버가 아직 없습니다 — 등록할 계정 이름으로 보입니다.'}</span>
      {list.map((g) => (
        <div key={g.user} className="fm-col">
          <div className="fm-row fm-between"><b>계정 {g.user}{g.hosts.length ? ` · 서버 ${g.hosts.length}대` : ''}</b>
            <span className="fm-row">
              <button type="button" className="fm-btn sm" onClick={() => copy(installCommand(node.key.publicKey, g.user), '명령')}>명령 복사</button>
              {g.hosts.length ? <button type="button" className="fm-btn sm" onClick={() => copy(g.hosts.join('\n'), '서버 목록')}>서버 목록 복사</button> : null}
            </span></div>
          <pre className="fm-code">{installCommand(node.key.publicKey, g.user)}</pre>
          {g.hosts.length ? <span className="fm-dim fm-mono">{g.hosts.slice(0, 12).join(' · ')}{g.hosts.length > 12 ? ` 외 ${g.hosts.length - 12}대` : ''}</span> : null}
        </div>
      ))}
      <span className="fm-dim">{INSTALL_NOTE}</span>
      <span className="fm-dim">{KEY_FILE_NOTE}</span>
    </div>
  );
}

