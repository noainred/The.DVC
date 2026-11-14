/**
 * SshAccessSettings.jsx — 설정 › 보안 › SSH 공용 접속(v3.9.0 · 설계 docs/design/ssh-access · 시안 Ssh · SshKeys · SshPick · SshUse · SshSec).
 *
 * 7b SSH 키 저장소(키 + 법인 공통 계정)와 OS 계정 등록부(서버) 위에 얹은 화면이다 — 새 저장소가 아니다.
 *  · 탭: 법인 · 서버 / 키 폴더 / 쓰는 기능 / 키 보안. 판정(이 서버에 쓸 수 있는 키 · 키 점검 등급)은 서버가 한다 — 화면은 그린다.
 *  · 조회는 설정 소유자 등급, 바꾸는 것은 본인 OTP 까지(서버가 다시 막는다). 개인키 · passphrase · 비밀번호는 보내기만 하고 다시 받지 않는다(보낸 뒤 비운다).
 *  · ⚠ postJson 은 409 를, putJson · delJson 은 400 · 409 를 던지지 않는다(api.js) — 쓰기 결과는 전부 `must()` 로 `ok:false` 를 오류로 바꾼다
 *    (5축 점검 E-H1: 키 고르기 실패 · 폴더 충돌 · 승인 거절을 성공으로 그리던 결함).
 *  · 무거운 API 는 폴링하지 않는다(마운트 1회 + 버튼). 늦게 온 이전 응답은 버린다(gen). 다시 읽기가 실패하면 이전 화면을 두고 오류를 띠로 보인다.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, delJson } from '../api.js';
import { ErrorBox } from '../components/ui.jsx';
import { STable } from '../components/STable.jsx';
import Select from '../components/Select.jsx';
import BoldText from '../components/boldText.jsx';
import { toneVar } from './tools/toneVar.js';
import { unitText } from './unitText.js';
import {
  LEVEL_TEXT, LEVEL_TONE, KEY_MODE_TEXT, ISSUE_TEXT, INBOX_CODE_TEXT, EVENT_TEXT, USE_CODE_TEXT, UNUSUAL_TEXT,
  shortFp, dateTime, ageDays, featuresText, folderTree, keysInFolder, inboxInFolder, sortedCheck, suggestKeyName, serverStatus, auditTime, COLLECT_FEATURES,
} from './sshAccessText.js';
import './sshAccess.css';
import { copyText as copyToClipboard } from '../util/copyText.js';   // v3.10.6: HTTP 포탈에서도 복사(Clipboard API → execCommand 폴백 · 실패는 false)

const errText = (e) => e?.body?.reason || e?.message || String(e);
/** 쓰기 응답 — ok:false(400 · 409 를 던지지 않는 api.js 경로)를 오류로 바꾼다. */
function must(r) {
  if (r && r.ok === false) { const e = new Error(r.reason || r.code || '실패했습니다'); e.body = r; throw e; }
  return r;
}
const TABS = [['servers', '법인 · 서버'], ['folders', '키 폴더'], ['features', '쓰는 기능'], ['security', '키 보안']];

function useLoad(path) {
  const [st, setSt] = useState({ loading: true, resp: null, err: null });
  const gen = useRef(0);
  const load = async () => {
    if (!path) return;
    const g = ++gen.current;
    setSt((p) => ({ ...p, loading: true, err: null }));
    // 다시 읽기가 실패해도 이전 자료는 둔다(동작 뒤 재조회 실패로 화면 전체가 오류 상자로 바뀌지 않게) — 오류는 따로 보인다.
    try { const r = await fetchJson(path, {}, undefined, { timeoutMs: 60_000 }); if (g === gen.current) setSt({ loading: false, resp: r, err: null }); }
    catch (e) { if (g === gen.current) setSt((p) => ({ loading: false, resp: p.resp, err: e })); }
  };
  useEffect(() => { load(); }, [path]);   // eslint-disable-line react-hooks/exhaustive-deps -- load 는 path 만 본다(gen 으로 늦은 응답 버림)
  return [st, load];
}
const Chip = ({ tone = 'muted', children, title }) => <span className="ssa-chip" style={{ color: toneVar(tone), borderColor: 'currentColor' }} title={title}>{children}</span>;
const Otp = ({ value, onChange }) => (
  <label className="ssa-otp">본인 OTP <input className="input" inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value)} maxLength={8} autoComplete="one-time-code" /></label>
);
/**
 * 쓸 수 있는 기능 고르기 — 렌더 밖 컴포넌트(안에서 정의하면 누를 때마다 다시 마운트돼 포커스를 잃는다 · E-L1).
 * allowAll: ‘제한 없음(예전 방식)’ 칸을 보인다(값 null). 예전 키를 편집 폼에서 저장만 해도 기능이 비는 사고를 막는다(E-H3).
 */
function FeaturePicker({ catalog, value, onChange, allowAll = false }) {
  const all = value == null;
  const list = Array.isArray(value) ? value : [];
  return (
    <div className="ssa-feats" role="group" aria-label="쓸 수 있는 기능">
      {allowAll && <label><input type="checkbox" checked={all} onChange={() => onChange(all ? [] : null)} /> 제한 없음(예전 방식 — 모든 기능)</label>}
      {(catalog || []).map((f) => (
        <label key={f.id}><input type="checkbox" disabled={all} checked={all || list.includes(f.id)} onChange={() => onChange(list.includes(f.id) ? list.filter((x) => x !== f.id) : [...list, f.id])} /> {f.label}{f.ready === false ? ' (다음 단계)' : ''}</label>
      ))}
    </div>
  );
}
const featuresChosen = (v) => v == null || (Array.isArray(v) && v.length > 0);

