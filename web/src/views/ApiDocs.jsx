import React, { useEffect, useMemo, useState } from 'react';
import {
  INTRO, SCOPE_NOTE, SAMPLE_NOTE, KEY_NOTE, TRY_NOTE, SENSITIVITY_TONE,
  scopeBadge, filterEndpoints, tryResultNote, responseHints, disabledNote, parseRich,
} from './apiDocsText.js';

/**
 * 공개 API 안내 — **로그인 없이** 보는 페이지 (v2.564).
 *
 * 사용자 요청: "로그인 없이 볼 수 있는 페이지를 하나 만들어서 API 를 찾아서 사용할 수 있는
 * 페이지 · 사용 예시와 샘플을 같이 제공".
 *
 * ⚠⚠ **이 컴포넌트는 인증이 필요한 API 를 절대 부르지 않는다.** 부르는 것은 무인증
 *   `/api/docs` 하나이고, '직접 호출' 은 **방문자가 붙여넣은 키**로 `/api/v1/*` 를 칠 때뿐이다.
 *   `api.js` 의 `fetchJson`(세션 토큰을 붙인다)을 여기서 쓰지 말 것 — 로그인 전이라 토큰이
 *   없고, 있다면 그것대로 무인증 페이지가 세션을 쓰는 셈이 된다.
 * ⚠⚠ **방문자 키를 저장하지 않는다.** `useState` 에만 둔다 — `localStorage` 에 넣으면 공용 PC
 *   에서 다음 사람이 가져간다. 로그·URL·어디에도 싣지 않는다.
 * ⚠ 훅은 전부 조기 return **위**에(React #310 — v2.202 실제 사고).
 */

const TONE = { ok: '#4ade80', warn: '#fbbf24', bad: '#f87171', muted: '#94a3b8' };

/**
 * 문구 렌더 — `**강조**` 와 백틱 코드를 함께 해석한다.
 * ⚠⚠ **여기서 `BoldText` 를 쓰면 안 된다.** 그것은 `**강조**` 만 해석해 백틱이 **글자로 샌다**
 *   — 이 화면의 원문(OpenAPI 스펙용 마크다운)은 `null`·`meta.truncated` 를 백틱으로 적는다.
 *   v2.564 초판이 BoldText 를 써서 백틱 18개가 그대로 보였고 Chromium 판독이 잡았다.
 */
function Rich({ text }) {
  return (
    <>
      {parseRich(text).map((t, i) => {
        if (t.code) {
          return (
            <code key={i} style={{
              fontFamily: 'monospace', fontSize: '0.92em', padding: '0 4px', borderRadius: 3,
              background: '#ffffff12', border: '1px solid #ffffff1a',
              fontWeight: t.bold ? 700 : 400, whiteSpace: 'nowrap',
            }}>{t.v}</code>
          );
        }
        return t.bold ? <b key={i}>{t.v}</b> : <React.Fragment key={i}>{t.v}</React.Fragment>;
      })}
    </>
  );
}

