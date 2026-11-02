import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, delJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import BoldText from '../../components/boldText.jsx';
import {
  checkView, checkCountsText, stepView, jobView, edgeAgeText, targetModeText, uploadText, stepDurText, fixesOrdered, retryLabel,
  defaultPlan, planBody, planIssues, PYVMOMI_REASON, WEEKDAY_KO, bytesText, whenText,
  RUNNING_UNKNOWN_OK_LABEL, runningUnknown, volumesSizeText, okOrThrow, rollbackCauseText,
  bundleFromText, importDirStateText, bundleWhereText, bundleStateView, bundleSourceHelp,
} from './bareosInstallText.js';

/**
 * Bareos 완전 설치(v2.844 · 설정 탭 — 전 법인 범위 관리자만 보인다).
 * 사용자 요청: '엣지 노드의 ip/id/pw 를 알고 있으니 bareos 를 완전히 자동으로 설치' · '실패하면 구체적으로 오류를 알려주고 고쳐서 다시 시도'.
 * 단계: 대상 → (재설치면 초기화 확인) → 사전 점검(쓰기 없음) → 계획 → 실행(엣지 노드 안에서 · 화면을 닫아도 계속) → 마무리(vCenter 계정 1회).
 * OTP 코드는 묻지 않는다(사용자 결정 — OTP 를 등록한 관리자만 실행 · 감사에 'OTP 없이 실행').
 */
const P = '/tools/bareos-backup/settings/install';
const ROW = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' };
const BTN = { padding: '4px 10px', fontSize: 12 };
const INP = { minWidth: 0, width: '100%', boxSizing: 'border-box' };
const FIELD = { fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 };
const GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(170px, 100%), 1fr))', gap: 10, marginTop: 8, alignItems: 'end' };
const CARD = { padding: 14, marginTop: 10, minWidth: 0 };
const DEEP = { padding: 12, marginTop: 10, minWidth: 0, background: 'var(--panel-deep)' };
const PRE = { margin: '6px 0 0', padding: 10, background: 'var(--panel-deep)', borderRadius: 6, fontSize: 11.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 260, overflow: 'auto' };
const POLL_MS = 4000;
// 표 칸은 기본 nowrap — 긴 사유·패키지 이름은 칸 안에서 줄바꿈(Chromium 1440: 사유가 한 줄로 길어 오른쪽 열이 가려졌다)
const WRAP = { whiteSpace: 'normal', overflowWrap: 'anywhere', minWidth: 0 };

function Badge({ cls, children }) { return <span className={`badge ${cls}`} style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{children}</span>; }
function Msg({ m }) {
  if (!m) return null;
  return <div className={`banner ${m.ok === false ? 'bad' : m.ok === 'warn' ? 'warn' : 'ok'}`} role={m.ok === false ? 'alert' : 'status'} style={{ marginTop: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}><BoldText text={m.text} /></div>;
}
const copyText = (t, say) => { try { navigator.clipboard.writeText(t).then(() => say({ ok: true, text: '복사했습니다.' }), () => say({ ok: false, text: '복사하지 못했습니다 — 직접 선택해 복사하세요.' })); } catch { say({ ok: false, text: '복사하지 못했습니다.' }); } };

function Stepper({ step, reinstall }) {
  const steps = [['targets', '대상 고르기'], ...(reinstall ? [['reset', '초기화 확인']] : []), ['precheck', '사전 점검'], ['plan', '설치 계획'], ['run', '실행'], ['finish', '마무리']];
  const cur = steps.findIndex(([k]) => k === step);
  return (
    <ol aria-label="완전 설치 단계" style={{ ...ROW, listStyle: 'none', margin: '10px 0 0', padding: 0 }}>
      {steps.map(([k, label], i) => (
        <li key={k} className={`badge ${i === cur ? 'blue' : i < cur ? 'green' : 'gray'}`} style={{ fontSize: 12 }} aria-current={i === cur ? 'step' : undefined}>{i < cur ? '✓ ' : `${i + 1} `}{label}</li>
      ))}
    </ol>
  );
}

/* ───────── 번들 ───────── */
function BundleCard({ ov, onReload, say, writable }) {
  const [busy, setBusy] = useState(false);
  const src = ov.bundleSource || null;
  const [edit, setEdit] = useState(null);   // v2.850 받는 곳 · 서버 디렉터리 편집({ baseUrl, importDir })
  const b = (ov.bundles || []).find((x) => x.ok) || null;
  const f = ov.fetch;
  const act = async (fn, okText) => { setBusy(true); try { await fn(); if (okText) say({ ok: true, text: okText }); await onReload(); } catch (e) { say({ ok: false, text: e.message }); } finally { setBusy(false); } };
  return (
    <div className="card" style={DEEP}>
      <div style={ROW}>
        <div style={{ flex: '1 1 380px', minWidth: 0 }}>
          <b>오프라인 번들</b>
          <div className="muted" style={{ fontSize: 12, marginTop: 2, overflowWrap: 'anywhere' }}>
            Rocky/RHEL 9 용 Bareos · PostgreSQL · WebUI · VMware 플러그인(VDDK 포함) · pyVmomi 8.x 휠 묶음입니다. 포탈 릴리스와 <b>같은 서명 키</b>로 서명된 번들만 씁니다(어디서 받든 같은 검증).
          </div>
          <div style={{ fontSize: 12, marginTop: 4, overflowWrap: 'anywhere' }}>받는 곳: <code>{ov.bundleBaseUrl || '—'}</code>{src ? <span className="muted"> · {bundleFromText(src.from)}</span> : null}</div>
          {src && <div style={{ fontSize: 12, marginTop: 2, overflowWrap: 'anywhere' }}>서버 디렉터리: {src.importDir ? <><code>{src.importDir}</code> <Badge cls={importDirStateText(src.importDirState).cls}>{importDirStateText(src.importDirState).text}</Badge></> : <span className="muted">정하지 않음</span>}</div>}
          {src?.loadError && <div className="banner warn" style={{ marginTop: 4, fontSize: 12 }}>{src.loadError}</div>}
        </div>
        {/* v2.850(Chromium 400 — 단추 셋이 줄지 않아 16px 넘쳤다): 단추 묶음도 줄고 줄바꿈한다 */}
        <div style={{ ...ROW, flex: '0 1 auto', minWidth: 0 }}>
          <button type="button" className="login-btn" style={BTN} disabled={busy || !writable || (f && !f.doneAt)} onClick={() => act(async () => okOrThrow(await postJson(`${P}/bundle/fetch`, {})), '번들 받기를 시작했습니다 — 아래에 진행이 보입니다.')}>번들 받기(최신)</button>
          <button type="button" className="logout-btn" style={BTN} disabled={busy || !writable} onClick={() => act(async () => okOrThrow(await postJson(`${P}/bundle/rescan`, {})), '번들 폴더를 다시 확인했습니다(서명·해시).')}>다시 확인</button>
          {src && <button type="button" className="logout-btn" style={BTN} disabled={busy || !writable} onClick={() => setEdit((e) => (e ? null : { baseUrl: src.savedUrl || '', importDir: src.importDir || '' }))}>{edit ? '받는 곳 닫기' : '받는 곳 · 디렉터리 바꾸기'}</button>}
        </div>
      </div>
      {edit && src && (
        <div className="card" style={{ ...DEEP, marginTop: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: 10 }}>
            <label className="muted" style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, minWidth: 0 }}>번들 받는 주소(비우면 기본)
              <input className="input" value={edit.baseUrl} onChange={(e) => setEdit({ ...edit, baseUrl: e.target.value })} placeholder={src.envUrl || 'https://미러/…/releases/download/bareos-bundle'} aria-label="번들 받는 주소" />
            </label>
            <label className="muted" style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, minWidth: 0 }}>서버 디렉터리(비우면 쓰지 않음)
              <input className="input" value={edit.importDir} onChange={(e) => setEdit({ ...edit, importDir: e.target.value })} placeholder="/data/bareos-bundle" aria-label="서버 디렉터리" />
            </label>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 6, overflowWrap: 'anywhere' }}>
            <BoldText text={bundleSourceHelp(src)} />
          </div>
          <div style={{ ...ROW, marginTop: 8 }}>
            <button type="button" className="login-btn" style={BTN} disabled={busy || !writable} onClick={() => act(async () => { okOrThrow(await putJson(`${P}/bundle/source`, { baseUrl: edit.baseUrl.trim(), importDir: edit.importDir.trim() }), '저장하지 못했습니다.'); setEdit(null); }, '번들 받는 곳 · 서버 디렉터리를 저장했습니다.')}>저장</button>
            <button type="button" className="logout-btn" style={BTN} disabled={busy} onClick={() => setEdit(null)}>취소</button>
          </div>
        </div>
      )}
      {f && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>받기: {f.doneAt ? (f.phase === 'done' ? `끝 · ${f.version}` : `실패 — ${f.error || '사유 미상'}`) : `${f.phase} · ${f.version || ''} ${f.total ? `${bytesText(f.sent)} / ${bytesText(f.total)}` : ''}`}</div>}
      <div className="table-wrap" style={{ marginTop: 8 }}>
        <STable minWidth={760}>
          <thead><tr><th>번들</th><th>위치</th><th>상태</th><th>Bareos</th><th>PostgreSQL</th><th>pyVmomi(휠)</th><th>VDDK</th><th className="right">크기</th><th data-nosort>동작</th></tr></thead>
          <tbody>
            {(ov.bundles || []).length === 0 && <tr><td colSpan={9} className="center muted" style={{ padding: 14 }}>받아 둔 번들이 없습니다 — ‘번들 받기’ 를 누르거나, 서버 디렉터리에 번들 파일 3개를 두세요.</td></tr>}
            {(ov.bundles || []).map((x) => (
              <tr key={`${x.where || 'bundle'}:${x.version}`}>
                <td><code>{x.version}</code></td>
                <td>{bundleWhereText(x.where)}</td>
                <td><Badge cls={bundleStateView(x).cls}>{bundleStateView(x).text}</Badge></td>
                <td>{x.contents?.bareosVersion || '—'}</td><td>{x.contents?.postgresqlVersion || '—'}</td>
                <td style={WRAP}>{x.contents?.pyvmomi?.versions?.join(' · ') || '—'}</td><td style={{ ...WRAP, fontSize: 12 }}>{x.contents?.vddk?.join(' · ') || '—'}</td>
                <td className="right">{bytesText(x.size)}</td>
                {/* v2.850: 서버 디렉터리의 번들은 사람의 파일 — 포탈이 지우지 않는다 */}
                <td>{x.where === 'import' ? <span className="muted" title="서버 디렉터리의 파일은 포탈이 지우지 않습니다">—</span> : <button type="button" className="logout-btn" style={BTN} disabled={busy || !writable || ov.demo} onClick={() => act(() => delJson(`${P}/bundle/${encodeURIComponent(x.version)}`), `번들 ${x.version} 을(를) 지웠습니다.`)}>지우기</button>}</td>
              </tr>
            ))}
          </tbody>
        </STable>
      </div>
      {b && /pre/.test(b.contents?.bareosVersion || '') && <div className="banner warn" style={{ marginTop: 8, fontSize: 12 }}>이 번들의 Bareos 는 <b>사전 공개판</b>({b.contents.bareosVersion} — download.bareos.org/current, ‘experimental’ 키 서명)입니다. 현장 설치 문서의 판과 같습니다. 정식판은 구독 저장소(자격증명 필요)에서만 받을 수 있습니다.</div>}
    </div>
  );
}

