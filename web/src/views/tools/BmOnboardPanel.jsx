/**
 * BmOnboardPanel.jsx — 7b단계 설정 › 베어메탈 성능 › 서버 등록(설계 PROFILES §18 · 아트보드 Onboard · Security).
 * 순서: SSH 키 저장소 → 법인 공통 계정 → CSV/Excel 등록(파일 → 미리보기 · 검증 → 적용) → 엣지 배포 목록(중앙) → 누락 점검.
 *  · 판정은 서버가 한다(행 판정 · 사유 · 경고 · 누락 칸) — 화면은 그대로 그린다.
 *  · 키 · 공통 계정 관리는 설정 소유자 등급 + 본인 OTP(서버가 다시 막는다). 개인키 · passphrase · 비밀번호는 보내기만 하고 다시 받지 않는다.
 *  · 무거운 API 는 폴링하지 않는다(마운트 1회 + 버튼). 늦게 온 이전 응답은 버린다(gen).
 */
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, postJson, delJson, hasRole, getCurrentUser, downloadFile } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import BoldText from '../../components/boldText.jsx';
import { toneVar } from './toneVar.js';
import { downloadBlob } from './bmCapture.js';
import {
  ACTION_TEXT, ACTION_TONE, BUCKET_TEXT, BUCKET_ORDER, MISS_REASON_TEXT, KEY_STATUS_TEXT, ACCOUNT_KIND_TEXT,
  numOr, summaryChips, applicable, edgeSyncText, shortFp, ymd, bufToBase64, suggestCsv, rowNote, canManageKeys,
} from './bmOnboardText.js';
import './bmOps.css';
import './bmOnboard.css';

const errText = (e) => e?.body?.reason || e?.message || String(e);
function useLoad(path) {
  const [st, setSt] = useState({ loading: true, resp: null, err: null });
  const gen = useRef(0);
  const load = async () => {
    const g = ++gen.current;
    setSt((p) => ({ ...p, loading: true, err: null }));
    try { const r = await fetchJson(path, {}, undefined, { timeoutMs: 60_000 }); if (g === gen.current) setSt({ loading: false, resp: r, err: null }); }
    catch (e) { if (g === gen.current) setSt({ loading: false, resp: null, err: e }); }
  };
  useEffect(() => { load(); }, [path]);   // eslint-disable-line react-hooks/exhaustive-deps -- load 는 path 만 본다(gen 으로 늦은 응답 버림)
  return [st, load];
}
const Chip = ({ tone = 'muted', children, title }) => <span className={`bmob-chip bmob-${tone}`} title={title}>{children}</span>;

