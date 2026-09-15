import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, downloadFile } from '../../api.js';
import { Modal } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import {
  FORMATS, actionLabel, actionClass, testLabel, dryRunSummary, testProgressText,
  stageFlags, defaultSelection, selectableLines, testOnlyNote, registerSummary,
  tokenHint, ioUrl,
} from './bulkIoText.js';

/**
 * views/tools/BulkDeviceIo.jsx — 장비 **대량 등록/내보내기** 공용 모달(v2.513).
 *
 * 사용자 요청(2026-09-15): "다수의 스토리지 입력을 위한 csv와 free text 를 사용한 import/export
 * 기능 추가하고, sample download 기능 추가" → "san switch 도 같은 메뉴 만들어줘" →
 * "csv/text 올릴때 정상으로 동작하는지 검증하고 실제로 테스트해서 동작하는지 검증하는 부분 추가,
 *  검증을 통화한 일부만 등록하는 기능, 실패한 부분을 text 의 어떤 부분을 고치라고 조언하는 기능".
 *
 * ── 왜 **하나**인가 ─────────────────────────────────────────────────────────
 * 스토리지와 SAN 스위치는 열 구성만 다르고 흐름이 같다. 복제하면 두 화면이 갈라진다 —
 * 이 저장소는 그 사고를 이미 겪었다(CLAUDE.md: `console/`↔`version_3/` 58~87% 중복,
 * v2.506 svcmon 권한 버그를 두 곳에 고쳐야 했던 일). 그래서 도구별로 다른 것은 `base`·
 * `title`·`keyLabel`·`columns` **주입**이고, 판정·문구는 `bulkIoText.js`(순수) 하나가 갖는다.
 *
 * ── 3단계(화면 = 서버 라우트 1:1) ──────────────────────────────────────────
 *   ① 형식 검증   POST {base}/devices/import {dryRun:true} → 행별 add/update/error + **조언**
 *   ② 연결 테스트 POST {base}/devices/import/test → run id → GET …/test/:id 폴링
 *   ③ 선택 등록   POST {base}/devices/import {selectLines[, testRunId]}
 *
 * ── 반드시 지킬 것 ──────────────────────────────────────────────────────────
 *  · **훅은 조기 return 위**(React #310 — v2.202 실제 크래시). 이 컴포넌트에는 조기 return 이
 *    없지만 패널을 추가할 때 지킬 것.
 *  · **폴링 간격을 줄이지 말 것**: 연결 테스트는 SSH 로그인이라 2초 폴이면 충분하고,
 *    끝나면(`status==='done'`) **즉시 멈춘다**(타이머를 남기면 모달을 닫아도 계속 돈다).
 *  · **서버 문구는 `BoldText` 로 렌더**: 조언에 `**강조**` 가 들어 있다 — 그대로 뿌리면
 *    별표가 화면에 샌다(v2.439/2.440/2.505 실제 사고).
 *  · **'테스트 불가' 를 빨강으로 칠하지 말 것**(bulkIoText 주석 — 엣지 위임은 실패가 아니다).
 */

const POLL_MS = 2000;

const S = {
  step: { fontSize: 12.5, fontWeight: 600, marginBottom: 6 },
  card: { padding: 10, marginTop: 10, fontSize: 12.5 },
  mono: { fontFamily: 'ui-monospace, monospace', fontSize: 12 },
};