/* ───────── 1 대상 ───────── */
function TargetsStep({ ov, sel, setSel, onNext, onOpenJob }) {
  const t = ov.targets.find((x) => x.vcenterId === sel) || null;
  return (
    <div className="card" style={CARD}>
      <b>1 대상 고르기</b>
      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>설치 대상은 <b>법인의 엣지 노드 자체</b>입니다. 접속은 배포 등록부에 저장된 SSH root 계정을 쓰므로 비밀번호를 다시 묻지 않습니다. 법인 · vCenter · Bareos 는 1:1:1 입니다. Director 가 이미 등록된 법인은 <b>초기화 후 재설치</b>로 고를 수 있습니다(엣지 노드 위의 Director 일 때만).</div>
      <div className="table-wrap" style={{ marginTop: 10 }}>
        <STable minWidth={960}>
          <thead><tr><th data-nosort>선택</th><th>법인(vCenter)</th><th>엣지 노드</th><th>엣지 응답</th><th>SSH 계정</th><th>Director 등록</th><th>완전 설치</th><th>최근 작업</th></tr></thead>
          <tbody>
            {ov.targets.length === 0 && <tr><td colSpan={8} className="center muted" style={{ padding: 14 }}>vCenter 가 없습니다.</td></tr>}
            {ov.targets.map((r) => (
              <tr key={r.vcenterId} className={r.can ? '' : 'off'}>
                <td><input type="radio" name="bi-target" aria-label={`${r.vcenterName} 고르기`} disabled={!r.can} checked={sel === r.vcenterId} onChange={() => setSel(r.vcenterId)} /></td>
                <td><b>{r.vcenterName}</b><div className="muted" style={{ fontSize: 11.5 }}>{r.vcHost || '—'}</div></td>
                <td>{r.agent ? <>{r.agent}<div className="muted" style={{ fontSize: 11.5 }}>{r.sshHost || '—'}{r.sshPort && r.sshPort !== 22 ? `:${r.sshPort}` : ''}</div></> : '—'}</td>
                <td data-sort={r.edgeAgeMs ?? ''}>{r.agent ? edgeAgeText(r.edgeAgeMs) : '—'}</td>
                <td>{r.sshUser ? `${r.sshUser} · ${r.hasPassword ? '저장됨' : '없음'}` : '—'}</td>
                <td>{r.director ? <>{r.director.name}<div className="muted" style={{ fontSize: 11.5 }}>{r.director.host}{r.director.agent ? ` · 담당 ${r.director.agent}` : ' · 중앙 직접'}</div></> : '미등록'}</td>
                <td style={{ ...WRAP, maxWidth: 300 }}>{r.can ? <Badge cls={r.mode === 'reinstall' ? 'amber' : 'green'}>{targetModeText(r)}</Badge> : <span className="muted" style={{ fontSize: 12 }}>{targetModeText(r)}</span>}</td>
                <td>{r.lastJob ? <button type="button" className="logout-btn" style={BTN} onClick={() => onOpenJob(r.lastJob.id)}><Badge cls={jobView(r.lastJob.status).cls}>{jobView(r.lastJob.status).text}</Badge></button> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </STable>
      </div>
      <div style={{ ...ROW, marginTop: 10, justifyContent: 'flex-end' }}>
        <span className="muted" style={{ fontSize: 12 }}>다음 단계는 서버에 쓰지 않습니다(읽기만).</span>
        <button type="button" className="login-btn" disabled={!t} onClick={onNext}>{t?.mode === 'reinstall' ? '초기화 확인으로 →' : '사전 점검으로 →'}</button>
      </div>
    </div>
  );
}

/* ───────── 점검 표 ───────── */
function CheckTable({ pre }) {
  return (
    <div className="table-wrap" style={{ marginTop: 8 }}>
      <STable minWidth={820}>
        <thead><tr><th>항목</th><th>결과</th><th>상세</th><th>조치</th></tr></thead>
        <tbody>
          {pre.items.map((i) => { const v = checkView(i.status); return (
            <tr key={i.key}><td><b>{i.label}</b></td><td data-sort={i.status}><Badge cls={v.cls}>{v.mark}</Badge></td><td style={WRAP}>{i.detail || '—'}</td><td className="muted" style={{ ...WRAP, fontSize: 12 }}>{i.action || '없음'}</td></tr>
          ); })}
        </tbody>
      </STable>
    </div>
  );
}

/* ───────── 1b 초기화 확인 ───────── */
function ResetStep({ t, pre, plan, setPlan, onBack, onNext, onRecheck, busy }) {
  const r = plan.reset || {};
  const set = (patch) => setPlan({ ...plan, reset: { ...r, ...patch } });
  const vols = (pre?.volumes || []).filter((v) => !v.missing);
  const volSize = volumesSizeText(vols);   // v2.846 U-12: 못 읽은 크기를 0 으로 더하지 않는다('일부 모름')
  const nameOk = !r.volumes || String(r.confirmName || '').trim() === String(t.vcenterName).trim();
  return (
    <div className="card" style={CARD}>
      <div style={ROW}><b style={{ flex: '1 1 auto' }}>초기화 확인 — {t.vcenterName}</b><Badge cls="amber">초기화 후 재설치</Badge>
        <button type="button" className="logout-btn" style={BTN} disabled={busy} onClick={onRecheck}>다시 읽기</button></div>
      <div className="banner warn" style={{ marginTop: 8, fontSize: 12.5 }}>이 법인에는 Director ‘{t.director?.name}’ 가 이미 등록돼 있습니다. 완전 설치를 하려면 <b>기존 설치 패키지 · 설정값을 지우고 다시 설치</b>합니다. 아래는 지금 상태를 <b>읽기만</b> 한 것이고, 무엇을 지울지는 실행 때마다 여기서 고릅니다.</div>
      {!pre ? <Loading /> : (
        <>
          <dl className="muted" style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr)', gap: '4px 14px', fontSize: 12.5, margin: '10px 0 0' }}>
            <dt>Bareos 패키지 · 설정</dt><dd style={{ margin: 0 }}>{pre.items.find((i) => i.key === 'bareos')?.detail || '—'}</dd>
            <dt>실행 중 작업</dt><dd style={{ margin: 0 }}>{pre.items.find((i) => i.key === 'running')?.detail || '—'}</dd>
            <dt>카탈로그 DB</dt><dd style={{ margin: 0 }}>{pre.catalogBytes == null ? '읽지 못함(PostgreSQL 꺼짐 또는 DB 없음)' : `bareos · ${bytesText(pre.catalogBytes)}`}</dd>
            <dt>백업 볼륨</dt><dd style={{ margin: 0 }}>{vols.length ? vols.map((v) => `${v.path} · ${v.files == null ? '파일 수 —' : `파일 ${v.files}개`} · ${bytesText(v.bytes)} · 마지막 ${whenText(v.lastAt)}`).join(' / ') : '설정에서 읽은 볼륨 경로 없음'}</dd>
            <dt>포탈 쪽</dt><dd style={{ margin: 0 }}>Director 등록 ‘{t.director?.name}’ · 이 법인의 백업 대상 {pre.ledgerTargets == null ? '—' : `${pre.ledgerTargets}개`}(초기화하면 Director 의 잡 설정이 지워집니다 — 포탈 목록은 남고, 마무리 화면이 다시 등록하는 방법을 안내합니다)</dd>
          </dl>
          <div className="card" style={DEEP}>
            <label style={{ ...ROW, fontSize: 13 }}><input type="checkbox" checked disabled /> <b>패키지 · 설정 삭제</b> <Badge cls="gray">필수 · 끌 수 없음</Badge></label>
            <div className="muted" style={{ fontSize: 12, marginLeft: 24 }}>bareos 패키지를 지우고 /etc/bareos 를 지웁니다. 지우기 전에 <b>엣지 노드 안</b>(/var/lib/portal-bareos-install/reset/)에 tar 로 보관합니다 — 법인 밖으로 보내지 않습니다. 서비스는 멈추고 끕니다.</div>
            <label style={{ ...ROW, fontSize: 13, marginTop: 10 }}><input type="checkbox" checked={r.catalog !== false} onChange={(e) => set({ catalog: e.target.checked })} /> <b>카탈로그 DB 삭제</b> <Badge cls="amber">기본 켬</Badge></label>
            <div className="muted" style={{ fontSize: 12, marginLeft: 24 }}>끄면 재설치 뒤 기존 기록(잡 이력 · 볼륨 목록)을 그대로 쓰고 판만 맞춥니다(update_bareos_tables).</div>
            <label style={{ ...ROW, fontSize: 13, marginTop: 10 }}><input type="checkbox" checked={!!r.volumes} onChange={(e) => set({ volumes: e.target.checked })} /> <b>백업 볼륨 삭제</b> <Badge cls="gray">기본 끔</Badge></label>
            {!r.volumes ? <div className="muted" style={{ fontSize: 12, marginLeft: 24 }}>끈 상태: 볼륨({volSize.text})은 남고, 재설치 뒤 bscan 으로 다시 읽어 들일 수 있습니다(오래 걸림 — 크기에 비례).</div> : (
              <div style={{ marginLeft: 24, marginTop: 6 }}>
                <div className="banner bad" style={{ fontSize: 12.5 }}><b>기존 백업 데이터가 모두 지워지고 복원할 수 없습니다.</b> 볼륨 {vols.length}곳 · {volSize.text}. 진행하려면 법인 이름을 정확히 입력하세요.</div>
                <label style={{ ...FIELD, marginTop: 6, maxWidth: 360 }}>법인 이름 입력 — ‘{t.vcenterName}’ 과 일치해야 진행
                  <input className="input" style={INP} value={r.confirmName || ''} onChange={(e) => set({ confirmName: e.target.value })} aria-label="법인 이름 확인" /></label>
              </div>
            )}
          </div>
          <div className="banner" style={{ marginTop: 10, fontSize: 12.5 }}>실행 화면 맨 앞에 <b>0 기존 제거</b> 단계가 붙습니다 — 지운 것은 되돌릴 수 없어, 이 단계가 실패하면 되돌리지 않고 남은 것을 보인 뒤 이어서 다시 합니다.</div>
          <div style={{ ...ROW, marginTop: 10 }}>
            <label style={{ ...ROW, flex: '1 1 auto', fontSize: 13 }}><input type="checkbox" checked={!!r.ack} onChange={(e) => set({ ack: e.target.checked })} /> 위 항목을 지우는 것을 확인했습니다</label>
            <button type="button" className="logout-btn" onClick={onBack}>← 대상 고르기로</button>
            <button type="button" className="login-btn" disabled={!r.ack || !nameOk} onClick={onNext}>초기화하고 재설치 계획으로 →</button>
          </div>
          {(!r.ack || !nameOk) && <div className="muted" style={{ fontSize: 12, textAlign: 'right', marginTop: 4 }}>필요: {!r.ack ? '확인 체크' : '법인 이름 일치'}</div>}
        </>
      )}
    </div>
  );
}

/* ───────── 2 사전 점검 ───────── */
function PrecheckStep({ pre, onRecheck, onBack, onNext, busy }) {
  return (
    <div className="card" style={CARD}>
      <div style={ROW}>
        <b style={{ flex: '1 1 auto' }}>2 사전 점검(쓰기 없음)</b>
        {pre && <span className="muted" style={{ fontSize: 12 }}>{checkCountsText(pre.counts)} · {whenText(pre.at)} · {Math.round((pre.ms || 0) / 100) / 10}초</span>}
        <button type="button" className="logout-btn" style={BTN} disabled={busy} onClick={onRecheck}>다시 점검</button>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>저장된 root 계정으로 접속해 읽기만 합니다. 결과는 지금 이 순간의 상태이고, ‘설치 시작’ 을 누를 때 같은 점검을 한 번 더 합니다. ✗ 가 있으면 진행하지 않습니다 · ? 는 읽지 못한 것(0 이 아님)입니다.</div>
      {!pre ? <Loading /> : <CheckTable pre={pre} />}
      <div style={{ ...ROW, marginTop: 10, justifyContent: 'flex-end' }}>
        <button type="button" className="logout-btn" onClick={onBack}>← 앞으로</button>
        <button type="button" className="login-btn" disabled={!pre || pre.blocked} onClick={onNext}>{pre?.blocked ? '필요: ✗ 조치' : '설치 계획으로 →'}</button>
      </div>
    </div>
  );
}

/* ───────── 3 계획 ───────── */
function PlanFields({ plan, setPlan, bundle, pre, compact = false }) {
  const set = (k, v) => setPlan({ ...plan, [k]: v });
  const setIn = (k, kk, v) => setPlan({ ...plan, [k]: { ...plan[k], [kk]: v } });
  const versions = bundle?.contents?.pyvmomi?.versions || [];
  return (
    <>
      <div style={GRID}>
        <label style={FIELD}>pyVmomi 판(번들 휠)
          <Select className="input" sort={false} style={INP} value={plan.pyvmomi} onChange={(e) => set('pyvmomi', e.target.value)} aria-label="pyVmomi 판">
            {versions.map((v, i) => <option key={v} value={v}>{v}{i === 0 ? ' — 권고' : ''}</option>)}
            <option value="" disabled>9.x — 고를 수 없음(Python 3.9 에서 동작 안 함)</option>
          </Select></label>
        <label style={FIELD}>볼륨 경로(엣지 노드 디스크)<input className="input" style={INP} value={plan.volumeDir} onChange={(e) => set('volumeDir', e.target.value)} /></label>
        <label style={FIELD}>볼륨 하나 최대(GB)<input className="input" style={INP} inputMode="numeric" value={plan.pools.maxVolumeGB} onChange={(e) => setIn('pools', 'maxVolumeGB', e.target.value)} /></label>
        {!compact && <>
          <label style={FIELD}>Full 풀 보존(일)<input className="input" style={INP} inputMode="numeric" value={plan.pools.fullDays} onChange={(e) => setIn('pools', 'fullDays', e.target.value)} /></label>
          <label style={FIELD}>Incr 풀 보존(일)<input className="input" style={INP} inputMode="numeric" value={plan.pools.incrDays} onChange={(e) => setIn('pools', 'incrDays', e.target.value)} /></label>
          <label style={FIELD}>전체 백업 요일
            <Select className="input" sort={false} style={INP} value={plan.schedule.fullDay} onChange={(e) => setIn('schedule', 'fullDay', e.target.value)} aria-label="전체 백업 요일">
              {Object.entries(WEEKDAY_KO).map(([k, v]) => <option key={k} value={k}>{v}요일</option>)}
            </Select></label>
          <label style={FIELD}>시각(서버 시각 · 나머지 요일은 증분)<input className="input" style={INP} value={plan.schedule.time} onChange={(e) => setIn('schedule', 'time', e.target.value)} placeholder="02:00" /></label>
          <label style={FIELD}>포탈 전용 콘솔 이름<input className="input" style={INP} value={plan.consoleName} onChange={(e) => set('consoleName', e.target.value)} /></label>
          <label style={FIELD}>포탈에 등록할 Director 이름<input className="input" style={INP} value={plan.directorName} onChange={(e) => set('directorName', e.target.value)} /></label>
        </>}
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{PYVMOMI_REASON}</div>
      {(pre?.pluginPathCopies?.length > 0 || plan.pyvmomiFix) && (
        <label style={{ ...ROW, fontSize: 12.5, marginTop: 6 }}><input type="checkbox" checked={!!plan.pyvmomiFix} onChange={(e) => set('pyvmomiFix', e.target.checked)} /> 플러그인 경로(/usr/lib64/bareos/plugins)의 pyVmomi 사본을 옆으로 옮깁니다(지우지 않음 · 두 곳에 다른 판이 있으면 그쪽이 먼저 불립니다)</label>
      )}
      {!compact && <label style={{ ...ROW, fontSize: 12.5, marginTop: 6 }}><input type="checkbox" checked={plan.webui !== false} onChange={(e) => set('webui', e.target.checked)} /> WebUI(bareos-webui · httpd · php-fpm) 함께 설치 — 웹 포트 80 을 firewalld 에 엽니다(켜져 있을 때) · 로그인 계정은 다음 기능(WebUI 계정)에서 만듭니다</label>}
    </>
  );
}

function PlanStep({ t, pre, bundle, plan, setPlan, onBack, onStart, busy }) {
  const issues = planIssues(plan, t, pre);
  const unknownRun = runningUnknown(pre, t);
  const b = bundle?.contents || {};
  return (
    <div className="card" style={CARD}>
      <b>3 설치 계획 — {t.vcenterName} · {t.agent}({pre?.hostAddr || t.sshHost})</b>
      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>‘설치 시작’ 전에는 서버에 아무것도 쓰지 않습니다. 패키지 판은 번들에 고정이고 pyVmomi 만 번들 안의 8.x 중에서 고릅니다. 시작하면 1 → 7단계가 이어서 돌고, 마무리에서 vCenter 계정 · 비밀번호만 한 번 묻습니다.</div>
      <div className="card" style={DEEP}>
        <b style={{ fontSize: 13 }}>패키지 — 오프라인 번들 {bundle?.version || '—'}</b>
        <div style={{ fontSize: 12.5, marginTop: 4, lineHeight: 1.7 }}>Bareos {b.bareosVersion || '—'}(Director · Storage · FD · VMware 플러그인 · tools) · PostgreSQL {b.postgresqlVersion || '—'}(카탈로그) · VDDK {b.vddk?.join(' · ') || '—'}(플러그인 의존성으로 함께) · WebUI · 설치는 dnf(번들 저장소만 · 인터넷 없음 · 서명 확인)</div>
      </div>
      <PlanFields plan={plan} setPlan={setPlan} bundle={bundle} pre={pre} />
      <div className="card" style={DEEP}>
        <b style={{ fontSize: 13 }}>무엇이 바뀌나요 — 엣지 노드 ‘{t.agent}’ 에서</b>
        <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12.5, lineHeight: 1.7 }}>
          {t.mode === 'reinstall' && <li><b>0 기존 제거</b>: bareos 패키지 · /etc/bareos(보관 뒤){plan.reset?.catalog !== false ? ' · 카탈로그 DB' : ''}{plan.reset?.volumes ? ' · 백업 볼륨' : ''}</li>}
          <li>설치: 번들의 패키지 · pyVmomi {plan.pyvmomi}(pip — 시스템 site-packages) · 카탈로그 DB 초기화</li>
          <li>만드는 파일(포탈 표지 파일): SD 장치 PortalFileStorage(볼륨 {plan.volumeDir}) · Director 스토리지 PortalFile · 콘솔 ‘{plan.consoleName}’ · Profile · FileSet · JobDefs · 풀 2개 · 스케줄 · 복원 잡 · FD 플러그인 줄</li>
          <li>켜는 서비스: postgresql · bareos-dir · bareos-sd · bareos-fd{plan.webui !== false ? ' · httpd · php-fpm' : ''} · 방화벽: {plan.webui !== false ? 'http(80)만 엽니다' : '바꾸지 않습니다'}(Director · SD · FD 는 한 서버 안에서만 통신)</li>
          <li>포탈에 기록: Director 등록(담당 = 엣지 ‘{t.agent}’ · 주소 {pre?.hostAddr || '—'}) · 매핑 1건 · 콘솔 비밀번호(암호화) · 감사 로그</li>
          <li>되돌리기: 실패하면 <b>그 단계만</b> 되돌리고(앞 단계는 유지) 원인과 고치는 방법을 보입니다. 서버를 설치 전으로 돌리려면 실행 화면의 ‘전부 되돌리기’.</li>
        </ul>
      </div>
      <div className="banner" style={{ marginTop: 10, fontSize: 12.5 }}>실행 계정: OTP 를 등록한 관리자(코드 입력 없음) · 감사 로그에 ‘OTP 없이 실행’ 으로 남깁니다. 시작하는 순간 사전 점검을 한 번 더 하고, 결과가 달라졌으면 시작하지 않습니다.</div>
      {unknownRun && (
        <div className="banner warn" style={{ marginTop: 8, fontSize: 12.5 }}>
          사전 점검이 Director 의 <b>실행 중 작업을 확인하지 못했습니다</b>(bconsole 접속 · 인증 실패 또는 bconsole 없음). 0단계도 같은 확인을 하고, 못 읽으면 아무것도 지우지 않고 멈춥니다.
          진행 현황 탭 · WebUI 에서 실행 중인 백업 · 복원이 없음을 직접 확인했을 때만 체크하세요 — 돌던 작업이 있으면 초기화가 끊습니다(이번 실행에만 적용).
          <label style={{ ...ROW, marginTop: 6 }}><input type="checkbox" checked={plan.runningUnknownOk === true} onChange={(e) => setPlan({ ...plan, runningUnknownOk: e.target.checked })} /> {RUNNING_UNKNOWN_OK_LABEL}</label>
        </div>
      )}
      {issues.length > 0 && <div className="banner warn" style={{ marginTop: 8, fontSize: 12.5 }}>{issues.join(' · ')}</div>}
      <div style={{ ...ROW, marginTop: 10, justifyContent: 'flex-end' }}>
        <button type="button" className="logout-btn" onClick={onBack}>← 사전 점검으로</button>
        <button type="button" className="login-btn" disabled={busy || issues.length > 0} onClick={onStart}>{busy ? '시작하는 중…' : t.mode === 'reinstall' ? '초기화하고 설치 시작' : '설치 시작'}</button>
      </div>
    </div>
  );
}

/* ───────── 4 실행 ───────── */
function FailureCard({ j, bundle, onRetry, onRollback, busy, say }) {
  const f = j.failure;
  const [edit, setEdit] = useState(null);
  const [rbAck, setRbAck] = useState(false);
  const [showOut, setShowOut] = useState(false);
  const [unknownAck, setUnknownAck] = useState(false);
  const [rbFixed, setRbFixed] = useState(false);
  if (!f) return null;
  const c = f.cause || {};
  // v2.847 S2-2: SSH 인증 실패로 멈춘 작업은 되돌리기도 같은 저장 계정으로 root 로그인한다 — 계정을 고쳤다는 표시를 받는다(서버도 sshFixed 없으면 거부)
  const rbAuth = c.key === 'ssh-auth';
  // v2.846 C-1: 전부 되돌리기를 시도한 작업은 다시 하지 않는다(서버도 거부 — 그 '다시' 가 0단계 초기화부터 돌 수 있었다)
  const rolledAll = (j.attempts || []).some((a) => a.rollbackAll);
  const fixes = rolledAll ? [] : fixesOrdered(c);
  return (
    <div className="card" style={{ ...CARD, borderColor: 'var(--red)' }}>
      <div style={ROW}><b style={{ flex: '1 1 auto', color: 'var(--red)' }}>{f.step ?? '—'}단계 실패 — {c.title || '원인 미분류'}</b><span className="muted" style={{ fontSize: 12 }}>{whenText(f.at)}</span></div>
      <div style={{ fontSize: 12.5, marginTop: 6 }}>{f.rolledBack === true ? '이 단계에서 바꾼 것은 되돌렸습니다(앞 단계는 그대로).' : f.step === 0 ? '기존 제거 단계는 되돌리지 않습니다(지운 것은 복구할 수 없음) — 이어서 다시 하면 이미 한 것은 건너뜁니다.' : f.rollbackFailed ? '되돌리기 일부가 실패했습니다 — 아래 로그에서 남은 것을 확인하세요.' : ''}</div>
      <dl style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr)', gap: '4px 14px', fontSize: 12.5, margin: '8px 0 0' }}>
        <dt className="muted">원인 판정</dt><dd style={{ margin: 0 }}>{c.why || '—'}</dd>
        <dt className="muted">근거</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{c.evidence ? <code>{c.evidence}</code> : (c.unclassified ? '규칙에 맞는 줄 없음 — 원문을 보세요' : '—')}</dd>
        <dt className="muted">실패한 명령</dt><dd style={{ margin: 0 }}>{f.cmd || '—'}{f.code != null ? ` · 종료 코드 ${f.code}` : ''}</dd>
        {f.message && <><dt className="muted">사유</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{f.message}</dd></>}
      </dl>
      <button type="button" className="logout-btn" style={{ ...BTN, marginTop: 8 }} onClick={() => setShowOut((x) => !x)}>{showOut ? '출력 원문 접기' : '출력 원문 보기'}</button>
      {showOut && <pre style={PRE}>{f.output || '(출력 없음)'}</pre>}
      <div style={{ marginTop: 10 }}><b style={{ fontSize: 13 }}>고치는 방법</b></div>
      {fixes.map((x, i) => (
        <div key={i} className="card" style={{ ...DEEP, marginTop: 6 }}>
          <div style={ROW}>
            <Badge cls={x.kind === 'portal' ? 'blue' : x.kind === 'retry' ? 'green' : 'gray'}>{x.kind === 'portal' ? '(a) 포탈에서 고치기' : x.kind === 'retry' ? '그대로 다시' : '(b) 서버에서 직접'}</Badge>
            <span style={{ flex: '1 1 260px', minWidth: 0, fontSize: 12.5 }}>{x.label}{x.detail ? <span className="muted"> — {x.detail}</span> : null}</span>
            {x.kind === 'portal' && x.action === 'edit-plan' && <button type="button" className="logout-btn" style={BTN} onClick={() => setEdit((e) => (e ? null : { ...j.plan }))}>{edit ? '접기' : '계획 값 바꾸기'}</button>}
            {x.kind === 'portal' && x.action === 'running-unknown-ok' && <label style={{ ...ROW, fontSize: 12.5 }}><input type="checkbox" checked={unknownAck} onChange={(e) => setUnknownAck(e.target.checked)} /> 실행 중인 백업 · 복원이 없음을 직접 확인했습니다</label>}
            {x.kind === 'portal' && x.action !== 'edit-plan' && <button type="button" className="login-btn" style={BTN} disabled={busy || (x.action === 'running-unknown-ok' && !unknownAck)} onClick={() => onRetry({ fix: x.action })}>{retryLabel(x, f.step)}</button>}
            {x.kind === 'retry' && <button type="button" className="login-btn" style={BTN} disabled={busy} onClick={() => onRetry({})}>{retryLabel(null, f.step)}</button>}
          </div>
          {x.commands?.length > 0 && <>
            <pre style={PRE}>{x.commands.join('\n')}</pre>
            <div style={{ ...ROW, marginTop: 4 }}><button type="button" className="logout-btn" style={BTN} onClick={() => copyText(x.commands.join('\n'), say)}>명령 복사</button>
              <button type="button" className="login-btn" style={BTN} disabled={busy} onClick={() => onRetry({})}>고쳤으면 {retryLabel(null, f.step)}</button></div>
          </>}
          {x.action === 'edit-plan' && edit && <>
            <PlanFields plan={edit} setPlan={setEdit} bundle={bundle} pre={null} compact />
            <button type="button" className="login-btn" style={{ ...BTN, marginTop: 8 }} disabled={busy} onClick={() => onRetry({ plan: planBody(edit) })}>바꾼 값으로 {f.step ?? ''}단계부터 다시</button>
          </>}
        </div>
      ))}
      {rolledAll && <div className="banner warn" style={{ marginTop: 8, fontSize: 12.5 }}>전부 되돌리기를 시도한 작업은 다시 하지 않습니다 — 아래에서 다시 되돌리거나, 대상 표에서 새 작업으로 설치하세요.</div>}
      {c.key === 'ssh-auth' && !rolledAll && <div className="banner warn" style={{ marginTop: 8, fontSize: 12.5 }}>SSH 로그인 실패는 자동으로 다시 시도하지 않습니다(계정 잠금). 배포 등록부의 계정을 고친 뒤 아래에서 ‘고쳤음’ 으로 다시 하세요.
        <div><button type="button" className="login-btn" style={{ ...BTN, marginTop: 6 }} disabled={busy} onClick={() => onRetry({ sshFixed: true })}>고쳤음 — 다시</button></div></div>}
      <div className="card" style={{ ...DEEP, borderLeft: '3px solid var(--red)' }}>
        <b style={{ fontSize: 13 }}>전부 되돌리기(서버를 설치 전으로)</b>
        <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>이 설치가 넣은 패키지 · 파일 · 서비스 · 방화벽 규칙 · 로컬 저장소 · 올린 번들, 이 설치가 만든 <b>카탈로그 DB(bareos)</b> · 이 설치가 초기화한 <b>PostgreSQL 데이터 디렉터리(/var/lib/pgsql/data 전체)</b> · /etc/bareos(설치 전에 없었을 때)를 지우고, 원격이 다 되돌려지면 포탈에 새로 만든 등록 · 매핑을 지웁니다. 원래 있던 것은 건드리지 않습니다. 이 설치의 Director(재설치면 다시 등록한 기존 Director)에 백업 대상이 있으면 되돌리지 않습니다.{j.mode === 'reinstall' ? ' 초기화로 지운 옛 설치는 되살리지 못합니다(보관한 /etc/bareos tar 는 남깁니다).' : ''}</div>
        {rbAuth && <label style={{ ...ROW, fontSize: 12.5, marginTop: 6 }}><input type="checkbox" checked={rbFixed} onChange={(e) => setRbFixed(e.target.checked)} /> 배포 등록부의 SSH 계정을 고쳤습니다(되돌리기도 그 계정으로 로그인합니다 — 계정 잠금)</label>}
        <div style={{ ...ROW, marginTop: 6 }}><label style={{ ...ROW, fontSize: 12.5 }}><input type="checkbox" checked={rbAck} onChange={(e) => setRbAck(e.target.checked)} /> 위 목록을 지우는 것을 확인했습니다</label>
          <button type="button" className="logout-btn" style={{ ...BTN, color: 'var(--red)' }} disabled={busy || !rbAck || (rbAuth && !rbFixed)} onClick={() => onRollback(rbAuth ? { sshFixed: true } : undefined)}>전부 되돌리기</button></div>
      </div>
    </div>
  );
}