/* ── SSH 키 저장소 ─────────────────────────────────────────────────── */
function KeysSection({ manage, onChanged }) {
  const [st, load] = useLoad('/tools/bm-usage/ssh-keys');
  const [f, setF] = useState({ name: '', privateKey: '', passphrase: '', rotateAt: '', otp: '' });
  const [rot, setRot] = useState({ from: '', to: '', otp: '' });
  const [msg, setMsg] = useState({ text: '', tone: 'muted' });
  const [busy, setBusy] = useState(false);
  const keys = st.resp?.keys || [];
  const add = async () => {
    setBusy(true); setMsg({ text: '', tone: 'muted' });
    try {
      const r = await postJson('/tools/bm-usage/ssh-keys', { name: f.name, privateKey: f.privateKey, passphrase: f.passphrase, rotateAt: f.rotateAt || undefined, otp: f.otp });
      if (r?.ok === false) { setMsg({ text: `등록하지 못했습니다 — ${r.reason || r.code}`, tone: 'bad' }); return; }
      setMsg({ text: `등록했습니다 — ${r.key.algo} ${r.key.bits ?? ''} · ${r.key.fingerprint}`, tone: 'ok' });
      setF({ name: '', privateKey: '', passphrase: '', rotateAt: '', otp: '' });
      load(); onChanged?.();
    } catch (e) { setMsg({ text: `등록하지 못했습니다 — ${errText(e)}`, tone: 'bad' }); setF((x) => ({ ...x, otp: '' })); }
    finally { setBusy(false); }
  };
  const del = async (k) => {
    const otp = window.prompt(`키 ‘${k.name}’ 를 지웁니다 — 본인 OTP(없으면 비워 두세요)`, '');
    if (otp === null) return;
    try {
      const r = await delJson(`/tools/bm-usage/ssh-keys/${encodeURIComponent(k.id)}?otp=${encodeURIComponent(otp)}`);
      if (r?.ok === false) { setMsg({ text: `지우지 못했습니다 — ${r.reason || r.code}`, tone: 'bad' }); return; }
      setMsg({ text: `지웠습니다 — ${k.name}`, tone: 'ok' }); load(); onChanged?.();
    } catch (e) { setMsg({ text: `지우지 못했습니다 — ${errText(e)}`, tone: 'bad' }); }
  };
  const rotate = async () => {
    setBusy(true); setMsg({ text: '', tone: 'muted' });
    try {
      const r = await postJson('/tools/bm-usage/ssh-keys/rotate', rot);
      if (r?.ok === false) { setMsg({ text: `회전하지 못했습니다 — ${r.reason || r.code}`, tone: 'bad' }); return; }
      setMsg({ text: `회전했습니다 — 서버 ${r.servers.length}대 · 공통 계정 ${r.accounts}개가 새 키를 씁니다.${r.retestAdvised ? ' 서버마다 ‘연결 시험’ 을 다시 하세요(자동 재시험 없음).' : ''}`, tone: 'ok' });
      setRot({ from: '', to: '', otp: '' }); load(); onChanged?.();
    } catch (e) { setMsg({ text: `회전하지 못했습니다 — ${errText(e)}`, tone: 'bad' }); setRot((x) => ({ ...x, otp: '' })); }
    finally { setBusy(false); }
  };
  if (st.err) return <section className="bmob-sec"><h4>SSH 키 저장소</h4><ErrorBox error={st.err} /></section>;
  return (
    <section className="bmob-sec">
      <h4>SSH 키 저장소</h4>
      <p className="bmo-note"><BoldText text={'키는 **봉인 저장**하고 화면 · API · 내보내기 · 백업에는 **지문 · 공개키만** 나갑니다. ed25519 권장 · RSA 2048 비트 미만 · DSA 는 받지 않습니다. 포탈은 서버의 authorized_keys 를 건드리지 않습니다 — 공개키 배포는 현장에서 합니다.'} /></p>
      {st.loading && !st.resp ? <p className="bmo-note">읽는 중…</p> : (
        <STable minWidth={980} className="bmo-t" style={{ fontSize: 12 }}>
          <thead><tr><th>이름</th><th>종류</th><th>지문(SHA256)</th><th>등록</th><th>회전 예정</th><th className="right">쓰는 서버</th><th>상태</th>{manage && <th data-nosort>동작</th>}</tr></thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td className="bmo-name" data-sort={k.name}>{k.name}</td>
                <td data-sort={k.algo}>{k.algo}{k.bits ? ` ${k.bits}` : ''}{k.recommended ? <span className="bmo-sub"> · 권장</span> : ''}{k.hasPassphrase ? <span className="bmo-sub"> · passphrase</span> : ''}</td>
                <td data-sort={k.fingerprint}><code title={`${k.fingerprint}\n${k.publicKey}`}>{shortFp(k.fingerprint)}</code></td>
                <td data-sort={k.createdAt || 0}>{ymd(k.createdAt)}<div className="bmo-sub">{k.createdBy || '—'}</div></td>
                <td data-sort={k.rotateAt || 0}>{ymd(k.rotateAt)}{k.rotateDue && <div><Chip tone="warn">예정일 지남</Chip></div>}</td>
                <td className="right" data-sort={k.servers ?? -1}>{numOr(k.servers)}{k.accountsUsing ? <div className="bmo-sub">계정 {k.accountsUsing}</div> : null}</td>
                <td data-sort={k.status}>{KEY_STATUS_TEXT[k.status] || k.status}</td>
                {manage && <td data-nosort><button className="btn btn-sm" type="button" onClick={() => del(k)} disabled={busy}>삭제</button></td>}
              </tr>
            ))}
            {!keys.length && <tr><td colSpan={manage ? 8 : 7} className="bmo-sub">등록한 키가 없습니다.</td></tr>}
          </tbody>
        </STable>
      )}
      {st.resp && st.resp.usageKnown === false && <p className="bmo-note" style={{ color: toneVar('warn') }}>OS 계정 등록부를 읽지 못해 ‘쓰는 서버’ 를 모릅니다(—) — 이 동안 삭제는 막힙니다.</p>}
      {manage ? (
        <div className="bmob-forms">
          <fieldset className="bmob-form">
            <legend>키 등록</legend>
            <label>이름 <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="kr-ops-ed25519" maxLength={64} /></label>
            <label className="bmob-wide">개인키(OpenSSH · PEM) <textarea className="input" rows={4} value={f.privateKey} onChange={(e) => setF({ ...f, privateKey: e.target.value })} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" spellCheck={false} autoComplete="off" /></label>
            <label>passphrase <input className="input" type="password" value={f.passphrase} onChange={(e) => setF({ ...f, passphrase: e.target.value })} autoComplete="new-password" /></label>
            <label>회전 예정일 <input className="input" type="date" value={f.rotateAt} onChange={(e) => setF({ ...f, rotateAt: e.target.value })} /></label>
            <label>본인 OTP <input className="input" inputMode="numeric" value={f.otp} onChange={(e) => setF({ ...f, otp: e.target.value })} maxLength={8} autoComplete="one-time-code" /></label>
            <div><button className="btn btn-primary" type="button" disabled={busy || !f.name || !f.privateKey} onClick={add}>등록</button></div>
          </fieldset>
          <fieldset className="bmob-form">
            <legend>회전(참조 교체)</legend>
            <p className="bmo-sub">순서: 새 키 등록 → 서버 authorized_keys 배포(현장) → 여기서 교체 → 전 서버 연결 시험 → 옛 키 사용 0 이면 삭제.</p>
            <label>옛 키 <Select sort={false} className="select select-sm" value={rot.from} onChange={(e) => setRot({ ...rot, from: e.target.value })}><option value="">선택</option>{keys.filter((k) => k.status === 'active').map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}</Select></label>
            <label>새 키 <Select sort={false} className="select select-sm" value={rot.to} onChange={(e) => setRot({ ...rot, to: e.target.value })}><option value="">선택</option>{keys.filter((k) => k.status === 'active' && k.id !== rot.from).map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}</Select></label>
            <label>본인 OTP <input className="input" inputMode="numeric" value={rot.otp} onChange={(e) => setRot({ ...rot, otp: e.target.value })} maxLength={8} autoComplete="one-time-code" /></label>
            <div><button className="btn" type="button" disabled={busy || !rot.from || !rot.to} onClick={rotate}>참조 교체</button></div>
          </fieldset>
        </div>
      ) : <p className="bmo-note">키 등록 · 회전 · 삭제는 설정 소유자(전체 범위 관리자) + 본인 OTP 로만 합니다.</p>}
      {msg.text && <p className="bmo-note" role="status" style={{ color: toneVar(msg.tone) }}>{msg.text}</p>}
    </section>
  );
}

