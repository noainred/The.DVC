/**
 * ServerCmdTool.jsx — 특수 기능 ‘서버 명령 실행’(v3.30 · 설계 docs/design/server-cmd ③).
 * 등록된 서버에 **정해 둔 확인 명령(프리셋)** 을 누를 때만 돌리고 출력을 본다. 읽기 전용 · sudo 없음 · 명령 글자를 넣는 칸이 없다(프리셋과 값만).
 * 계정 · 로그인은 설정 › 보안 › 서버 접속(SSH · Windows)이 정한다 — 이 화면은 계정을 고르지 않는다.
 * 출력은 서버 메모리에 마지막 실행 한 건만(끝나고 30분 — 숫자는 API 값) · 화면은 글자로만 그린다(HTML 로 해석하지 않는다).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import { fmtAgo, fmtTime } from '../../util/fmt.js';
import { copyText } from '../../util/copyText.js';
import { CODE_TEXT, CRED_TEXT, codeTone, pickIssue, sourceText, osText, paramsText, resultText, msText, resultCounts, copyAllText } from './serverCmdText.js';
import { Chip } from '../sshAccessParts.jsx';   // 서버 접속 화면과 같은 칩(같은 CSS)
import { toneVar } from './toneVar.js';
import '../sshAccess.css';
import './serverCmd.css';

export default function ServerCmdTool() {
  const [v, setV] = useState(null);
  const [err, setErr] = useState(null);
  const [group, setGroup] = useState('');
  const [presetId, setPresetId] = useState('');
  const [params, setParams] = useState({});
  const [preview, setPreview] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [corp, setCorp] = useState('');
  const [osF, setOsF] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [outs, setOuts] = useState(() => new Map());   // 서버 id → 출력(마지막 실행 — 펼친 것만 받아 둔다)
  const [open, setOpen] = useState(() => new Set());
  const pvSeq = useRef(0);
  const load = useCallback(async () => { try { setV(await fetchJson('/tools/server-cmd')); setErr(null); } catch (e) { setErr(e); } }, []);
  useEffect(() => { load(); }, [load]);
  // 실행은 서버가 백그라운드로 돈다(202) — 도는 동안만 3초마다 다시 읽는다(끝나면 멈춘다 · 상시 폴링 없음)
  const running = !!v?.job;
  useEffect(() => { if (!running) return undefined; const id = setTimeout(load, 3000); return () => clearTimeout(id); }, [running, v, load]);
  const presets = useMemo(() => v?.presets || [], [v]);
  const groups = useMemo(() => v?.groups || [], [v]);
  const curGroup = group || groups[0] || '';
  const preset = presets.find((p) => p.id === presetId) || null;
  // 미리 보기 — 서버가 만든 명령 그대로(값 검사를 지난 것만). 늦게 온 이전 응답은 버린다.
  useEffect(() => {
    if (!preset) { setPreview(null); return undefined; }
    const my = ++pvSeq.current;
    const id = setTimeout(async () => {
      try {
        const r = await fetchJson('/tools/server-cmd/preview', { preset: preset.id, ...params }, undefined, { retries: 0 });
        if (my === pvSeq.current) setPreview({ ok: true, linux: r.linux, windows: r.windows });
      } catch (e) { if (my === pvSeq.current) setPreview({ ok: false, reason: String(e?.message || e) }); }
    }, 250);
    return () => clearTimeout(id);
  }, [preset, params]);
  // 새 실행이 보이면 받아 둔 출력 · 펼침을 비운다(마지막 실행 한 건만)
  const lastKey = v?.last ? `${v.last.preset}|${v.last.startedAt}` : '';
  useEffect(() => { setOuts(new Map()); setOpen(new Set()); }, [lastKey]);
  const servers = useMemo(() => v?.servers || [], [v]);
  const corps = useMemo(() => [...new Set(servers.map((s) => s.corp).filter(Boolean))].sort(), [servers]);
  const shown = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return servers.filter((s) => (!corp || s.corp === corp) && (!osF || (osF === 'none' ? !s.os : s.os === osF))
      && (!ql || `${s.name} ${s.host}`.toLowerCase().includes(ql)));
  }, [servers, corp, osF, q]);
  const pickable = useMemo(() => shown.filter((s) => !pickIssue(s, preset)), [shown, preset]);
  const lastRows = useMemo(() => v?.last?.rows || [], [v]);
  const counts = useMemo(() => resultCounts(lastRows), [lastRows]);
  if (err) return <ErrorBox error={err} />;
  if (!v) return <Loading />;
  const max = v.limits?.batch || 50;
  const pickedIds = [...picked].filter((id) => servers.some((s) => s.id === id && !pickIssue(s, preset)));
  const paramsOk = !!preset && !!preview?.ok;
  const pickPreset = (id) => { setPresetId(id); setParams({}); setMsg(null); };
  const toggle = (id) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const run = async () => {
    if (!preset || !pickedIds.length) return;
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/tools/server-cmd/run', { preset: preset.id, params, ids: pickedIds });
      if (!r?.ok) setMsg({ tone: 'bad', text: r?.reason || '실행하지 못했습니다.' });
      else setMsg({ tone: 'ok', text: `${r.total}대에 실행을 시작했습니다 — 끝나면 아래 결과가 바뀝니다(응답 없는 서버가 섞이면 몇 분 걸립니다).` });
    } catch (e) { setMsg({ tone: 'bad', text: String(e?.message || e) }); }
    setBusy(false); load();
  };
  const fetchOut = async (id = '') => {
    const r = await fetchJson('/tools/server-cmd/output', id ? { id } : {});
    setOuts((m) => { const n = new Map(m); for (const x of r.rows || []) n.set(x.id, x); return n; });
    return r.rows || [];
  };
  const toggleOpen = async (id) => {
    if (open.has(id)) { setOpen((s) => { const n = new Set(s); n.delete(id); return n; }); return; }
    try { if (!outs.has(id)) await fetchOut(id); setOpen((s) => new Set(s).add(id)); } catch (e) { setMsg({ tone: 'bad', text: String(e?.message || e) }); }
  };
  const openAll = async () => {
    try { const rows = await fetchOut(); setOpen(new Set(rows.map((x) => x.id))); } catch (e) { setMsg({ tone: 'bad', text: String(e?.message || e) }); }
  };
  const copyOne = async (o) => { const ok = await copyText(o.out || ''); setMsg({ tone: ok ? 'ok' : 'bad', text: ok ? `${o.name} 출력을 복사했습니다.` : '복사하지 못했습니다(브라우저가 막음).' }); };
  const copyAll = async () => {
    try {
      const rows = await fetchOut();
      const ok = await copyText(copyAllText(v.last?.label || '', rows));
      setMsg({ tone: ok ? 'ok' : 'bad', text: ok ? `${rows.length}대 출력을 복사했습니다.` : '복사하지 못했습니다(브라우저가 막음).' });
    } catch (e) { setMsg({ tone: 'bad', text: String(e?.message || e) }); }
  };
  const last = v.last;
  const lastPreset = last ? presets.find((p) => p.id === last.preset) : null;
  const openRows = lastRows.filter((r) => open.has(r.id) && outs.has(r.id));
  return (
    <div className="ssa">
      <div className="ssa-head">
        <div className="ssa-title">
          <h3>서버 명령 실행</h3>
          <p className="ssa-note">등록된 서버에 <b>정해 둔 확인 명령</b>을 누를 때만 돌리고 출력을 봅니다. 읽기 전용 · sudo 를 쓰지 않음 · 명령 글자를 직접 넣는 칸은 없습니다. 출력은 저장하지 않고 포탈 메모리에 마지막 실행 한 건만 {v.limits?.ttlMin ?? '—'}분 둡니다. 계정은 설정 › 보안 › 서버 접속(SSH · Windows)에서 정하고, 계정 · 키마다 ‘서버 명령 실행’ 을 직접 켜야 씁니다.</p>
        </div>
        <button className="btn btn-sm" type="button" onClick={load}>다시 읽기(화면)</button>
      </div>

      <div className="scm-split">
        <section className="scm-card scm-presets" aria-label="프리셋 고르기">
          <div className="scm-step"><span className="scm-num">1</span><h4>프리셋 고르기</h4></div>
          <div className="ssa-tabs" role="tablist" aria-label="프리셋 묶음">
            {groups.map((g) => (
              <button key={g} type="button" role="tab" aria-selected={g === curGroup} className={`ssa-tab${g === curGroup ? ' on' : ''}`} onClick={() => setGroup(g)}>
                {g} {presets.filter((p) => p.group === g).length}
              </button>
            ))}
          </div>
          <div className="scm-list">
            {presets.filter((p) => p.group === curGroup).map((p) => (
              <button key={p.id} type="button" className={`scm-pi${p.id === presetId ? ' on' : ''}`} aria-pressed={p.id === presetId} onClick={() => pickPreset(p.id)}>
                <span className="scm-pi-l">{p.label}</span>
                {p.params.length > 0 && <Chip>값</Chip>}
                {p.os.map((o) => <Chip key={o}>{o === 'windows' ? 'Windows' : 'Linux'}</Chip>)}
              </button>
            ))}
          </div>
          {preset && (
            <>
              {preset.params.map((d) => (
                <div className="scm-field" key={d.name}>
                  <label htmlFor={`scm-p-${d.name}`}>{d.label}</label>
                  <input id={`scm-p-${d.name}`} type="text" maxLength={d.max} value={params[d.name] || ''} autoComplete="off" spellCheck={false}
                    onChange={(e) => setParams((x) => ({ ...x, [d.name]: e.target.value }))} />
                  <span className="ssa-sub">{d.hint}</span>
                </div>
              ))}
              {preset.note && <p className="ssa-note">{preset.note}</p>}
              <div className="scm-field">
                <span className="ssa-sub">실행될 명령 — 서버가 만든 것을 그대로 보여 줍니다</span>
                {preview && !preview.ok && <span className="ssa-sub" style={{ color: toneVar('warn') }}>{preview.reason}</span>}
                {preview?.ok && preview.linux && <><span className="ssa-sub">Linux</span><pre className="scm-pre cmd">{preview.linux}</pre></>}
                {preview?.ok && preview.windows && <><span className="ssa-sub">Windows <Chip tone="warn" title="실제 Windows 서버 출력으로 확인하지 못했습니다">시험</Chip> — PowerShell(Base64 로 바꿔 넘김)</span><pre className="scm-pre cmd">{preview.windows}</pre></>}
              </div>
              <div className="ssa-acts">
                <Chip tone="ok">읽기 전용</Chip>
                {preset.timeoutS.linux != null && <Chip>Linux 시한 {preset.timeoutS.linux}초</Chip>}
                {preset.timeoutS.windows != null && <Chip>Windows 시한 {preset.timeoutS.windows}초</Chip>}
                <Chip>출력 상한 {Math.round((v.limits?.maxBytes || 0) / 1024)}KB</Chip>
              </div>
            </>
          )}
          {!preset && <p className="ssa-sub">왼쪽 묶음에서 프리셋을 고르세요.</p>}
        </section>

        <section className="scm-card scm-targets" aria-label="대상 서버 고르기">
          <div className="scm-step"><span className="scm-num">2</span><h4>대상 서버 고르기</h4></div>
          <div className="scm-filters">
            <div className="scm-field">
              <label htmlFor="scm-corp">법인</label>
              <Select id="scm-corp" value={corp} onChange={(e) => setCorp(e.target.value)}>
                <option value="">전체</option>
                {corps.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </div>
            <div className="scm-field">
              <label htmlFor="scm-os">OS 종류</label>
              <Select id="scm-os" value={osF} sort={false} onChange={(e) => setOsF(e.target.value)}>
                <option value="">전체</option><option value="linux">Linux</option><option value="windows">Windows</option><option value="none">미지정</option>
              </Select>
            </div>
            <div className="scm-field grow">
              <label htmlFor="scm-q">찾기</label>
              <input id="scm-q" type="search" placeholder="서버 이름 · 주소" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <button className="btn btn-sm" type="button" disabled={!pickable.length} onClick={() => setPicked(new Set(pickable.map((s) => s.id)))}>고를 수 있는 서버 모두 선택({pickable.length})</button>
            <button className="btn btn-sm" type="button" disabled={!picked.size} onClick={() => setPicked(new Set())}>선택 지우기</button>
          </div>
          <STable minWidth={720} className="ssa-t scm-t" limit={300}>
            <thead><tr>
              <th data-nosort><span className="ssa-sub">선택</span></th><th>서버</th><th>법인</th><th>OS</th><th>계정이 오는 곳</th><th>고를 수 있나</th>
            </tr></thead>
            <tbody>
              {shown.map((s) => {
                const issue = pickIssue(s, preset);
                return (
                  <tr key={s.id}>
                    <td data-nosort>{issue ? null : <input type="checkbox" aria-label={`${s.name} 고르기`} checked={picked.has(s.id)} onChange={() => toggle(s.id)} />}</td>
                    <td data-sort={s.name}><b>{s.name}</b><div className="ssa-sub"><code>{s.host}{s.port !== 22 ? `:${s.port}` : ''}</code></div></td>
                    <td data-sort={s.corp}>{s.corp || '—'}</td>
                    <td data-sort={s.os}>{osText(s.os)}</td>
                    <td data-sort={sourceText(s)}>{sourceText(s)}</td>
                    <td data-sort={issue ? issue.label : '가능'}>{s.running ? <Chip tone="muted">실행 중</Chip> : issue ? <Chip tone={issue.tone}>{issue.label}</Chip> : <Chip tone="ok">가능</Chip>}</td>
                  </tr>
                );
              })}
              {!shown.length && <tr><td colSpan={6} className="ssa-sub">{servers.length ? '조건에 맞는 서버가 없습니다.' : '등록된 서버가 없습니다 — 베어메탈 스토리지 · 서버 등록(온보딩)에서 서버를 등록합니다.'}</td></tr>}
            </tbody>
          </STable>
          <div className="ssa-acts" style={{ justifyContent: 'space-between' }}>
            <span className="ssa-sub">선택 <b>{pickedIds.length}</b>대 · 한 번에 최대 {max}대 · 동시에 {v.limits?.concurrency ?? '—'}대씩</span>
            <button className="btn btn-sm primary" type="button" disabled={busy || running || !paramsOk || !pickedIds.length || pickedIds.length > max} onClick={run}>
              {running ? `실행 중 ${v.job.done}/${v.job.total}대…` : `선택한 ${pickedIds.length}대에 실행`}
            </button>
          </div>
          {pickedIds.length > max && <span className="ssa-sub" style={{ color: toneVar('warn') }}>한 번에 {max}대까지입니다.</span>}
          {running && v.job.by && <span className="ssa-sub">{v.job.by} 님이 {v.job.meta?.label || '프리셋'} 실행 중 — 끝난 뒤 다시 누를 수 있습니다.</span>}
          {msg && <span className="ssa-sub" style={{ color: toneVar(msg.tone) }}>{msg.text}</span>}
        </section>
      </div>

      <section className="scm-card" aria-label="결과">
        <div className="ssa-acts">
          <span className="scm-num">3</span><h4 style={{ margin: 0 }}>결과</h4>
          {last ? <span className="ssa-sub">{last.label}{paramsText(lastPreset, last.params) ? ` · ${paramsText(lastPreset, last.params)}` : ''} · {fmtTime(last.startedAt)} · {last.by} 실행 · {last.rows.length} / {last.total}대 끝남</span>
            : <span className="ssa-sub">아직 실행하지 않았거나, 지난 출력이 지워졌습니다({v.limits?.ttlMin ?? '—'}분이 지나면 지웁니다).</span>}
        </div>
        {last && (
          <>
            <div className="ssa-acts" style={{ justifyContent: 'space-between' }}>
              <div className="ssa-acts">
                <Chip tone="ok">실행됨 {counts.ran}</Chip>
                {counts.partial > 0 && <Chip tone="warn">시한 · 잘림 {counts.partial}</Chip>}
                <Chip tone={counts.failed ? 'bad' : 'muted'}>실행 못 함 {counts.failed}</Chip>
                {counts.nonZero > 0 && <Chip tone="warn" title="끝 코드가 0 이 아니어도 실패로 치지 않습니다 — 출력을 보세요">끝 코드 0 아님 {counts.nonZero}</Chip>}
                {last.expiresAt && <span className="ssa-sub">{fmtAgo(last.finishedAt)} 끝남 · {fmtTime(last.expiresAt)}에 지움</span>}
              </div>
              <div className="ssa-acts">
                <button className="btn btn-sm" type="button" disabled={!lastRows.some((r) => r.ran)} onClick={openAll}>모두 펼치기</button>
                <button className="btn btn-sm" type="button" disabled={!lastRows.some((r) => r.ran)} onClick={copyAll}>전체 복사</button>
              </div>
            </div>
            <STable minWidth={860} className="ssa-t scm-t" limit={300}>
              <thead><tr><th>서버</th><th>결과</th><th>출력 첫 줄 · 사유</th><th>줄 수</th><th>걸린 시간</th><th data-nosort><span className="ssa-sub">보기</span></th></tr></thead>
              <tbody>
                {lastRows.map((r) => (
                  <tr key={r.id}>
                    <td data-sort={r.name}><b>{r.name}</b>{r.demo && <div className="ssa-sub">데모 서버</div>}</td>
                    <td data-sort={r.code}><Chip tone={codeTone(r.code)}>{resultText(r)}</Chip>{r.os === 'windows' && r.ran && <Chip tone="warn" title="실제 Windows 서버 출력으로 확인하지 못한 프리셋입니다">시험</Chip>}</td>
                    <td data-sort={r.first || r.reason}>
                      {r.ran ? <span className="scm-first">{r.first || <span className="ssa-sub">출력 없음</span>}</span>
                        : <span className="ssa-sub">{r.code === 'cred' && CRED_TEXT[r.credCode] ? CRED_TEXT[r.credCode] : (r.reason || CODE_TEXT[r.code] || '—')}</span>}
                      {r.ran && r.partial && <div className="ssa-sub" style={{ color: toneVar('warn') }}>{r.reason}</div>}
                    </td>
                    <td data-sort={r.ran ? r.lines : -1}>{r.ran ? r.lines : '—'}{r.cut && <div><Chip tone="warn">잘림</Chip></div>}</td>
                    <td data-sort={r.ms ?? -1}>{msText(r.ms)}</td>
                    <td data-nosort>{r.ran ? <button className="btn btn-sm" type="button" aria-expanded={open.has(r.id)} onClick={() => toggleOpen(r.id)}>{open.has(r.id) ? '접기' : '펼치기'}</button> : <span className="ssa-sub">—</span>}</td>
                  </tr>
                ))}
                {!lastRows.length && <tr><td colSpan={6} className="ssa-sub">진행 중 — 끝난 서버부터 보입니다.</td></tr>}
              </tbody>
            </STable>
            {openRows.map((r) => {
              const o = outs.get(r.id);
              return (
                <div className="scm-out" key={r.id}>
                  <div className="ssa-acts" style={{ justifyContent: 'space-between' }}>
                    <span className="ssa-sub"><b style={{ color: 'var(--text)' }}>{r.name}</b> · {r.via === 'winrm' ? 'WinRM' : 'SSH'} · {r.auth?.kind === 'key' ? '키' : '비밀번호'}{r.auth?.account ? ` · ${r.auth.account}` : ''} · {osText(r.os)} · {resultText(r)}{o.cut ? ' · 잘림' : ''}</span>
                    <div className="ssa-acts">
                      <button className="btn btn-sm" type="button" onClick={() => copyOne(o)}>복사</button>
                      <button className="btn btn-sm" type="button" onClick={() => toggleOpen(r.id)}>접기</button>
                    </div>
                  </div>
                  <pre className="scm-pre">{o.out || '(출력 없음)'}</pre>
                  {o.err && <><span className="ssa-sub">오류 출력</span><pre className="scm-pre cmd">{o.err}</pre></>}
                </div>
              );
            })}
          </>
        )}
      </section>
    </div>
  );
}