/** v2.846 C-1 · C-2: 전부 되돌리기 실패 — 원인 · 남은 것 · 다시 되돌리기(SSH 인증 실패면 '고쳤음' 필요). 설치 '다시' 는 두지 않는다. */
function RollbackFailedCard({ j, onRollback, busy }) {
  const [ack, setAck] = useState(false);
  const [fixed, setFixed] = useState(false);
  const rb = j.rollback || {};
  const auth = rb.cause === 'ssh-auth';
  return (
    <div className="card" style={{ ...CARD, borderColor: 'var(--red)' }}>
      <div style={ROW}><b style={{ flex: '1 1 auto', color: 'var(--red)' }}>전부 되돌리기 실패</b><span className="muted" style={{ fontSize: 12 }}>{whenText(rb.doneAt)}</span></div>
      <div style={{ fontSize: 12.5, marginTop: 6 }}>{rollbackCauseText(rb.cause)}</div>
      {rb.message && <div className="muted" style={{ fontSize: 12, marginTop: 4, overflowWrap: 'anywhere' }}>사유: {rb.message}</div>}
      {rb.left?.length > 0 && <pre style={PRE}>{rb.left.join('\n')}</pre>}
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>설치를 이어서 다시 하지는 않습니다(되돌리기를 시도한 작업 — 서버도 거부). 포탈의 Director 등록 · 매핑은 원격 되돌리기가 끝난 뒤에만 지웁니다.</div>
      {auth && <label style={{ ...ROW, fontSize: 12.5, marginTop: 6 }}><input type="checkbox" checked={fixed} onChange={(e) => setFixed(e.target.checked)} /> 배포 등록부의 SSH 계정을 고쳤습니다(자동으로 다시 시도하지 않습니다 — 계정 잠금)</label>}
      <div style={{ ...ROW, marginTop: 6 }}><label style={{ ...ROW, fontSize: 12.5 }}><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> 전부 되돌리기 목록을 다시 확인했습니다</label>
        <button type="button" className="logout-btn" style={{ ...BTN, color: 'var(--red)' }} disabled={busy || !ack || (auth && !fixed)} onClick={() => onRollback(auth ? { sshFixed: true } : {})}>다시 되돌리기</button></div>
    </div>
  );
}