/* ── 법인 공통 계정 ───────────────────────────────────────────────── */
function AccountsSection({ manage, vcenters, keysRev }) {
  const [st, load] = useLoad('/tools/bm-usage/accounts');
  const [kst, loadKeys] = useLoad('/tools/bm-usage/ssh-keys');
  useEffect(() => { if (keysRev) loadKeys(); }, [keysRev]);   // eslint-disable-line react-hooks/exhaustive-deps -- 키가 바뀐 신호에만 다시 읽는다
  const blank = { id: '', name: '', kind: 'os', corp: '', username: '', keyRef: '', password: '', otp: '' };
  const [f, setF] = useState(blank);
  const [msg, setMsg] = useState({ text: '', tone: 'muted' });
  const [busy, setBusy] = useState(false);
  const accounts = st.resp?.accounts || [];
  const keys = (kst.resp?.keys || []).filter((k) => k.status === 'active');
  const keyName = (id) => (kst.resp?.keys || []).find((k) => k.id === id)?.name || (id ? '(없는 키)' : '—');
  const vcName = (id) => (id ? (vcenters.find((v) => v.id === id)?.name || id) : '전 법인 공용');
  const save = async () => {
    setBusy(true); setMsg({ text: '', tone: 'muted' });
    try {
      const body = { ...f, ...(f.id ? {} : { id: undefined }), password: f.password || undefined };
      const r = await postJson('/tools/bm-usage/accounts', body);
      if (r?.ok === false) { setMsg({ text: `저장하지 못했습니다 — ${r.reason || r.code}`, tone: 'bad' }); return; }
      setMsg({ text: `저장했습니다 — ${r.account.name}${r.droppedSecrets?.length ? ` (법인 · 계정명이 바뀌어 ${r.droppedSecrets.join(' · ')} 를 잇지 않았습니다 — 다시 입력하세요)` : ''}`, tone: r.droppedSecrets?.length ? 'warn' : 'ok' });
      setF(blank); load();
    } catch (e) { setMsg({ text: `저장하지 못했습니다 — ${errText(e)}`, tone: 'bad' }); setF((x) => ({ ...x, otp: '' })); }
    finally { setBusy(false); }
  };
  const del = async (a) => {
    const otp = window.prompt(`공통 계정 ‘${a.name}’ 을 지웁니다 — 본인 OTP(없으면 비워 두세요)`, '');
    if (otp === null) return;
    try {
      const r = await delJson(`/tools/bm-usage/accounts/${encodeURIComponent(a.id)}?otp=${encodeURIComponent(otp)}`);
      if (r?.ok === false) { setMsg({ text: `지우지 못했습니다 — ${r.reason || r.code}`, tone: 'bad' }); return; }
      setMsg({ text: `지웠습니다 — ${a.name}`, tone: 'ok' }); load();
    } catch (e) { setMsg({ text: `지우지 못했습니다 — ${errText(e)}`, tone: 'bad' }); }
  };
  if (st.err) return <section className="bmob-sec"><h4>법인 공통 계정</h4><ErrorBox error={st.err} /></section>;
  return (
    <section className="bmob-sec">
      <h4>법인 공통 계정</h4>
      <p className="bmo-note"><BoldText text={'CSV 의 os_cred · idrac_cred 칸은 **이 이름**을 가리킵니다. 비밀번호는 여기서 한 번 입력해 봉인합니다(CSV 에는 넣지 않습니다). OS 계정은 **기본 키**(키 인증 권장) 또는 비밀번호 · iDRAC 계정은 **읽기 전용 역할** 계정을 권합니다.'} /></p>
      <STable minWidth={900} className="bmo-t" style={{ fontSize: 12 }}>
        <thead><tr><th>이름</th><th>종류</th><th>법인</th><th>계정명</th><th>기본 키</th><th>비밀번호</th><th className="right">쓰는 서버</th>{manage && <th data-nosort>동작</th>}</tr></thead>
        <tbody>
          {accounts.map((a) => (
            <tr key={a.id}>
              <td className="bmo-name" data-sort={a.name}>{a.name}</td>
              <td data-sort={a.kind}>{ACCOUNT_KIND_TEXT[a.kind] || a.kind}</td>
              <td data-sort={vcName(a.corp)}>{vcName(a.corp)}</td>
              <td data-sort={a.username}>{a.username}</td>
              <td data-sort={keyName(a.keyRef)}>{a.kind === 'os' ? keyName(a.keyRef) : '—'}</td>
              <td data-sort={a.hasPassword ? 1 : 0}>{a.hasPassword ? '저장됨' : '없음'}</td>
              <td className="right" data-sort={a.servers ?? -1}>{numOr(a.servers)}</td>
              {manage && <td data-nosort><div className="bmob-acts"><button className="btn btn-sm" type="button" onClick={() => setF({ ...blank, id: a.id, name: a.name, kind: a.kind, corp: a.corp, username: a.username, keyRef: a.keyRef })}>고치기</button><button className="btn btn-sm" type="button" onClick={() => del(a)}>삭제</button></div></td>}
            </tr>
          ))}
          {!accounts.length && <tr><td colSpan={manage ? 8 : 7} className="bmo-sub">공통 계정이 없습니다.</td></tr>}
        </tbody>
      </STable>
      {manage && (
        <fieldset className="bmob-form">
          <legend>{f.id ? `고치기 — ${f.name}` : '공통 계정 추가'}</legend>
          <label>이름 <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={64} /></label>
          <label>종류 <Select sort={false} className="select select-sm" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="os">OS(SSH)</option><option value="idrac">iDRAC</option></Select></label>
          <label>법인 <Select sort={false} className="select select-sm" value={f.corp} onChange={(e) => setF({ ...f, corp: e.target.value })}><option value="">전 법인 공용</option>{vcenters.map((v) => <option key={v.id} value={v.id}>{v.name || v.id}</option>)}</Select></label>
          <label>계정명 <input className="input" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} maxLength={128} autoComplete="off" /></label>
          {f.kind === 'os' && <label>기본 키 <Select sort={false} className="select select-sm" value={f.keyRef} onChange={(e) => setF({ ...f, keyRef: e.target.value })}><option value="">없음(비밀번호)</option>{keys.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}</Select></label>}
          <label>비밀번호 <input className="input" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} placeholder={f.id ? '비우면 그대로' : ''} autoComplete="new-password" /></label>
          <label>본인 OTP <input className="input" inputMode="numeric" value={f.otp} onChange={(e) => setF({ ...f, otp: e.target.value })} maxLength={8} autoComplete="one-time-code" /></label>
          <div className="bmob-acts"><button className="btn btn-primary" type="button" disabled={busy || !f.name || !f.username} onClick={save}>저장</button>{f.id && <button className="btn" type="button" onClick={() => setF(blank)}>취소</button>}</div>
        </fieldset>
      )}
      {msg.text && <p className="bmo-note" role="status" style={{ color: toneVar(msg.tone) }}>{msg.text}</p>}
    </section>
  );
}