export default function SshAccessSettings() {
  const [st, load] = useLoad('/settings/ssh-access');
  const [tab, setTab] = useState('servers');
  const [msg, setMsg] = useState({ text: '', tone: 'muted' });
  const v = st.resp;
  const say = (text, tone = 'muted') => setMsg({ text, tone });
  const corpName = useMemo(() => { const m = new Map((v?.corps || []).map((c) => [c.id, c.name || c.id])); return (id) => (id ? (m.get(id) || id) : '미귀속'); }, [v]);
  if (st.err && !v) return <div className="ssa"><ErrorBox error={st.err} /></div>;
  if (!v) return <div className="ssa"><p className="ssa-note">읽는 중…</p></div>;
  const keyCount = (v.keys || []).filter((k) => k.status === 'active').length;
  const srvKey = (v.servers || []).filter((s) => s.keyMode === 'pinned' || s.keyMode === 'corp-default').length;
  const srvPw = (v.servers || []).filter((s) => s.keyMode === 'password').length;
  const sum = v.check?.summary || {};
  const checkTone = sum.bad ? 'bad' : sum.warn ? 'warn' : sum.unknown ? 'muted' : 'ok';
  return (
    <div className="ssa">
      <div className="ssa-head">
        <div className="ssa-title">
          <p className="ssa-note"><BoldText text={'Linux 서버에 붙는 SSH 계정 · 키를 법인마다 한 곳에서 정합니다. **법인 공통 계정**(기본 키)을 그 법인 서버가 함께 쓰고, 다른 키가 필요한 서버만 키를 **이름으로 고정**합니다. 지금 이 접속을 쓰는 기능은 베어메탈 사용률 · 베어메탈 스토리지입니다.'} /></p>
        </div>
        <div className="ssa-acts"><button className="btn btn-sm" type="button" onClick={load} disabled={st.loading}>{st.loading ? '읽는 중…' : '다시 읽기'}</button></div>
      </div>
      {st.err && <p className="ssa-banner" style={{ color: toneVar('bad') }}>다시 읽지 못했습니다 — 아래는 이전에 읽은 화면입니다({errText(st.err)}).</p>}
      {v.policyMode === 'unavailable' && (
        <p className="ssa-banner" style={{ color: toneVar('bad') }}><BoldText text={'자격증명 저장 방식(secrets-policy.json)을 **읽지 못해 잠겨** 있습니다 — 새 로그인 키를 받지 않습니다. 설정 › 보안 › 자격증명 저장 방식을 확인하세요.'} /></p>
      )}
      {v.policyMode && v.policyMode !== 'encrypted' && v.policyMode !== 'unavailable' && (
        <p className="ssa-banner" style={{ color: toneVar('bad') }}><BoldText text={'자격증명 저장 방식이 **평문**입니다 — 새 로그인 키를 받지 않습니다. 설정 › 보안 › 자격증명 저장 방식에서 암호화로 바꾸면 저장된 키도 함께 암호화됩니다.'} /></p>
      )}
      {(v.storeUnreadable || v.registryUnreadable || v.stateUnreadable) && (
        <p className="ssa-banner" style={{ color: toneVar('bad') }}>
          {v.storeUnreadable ? 'SSH 키 저장소(ssh-keys.json)를 읽지 못했습니다. ' : ''}{v.registryUnreadable ? 'OS 계정 등록부(bm-storage.json)를 읽지 못했습니다. ' : ''}
          {v.stateUnreadable ? '상태 파일(ssh-access-state.json)을 읽지 못해 모든 키 접속을 멈췄습니다. ' : ''}손상 보존본(*.corrupt.*)을 확인하세요.
        </p>
      )}
      <div className="ssa-kpis">
        <div className="ssa-kpi"><span className="ssa-sub">법인 · OS 등록 서버</span><b>{(v.corps || []).length}곳 · {v.registryUnreadable ? '—' : `${(v.servers || []).length}대`}</b></div>
        <div className="ssa-kpi"><span className="ssa-sub">키로 접속하는 서버</span><b style={{ color: srvKey ? toneVar('ok') : undefined }}>{v.registryUnreadable ? '—' : `${srvKey}대`}</b></div>
        <div className="ssa-kpi"><span className="ssa-sub">비밀번호로 접속하는 서버</span><b style={{ color: srvPw ? toneVar('warn') : undefined }}>{v.registryUnreadable ? '—' : `${srvPw}대`}</b></div>
        <div className="ssa-kpi"><span className="ssa-sub">활성 키</span><b>{v.storeUnreadable ? '—' : `${keyCount}개`}</b></div>
        <div className="ssa-kpi"><span className="ssa-sub">키 점검</span><b style={{ color: toneVar(checkTone) }}>위험 {sum.bad || 0} · 확인 {sum.warn || 0}{sum.unknown ? ` · 모름 ${sum.unknown}` : ''}</b></div>
      </div>
      <div className="ssa-tabs" role="tablist" aria-label="SSH 공용 접속 보기">
        {TABS.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`ssa-tab${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}>{label}</button>)}
      </div>
      {msg.text && <p className="ssa-note" role="status" style={{ color: toneVar(msg.tone) }}>{msg.text}</p>}
      {tab === 'servers' && <ServersTab v={v} corpName={corpName} reload={load} say={say} />}
      {tab === 'folders' && <FoldersTab v={v} corpName={corpName} reload={load} say={say} />}
      {tab === 'features' && <FeaturesTab v={v} />}
      {tab === 'security' && <SecurityTab v={v} corpName={corpName} reload={load} say={say} />}
    </div>
  );
}

/* ── 법인 · 서버 ───────────────────────────────────────────────────── */
function ServersTab({ v, corpName, reload, say }) {
  const corpIds = useMemo(() => {
    const ids = (v.corps || []).map((c) => c.id);
    if ((v.servers || []).some((s) => !s.vcenterId)) ids.push('');
    return ids;
  }, [v]);
  const [corp, setCorp] = useState(() => corpIds.find((id) => (v.servers || []).some((s) => (s.vcenterId || '') === id)) ?? corpIds[0] ?? '');
  const [pick, setPick] = useState(null);
  const [busy, setBusy] = useState(() => new Set());
  const servers = (v.servers || []).filter((s) => (s.vcenterId || '') === corp);
  const accounts = (v.accounts || []).filter((a) => (a.corp || '') === corp || !a.corp);
  const edges = (v.edgeRows || []).filter((r) => (r.corp || '') === corp);
  const stop0 = (v.corps || []).find((c) => c.id === corp)?.stop;
  // 상태 파일을 못 읽으면 stop = { unreadable } — ‘중지 중’ 이 아니라 ‘모름’(그동안 모든 키 접속이 멈춰 있다 · 반증 지적).
  const stateUnknown = !!stop0?.unreadable;
  const stop = stateUnknown ? null : stop0;
  const keyName = (id) => (v.keys || []).find((k) => k.id === id)?.name || '';
  const setB = (id, on) => setBusy((p) => { const n = new Set(p); if (on) n.add(id); else n.delete(id); return n; });
  const test = async (s) => {
    setB(s.id, true);
    try {
      const r = must(await postJson(`/settings/ssh-access/servers/${encodeURIComponent(s.id)}/test`, {}));
      say(r.connected ? `${s.name} — 접속됨(${r.authKind === 'key' ? '키' : '비밀번호'}${r.os ? ` · ${r.os}` : ''})` : `${s.name} — ${r.reason || r.kind}`, r.connected ? 'ok' : 'bad');
    } catch (e) { say(`${s.name} — ${errText(e)}`, 'bad'); } finally { setB(s.id, false); }
  };
  return (
    <div className="ssa-main">
      <div className="ssa-acts">
        <label className="ssa-corp-pick">법인 <Select sort={false} className="select select-sm" value={corp} onChange={(e) => setCorp(e.target.value)}>
          {corpIds.map((id) => {
            const c = (v.corps || []).find((x) => x.id === id);
            const n = (v.servers || []).filter((s) => (s.vcenterId || '') === id).length;
            return <option key={id || '_none'} value={id}>{corpName(id)}{c?.dc ? ` (${c.dc})` : ''} — 서버 {n}대{c?.stop?.unreadable ? ' · 상태 모름' : c?.stop ? ' · 키 사용 중지' : ''}</option>;
          })}
        </Select></label>
        <span className="ssa-sub">OS 등록 서버가 있는 법인 {corpIds.filter((id) => (v.servers || []).some((s) => (s.vcenterId || '') === id)).length}곳</span>
      </div>
      {stateUnknown && <p className="ssa-banner" style={{ color: toneVar('bad') }}>상태 파일을 읽지 못해 이 노드의 모든 키 접속을 멈췄습니다(사용 중지 기록을 모름) — 키 보안 탭에서 파일을 확인한 뒤 다시 읽으세요.</p>}
      {stop && <p className="ssa-banner" style={{ color: toneVar('bad') }}>이 법인은 키 사용이 중지돼 있습니다 — {stop.by || '—'} · {dateTime(stop.at)}{stop.reason ? ` · ${stop.reason}` : ''}. 키 보안 탭에서 재개합니다.</p>}
      <section className="ssa-sec">
        <h4>{corpName(corp)} — 법인 공통 계정</h4>
        {accounts.length ? (
          <STable minWidth={640} className="ssa-t">
            <thead><tr><th>이름</th><th>계정</th><th>기본 키</th><th>비밀번호</th><th className="right">쓰는 서버</th></tr></thead>
            <tbody>{accounts.map((a) => (
              <tr key={a.id}><td data-sort={a.name}><b>{a.name}</b>{!a.corp && <div className="ssa-sub">전 법인 공용</div>}</td><td><code>{a.username}</code></td>
                <td data-sort={keyName(a.keyRef)}>{a.keyRef ? keyName(a.keyRef) || <Chip tone="bad">키 없음</Chip> : '—'}</td>
                <td>{a.hasPassword ? '저장됨' : '—'}</td><td className="right" data-sort={a.servers ?? ''}>{a.servers ?? '—'}</td></tr>
            ))}</tbody>
          </STable>
        ) : <p className="ssa-note">{corp ? '이 법인의 공통 계정이 없습니다.' : '미귀속 서버에는 법인 공통 계정이 없습니다.'}</p>}
        <p className="ssa-note">공통 계정 추가 · 수정은 지금처럼 베어메탈 사용률 › 서버 등록 › 법인 공통 계정에서 합니다(같은 저장소).</p>
      </section>
      <section className="ssa-sec">
        <h4>{corpName(corp)} — 서버 {servers.length}대</h4>
        <STable minWidth={880} className="ssa-t">
          <thead><tr><th>서버</th><th>계정</th><th>쓰는 키</th><th>상태</th><th>서버에 들어 있는 키</th><th data-nosort>동작</th></tr></thead>
          <tbody>
            {servers.map((s) => {
              const stt = serverStatus(s, { tampered: v.tampered, stop: !!stop || stateUnknown, rsaMinBits: v.rsaMinBits });
              return (
                <tr key={s.id}>
                  <td data-sort={s.name}><b>{s.name}</b><div className="ssa-sub"><code>{s.host}{s.port !== 22 ? `:${s.port}` : ''}</code>{s.agent ? ` · 엣지 ${s.agent}` : ''}</div></td>
                  <td data-sort={s.username}>{s.accountMissing ? <Chip tone="bad">공통 계정 없음</Chip> : s.accountName ? `공통 ${s.accountName}` : '단독'}<div className="ssa-sub"><code>{s.username}</code></div></td>
                  <td data-sort={s.keyName || s.keyMode}>
                    {KEY_MODE_TEXT[s.keyMode] || s.keyMode}
                    {s.keyName && <div className="ssa-sub"><code>{s.keyName}</code></div>}
                  </td>
                  <td data-sort={stt.label}><Chip tone={stt.tone} title={stt.title}>{stt.label}</Chip></td>
                  <td data-sort={s.installed?.at || 0}>
                    {s.installed ? (s.installed.error ? <span className="ssa-sub">{s.installed.error}</span>
                      : <span>{s.installed.count}줄{s.keyName ? (s.installed.hasKey ? ' · 쓰는 키 있음' : ' · 쓰는 키 없음') : ''}</span>) : <span className="ssa-sub">읽지 않음</span>}
                    {s.installed && <div className="ssa-sub">{dateTime(s.installed.at)}{s.installed.stale ? ' · 주소가 바뀜(다시 읽기)' : ''}</div>}
                  </td>
                  <td data-nosort>
                    <div className="ssa-acts">
                      <button className="btn btn-sm" type="button" disabled={!!s.agent || busy.has(s.id)} onClick={() => setPick(s)}>키 고르기</button>
                      <button className="btn btn-sm" type="button" disabled={!!s.agent || busy.has(s.id)} onClick={() => test(s)}>{busy.has(s.id) ? '시험 중…' : '연결 시험'}</button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!servers.length && <tr><td colSpan={6} className="ssa-sub">이 법인으로 등록된 OS 서버가 없습니다(베어메탈 스토리지 · 서버 등록에서 법인을 지정한 서버만 여기 보입니다).</td></tr>}
          </tbody>
        </STable>
        <p className="ssa-note">계정을 정하는 순서: 서버에 이름으로 고정한 키 → 법인 공통 계정의 기본 키 → 비밀번호. 고정한 키가 사라지거나 다른 폴더로 가면 다른 키로 넘어가지 않고 멈춥니다.</p>
      </section>
      {edges.length > 0 && (
        <section className="ssa-sec">
          <h4>엣지가 수집하는 서버 {edges.length}대</h4>
          <p className="ssa-note">이 서버들의 키는 그 엣지 포탈의 SSH 공용 접속에서 고릅니다 — 키는 법인 밖으로 나가지 않고, 중앙에는 이름만 있습니다.</p>
          <STable minWidth={720} className="ssa-t">
            <thead><tr><th>서버</th><th>엣지</th><th>주소</th><th>공통 계정 · 키 이름</th></tr></thead>
            <tbody>{edges.map((r, i) => (
              <tr key={`${r.agent}-${r.name}-${i}`}><td data-sort={r.name}>{r.name}</td><td>{r.agent}</td><td><code>{r.osHost || '—'}</code></td><td>{[r.osCred, r.osKey].filter(Boolean).join(' · ') || '—'}</td></tr>
            ))}</tbody>
          </STable>
        </section>
      )}
      {pick && <KeyPicker server={pick} catalog={v.features} onClose={(changed) => { setPick(null); if (changed) reload(); }} say={say} />}
    </div>
  );
}

/* ── 키 고르기 창(시안 ⑥) ───────────────────────────────────────────── */
function KeyPicker({ server, catalog, onClose, say }) {
  const [st, load] = useLoad(`/settings/ssh-access/servers/${encodeURIComponent(server.id)}/candidates`);
  const [choice, setChoice] = useState(null);
  const [otp, setOtp] = useState('');
  const [once, setOnce] = useState('');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState({ text: '', tone: 'muted' });
  const readDone = useRef(false);
  const firstRef = useRef(null);
  const c = st.resp;
  useEffect(() => {
    if (!c || choice !== null) return;
    const cur = (c.keys || []).find((k) => k.current);
    // 지금 설정 그대로를 미리 고른다 — 이름 고정이면 그 키, 법인 기본 키를 따르면 '', 그 밖(비밀번호 고정 등)은 고르지 않음(E-L11).
    setChoice(c.server.keyMode === 'pinned' && cur ? cur.id : (c.server.keyMode === 'corp-default' ? '' : null));
  }, [c, choice]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(readDone.current); };
    window.addEventListener('keydown', onKey);
    firstRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const read = async () => {
    setBusy('read');
    try {
      const r = must(await postJson(`/settings/ssh-access/servers/${encodeURIComponent(server.id)}/installed-keys`, once ? { oncePassword: once } : {}));
      readDone.current = true;
      setNote({ text: `서버에 들어 있는 키 ${(r.keys || []).length}줄을 읽었습니다${r.error ? ` — ${r.error}` : ''}${r.truncated ? ` · ${r.truncated}줄은 상한을 넘어 읽지 않음` : ''}.`, tone: 'ok' });
      load();
    } catch (e) { setNote({ text: errText(e), tone: 'bad' }); } finally { setOnce(''); setBusy(''); }
  };
  const save = async () => {
    setBusy('save');
    try {
      const r = must(await postJson(`/settings/ssh-access/servers/${encodeURIComponent(server.id)}/key`, { keyId: choice || '', expectAddr: server.addr || '', otp }));
      say(`${server.name} — 고른 키로 접속을 확인하고 저장했습니다(${r.test?.authKind === 'key' ? '키' : '비밀번호'}).`, 'ok');
      onClose(true);
    } catch (e) {
      const b = e?.body || {};
      const revertFail = b.code === 'test-failed' && b.reverted === false;
      setNote({ text: revertFail ? `${errText(e)} — ⚠ 되돌리기도 실패했습니다(${b.revertError || '사유 모름'}). 서버 설정을 다시 읽어 확인하세요.` : errText(e), tone: 'bad' });
      if (b.code === 'test-failed') readDone.current = true;   // 되돌렸어도 표를 다시 읽는다
    } finally { setOtp(''); setBusy(''); }
  };
  const groups = [['server', '서버별 폴더 — 이 서버 전용'], ['common', '공통 폴더 — 법인 공통'], ['none', '미분류 — 폴더가 없는 예전 키']];
  const chosenKey = (c?.keys || []).find((k) => k.id === choice);
  const noCollect = chosenKey && Array.isArray(chosenKey.features) && !COLLECT_FEATURES.some((f) => chosenKey.features.includes(f));
  return (
    <div className="ssa-modal-back" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) onClose(readDone.current); }}>
      <div className="ssa-modal" role="dialog" aria-modal="true" aria-labelledby="ssa-pick-t">
        <div className="ssa-modal-h">
          <h4 id="ssa-pick-t">{server.name} — 쓸 키 고르기</h4>
          <span className="ssa-sub"><code>{server.host} · {server.username}</code></span>
        </div>
        {st.err && <ErrorBox error={st.err} />}
        {!c ? (!st.err && <p className="ssa-note">읽는 중…</p>) : (
          <div className="ssa-modal-b">
            <div role="radiogroup" aria-label="쓸 키">
              {c.corpDefault && (
                <label className={`ssa-opt${choice === '' ? ' on' : ''}`}>
                  <input ref={firstRef} type="radio" name="ssa-key" checked={choice === ''} onChange={() => setChoice('')} />
                  <span><b>법인 기본 키를 따름</b><span className="ssa-sub"> — 공통 계정 {c.corpDefault.accountName}({c.corpDefault.username}) · 기본 키 {c.corpDefault.keyName || '없음(비밀번호)'}</span></span>
                </label>
              )}
              {groups.map(([g, label]) => {
                const list = (c.keys || []).filter((k) => k.folder === g);
                if (!list.length) return null;
                return (
                  <div key={g}>
                    <div className="ssa-grp">{label}</div>
                    {list.map((k) => (
                      <label key={k.id} className={`ssa-opt${choice === k.id ? ' on' : ''}${k.selectable ? '' : ' off'}`}>
                        <input type="radio" name="ssa-key" checked={choice === k.id} disabled={!k.selectable} onChange={() => setChoice(k.id)} />
                        <span>
                          <b><code>{k.name}</code></b>
                          {k.current && <Chip tone="ok">지금 쓰는 키</Chip>}
                          {k.installed === true && <Chip tone="ok">이 서버에 들어 있음</Chip>}
                          {k.installed === false && <Chip tone="warn">이 서버에 없음</Chip>}
                          {!k.selectable && <Chip tone="bad">{ISSUE_TEXT[k.issue] || k.issue}</Chip>}
                          <span className="ssa-sub"> {k.algo}{k.bits ? ` ${k.bits}` : ''} · {shortFp(k.fingerprint)} · 기능 {featuresText(k.features, catalog)}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                );
              })}
              {!(c.keys || []).length && !c.corpDefault && <p className="ssa-note">이 서버에 쓸 수 있는 키가 없습니다 — 키 폴더 탭에서 이 법인(공통) 또는 이 서버 폴더에 키를 등록하세요.</p>}
              {noCollect && <p className="ssa-note" style={{ color: toneVar('warn') }}>이 키는 베어메탈 사용률 · 스토리지 수집에 허용되지 않았습니다 — 저장해도(연결 시험은 통과해도) 주기 수집은 이 키로 접속하지 않습니다. 키 폴더 탭에서 기능을 더하세요.</p>}
            </div>
            <div className="ssa-installed">
              <div className="ssa-acts">
                <b>이 서버에 들어 있는 키</b>
                <span className="ssa-sub">{c.installed ? `${dateTime(c.installed.at)} 읽음${c.installed.stale ? ' · 주소가 바뀜' : ''}` : '아직 읽지 않음'}</span>
              </div>
              {c.installed && !c.installed.error && (
                <ul className="ssa-list">{c.installed.keys.map((k, i) => (
                  <li key={`${k.fingerprint}-${i}`}><code>{shortFp(k.fingerprint)}</code> <span className="ssa-sub">{k.comment || '설명 없음'}</span> {k.keyName ? <Chip tone="ok">폴더에 있음 — {k.keyName}</Chip> : <Chip>개인키가 폴더에 없음</Chip>}</li>
                ))}</ul>
              )}
              {c.installed?.error && <p className="ssa-note">{c.installed.error}</p>}
              <div className="ssa-acts">
                <label className="ssa-otp">이번 한 번만 쓸 비밀번호(선택) <input className="input" type="password" value={once} onChange={(e) => setOnce(e.target.value)} autoComplete="new-password" /></label>
                <button className="btn btn-sm" type="button" disabled={busy === 'read'} onClick={read}>{busy === 'read' ? '읽는 중…' : '다시 읽기'}</button>
              </div>
              <p className="ssa-note">서버 계정의 ~/.ssh/authorized_keys 에서 공개키 줄만 읽어 지문으로 맞춥니다. 비밀번호를 넣으면 이번 읽기에만 쓰고 저장하지 않습니다. 폴더의 키를 차례로 대 보지는 않습니다(계정 잠금 방지).</p>
            </div>
          </div>
        )}
        {note.text && <p className="ssa-note" role="status" style={{ color: toneVar(note.tone) }}>{note.text}</p>}
        <div className="ssa-modal-f">
          <Otp value={otp} onChange={setOtp} />
          <div className="ssa-acts">
            <button className="btn" type="button" onClick={() => onClose(readDone.current)} ref={c?.corpDefault ? undefined : firstRef}>닫기</button>
            <button className="btn primary" type="button" disabled={busy === 'save' || choice === null || !c} onClick={save}>{busy === 'save' ? '확인 중…' : '이 키 사용'}</button>
          </div>
        </div>
        <p className="ssa-note">저장하면 고른 키로 한 번 접속해 확인합니다(연결 시험 — 기능 허용과 무관). 안 되면 이전 설정으로 되돌리고 이유를 적습니다.</p>
      </div>
    </div>
  );
}

/* ── 키 폴더(시안 ②) ───────────────────────────────────────────────── */
async function copyText(text) {
  if (await copyToClipboard(text)) return true;   // HTTP 에서도 폴백으로 복사한다(util/copyText.js)
  window.prompt('공개키 — 직접 복사하세요(Ctrl+C)', text);   // 그래도 못 했으면(권한 거부 등) 직접 복사하게 보여 준다(E-L10)
  return false;
}
function FoldersTab({ v, corpName, reload, say }) {
  const tree = useMemo(() => folderTree(v), [v]);
  const [sel, setSel] = useState(() => tree.find((n) => n.kind === 'common' && tree.find((c) => c.id === `corp:${n.corp}`)?.count) || tree.find((n) => n.kind === 'common') || tree[0]);
  const node = tree.find((n) => n.id === sel?.id) || tree[0];
  const shown = tree.filter((n) => n.kind === 'corp' || n.kind === 'none' || n.corp === node?.corp);
  const keys = keysInFolder(v, node);
  const inbox = inboxInFolder(v, node);
  const blankAdd = { name: '', privateKey: '', passphrase: '', rotateAt: '', features: [], otp: '' };
  const [edit, setEdit] = useState(null);   // { key, folderCorp, folderServer, features(null = 제한 없음), otp }
  const [add, setAdd] = useState(blankAdd);
  const [appr, setAppr] = useState(null);   // { item, name, passphrase, features, otp }
  const [busy, setBusy] = useState(false);
  const canAdd = node && (node.kind === 'common' || node.kind === 'server');
  /** 쓰기 하나 — 실패는 서버 사유 그대로(충돌 목록 포함). 성공 문구는 결과로 만든다. */
  const run = async (fn, okText) => {
    setBusy(true);
    try { const r = must(await fn()); say(typeof okText === 'function' ? okText(r) : okText, r.plaintextLeft ? 'bad' : 'ok'); reload(); return true; }
    catch (e) {
      const cf = e?.body?.conflicts;
      say(cf?.length ? `${errText(e)} — ${cf.slice(0, 8).map((x) => `${x.kind === 'account' ? '공통 계정' : '서버'} ${x.name}`).join(' · ')}${cf.length > 8 ? ` 외 ${cf.length - 8}` : ''}` : errText(e), 'bad');
      return false;
    } finally { setBusy(false); }
  };
  const path = node?.kind === 'server' ? (v.servers || []).find((s) => s.vcenterId === node.corp && s.name.toLowerCase() === node.server.toLowerCase())?.inboxPath
    : node?.kind === 'common' || node?.kind === 'corp' ? (v.corps || []).find((c) => c.id === node.corp)?.inboxPath : '';
  return (
    <div className="ssa-split">
      <nav className="ssa-tree" aria-label="키 폴더">
        {shown.map((n) => (
          <button key={n.id} type="button" className={`ssa-node d${n.depth}${node?.id === n.id ? ' on' : ''}`} onClick={() => setSel(n)} aria-current={node?.id === n.id ? 'true' : undefined}>
            <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M3 6.5h6l2 2.5h10v9.5H3z" /></svg>
            <span className="ssa-node-l">{n.label}</span><span className="ssa-sub">{n.count}</span>
          </button>
        ))}
      </nav>
      <div className="ssa-main">
        <section className="ssa-sec">
          <h4>{node?.kind === 'none' ? '미분류' : `${corpName(node?.corp)} › ${node?.kind === 'server' ? `서버별 › ${node.server}` : node?.kind === 'servers' ? '서버별(전부)' : node?.kind === 'corp' ? '전부' : '공통'}`} — 키 {keys.length}개</h4>
          {node?.kind === 'none' && <p className="ssa-note">폴더가 없는 키는 어느 법인 서버에든 쓰일 수 있습니다 — 법인(공통 · 서버별)을 정하세요.</p>}
          {path && <p className="ssa-note">서버에서 키 파일을 직접 넣는 곳: <code>{path}</code> — 넣은 파일은 아래 ‘받은 키’ 에 나타나고, 승인하기 전에는 쓰지 않습니다.</p>}
          <STable minWidth={620} className="ssa-t ssa-keys">
            <thead><tr><th>이름</th><th>지문</th><th>쓸 수 있는 기능</th><th>쓰는 곳 · 마지막 사용</th><th data-nosort>동작</th></tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td data-sort={k.name}><b><code>{k.name}</code></b>{k.status === 'retired' && <Chip tone="muted">퇴역</Chip>}{(v.tampered || []).includes(k.id) && <Chip tone="bad">포탈 밖에서 바뀜</Chip>}
                    <div className="ssa-sub">{k.folderServer ? `서버별 › ${k.folderServer}` : k.folderCorp ? '공통' : '미분류'} · {k.algo}{k.bits ? ` ${k.bits}` : ''}{k.hasPassphrase ? ' · passphrase' : ''} · {ageDays(k.createdAt) != null ? `${ageDays(k.createdAt)}일 전` : '—'}</div>
                    {k.rotateDue && <Chip tone="warn">회전 예정일 지남</Chip>}</td>
                  <td data-sort={k.fingerprint}><code title={`${k.fingerprint}\n${k.publicKey}`}>{shortFp(k.fingerprint)}</code></td>
                  <td data-sort={featuresText(k.features, v.features)}>{k.features == null ? <Chip tone="warn">모든 기능(예전 방식)</Chip> : k.features.length ? featuresText(k.features, v.features) : <Chip tone="bad">없음 — 어느 기능도 못 씀</Chip>}</td>
                  <td data-sort={k.servers ?? ''}>서버 {k.servers ?? '—'}{k.accountsUsing ? ` · 공통 계정 ${k.accountsUsing}` : ''}<div className="ssa-sub">{v.usageLoadFailed ? '사용 기록을 읽지 못함' : k.lastUse ? `${dateTime(k.lastUse.lastAt)} · ${k.lastUse.server}` : '쓴 기록 없음'}</div></td>
                  <td data-nosort>
                    <div className="ssa-acts">
                      <button className="btn btn-sm" type="button" disabled={busy || k.status !== 'active'} onClick={() => setEdit({ key: k, folderCorp: k.folderCorp, folderServer: k.folderServer, features: k.features == null ? null : [...k.features], otp: '' })}>폴더 · 기능</button>
                      <button className="btn btn-sm" type="button" onClick={async () => { if (await copyText(k.publicKey)) say(`${k.name} 공개키를 복사했습니다.`, 'ok'); }}>공개키 복사</button>
                    </div>
                  </td>
                </tr>
              ))}
              {!keys.length && <tr><td colSpan={5} className="ssa-sub">이 폴더에 키가 없습니다.</td></tr>}
            </tbody>
          </STable>
        </section>
        {edit && (
          <fieldset className="ssa-form">
            <legend>{edit.key.name} — 폴더 · 쓸 수 있는 기능</legend>
            <label>법인 <Select sort={false} className="select select-sm" value={edit.folderCorp} onChange={(e) => setEdit({ ...edit, folderCorp: e.target.value, folderServer: '' })}>
              <option value="">미분류(폴더 없음)</option>{(v.corps || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select></label>
            <label>서버(비우면 공통) <Select sort={false} className="select select-sm" value={edit.folderServer} disabled={!edit.folderCorp} onChange={(e) => setEdit({ ...edit, folderServer: e.target.value })}>
              <option value="">공통</option>{(v.servers || []).filter((s) => s.vcenterId === edit.folderCorp).map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
            </Select></label>
            <div className="ssa-wide"><span className="ssa-sub">쓸 수 있는 기능</span><FeaturePicker catalog={v.features} value={edit.features} onChange={(f) => setEdit({ ...edit, features: f })} allowAll={edit.key.features == null} /></div>
            {!featuresChosen(edit.features) && <p className="ssa-note" style={{ color: toneVar('warn') }}>기능을 하나 이상 고르세요 — 없으면 이 키로 어느 기능도 접속하지 않습니다(쓰는 서버 {unitText(edit.key.servers, '대')}의 수집이 멈춥니다).</p>}
            <Otp value={edit.otp} onChange={(x) => setEdit({ ...edit, otp: x })} />
            <div className="ssa-acts">
              <button className="btn primary" type="button" disabled={busy || !featuresChosen(edit.features)} onClick={async () => {
                const ok = await run(() => putJson(`/settings/ssh-access/keys/${encodeURIComponent(edit.key.id)}/placement`, { folderCorp: edit.folderCorp, folderServer: edit.folderServer, features: edit.features, otp: edit.otp }), `${edit.key.name} — 폴더 · 기능을 바꿨습니다.`);
                if (ok) setEdit(null); else setEdit((x) => ({ ...x, otp: '' }));
              }}>저장</button>
              <button className="btn" type="button" onClick={() => setEdit(null)}>닫기</button>
            </div>
            <p className="ssa-note">이 키를 쓰는 서버 · 공통 계정이 새 폴더 밖이 되면 저장하지 않고 목록을 보여 줍니다. 기능을 빼면 그 기능은 이 키로 접속하지 않습니다.</p>
          </fieldset>
        )}
        {(inbox.length > 0 || v.inbox?.truncated > 0) && (
          <section className="ssa-sec">
            <h4>받은 키 — 폴더에 직접 넣은 파일 {inbox.length}개</h4>
            {v.inbox?.truncated > 0 && <p className="ssa-note" style={{ color: toneVar('warn') }}>파일이 너무 많아 {v.inbox.truncated}개는 읽지 않았습니다.</p>}
            <STable minWidth={600} className="ssa-t">
              <thead><tr><th>파일</th><th>상태</th><th>종류 · 지문</th><th data-nosort>동작</th></tr></thead>
              <tbody>{inbox.map((it) => (
                <tr key={it.id}>
                  <td data-sort={it.relPath}><code>{it.file}</code><div className="ssa-sub">{it.server ? `서버별 › ${it.server}` : '공통'} · {dateTime(it.mtime)}{it.loosePerm ? ' · 다른 계정이 읽을 수 있음' : ''}</div></td>
                  <td data-sort={INBOX_CODE_TEXT[it.code] || it.code}><Chip tone={it.code === 'ready' || it.needPassphrase ? 'warn' : 'bad'}>{INBOX_CODE_TEXT[it.code] || it.code}</Chip></td>
                  <td data-sort={it.fingerprint || ''}>{it.algo ? `${it.algo}${it.bits ? ` ${it.bits}` : ''} · ` : ''}{it.fingerprint ? <code>{shortFp(it.fingerprint)}</code> : <span className="ssa-sub">{it.reason || '—'}</span>}</td>
                  <td data-nosort><div className="ssa-acts">
                    <button className="btn btn-sm" type="button" disabled={busy || !(it.code === 'ready' || it.needPassphrase)} onClick={() => setAppr({ item: it, name: suggestKeyName(it), passphrase: '', features: [], otp: '' })}>승인</button>
                    <button className="btn btn-sm" type="button" disabled={busy || !it.sha} title={it.sha ? undefined : '내용을 읽지 못한 파일(너무 큼 · 링크 등)은 서버에서 직접 지우세요.'} onClick={async () => { const otp = window.prompt(`${it.file} 파일을 지웁니다 — 본인 OTP(없으면 비워 두세요)`, ''); if (otp === null) return; await run(() => postJson('/settings/ssh-access/inbox/discard', { relPath: it.relPath, sha: it.sha || '', otp }), `${it.file} 를 지웠습니다.`); }}>지우기</button>
                  </div></td>
                </tr>
              ))}</tbody>
            </STable>
          </section>
        )}
        {appr && (
          <fieldset className="ssa-form">
            <legend>{appr.item.file} 승인 — 암호화 저장소로 옮기고 평문 파일은 지웁니다</legend>
            <label>키 이름 <input className="input" value={appr.name} onChange={(e) => setAppr({ ...appr, name: e.target.value })} maxLength={64} /></label>
            {appr.item.needPassphrase && <label>passphrase <input className="input" type="password" value={appr.passphrase} onChange={(e) => setAppr({ ...appr, passphrase: e.target.value })} autoComplete="new-password" /></label>}
            <div className="ssa-wide"><span className="ssa-sub">쓸 수 있는 기능</span><FeaturePicker catalog={v.features} value={appr.features} onChange={(f) => setAppr({ ...appr, features: f })} /></div>
            {!featuresChosen(appr.features) && <p className="ssa-note" style={{ color: toneVar('warn') }}>기능을 하나 이상 고르세요.</p>}
            <Otp value={appr.otp} onChange={(x) => setAppr({ ...appr, otp: x })} />
            <div className="ssa-acts">
              <button className="btn primary" type="button" disabled={busy || !appr.name || !featuresChosen(appr.features)} onClick={async () => {
                const ok = await run(() => postJson('/settings/ssh-access/inbox/approve', { relPath: appr.item.relPath, fingerprint: appr.item.fingerprint || '', sha: appr.item.sha || '', name: appr.name, passphrase: appr.passphrase, features: appr.features, otp: appr.otp }),
                  (r) => (r.plaintextLeft ? `${appr.name} — 승인했지만 ⚠ 평문 파일을 지우지 못했습니다(${r.removeError || '사유 모름'}). 서버에서 직접 지우세요.` : `${appr.name} — 승인했습니다(평문 파일 삭제).`));
                if (ok) setAppr(null); else setAppr((x) => ({ ...x, otp: '', passphrase: '' }));
              }}>승인</button>
              <button className="btn" type="button" onClick={() => setAppr(null)}>닫기</button>
            </div>
            <p className="ssa-note">파일이 놓인 폴더(법인 · 서버)가 키의 폴더가 됩니다. 화면에서 본 뒤 파일 내용이 바뀌었으면 승인하지 않습니다.</p>
          </fieldset>
        )}
        {canAdd && (
          <fieldset className="ssa-form">
            <legend>이 폴더에 키 등록</legend>
            <label>이름 <input className="input" value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} placeholder="kr-ops-ed25519" maxLength={64} /></label>
            <label>회전 예정일 <input className="input" type="date" value={add.rotateAt} onChange={(e) => setAdd({ ...add, rotateAt: e.target.value })} /></label>
            <label className="ssa-wide">개인키(OpenSSH · PEM) <textarea className="input" rows={4} value={add.privateKey} onChange={(e) => setAdd({ ...add, privateKey: e.target.value })} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" spellCheck={false} autoComplete="off" /></label>
            <label>passphrase <input className="input" type="password" value={add.passphrase} onChange={(e) => setAdd({ ...add, passphrase: e.target.value })} autoComplete="new-password" /></label>
            <div className="ssa-wide"><span className="ssa-sub">쓸 수 있는 기능</span><FeaturePicker catalog={v.features} value={add.features} onChange={(f) => setAdd({ ...add, features: f })} /></div>
            {!featuresChosen(add.features) && <p className="ssa-note">쓸 기능을 하나 이상 고르세요 — 고른 기능만 이 키로 접속합니다.</p>}
            <Otp value={add.otp} onChange={(x) => setAdd({ ...add, otp: x })} />
            <div className="ssa-acts"><button className="btn primary" type="button" disabled={busy || !add.name || !add.privateKey || !featuresChosen(add.features) || v.policyMode !== 'encrypted'} onClick={async () => {
              const body = { name: add.name, privateKey: add.privateKey, passphrase: add.passphrase, rotateAt: add.rotateAt || undefined, folderCorp: node.corp, folderServer: node.kind === 'server' ? node.server : '', features: add.features, otp: add.otp };
              // 개인키 · passphrase · OTP 는 보낸 뒤 성공 · 실패와 무관하게 비운다(입력 칸 위생 — 실패하면 다시 붙여 넣는다).
              setAdd((x) => ({ ...x, privateKey: '', passphrase: '', otp: '' }));
              const ok = await run(() => postJson('/settings/ssh-access/keys', body), `${body.name} 을 등록했습니다.`);
              if (ok) setAdd(blankAdd);
            }}>등록</button></div>
            <p className="ssa-note">ed25519 권장 · RSA {v.rsaMinBits || '—'} 비트 미만 · DSA 는 받지 않습니다. 개인키는 암호화해 저장하고 화면 · API · 백업에는 지문 · 공개키만 나갑니다.</p>
          </fieldset>
        )}
      </div>
    </div>
  );
}

/* ── 쓰는 기능(시안 ④) ─────────────────────────────────────────────── */
function FeaturesTab({ v }) {
  const keys = (v.keys || []).filter((k) => k.status === 'active');
  return (
    <section className="ssa-sec">
      <h4>SSH 공용 접속을 쓰는 기능</h4>
      <STable minWidth={760} className="ssa-t">
        <thead><tr><th>기능</th><th>무엇을 하나</th><th className="right">허용한 키</th><th className="right">예전 방식 키(모든 기능)</th></tr></thead>
        <tbody>{(v.features || []).map((f) => (
          <tr key={f.id}><td data-sort={f.label}><b>{f.label}</b>{f.ready === false && <div><Chip tone="muted">다음 단계 — 아직 접속하지 않음</Chip></div>}</td><td className="ssa-sub">{f.note}</td>
            <td className="right" data-sort={keys.filter((k) => (k.features || []).includes(f.id)).length}>{keys.filter((k) => (k.features || []).includes(f.id)).length}</td>
            <td className="right" data-sort={keys.filter((k) => k.features == null).length}>{keys.filter((k) => k.features == null).length}</td></tr>
        ))}</tbody>
      </STable>
      <p className="ssa-note">모든 기능이 같은 한 곳(서버 고정 키 → 법인 기본 키 → 비밀번호)에서 계정을 받습니다. 키마다 ‘쓸 수 있는 기능’ 에 없는 기능은 그 키로 접속하지 않습니다. 로그인이 거부되면 그 기능이 그 서버의 주기 접속을 멈춥니다(기능마다 따로 — 계정 잠금 방지).</p>
      <p className="ssa-note">GPU 게스트 수집 등 자체 계정을 쓰는 다른 기능을 이 공용 접속으로 옮기는 단추는 다음 단계에서 붙입니다.</p>
    </section>
  );
}

/* ── 키 보안(시안 ⑤) ───────────────────────────────────────────────── */
function SecurityTab({ v, corpName, reload, say }) {
  const [use, loadUse] = useLoad('/settings/ssh-access/usage?limit=100');
  const [chg, loadChg] = useLoad('/settings/ssh-access/changes?limit=200');
  const [stopF, setStopF] = useState({ corp: '', reason: '', otp: '' });
  const [busy, setBusy] = useState(false);
  const items = sortedCheck(v.check?.items);
  const scan = async () => {
    setBusy(true);
    try { must(await postJson('/settings/ssh-access/scan', {})); say('점검을 시작했습니다 — 키가 많으면 몇십 초 걸립니다. 잠시 뒤 다시 읽기를 누르세요.', 'ok'); }
    catch (e) { say(errText(e), 'bad'); } finally { setBusy(false); }
  };
  const doStop = async (resume) => {
    setBusy(true);
    try {
      let r;
      if (resume) r = must(await delJson(`/settings/ssh-access/corps/${encodeURIComponent(stopF.corp)}/stop?otp=${encodeURIComponent(stopF.otp)}`));
      else r = must(await postJson(`/settings/ssh-access/corps/${encodeURIComponent(stopF.corp)}/stop`, { reason: stopF.reason, otp: stopF.otp }));
      // 엣지가 수집하는 서버는 그 엣지의 키로 접속한다 — 여기서 건 중지가 닿지 않는다는 것을 그대로 알린다.
      const edgeNote = !resume && r?.edgeServers ? ` 엣지가 수집하는 서버 ${r.edgeServers}대는 그 엣지 포탈에서 따로 중지해야 합니다.` : '';
      say(`${corpName(stopF.corp)} — 키 사용을 ${resume ? '재개' : '중지'}했습니다.${edgeNote}`, resume ? 'ok' : 'warn');
      setStopF({ corp: '', reason: '', otp: '' }); reload(); loadChg();
    } catch (e) { say(errText(e), 'bad'); setStopF((x) => ({ ...x, otp: '' })); } finally { setBusy(false); }
  };
  const [relOtp, setRelOtp] = useState('');
  // 다시 읽기 — 상태 파일(손상을 사람이 고친 뒤) · 키 저장소(포탈 밖 변경을 사람이 확인한 뒤). 둘 다 OTP · 감사.
  const outside = items.some((i) => i.code === 'tampered' || i.code === 'added-outside');
  const doReload = async (which) => {
    setBusy(true);
    try {
      const r = must(await postJson(`/settings/ssh-access/reload-${which}`, { otp: relOtp }));
      say(which === 'state' ? '상태 파일을 다시 읽었습니다.' : `키 저장소를 다시 읽었습니다(키 ${unitText(r.keys, '개')}) — 디스크 내용이 새 기준입니다.`, 'ok');
      setRelOtp(''); reload(); loadChg();
    } catch (e) { say(errText(e), 'bad'); setRelOtp(''); } finally { setBusy(false); }
  };
  const stopSel = (v.corps || []).find((c) => c.id === stopF.corp)?.stop;
  const stopUnknown = !!stopSel?.unreadable;
  const stopped = stopUnknown ? null : stopSel;
  const changeRows = [
    ...(chg.resp?.events || []).map((e) => ({ at: Number(e.at) || 0, what: EVENT_TEXT[e.kind] || e.kind, code: false, target: `${e.corp ? `${corpName(e.corp)} · ` : ''}${e.target || '—'}`, who: e.by || '포탈' })),
    ...(chg.resp?.items || []).map((e) => ({ at: auditTime(e.at), what: e.action, code: true, target: e.target || '—', who: e.user })),
  ].sort((a, b) => b.at - a.at);
  return (
    <div className="ssa-sec-wrap">
      <section className="ssa-sec">
        <div className="ssa-acts"><h4>키 점검</h4><span className="ssa-sub">마지막 {dateTime(v.check?.at)} · {v.scanEveryMinutes ? `${v.scanEveryMinutes}분마다` : '주기 모름'}</span><button className="btn btn-sm" type="button" disabled={busy} onClick={scan}>지금 점검</button><button className="btn btn-sm" type="button" onClick={() => { reload(); loadChg(); loadUse(); }}>다시 읽기</button></div>
        <ul className="ssa-check">{items.map((i, n) => (
          <li key={`${i.code}-${n}`}><Chip tone={LEVEL_TONE[i.level]}>{LEVEL_TEXT[i.level] || i.level}</Chip> <b>{i.title}</b>{i.detail ? <div className="ssa-sub">{i.detail}</div> : null}</li>
        ))}</ul>
      </section>
      {(v.stateUnreadable || outside) && (
        <section className="ssa-sec">
          <h4>파일을 확인한 뒤 다시 읽기</h4>
          <p className="ssa-note">
            {v.stateUnreadable ? '상태 파일을 읽지 못해 모든 키 접속을 멈췄습니다. 손상 보존본(ssh-access-state.json.corrupt.*)을 보고 파일을 고친 뒤 다시 읽으세요. ' : ''}
            {outside ? '키 저장소 파일이 포탈 밖에서 바뀌었습니다. 누가 왜 바꿨는지 확인한 뒤에만 받아들이세요 — 받아들이면 디스크 내용이 새 기준이 되고, 바뀐 키도 다시 쓰입니다.' : ''}
          </p>
          <div className="ssa-form ssa-inline">
            <Otp value={relOtp} onChange={setRelOtp} />
            <div className="ssa-acts">
              {v.stateUnreadable && <button className="btn" type="button" disabled={busy} onClick={() => doReload('state')}>상태 파일 다시 읽기</button>}
              {outside && <button className="btn danger" type="button" disabled={busy} onClick={() => doReload('keystore')}>키 저장소 다시 읽기(받아들이기)</button>}
            </div>
          </div>
        </section>
      )}
      <section className="ssa-sec ssa-danger">
        <h4>긴급 조치 — 법인 키 사용 중지</h4>
        <p className="ssa-note">키가 샜다고 의심되면 그 법인의 키 접속을 바로 멈춥니다. 서버는 바꾸지 않습니다(이 노드가 그 법인 키로 접속하지 않을 뿐). 중지할 때 그 법인 서버 목록을 함께 적어 두므로 서버의 법인을 바꿔도 풀리지 않습니다. 비밀번호로 접속하는 서버는 멈추지 않고, 엣지가 수집하는 서버는 그 엣지의 키를 쓰므로 그 엣지 포탈에서 따로 중지합니다.</p>
        <div className="ssa-form ssa-inline">
          <label>법인 <Select sort={false} className="select select-sm" value={stopF.corp} onChange={(e) => setStopF({ ...stopF, corp: e.target.value })}>
            <option value="">선택</option>{(v.corps || []).map((c) => <option key={c.id} value={c.id}>{c.name}{c.stop?.unreadable ? ' — 상태 모름' : c.stop ? ' — 중지 중' : ''}</option>)}
          </Select></label>
          {!stopped && <label>사유 <input className="input" value={stopF.reason} onChange={(e) => setStopF({ ...stopF, reason: e.target.value })} maxLength={200} /></label>}
          <Otp value={stopF.otp} onChange={(x) => setStopF({ ...stopF, otp: x })} />
          <div className="ssa-acts">
            {stopUnknown ? <span className="ssa-sub">상태 파일을 읽지 못해 중지 · 재개를 할 수 없습니다(먼저 위에서 상태 파일을 다시 읽으세요).</span>
              : stopped ? <button className="btn" type="button" disabled={busy || !stopF.corp} onClick={() => doStop(true)}>사용 재개</button>
              : <button className="btn danger" type="button" disabled={busy || !stopF.corp} onClick={() => doStop(false)}>이 법인 키 사용 중지</button>}
          </div>
        </div>
      </section>
      <section className="ssa-sec">
        <div className="ssa-acts"><h4>키 사용 기록</h4><span className="ssa-sub">접속 결과 · {use.resp?.retainDays ?? '—'}일 보관 · 주기 성공은 묶음 횟수로만</span><button className="btn btn-sm" type="button" onClick={loadUse}>다시 읽기</button></div>
        {use.err && <ErrorBox error={use.err} />}
        {use.resp?.loadFailed && <p className="ssa-note" style={{ color: toneVar('warn') }}>사용 기록 파일이 손상돼 보존본을 남기고 새로 시작했습니다 — 그 이전 기록은 이 화면에 없습니다.</p>}
        {use.resp && (
          <STable minWidth={860} className="ssa-t" limit={100}>
            <thead><tr><th>시각</th><th>키</th><th>서버</th><th>기능</th><th>시작</th><th>결과</th></tr></thead>
            <tbody>{(use.resp.recent || []).map((e, i) => (
              <tr key={`${e.at}-${i}`}><td data-sort={e.at}>{dateTime(e.at)}</td><td data-sort={e.keyName}><code>{e.keyName || shortFp(e.fingerprint)}</code></td><td>{e.server}</td><td>{e.feature}</td>
                <td>{e.by || (e.trigger === 'manual' ? '사람(수동)' : '주기')}</td>
                <td data-sort={USE_CODE_TEXT[e.code] || e.code}><Chip tone={e.ok ? 'ok' : 'bad'}>{USE_CODE_TEXT[e.code] || e.code}</Chip>{e.unusual ? <Chip tone="warn">{UNUSUAL_TEXT[e.unusual] || e.unusual}</Chip> : null}</td></tr>
            ))}{!(use.resp.recent || []).length && <tr><td colSpan={6} className="ssa-sub">기록이 없습니다.</td></tr>}</tbody>
          </STable>
        )}
        <p className="ssa-note">‘처음 쓰인 서버 · 기능’ 은 표시만 합니다(막지 않습니다). 이 기록은 이 노드가 키로 접속한 것만입니다 — 엣지가 수집하는 서버는 그 엣지 포탈에 있습니다.</p>
      </section>
      <section className="ssa-sec">
        <div className="ssa-acts"><h4>키 변경 기록</h4><span className="ssa-sub">감사 로그(지울 수 없음) · 키 보안 사건 · 이 브라우저 시각</span><button className="btn btn-sm" type="button" onClick={loadChg}>다시 읽기</button></div>
        {chg.err && <ErrorBox error={chg.err} />}
        {chg.resp && (
          <STable minWidth={860} className="ssa-t" limit={300}>
            <thead><tr><th>시각</th><th>무엇</th><th>대상</th><th>누가</th></tr></thead>
            <tbody>
              {changeRows.map((e, i) => (<tr key={`c-${e.at}-${i}`}><td data-sort={e.at}>{dateTime(e.at)}</td><td data-sort={e.what}>{e.code ? <code>{e.what}</code> : e.what}</td><td>{e.target}</td><td>{e.who}</td></tr>))}
              {!changeRows.length && <tr><td colSpan={4} className="ssa-sub">기록이 없습니다.</td></tr>}
            </tbody>
          </STable>
        )}
      </section>
      <section className="ssa-sec">
        <h4>이 보호가 막지 못하는 것</h4>
        <ul className="ssa-list">
          <li>키를 암호화하는 열쇠는 이 포탈 서버 안에 있습니다. 서버의 관리자 권한이 넘어가면 키도 함께 열립니다 — 저장 암호화는 백업 · 사본 · 디스크 유출을 막는 보호입니다.</li>
          <li>접속하는 동안에는 개인키가 포탈 프로세스 메모리에 풀려 있습니다.</li>
          <li>키 파일이 포탈 밖에서 바뀌었는지는 {v.scanEveryMinutes ? `${v.scanEveryMinutes}분` : '주기'}마다 확인합니다 — 그 사이의 변경은 다음 점검에서 잡힙니다. 키 원문과 지문을 함께 바꾼 경우는 ‘포탈이 마지막으로 쓴 내용과 다름’ 으로만 압니다 — 포탈이 그 사이 재시작하면 디스크 내용이 새 기준이 되어 잡히지 않습니다.</li>
        </ul>
      </section>
    </div>
  );
}