function RunStep({ j, bundle, onRetry, onStop, onRollback, onFinish, busy, say }) {
  const now = Date.now();
  const steps = (j.stepsMeta || []).map((m) => ({ ...m, ...(j.steps?.[m.n] || {}) }));
  const done = steps.filter((s) => s.status === 'ok').length;
  const jv = jobView(j.status);
  return (
    <>
      <div className="card" style={CARD}>
        <div style={ROW}>
          <b style={{ flex: '1 1 auto' }}>4 실행 — {j.vcenterName} · {j.agent}</b>
          <Badge cls={jv.cls}>{jv.text}{j.status === 'running' && j.currentStep != null ? ` · ${j.currentStep}단계` : ''}</Badge>
          {j.attempts?.length > 1 && <Badge cls="amber">시도 {j.attempts.length}회차</Badge>}
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>시작 {whenText(j.createdAt)} · 실행자 {j.by || '—'} · 번들 {j.bundle?.version || '—'} · {j.planText || ''}</div>
        {j.status === 'running' && <div className="banner" style={{ marginTop: 8, fontSize: 12.5 }}>이 화면을 닫아도 됩니다 — 0~3단계는 엣지 노드 안에서 계속 돌고, 다시 열면 이어서 보입니다.{j.pollError ? ` (엣지 노드 읽기 실패 ${j.pollError.count}회 — ${j.pollError.message} · 자동으로 다시 읽습니다)` : ''}</div>}
        <ol style={{ listStyle: 'none', margin: '10px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }} aria-label="설치 단계">
          {steps.map((s) => { const v = stepView(s.status); return (
            // 상세는 이름·상태 아래 전체 폭(Chromium 400: 세 칸 격자에서 상세 칸이 몇 글자 폭으로 눌려 세로로 쪼개졌다)
            <li key={s.n} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', columnGap: 10, rowGap: 2, alignItems: 'baseline', fontSize: 12.5, paddingBottom: 4, borderBottom: '1px solid var(--border-soft)' }}>
              <span style={{ minWidth: 0 }}><b>{s.n}</b> {s.label}</span>
              <Badge cls={v.cls}>{v.mark}{s.status === 'running' || s.status === 'ok' ? ` · ${stepDurText(s, now)}` : ''}</Badge>
              <span className="muted" style={{ gridColumn: '1 / -1', minWidth: 0, overflowWrap: 'anywhere', fontSize: 12 }}>{s.n === 1 && j.upload ? uploadText(j.upload) : (s.msg || (s.remote ? '엣지 노드 안' : '중앙'))}</span>
            </li>
          ); })}
        </ol>
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{done}/{steps.length} 완료</div>
        <div style={{ ...ROW, marginTop: 10 }}>
          {j.status === 'running' && <button type="button" className="logout-btn" style={BTN} disabled={busy || !!j.stopRequestedAt} onClick={onStop}>{j.stopRequestedAt ? '중단 요청됨' : '중단 요청'}</button>}
          {j.status === 'running' && <span className="muted" style={{ fontSize: 12 }}>지금 단계가 끝나면 멈춥니다 — 끝난 단계는 유지되고, 이어서 하거나 ‘전부 되돌리기’ 를 고를 수 있습니다.</span>}
          {j.status === 'stopped' && <button type="button" className="login-btn" style={BTN} disabled={busy} onClick={() => onRetry({})}>{j.currentStep ?? ''}단계부터 이어서</button>}
          {j.status === 'done' && <button type="button" className="login-btn" onClick={onFinish}>마무리로 →</button>}
        </div>
        {j.rollback && <div className="banner" style={{ marginTop: 8, fontSize: 12.5 }}>전부 되돌리기: {j.status === 'rolledback' ? '끝' : j.status === 'rollback-failed' ? '실패' : j.status === 'rolling-back' ? '진행 중' : '앞 시도 기록'}{j.rollback.notes?.length ? ` · ${j.rollback.notes.join(' · ')}` : ''}{j.status !== 'rollback-failed' && j.rollback.left?.length ? ` · 남은 것: ${j.rollback.left.join(' / ')}` : ''}</div>}
      </div>
      {j.status === 'failed' && <FailureCard j={j} bundle={bundle} onRetry={onRetry} onRollback={onRollback} busy={busy} say={say} />}
      {j.status === 'rollback-failed' && <RollbackFailedCard j={j} onRollback={onRollback} busy={busy} />}
      {j.status === 'stopped' && <FailureCard j={{ ...j, failure: { step: j.currentStep, at: j.updatedAt, cause: { title: '중단 요청으로 멈춤', why: '요청대로 그 단계 앞에서 멈췄습니다.', fixes: [] } } }} bundle={bundle} onRetry={onRetry} onRollback={onRollback} busy={busy} say={say} />}
      <div className="card" style={CARD}>
        <b style={{ fontSize: 13 }}>실행 로그 — 최근 {j.log?.length || 0}줄</b>
        <pre style={PRE}>{(j.log || []).join('\n') || '(아직 없음)'}</pre>
        <div className="muted" style={{ fontSize: 12 }}>비밀번호는 로그에 남지 않습니다(같은 글자가 있는 줄은 빼고 보입니다). 원문은 엣지 노드의 /var/lib/portal-bareos-install/run/run.log 에 있습니다.</div>
      </div>
      {j.attempts?.length > 1 && (
        <div className="card" style={CARD}>
          <b style={{ fontSize: 13 }}>시도 기록</b>
          <div className="table-wrap" style={{ marginTop: 6 }}>
            <STable minWidth={640}>
              <thead><tr><th>회차</th><th>시작</th><th>결과</th><th>시작 단계</th><th>바뀐 값 · 고치기</th></tr></thead>
              <tbody>{j.attempts.map((a) => (
                <tr key={a.n}><td>{a.n}</td><td>{whenText(a.at)}</td><td>{a.rollbackAll ? `전부 되돌리기${a.result === 'rollback-failed' ? ' · 실패' : a.result === 'rolledback' ? ' · 끝' : ''}` : a.result === 'failed' ? `실패 · ${a.failedStep ?? '—'}단계${a.cause ? ` · ${a.cause}` : ''}` : a.result === 'done' ? '완료' : '진행 중'}</td><td>{a.fromStep ?? '—'}</td><td style={{ fontSize: 12 }}>{[a.fix, a.change].filter(Boolean).join(' · ') || '—'}</td></tr>
              ))}</tbody>
            </STable>
          </div>
        </div>
      )}
    </>
  );
}

/* ───────── 5 마무리 ───────── */
function FinishStep({ j, say }) {
  const [vcuser, setVcuser] = useState('');
  const [vcpass, setVcpass] = useState('');
  const [thumb, setThumb] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const readThumb = async () => { setBusy(true); try { const r = okOrThrow(await postJson(`${P}/jobs/${j.id}/fd-thumbprint`, {}), '지문을 읽지 못했습니다.'); setThumb(r.thumbprint || ''); say({ ok: true, text: `FD 가 읽은 vCenter(${r.vcserver}) 지문을 넣었습니다 — 알고 있는 값과 대조하세요.` }); } catch (e) { say({ ok: false, text: e.message }); } finally { setBusy(false); } };
  const writeIni = async () => {
    setBusy(true);
    try { const r = okOrThrow(await postJson(`${P}/jobs/${j.id}/fd-ini`, { vcuser, vcpass, vcthumbprint: thumb }), 'FD INI 를 쓰지 못했습니다.'); setRes(r); setVcpass(''); say({ ok: true, text: `FD INI 를 썼습니다(${r.path}).` }); }
    catch (e) { say({ ok: false, text: e.message }); } finally { setBusy(false); }
  };
  return (
    <div className="card" style={CARD}>
      <b>5 마무리 — {j.vcenterName}</b>
      <div className="banner ok" style={{ marginTop: 8, fontSize: 12.5 }}>설치가 끝났습니다 — Director 를 포탈에 등록했고(담당 = 엣지 ‘{j.agent}’) 매핑을 저장했습니다. 남은 일은 vCenter 자격증명을 FD 에 한 번 넘기는 것입니다.</div>
      <div style={GRID}>
        <label style={FIELD}>vCenter 계정<input className="input" style={INP} value={vcuser} onChange={(e) => setVcuser(e.target.value)} autoComplete="off" /></label>
        <label style={FIELD}>vCenter 비밀번호(저장하지 않음)<input className="input" style={INP} type="password" value={vcpass} onChange={(e) => setVcpass(e.target.value)} autoComplete="new-password" /></label>
        <label style={FIELD}>vCenter 인증서 SHA1 지문<input className="input" style={INP} value={thumb} onChange={(e) => setThumb(e.target.value)} /></label>
      </div>
      <div style={{ ...ROW, marginTop: 8 }}>
        <button type="button" className="logout-btn" style={BTN} disabled={busy} onClick={readThumb}>FD 에서 지문 읽기</button>
        <button type="button" className="login-btn" style={BTN} disabled={busy || !vcuser || !vcpass || !thumb} onClick={writeIni}>{!vcuser || !vcpass ? '필요: 계정 · 비밀번호' : !thumb ? '필요: 지문' : 'FD INI 쓰기'}</button>
        <span className="muted" style={{ fontSize: 12 }}>비밀번호는 이 요청에서만 FD 로 전달하고 포탈 · 로그 · 감사 어디에도 남기지 않습니다.</span>
      </div>
      {res && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>쓴 경로 {res.path} · {res.action === 'created' ? '새로 만듦' : res.action === 'updated' ? '바꿈' : '같음'}</div>}
      <dl style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr)', gap: '4px 14px', fontSize: 12.5, margin: '12px 0 0' }}>
        <dt className="muted">서버</dt><dd style={{ margin: 0 }}>{j.agent} · {j.hostAddr || '—'}</dd>
        <dt className="muted">번들</dt><dd style={{ margin: 0 }}>{j.bundle?.version} · Bareos {j.bundle?.bareosVersion || '—'}</dd>
        <dt className="muted">WebUI</dt><dd style={{ margin: 0 }}>{j.plan?.webui === false ? '설치 안 함' : `http://${j.hostAddr || '<엣지 주소>'}/bareos-webui — 로그인 계정은 다음 기능(WebUI 계정)에서 만듭니다`}</dd>
        <dt className="muted">계획</dt><dd style={{ margin: 0 }}>{j.planText}</dd>
        {j.mode === 'reinstall' && <><dt className="muted">백업 대상</dt><dd style={{ margin: 0 }}>초기화로 Director 의 잡 설정이 지워졌습니다 — 이 법인의 백업 대상은 포탈 목록에는 남아 있지만 Director 에는 잡이 없습니다. 백업 대상 탭에서 그 대상을 지우고 다시 등록(일괄 등록)하세요.</dd></>}
      </dl>
    </div>
  );
}

/* ───────── 패널 ───────── */
export default function BareosInstallPanel({ writable = true }) {
  const [ov, setOv] = useState(null);
  const [err, setErr] = useState(null);
  const [sel, setSel] = useState('');
  const [step, setStep] = useState('targets');
  const [pre, setPre] = useState(null);
  const [plan, setPlan] = useState(null);
  const [jobId, setJobId] = useState('');
  const [job, setJob] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const gen = useRef(0);
  const load = () => {
    const g = ++gen.current;
    return fetchJson(P).then((r) => { if (g === gen.current) { setOv(r); setErr(null); } }).catch((e) => { if (g === gen.current) setErr(e); });
  };
  useEffect(() => { load(); }, []);
  // 받는 중이면 개요를 따라 읽는다
  useEffect(() => {
    if (!ov?.fetch || ov.fetch.doneAt) return undefined;
    const t = setTimeout(load, 3000); return () => clearTimeout(t);
  }, [ov]);
  // 작업 진행 읽기(진행 중일 때만 · 늦게 온 응답은 버림)
  const jgen = useRef(0);
  useEffect(() => {
    if (!jobId) return undefined;
    let stop = false; let timer = null;
    const tick = async () => {
      const g = ++jgen.current;
      try {
        const r = await fetchJson(`${P}/jobs/${encodeURIComponent(jobId)}`, {}, undefined, { retries: 0 });
        if (stop || g !== jgen.current) return;
        setJob(r.job);
        if (['running', 'rolling-back'].includes(r.job.status)) timer = setTimeout(tick, POLL_MS);
      } catch (e) { if (!stop) { setMsg({ ok: false, text: `진행을 읽지 못했습니다: ${e.message}` }); timer = setTimeout(tick, POLL_MS * 3); } }
    };
    tick();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [jobId]);

  if (err && !ov) return <ErrorBox error={err} />;
  if (!ov) return <Loading />;
  const t = ov.targets.find((x) => x.vcenterId === sel) || null;
  const bundle = (ov.bundles || []).find((x) => x.ok) || null;
  const reinstall = t?.mode === 'reinstall' || job?.mode === 'reinstall';

  const runPre = async () => {
    if (!t) return;
    setBusy(true); setPre(null); setMsg(null);
    try { const r = okOrThrow(await postJson(`${P}/precheck`, { vcenterId: t.vcenterId, ...planBody(plan || defaultPlan(bundle, t)) })); setPre(r); }
    catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };
  const goNext = async () => {
    const p = defaultPlan(bundle, t);
    setPlan(p); setPre(null);
    setStep(t.mode === 'reinstall' ? 'reset' : 'precheck');
    setBusy(true); setMsg(null);
    try { const r = okOrThrow(await postJson(`${P}/precheck`, { vcenterId: t.vcenterId, ...planBody(p) })); setPre(r); if (r.pluginPathCopies?.length) setPlan({ ...p, pyvmomiFix: true }); }
    catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };
  const start = async () => {
    setBusy(true); setMsg(null);
    try {
      // v2.846 U-7: 409 precheck 본문을 e.body 로 넘겨야 아래 '점검 표로 돌아가기' 가 돈다(예전에는 new Error 로 바꿔 본문을 버렸다)
      const r = okOrThrow(await postJson(`${P}/start`, { vcenterId: t.vcenterId, ...planBody(plan, { pre, target: t }) }), '시작하지 못했습니다.');
      setJob(r.job); setJobId(r.job.id); setStep('run');
    } catch (e) {
      setMsg({ ok: false, text: e.message });
      if (e?.body?.precheck) { setPre(e.body.precheck); setStep('precheck'); }
    } finally { setBusy(false); }
  };
  const act = async (path, body, okText) => {
    setBusy(true); setMsg(null);
    try {
      const r = okOrThrow(await postJson(`${P}/jobs/${encodeURIComponent(job.id)}/${path}`, body)); setJob(r.job); setJobId(''); setTimeout(() => setJobId(r.job.id), 0);
      // v2.846 C-1: 잠금에 걸린 되돌리기는 서버가 바로 '되돌리기 실패(busy)' 로 남긴다 — 시작했다고 말하지 않는다
      if (r.job?.status === 'rollback-failed') setMsg({ ok: false, text: `전부 되돌리기를 시작하지 못했습니다 — ${r.job.rollback?.message || '사유 미상'}` });
      else if (okText) setMsg({ ok: true, text: okText });
    }
    catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };
  const openJob = (id) => { setJobId(id); setStep('run'); };

  return (
    <div className="card" style={{ ...CARD, borderColor: 'var(--accent)' }} data-bareos-install="">
      <div style={ROW}>
        <div style={{ flex: '1 1 420px', minWidth: 0 }}>
          <b>법인 Bareos 완전 설치</b>{ov.demo && <> <Badge cls="amber">데모</Badge></>}
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>법인의 엣지 노드에 Bareos(Director · Storage · FD · VMware 플러그인 · WebUI)를 한 번에 설치하고 그 법인의 Director 를 이 포탈에 등록합니다. 백업은 법인 안에서 돌고, 중앙은 로그와 상태만 모읍니다. 전 법인 범위 관리자에게만 보입니다.</div>
        </div>
        {step !== 'targets' && <button type="button" className="logout-btn" style={BTN} onClick={() => { setStep('targets'); setJobId(''); setJob(null); load(); }}>대상 표로</button>}
      </div>
      {!writable && <div className="banner warn" style={{ marginTop: 8 }}>쓰기 범위가 지정된 계정은 완전 설치를 실행할 수 없습니다(전 법인 공용 설정).</div>}
      <Stepper step={step} reinstall={reinstall} />
      <Msg m={msg} />
      {step === 'targets' && <><BundleCard ov={ov} onReload={load} say={setMsg} writable={writable} /><TargetsStep ov={ov} sel={sel} setSel={setSel} onNext={goNext} onOpenJob={openJob} /></>}
      {step === 'reset' && t && plan && <ResetStep t={t} pre={pre} plan={plan} setPlan={setPlan} busy={busy} onRecheck={runPre} onBack={() => setStep('targets')} onNext={() => setStep('precheck')} />}
      {step === 'precheck' && t && <PrecheckStep pre={pre} busy={busy} onRecheck={runPre} onBack={() => setStep(reinstall ? 'reset' : 'targets')} onNext={() => setStep('plan')} />}
      {step === 'plan' && t && plan && <PlanStep t={t} pre={pre} bundle={pre?.bundle || bundle} plan={plan} setPlan={setPlan} busy={busy || !writable} onBack={() => setStep('precheck')} onStart={start} />}
      {step === 'run' && (job ? <RunStep j={job} bundle={bundle} busy={busy || !writable} say={setMsg}
        onRetry={(b) => act('retry', b, '다시 시작했습니다.')} onStop={() => act('stop', {}, '중단을 요청했습니다 — 지금 단계가 끝나면 멈춥니다.')}
        // v2.847 U2-1(2회차 점검 — 재현): 단추가 onClick={onRollback} 으로 클릭 이벤트를 넘겨 본문에 펼쳐졌다(순환 JSON — 요청이 나가지 않았다). 아는 칸만 고른다
        onRollback={(extra) => act('rollback', { ack: true, ...(extra && extra.sshFixed === true ? { sshFixed: true } : {}) }, '전부 되돌리기를 시작했습니다.')} onFinish={() => { setMsg(null); setStep('finish'); }} /> : <Loading />)}
      {step === 'finish' && job && <FinishStep j={job} say={setMsg} />}
    </div>
  );
}