/* ── CSV/Excel 등록 ───────────────────────────────────────────────── */
function ImportSection({ onApplied }) {
  const [file, setFile] = useState(null);   // { name, data(base64) } — 서버에 보관하지 않는다(분석 · 적용 요청에만 싣는다)
  const [an, setAn] = useState({ busy: false, resp: null, err: null });
  const [ap, setAp] = useState({ busy: false, msg: '', tone: 'muted' });
  const [only, setOnly] = useState('');
  const gen = useRef(0);
  const pick = async (ev) => {
    const fl = ev.target.files?.[0]; ev.target.value = '';
    if (!fl) return;
    const g = ++gen.current;
    setAn({ busy: true, resp: null, err: null }); setAp({ busy: false, msg: '', tone: 'muted' });
    try {
      const data = bufToBase64(await fl.arrayBuffer());
      const f = { name: fl.name, data };
      if (g !== gen.current) return;
      setFile(f);
      const r = await postJson('/tools/bm-usage/onboard/analyze', { fileName: f.name, data }, { timeoutMs: 120_000 });
      if (g !== gen.current) return;
      if (r?.ok === false) { setAn({ busy: false, resp: null, err: { message: r.reason || r.code } }); return; }
      setAn({ busy: false, resp: r, err: null });
    } catch (e) { if (g === gen.current) setAn({ busy: false, resp: null, err: e }); }
  };
  const apply = async () => {
    const r0 = an.resp;
    if (!r0 || !file) return;
    if (!window.confirm(`신규 ${r0.summary.new} · 갱신 ${r0.summary.update} 행을 적용합니다(거부 ${r0.summary.reject} 행은 적용하지 않습니다). 직전 등록부를 스냅샷으로 남깁니다.`)) return;
    setAp({ busy: true, msg: '', tone: 'muted' });
    try {
      const r = await postJson('/tools/bm-usage/onboard/apply', { fileName: file.name, data: file.data, sig: r0.sig }, { timeoutMs: 180_000 });
      if (r?.ok === false) { setAp({ busy: false, msg: r.code === 'analysis-changed' ? r.reason : `적용하지 못했습니다 — ${r.reason || r.code}`, tone: 'bad' }); return; }
      const a = r.applied || {};
      setAp({ busy: false, msg: r.nothing ? '적용할 행이 없습니다.' : `적용했습니다 — OS ${a.os} · iDRAC ${a.idrac} · 엣지 배포 ${a.edge} · 중앙에서 뺌 ${a.removed}${a.tags ? ` · 태그 ${a.tags}` : ''}(직전 등록부 스냅샷: 설정 폴더 onboard-prev).`, tone: 'ok' });
      setAn({ busy: false, resp: null, err: null }); setFile(null); onApplied?.();
    } catch (e) { setAp({ busy: false, msg: `적용하지 못했습니다 — ${errText(e)}${e?.body?.partial ? ` · 부분 적용(${e.body.step}) — 스냅샷으로 되돌릴 수 있습니다` : ''}`, tone: 'bad' }); }
  };
  const rows = an.resp?.rows || [];
  const shown = only ? rows.filter((r) => (only === 'warn' ? r.action !== 'reject' && r.warnings?.length : r.action === only)) : rows;
  return (
    <section className="bmob-sec">
      <h4>CSV · Excel 로 서버 등록</h4>
      <p className="bmo-note"><BoldText text={'한 장의 표가 iDRAC 등록부 · OS 계정 등록부 · 분류 태그로 나뉘어 들어갑니다(새 등록부 없음). **비밀번호 · 키 내용이 든 행은 거부**합니다 — 자격 칸에는 공통 계정 · SSH 키 **이름**만 적습니다. 파일은 서버에 보관하지 않습니다. 적용 전에 판정을 전부 보여 주고, 적용은 같은 파일을 서버가 다시 분석해 판정이 같을 때만 합니다.'} /></p>
      <div className="bmob-acts">
        <button className="btn" type="button" onClick={() => downloadFile('/tools/bm-usage/onboard/template.csv', 'bm-onboard-template.csv').catch(() => {})}>템플릿 내려받기(CSV)</button>
        <label className="btn btn-primary bmob-file">파일 고르기(CSV · .xlsx)<input type="file" accept=".csv,.tsv,.txt,.xlsx" onChange={pick} /></label>
        {file && <span className="bmo-sub">{file.name}</span>}
      </div>
      {an.busy && <p className="bmo-note">분석 중…</p>}
      {an.err && <ErrorBox error={an.err} />}
      {an.resp && (
        <>
          <div className="bmob-chips">
            {summaryChips(an.resp.summary).map((c) => <button key={c.k} type="button" className={`bmob-chip bmob-${c.tone}${only === c.k ? ' on' : ''}`} onClick={() => setOnly(only === c.k ? '' : c.k)}>{c.text}</button>)}
            <span className="bmo-sub">{an.resp.format === 'xlsx' ? 'Excel 첫 시트' : `CSV · ${an.resp.encoding}`} · {numOr(an.resp.summary.total)}행 · 엣지 {numOr(an.resp.summary.edge)} · 중앙 {numOr(an.resp.summary.central)}</span>
          </div>
          {(an.resp.fileWarnings || []).map((w) => <p key={w} className="bmo-note" style={{ color: toneVar('warn') }}>{w}</p>)}
          <STable minWidth={1000} limit={500} className="bmo-t" style={{ fontSize: 12 }}>
            <thead><tr><th className="right">행</th><th>name</th><th>법인</th><th>경로</th><th>판정</th><th>사유 · 경고</th><th>바뀌는 칸</th></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.line}>
                  <td className="right" data-sort={r.line}>{r.line}</td>
                  <td className="bmo-name" data-sort={r.name}>{r.name || '—'}</td>
                  <td data-sort={r.corpName || r.corp}>{r.corpName || r.corp || '—'}</td>
                  <td data-sort={`${r.via}${r.agent}`}>{r.via ? (r.via === 'edge' ? `edge${r.agent ? ` → ${r.agent}` : ''}` : 'central') : '—'}</td>
                  <td data-sort={r.action}><Chip tone={ACTION_TONE[r.action]}>{ACTION_TEXT[r.action] || r.action}</Chip></td>
                  <td className="bmo-wrap bmob-note-cell" data-sort={rowNote(r)}>{rowNote(r) || '—'}</td>
                  <td data-sort={(r.changes || []).join(' ')}>{(r.changes || []).join(' · ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </STable>
          {shown.length > 500 && <p className="bmo-sub">앞 500행만 그립니다 — 전체는 결과 CSV 로 보세요.</p>}
          <div className="bmob-acts">
            <button className="btn" type="button" onClick={() => downloadBlob(new Blob([an.resp.resultCsv], { type: 'text/csv;charset=utf-8' }), 'bm-onboard-result.csv')}>결과 CSV(판정 열)</button>
            <button className="btn btn-primary" type="button" disabled={ap.busy || !applicable(an.resp.summary)} onClick={apply}>{ap.busy ? '적용 중…' : '적용'}</button>
          </div>
        </>
      )}
      {ap.msg && <p className="bmo-note" role="status" style={{ color: toneVar(ap.tone) }}>{ap.msg}</p>}
    </section>
  );
}

/* ── 엣지 배포 목록(중앙) ─────────────────────────────────────────── */
function EdgeRowsSection({ rev }) {
  const [st, load] = useLoad('/tools/bm-usage/onboard/edge-rows');
  useEffect(() => { if (rev) load(); }, [rev]);   // eslint-disable-line react-hooks/exhaustive-deps -- 적용 뒤 신호에만 다시 읽는다
  const [msg, setMsg] = useState('');
  const agents = st.resp?.agents || [];
  if (st.resp?.edge) return null;
  const remove = async (agent, name) => {
    if (!window.confirm(`${agent} 배포 목록에서 ${name} 을 뺍니다 — 엣지가 다음 인출에서 자기가 만든 등록을 지웁니다.`)) return;
    try { const r = await delJson(`/tools/bm-usage/onboard/edge-rows?agent=${encodeURIComponent(agent)}&name=${encodeURIComponent(name)}`); setMsg(r?.ok === false ? `빼지 못했습니다 — ${r.reason}` : `뺐습니다 — ${agent} / ${name}`); load(); }
    catch (e) { setMsg(`빼지 못했습니다 — ${errText(e)}`); }
  };
  if (st.err) return <section className="bmob-sec"><h4>엣지 배포 목록</h4><ErrorBox error={st.err} /></section>;
  return (
    <section className="bmob-sec">
      <h4>엣지 배포 목록(수집 경로 edge)</h4>
      <p className="bmo-note"><BoldText text={`엣지는 이 목록을 받아 **자기 키 저장소 · 공통 계정의 같은 이름**으로 등록합니다(키는 법인 밖으로 나가지 않습니다). 엣지가 끊겨도 central 로 옮기지 않습니다.${st.resp?.minEdgeVersion ? ` 받는 엣지는 ${st.resp.minEdgeVersion} 이상이어야 합니다.` : ''}`} /></p>
      {!agents.length ? <p className="bmo-sub">배포 목록이 없습니다.</p> : agents.map((a) => {
        const sy = edgeSyncText(a);
        return (
          <details key={a.agent} className="bmob-edge">
            <summary><b>{a.agent}</b> · {numOr(a.total)}대 · <span style={{ color: toneVar(sy.tone) }}>{sy.text}</span>{a.applied ? <span className="bmo-sub"> · 엣지 적용 {numOr(a.applied.ok)} · 거부 {numOr(a.applied.rejected)} · 지움 {numOr(a.applied.removed)}</span> : null}</summary>
            <STable minWidth={640} className="bmo-t" style={{ fontSize: 12 }}>
              <thead><tr><th>name</th><th>법인</th><th>경로</th><th>공통 계정 · 키(이름)</th><th data-nosort>동작</th></tr></thead>
              <tbody>{a.rows.map((r) => (
                <tr key={r.name}><td className="bmo-name" data-sort={r.name}>{r.name}</td><td data-sort={r.corp}>{r.corp || '—'}</td>
                  <td data-sort={`${r.idracHost}${r.osHost}`}>{[r.idracHost && 'iDRAC', r.osHost && 'OS'].filter(Boolean).join(' + ') || '—'}</td>
                  <td data-sort={`${r.osCred}${r.osKey}`}>{[r.idracCred, r.osCred, r.osKey].filter(Boolean).join(' · ') || '—'}</td>
                  <td data-nosort><button type="button" className="btn btn-sm" onClick={() => remove(a.agent, r.name)}>빼기</button></td></tr>
              ))}</tbody>
            </STable>
          </details>
        );
      })}
      {msg && <p className="bmo-note" role="status">{msg}</p>}
    </section>
  );
}

/* ── 누락 점검 ───────────────────────────────────────────────────── */
function MissingSection({ rev }) {
  const [st, load] = useLoad('/tools/bm-usage/onboard/missing');
  useEffect(() => { if (rev) load(); }, [rev]);   // eslint-disable-line react-hooks/exhaustive-deps -- 적용 뒤 신호에만 다시 읽는다
  const [only, setOnly] = useState('');
  const rows = st.resp?.rows || [];
  const shown = only ? rows.filter((r) => r.bucket === only) : rows.filter((r) => r.bucket !== 'both');
  const sugg = rows.filter((r) => r.suggest);
  if (st.err) return <section className="bmob-sec"><h4>누락 점검</h4><ErrorBox error={st.err} /></section>;
  return (
    <section className="bmob-sec">
      <h4>누락 점검</h4>
      <p className="bmo-note"><BoldText text={'칸은 보드 커버리지와 **같은 값**입니다(마지막 수집이 읽은 경로). 수집 기록이 없는 서버는 ‘없음’ 이 아니라 **‘모름’** 으로 셉니다. 제안 CSV 는 이름 · 알고 있는 주소만 채운 등록 줄입니다 — **자동 등록하지 않습니다**(고쳐서 위 등록으로 올리세요).'} /></p>
      {st.loading && !st.resp ? <p className="bmo-note">읽는 중…</p> : (
        <>
          <div className="bmob-chips">
            {BUCKET_ORDER.map((b) => <button key={b} type="button" className={`bmob-chip bmob-${b === 'both' ? 'ok' : b === 'unknown' ? 'muted' : b === 'none' ? 'bad' : 'warn'}${only === b ? ' on' : ''}`} onClick={() => setOnly(only === b ? '' : b)}>{BUCKET_TEXT[b]} {numOr(st.resp?.counts?.[b])}</button>)}
            <button className="btn btn-sm" type="button" onClick={load}>다시 점검</button>
            <button className="btn btn-sm" type="button" disabled={!sugg.length} onClick={() => downloadBlob(new Blob([suggestCsv(sugg)], { type: 'text/csv;charset=utf-8' }), 'bm-onboard-suggest.csv')}>제안 CSV {sugg.length}줄</button>
          </div>
          {st.resp?.sourceErrors ? <p className="bmo-note" style={{ color: toneVar('warn') }}>대상 해석 입력 {st.resp.sourceErrors}건을 읽지 못했습니다 — 일부 서버가 빠졌을 수 있습니다.</p> : null}
          <STable minWidth={760} limit={500} className="bmo-t" style={{ fontSize: 12 }}>
            <thead><tr><th>서버</th><th>법인</th><th>수집 노드</th><th>칸</th><th>사유</th></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={`${r.via}|${r.key}`}>
                  <td className="bmo-name" data-sort={r.name}>{r.name || r.key}</td>
                  <td data-sort={r.vcenterId}>{r.vcenterId || '미귀속'}</td>
                  <td data-sort={r.via}>{r.via === 'edge' ? `엣지 ${r.agent || ''}` : '이 노드'}</td>
                  <td data-sort={r.bucket}>{BUCKET_TEXT[r.bucket] || r.bucket}</td>
                  <td className="bmo-wrap" data-sort={r.reason}>{r.reason ? (MISS_REASON_TEXT[r.reason] || r.reason) : '—'}</td>
                </tr>
              ))}
              {!shown.length && <tr><td colSpan={5} className="bmo-sub">{only ? '해당 서버가 없습니다.' : '빠진 경로가 있는 서버가 없습니다.'}</td></tr>}
            </tbody>
          </STable>
        </>
      )}
    </section>
  );
}

export default function BmOnboardPanel({ vcenters = [] }) {
  const isAdmin = hasRole('admin');
  const manage = canManageKeys(getCurrentUser(), isAdmin);
  const [keysRev, setKeysRev] = useState(0);
  const [rev, setRev] = useState(0);
  if (!isAdmin) return null;
  return (
    <div className="bmob" style={{ marginTop: 14 }}>
      <h4 style={{ margin: 0 }}>서버 등록 · 온보딩</h4>
      <p className="bmo-note"><BoldText text={'수집 경로는 서버마다 하나 — **edge**(법인 엣지가 읽음) · **central**(중앙이 직접) · **auto**(그 법인 엣지가 지금 접속 중이면 edge, 엣지가 없으면 central — 엣지가 있는데 접속을 모르면 판정하지 않습니다). 포탈은 서버에 계정 · 키를 만들지 않습니다.'} /></p>
      <KeysSection manage={manage} onChanged={() => setKeysRev((x) => x + 1)} />
      <AccountsSection manage={manage} vcenters={vcenters} keysRev={keysRev} />
      <ImportSection onApplied={() => setRev((x) => x + 1)} />
      <EdgeRowsSection rev={rev} />
      <MissingSection rev={rev} />
    </div>
  );
}