function Badge({ tone = 'muted', children, title }) {
  return (
    <span title={title} style={{
      display: 'inline-block', padding: '1px 7px', borderRadius: 999, fontSize: 11,
      border: `1px solid ${TONE[tone]}55`, color: TONE[tone], background: `${TONE[tone]}18`,
      whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

function Code({ children }) {
  return (
    <pre style={{
      background: '#0b1220', border: '1px solid #ffffff14', borderRadius: 6,
      padding: '9px 11px', margin: 0, overflowX: 'auto', fontSize: 12, lineHeight: 1.55,
    }}>{children}</pre>
  );
}

function CopyBtn({ text }) {
  const [done, setDone] = useState(false);
  return (
    <button className="btn" style={{ fontSize: 11, padding: '1px 8px' }}
      onClick={async () => {
        // ⚠ 클립보드는 비-HTTPS·권한 거부에서 throw 한다 — 실패해도 화면이 죽지 않게.
        try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }
        catch { setDone(false); }
      }}>{done ? '복사됨' : '복사'}</button>
  );
}

/** '직접 호출' 패널. 컴포넌트를 렌더 함수 밖에 둔다(v2.416 — 안에 두면 입력이 포커스를 잃는다). */
function TryPanel({ ep, baseUrl, apiKey, setApiKey }) {
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState(null);

  const run = async () => {
    setBusy(true); setOut(null);
    try {
      // ⚠ 세션 헤더를 붙이지 않는다 — 방문자 키만 쓴다.
      const res = await fetch(`${baseUrl}${ep.path}`, { headers: { 'X-Api-Key': apiKey } });
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      setOut({ status: res.status, body, at: Date.now() });
    } catch (e) {
      setOut({ status: 0, body: { reason: String(e?.message || e) }, at: Date.now() });
    } finally { setBusy(false); }
  };

  const note = out ? tryResultNote(out.status, out.body) : null;
  const hints = out && out.status >= 200 && out.status < 300 ? responseHints(out.body) : [];

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid #ffffff12', paddingTop: 10 }}>
      <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}><Rich text={TRY_NOTE} /></div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <input className="input" type="password" autoComplete="off" spellCheck={false}
          placeholder="발급받은 API 키" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
          style={{ flex: '1 1 260px', minWidth: 0, fontFamily: 'monospace' }} />
        <button className="btn primary" disabled={busy || !apiKey.trim()} onClick={run}
          title={!apiKey.trim() ? '키를 넣어야 호출할 수 있습니다.' : ''}>
          {busy ? '호출 중…' : '직접 호출'}
        </button>
      </div>
      {out ? (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Badge tone={note.tone}>{note.title}</Badge>
            {note.hint ? <span style={{ fontSize: 11, color: TONE[note.tone] }}><Rich text={note.hint} /></span> : null}
          </div>
          {hints.map((h, i) => (
            <div key={i} className="muted" style={{ fontSize: 11, marginTop: 4 }}>· <Rich text={h} /></div>
          ))}
          <div style={{ marginTop: 6 }}>
            <Code>{JSON.stringify(out.body, null, 2).slice(0, 4000)}</Code>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Endpoint({ ep, baseUrl, apiKey, setApiKey, groupLabel }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('sample');
  const sc = scopeBadge(ep);
  return (
    <div className="card" style={{ minWidth: 0, padding: '11px 13px' }}>
      <div role="button" tabIndex={0} onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); } }}
        style={{ cursor: 'pointer', display: 'flex', gap: 9, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <Badge tone="ok">{ep.method}</Badge>
        <b style={{ fontFamily: 'monospace', fontSize: 13, wordBreak: 'break-all' }}>{ep.path}</b>
        <Badge tone="muted">{groupLabel}</Badge>
        {sc ? <Badge tone={sc.tone} title={sc.title}>{sc.label}</Badge> : null}
        <span className="muted" style={{ fontSize: 11, marginLeft: 'auto' }}>{open ? '▲ 접기' : '▼ 펼치기'}</span>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{ep.summary}</div>

      {open ? (
        <div style={{ marginTop: 10 }}>
          <div className="muted" style={{ fontSize: 11 }}>
            <b>응답 필드</b>({ep.fields.length}개) — 선언된 것만 나가고, 값이 없으면 키가 사라지는 대신 <b>null</b> 입니다.
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, margin: '5px 0 10px' }}>
            {ep.fields.map((f) => (
              <span key={f} style={{
                fontFamily: 'monospace', fontSize: 11, padding: '1px 6px', borderRadius: 4,
                background: '#ffffff0d', border: '1px solid #ffffff14',
              }}>{f}</span>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 5, marginBottom: 6, flexWrap: 'wrap' }}>
            {[['sample', '샘플 응답'], ...(ep.examples || []).map((x) => [x.lang, x.label])].map(([k, label]) => (
              <button key={k} className={`btn${tab === k ? ' primary' : ''}`}
                style={{ fontSize: 11, padding: '2px 9px' }} onClick={() => setTab(k)}>{label}</button>
            ))}
          </div>

          {tab === 'sample' ? (
            ep.sample ? (
              <>
                <div className="muted" style={{ fontSize: 11, marginBottom: 5 }}><Rich text={SAMPLE_NOTE} /></div>
                <Code>{JSON.stringify(ep.sample, null, 2)}</Code>
              </>
            ) : (
              // ⚠ 샘플이 없으면 지어내지 않고 없다고 말한다.
              <div className="muted" style={{ fontSize: 12 }}>이 경로의 샘플이 준비되지 않았습니다.</div>
            )
          ) : (() => {
            const ex = (ep.examples || []).find((x) => x.lang === tab);
            if (!ex) return <div className="muted" style={{ fontSize: 12 }}>예시가 없습니다.</div>;
            return (
              <>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
                  <CopyBtn text={ex.code} />
                </div>
                <Code>{ex.code}</Code>
              </>
            );
          })()}

          <TryPanel ep={ep} baseUrl={baseUrl} apiKey={apiKey} setApiKey={setApiKey} />
        </div>
      ) : null}
    </div>
  );
}

export default function ApiDocs({ onBack }) {
  const [doc, setDoc] = useState(null);
  const [state, setState] = useState('loading');     // loading | ok | off | error
  const [q, setQ] = useState('');
  // ⚠ 키는 메모리에만 — localStorage 금지(공용 PC 에서 다음 사람이 가져간다).
  const [apiKey, setApiKey] = useState('');

  useEffect(() => {
    let alive = true;
    // ⚠ 무인증 경로 하나만 부른다. 세션 토큰을 붙이지 않는다.
    fetch('/api/docs', { headers: { Accept: 'application/json' } })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!alive) return;
        if (res.status === 404) { setState('off'); return; }
        if (!res.ok || !body?.ok) { setState('error'); return; }
        setDoc(body); setState('ok');
      })
      .catch(() => { if (alive) setState('error'); });
    return () => { alive = false; };
  }, []);

  const groupLabel = useMemo(() => {
    const m = {};
    for (const g of doc?.groups || []) m[g.key] = g.label;
    return m;
  }, [doc]);
  const shown = useMemo(() => filterEndpoints(doc?.endpoints, q), [doc, q]);

  const Shell = ({ children }) => (
    <div style={{ minHeight: '100vh', background: 'var(--bg, #0b1220)' }}>
      <div style={{
        borderBottom: '1px solid #ffffff14', padding: '12px 16px',
        display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
      }}>
        <b style={{ fontSize: 15 }}>공개 API 안내</b>
        <Badge tone="ok">로그인 불필요</Badge>
        <span style={{ marginLeft: 'auto' }}>
          <button className="btn" onClick={() => { if (onBack) onBack(); else { window.location.hash = '#/'; } }}>
            포탈 로그인
          </button>
        </span>
      </div>
      {/* ⚠ minWidth:0 — 안쪽 pre(코드)가 카드를 밀어 늘려 400px 에서 페이지가 가로로 넘친다(v2.520·2.556·2.562). */}
      <div style={{ maxWidth: 1000, margin: '0 auto', padding: '16px', display: 'grid', gap: 12, minWidth: 0 }}>
        {children}
      </div>
    </div>
  );

  if (state === 'loading') return <Shell><div className="muted">불러오는 중…</div></Shell>;
  if (state !== 'ok') {
    return (
      <Shell>
        <div className="card" style={{ minWidth: 0 }}>
          <Rich text={disabledNote(state === 'off' ? 'off' : 'error')} />
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="card" style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, lineHeight: 1.8 }}>
          <Rich text={INTRO} /><br />
          <Rich text={SCOPE_NOTE} /><br />
          <Rich text={KEY_NOTE} />
        </div>
        <div style={{ marginTop: 10, display: 'grid', gap: 5 }}>
          <div className="muted" style={{ fontSize: 11 }}><b>기준 주소</b></div>
          <Code>{doc.baseUrl}</Code>
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            <b>인증 헤더</b> — 이 값을 모든 요청에 넣습니다
          </div>
          <Code>{`X-Api-Key: ${doc.keyPrefix}…`}</Code>
        </div>
      </div>

      <div className="card" style={{ minWidth: 0 }}>
        <b style={{ fontSize: 13 }}>반드시 알아야 하는 것</b>
        <ol style={{ margin: '8px 0 0', paddingLeft: 20, fontSize: 12, lineHeight: 1.85 }}>
          {(doc.contract || []).map((c, i) => <li key={i}><Rich text={c} /></li>)}
        </ol>
      </div>

      <div className="card" style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <b style={{ fontSize: 13 }}>엔드포인트 {doc.endpoints.length}개</b>
          <input className="input" placeholder="경로·필드·설명으로 검색 (예: usedPct)"
            value={q} onChange={(e) => setQ(e.target.value)}
            style={{ flex: '1 1 220px', minWidth: 0 }} />
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          {(doc.groups || []).map((g) => (
            <Badge key={g.key} tone={SENSITIVITY_TONE[g.sensitivity] || 'muted'} title={g.desc}>{g.label}</Badge>
          ))}
        </div>
        {q && shown.length === 0 ? (
          <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
            ‘{q}’ 와 맞는 엔드포인트가 없습니다. 이 페이지는 공개 API {doc.endpoints.length}개만 다룹니다.
          </div>
        ) : null}
      </div>

      {shown.map((ep) => (
        <Endpoint key={ep.path} ep={ep} baseUrl={doc.baseUrl} groupLabel={groupLabel[ep.group] || ep.group}
          apiKey={apiKey} setApiKey={setApiKey} />
      ))}

      <div className="card" style={{ minWidth: 0 }}>
        <b style={{ fontSize: 13 }}>오류 코드</b>
        <div className="muted" style={{ fontSize: 11, margin: '4px 0 8px' }}>
          사유마다 <b>조치가 다릅니다</b> — 한 문구로 덮지 말고 <b>code</b> 로 분기하세요.
        </div>
        {/* ⚠ 표는 가로 스크롤 컨테이너로 감싸고 minWidth 를 준다 — 없으면 400px 에서 열이 짜부라진다(v2.562). */}
        <div style={{ overflowX: 'auto', minWidth: 0 }}>
          <table className="rpt-wrap" style={{ minWidth: 640, width: '100%', fontSize: 12 }}>
            <thead><tr><th>HTTP</th><th>code</th><th>언제</th><th>조치</th></tr></thead>
            <tbody>
              {(doc.errors || []).map((e) => (
                <tr key={e.code}>
                  <td><Badge tone={e.status < 300 ? 'ok' : e.status < 500 ? 'warn' : 'bad'}>{e.status}</Badge></td>
                  <td style={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{e.code}</td>
                  <td style={{ whiteSpace: 'normal' }}>{e.when}</td>
                  <td style={{ whiteSpace: 'normal' }}>{e.fix}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="muted" style={{ fontSize: 11, lineHeight: 1.8, paddingBottom: 24 }}>
        · 목록 상한은 <b>{doc.listMax?.toLocaleString?.() ?? doc.listMax}행</b>이고, 넘치면 <b>meta.truncated</b> 와 <b>meta.omitted</b> 로 밝힙니다.<br />
        · 분당 상한 기본값은 <b>{doc.defaultRpm}회</b>이고 키마다 관리자가 정합니다.<br />
        · 규격(OpenAPI 3.1)은 키를 넣어 <b>GET {doc.baseUrl}/openapi.json</b> 으로 받을 수 있습니다.<br />
        · <Rich text={doc.disclosure?.note || ''} />
      </div>
    </Shell>
  );
}