export default function BulkDeviceIo({
  base,                 // 예: '/tools/storage' | '/tools/sanswitch'
  title,                // 모달 제목
  keyLabel = 'host',    // 동일 장비 판정 키(문구용) — 스토리지 'host+type', 스위치 'host'
  passwordExport = false, // 비밀번호 포함 내보내기(스토리지만 — 설정 소유자 게이트)
  onClose,
  onDone,               // 등록 후 목록 새로고침
}) {
  const [format, setFormat] = useState('csv');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const [check, setCheck] = useState(null);           // ① 드라이런 결과
  const [checkedText, setCheckedText] = useState(null);
  const [sel, setSel] = useState(() => new Set());    // 체크된 줄 번호

  const [runId, setRunId] = useState(null);           // ② 연결 테스트
  const [run, setRun] = useState(null);
  const [runText, setRunText] = useState(null);
  const [testOnly, setTestOnly] = useState(false);    // 서버가 연결 성공분으로 한 번 더 좁힌다

  const [result, setResult] = useState(null);         // ③ 등록 결과
  const fileRef = useRef(null);

  const flags = stageFlags({ text, check, checkedText, run, runText, busy });

  /* 연결 테스트 진행률 폴링 — 완료되면 즉시 정지(모달을 닫아도 돌지 않게 cleanup 도 함께). */
  useEffect(() => {
    if (!runId) return undefined;
    let alive = true;
    let timer = 0;
    const tick = async () => {
      try {
        const r = await fetchJson(`${base}/devices/import/test/${runId}`);
        if (!alive) return;
        setRun(r);
        if (r.status !== 'done') timer = setTimeout(tick, POLL_MS);
      } catch (e) {
        if (!alive) return;
        setErr(`연결 테스트 조회 실패: ${e.message}`);
      }
    };
    tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [runId, base]);

  /* 테스트가 끝나면 기본 선택을 다시 계산한다 — 실패 행만 빠지고 '테스트 불가' 는 남는다. */
  useEffect(() => {
    if (run?.status === 'done' && check) setSel(new Set(defaultSelection(check.report, run)));
  }, [run?.status]);   // eslint-disable-line react-hooks/exhaustive-deps

  const invalidate = (t) => {
    setText(t); setResult(null);
    // 입력이 바뀌면 옛 판정을 근거로 저장하지 않는다(stageFlags.changed 가 버튼을 막지만,
    // 테스트 결과도 함께 무효로 보이게 runText 를 그대로 둔다 — testStale 판정에 쓰인다).
  };

  const onFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || '');
      invalidate(s); setCheck(null); setCheckedText(null);
      // 확장자로 형식을 추정한다(사용자가 토글을 잊고 올리는 실수를 줄인다).
      if (/\.csv$/i.test(f.name)) setFormat('csv');
      else if (/\.(txt|tsv|text)$/i.test(f.name)) setFormat('text');
    };
    r.readAsText(f);
    e.target.value = '';   // 같은 파일을 다시 고를 수 있게
  };

  const body = (extra = {}) => (format === 'text' ? { text, format: 'text', ...extra } : { csv: text, format: 'csv', ...extra });

  const dl = (kind) => downloadFile(ioUrl(base, kind, format)).catch((e) => setErr(e.message));

  /* ① 형식 검증 */
  const verify = async () => {
    setBusy(true); setErr(null); setResult(null); setCheck(null); setRunId(null); setRun(null);
    try {
      const r = await postJson(`${base}/devices/import`, body({ dryRun: true }));
      if (r.ok === false) { setErr(r.reason); return; }
      setCheck(r); setCheckedText(text);
      setSel(new Set(defaultSelection(r.report, null)));
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  /* ② 실제 연결 테스트 */
  const startTest = async () => {
    setBusy(true); setErr(null); setResult(null); setRun(null);
    try {
      const r = await postJson(`${base}/devices/import/test`, body());
      if (r.ok === false) { setErr(r.reason); return; }
      setRunId(r.id); setRunText(text);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  /* ③ 선택 등록 */
  const register = async () => {
    setBusy(true); setErr(null);
    try {
      const extra = { selectLines: [...sel] };
      if (testOnly && flags.testDone) extra.testRunId = runId;
      const r = await postJson(`${base}/devices/import`, body(extra));
      if (r.ok === false) { setErr(r.reason); return; }
      setResult(r);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const statusOf = useMemo(() => new Map((run?.results || []).map((r) => [r.line, r])), [run]);
  const pickable = check ? selectableLines(check.report) : [];
  const allPicked = pickable.length > 0 && pickable.every((l) => sel.has(l));
  const toggle = (line) => setSel((p) => { const n = new Set(p); n.has(line) ? n.delete(line) : n.add(line); return n; });
  const fmt = FORMATS.find((f) => f.key === format) || FORMATS[0];

  return (
    <Modal title={title} onClose={onClose} width={980}>
      {/* 형식 토글 + 파일/샘플/내보내기 */}
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 8 }}>
        <span className="muted" style={{ fontSize: 12 }}>형식</span>
        {FORMATS.map((f) => (
          <button key={f.key} className={format === f.key ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '5px 12px', fontSize: 12 }}
            title={f.hint} onClick={() => { setFormat(f.key); setCheck(null); setCheckedText(null); setRunId(null); setRun(null); setResult(null); }}>
            {f.label}
          </button>
        ))}
        <span style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 2px' }} />
        <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,.text,text/csv,text/plain,text/tab-separated-values" style={{ display: 'none' }} onChange={onFile} />
        <button className="tab" style={{ flex: 'none', padding: '5px 11px', fontSize: 12 }} onClick={() => fileRef.current?.click()}>📁 파일 선택</button>
        <button className="tab" style={{ flex: 'none', padding: '5px 11px', fontSize: 12 }} title={`양식·예시가 담긴 샘플 ${fmt.label} 내려받기(그대로 가져와도 오류가 나지 않습니다)`}
          onClick={() => dl('sample')}>📄 샘플 {fmt.label}</button>
        <button className="tab" style={{ flex: 'none', padding: '5px 11px', fontSize: 12 }} title={`현재 등록 장비를 ${fmt.label} 로 내려받기 — 비밀번호는 담기지 않습니다`}
          onClick={() => dl('export')}>⬇ 내보내기</button>
        {passwordExport && (
          <button className="tab" style={{ flex: 'none', padding: '5px 11px', fontSize: 12, color: 'var(--amber)' }}
            title="비밀번호를 평문으로 포함해 내려받습니다 — 설정 소유자 계정만 가능하고 감사로그에 남습니다."
            onClick={() => downloadFile(`${base}/devices/export.csv?passwords=1`).catch((e) => setErr(e.message))}>🔑 비밀번호 포함 CSV</button>
        )}
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginBottom: 8, lineHeight: 1.6 }}>
        {fmt.hint}. <b>{keyLabel}</b> 가 같은 장비는 <b>수정</b>, 없으면 <b>추가</b>입니다.
        비밀번호 칸은 값이 있으면 저장하고 비우면 기존 값을 유지합니다.
      </div>

      <textarea className="input" style={{ width: '100%', minHeight: 120, ...S.mono }}
        value={text} onChange={(e) => invalidate(e.target.value)}
        placeholder={format === 'csv'
          ? '여기에 CSV 를 붙여넣거나 위에서 파일을 고르세요.'
          : '탭·파이프·공백으로 나눈 줄, 또는 `host=10.0.0.1 계정=admin` 처럼 키=값 으로 적어도 됩니다.'} />

      {err && <div style={{ color: 'var(--red)', fontSize: 12.5, marginTop: 8 }}>⚠ {err}</div>}
      {flags.note && <div style={{ color: 'var(--amber)', fontSize: 12.5, marginTop: 8 }}>⚠ {flags.note}</div>}

      {/* 파싱 경고(형식을 어떻게 읽었는지) — 조용히 넘기지 않는다 */}
      {check?.warnings?.length > 0 && (
        <div className="card" style={{ ...S.card, borderColor: 'var(--amber)' }}>
          <div style={S.step}>읽는 과정에서 조정한 것 {check.warnings.length}건</div>
          <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
            {check.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      {/* 사전 힌트 — 형식 검증을 통과했더라도 의심스러운 값 */}
      {check?.hints?.length > 0 && (
        <div className="card" style={{ ...S.card, borderColor: 'var(--amber)' }}>
          <div style={S.step}>고치면 좋을 값 {check.hints.length}건</div>
          <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
            {check.hints.map((h, i) => <li key={i}><BoldText text={h.advice} /></li>)}
          </ul>
        </div>
      )}

      {/* ① 검증 결과 + ② 테스트 상태 + ③ 선택 — 한 표에서 본다 */}
      {check && (
        <div className="card" style={S.card}>
          <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 6 }}>
            <span>{dryRunSummary(check)}</span>
            {check.headerUsed && <span className="muted" style={{ fontSize: 11.5 }}>열 순서: {check.headerUsed.join(' ')}</span>}
            <span style={{ marginLeft: 'auto' }} className="muted">{sel.size}/{pickable.length}행 선택</span>
            <button className="tab" style={{ flex: 'none', padding: '3px 9px', fontSize: 11.5 }}
              onClick={() => setSel(allPicked ? new Set() : new Set(pickable))}>{allPicked ? '전체 해제' : '전체 선택'}</button>
          </div>
          {run && <div style={{ fontSize: 12.5, marginBottom: 6 }}>{testProgressText(run)}</div>}
          <div className="table-wrap" style={{ maxHeight: '34vh' }}>
            <STable>
              <thead>
                <tr>
                  <th data-nosort>선택</th>
                  <th style={{ textAlign: 'right' }}>줄</th>
                  <th>장비</th>
                  <th title="장비 주소(host) — IP 또는 호스트명">주소</th>
                  <th>타입</th><th>동작</th><th>비밀번호</th>
                  <th>연결 테스트</th>
                  {/* 조언은 문장이라 길다 — 줄바꿈시키지 않으면 오른쪽에서 잘린다
                      (v2.513 Chromium 스크린샷 판독에서 실제로 잘려 있었다). */}
                  <th style={{ minWidth: 220, maxWidth: 380 }}>문제 · 고칠 곳</th>
                </tr>
              </thead>
              <tbody>
                {check.report.map((r) => {
                  const t = statusOf.get(r.line);
                  const tl = testLabel(t?.status);
                  const canPick = r.action !== 'error';
                  return (
                    <tr key={r.line}>
                      <td data-sort={sel.has(r.line) ? 1 : 0}>
                        <input type="checkbox" checked={canPick && sel.has(r.line)} disabled={!canPick}
                          title={canPick ? '' : '오류 행은 등록할 수 없습니다'} onChange={() => toggle(r.line)} />
                      </td>
                      <td style={{ textAlign: 'right' }} className="muted">{r.line}</td>
                      <td><b>{r.name || '—'}</b></td>
                      <td className="muted" style={{ fontSize: 11.5 }}>{r.host || '—'}</td>
                      <td className="muted" style={{ fontSize: 11.5 }}>{r.type || '—'}</td>
                      <td><span className={`badge ${actionClass(r.action)}`}>{actionLabel(r.action)}</span></td>
                      <td className="muted" style={{ fontSize: 11.5 }}>{r.hasPassword ? '반영' : '유지'}</td>
                      <td data-sort={t?.status || ''} style={{ fontSize: 11.5, maxWidth: 240, whiteSpace: 'normal', wordBreak: 'break-word' }}
                        title={t?.reason || (t ? '' : '아직 테스트하지 않았습니다')}>
                        {t
                          ? <span className={tl.cls ? `badge ${tl.cls}` : 'muted'}>{tl.icon} {tl.text}</span>
                          : <span className="muted">—</span>}
                        {t?.reason && t.status !== 'ok' && <div className="muted" style={{ fontSize: 11, lineHeight: 1.5 }}>{t.reason}</div>}
                      </td>
                      <td style={{ fontSize: 11.5, lineHeight: 1.6, maxWidth: 380, whiteSpace: 'normal', wordBreak: 'break-word' }}>
                        {r.reason && <div style={{ color: 'var(--red)' }}>{r.reason}</div>}
                        {r.advice && <div style={{ marginTop: 3 }}><BoldText text={r.advice} /></div>}
                        {tokenHint(r) && <div className="muted" style={{ fontSize: 11 }}>위치: {tokenHint(r)}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </STable>
          </div>
          {flags.testDone && (
            <label className="flex gap" style={{ alignItems: 'center', fontSize: 12, marginTop: 8, gap: 6 }} title={testOnlyNote(run)}>
              <input type="checkbox" checked={testOnly} onChange={(e) => setTestOnly(e.target.checked)} />
              연결 성공한 행만 등록(서버 재확인)
              <span className="muted" style={{ fontSize: 11.5 }}>— {testOnlyNote(run)}</span>
            </label>
          )}
        </div>
      )}

      {/* ③ 등록 결과 */}
      {result && (
        <div className="card" style={S.card}>
          <div>{registerSummary(result)}</div>
          {result.failed?.length > 0 && (
            <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: 'var(--red)' }}>
              {result.failed.map((f, i) => <li key={i}>{f.line}줄 ({f.name}): {f.reason}</li>)}
            </ul>
          )}
          {result.skipped?.length > 0 && (
            <>
              <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>등록하지 않은 행 {result.skipped.length}건 — 사유</div>
              <ul style={{ margin: '3px 0 0', paddingLeft: 18, lineHeight: 1.7 }} className="muted">
                {result.skipped.map((s, i) => <li key={i}>{s.line}줄: {s.reason}</li>)}
              </ul>
            </>
          )}
        </div>
      )}

      <div className="flex gap wrap" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
        {result
          ? <button className="login-btn" style={{ padding: '8px 18px' }} onClick={onDone}>완료(목록 새로고침)</button>
          : <>
            <button className="tab" style={{ padding: '8px 15px' }} disabled={!flags.canVerify} onClick={verify}>
              {busy && !runId ? '검사 중…' : '① 형식 검증'}
            </button>
            <button className="tab" style={{ padding: '8px 15px' }} disabled={!flags.canTest} onClick={startTest}
              title={flags.canTest
                ? '저장하기 전에 행마다 실제로 로그인해 봅니다. 자동 재시도는 하지 않습니다(계정 잠금 방지).'
                : '먼저 형식 검증을 통과하세요'}>
              {flags.testRunning ? `② 테스트 중… ${run?.done ?? 0}/${run?.total ?? 0}` : '② 연결 테스트(선택)'}
            </button>
            <button className="login-btn" style={{ padding: '8px 18px' }} disabled={!flags.canRegister || sel.size === 0} onClick={register}
              title={sel.size === 0 ? '등록할 행을 고르세요' : `선택한 ${sel.size}행을 저장합니다`}>
              ③ 선택 등록 {sel.size ? `(${sel.size}행)` : ''}
            </button>
          </>}
      </div>
    </Modal>
  );
}
