import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson, postJson, patchJson, putJson, delJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import { STable } from '../components/STable.jsx';
import BoldText from '../components/boldText.jsx';
import {
  keyState, KEY_STATES, expiryNote, scopeText, groupsText, kpisOf,
  lastUsedText, fullScopeWarning, curlExample, rpmNote, staleGroups,
  DIRECTION_NOTE, ONCE_NOTE, READONLY_NOTE,
} from './apiKeyText.js';

/**
 * 설정 › 연동 키 — 다른 포탈이 이 포탈의 조회 데이터를 읽는 **전용 API 키**(v2.562).
 *
 * 사용자 선택: 조회 전용 + 허용 목록(거부 기본값) · 전용 키 신규 발급(CENTRAL_TOKEN 재사용
 * 안 함) · 버전 고정 경로 + OpenAPI · **설정 화면에서 발급**.
 *
 * ⚠⚠ **평문 키는 발급 응답에만 있다.** 목록·수정 응답에는 없다(서버가 해시만 보관한다).
 *   그래서 발급 직후 모달이 그 사실을 **먼저** 말하고, 사용자가 닫으면 복구할 길이 없다.
 * ⚠ 판정·문구는 `apiKeyText.js` 하나가 소유한다 — 여기서 다시 판정하면 KPI 합계와 표의
 *   색이 어긋난다(v2.560 실제 사고).
 * ⚠ 훅은 전부 조기 return **위**에 — 뒤에 추가하면 React #310 으로 화면이 크래시한다(v2.202).
 */

const TONE = { ok: '#4ade80', warn: '#fbbf24', bad: '#f87171', muted: '#94a3b8' };

/** 만료일 입력(날짜) → epoch ms. 빈 값은 **무기한**이고 0 으로 떨어지지 않게 null 을 준다. */
function dayToMs(s) {
  if (!s) return null;
  const t = Date.parse(`${s}T23:59:59`);
  return Number.isFinite(t) ? t : null;
}
function msToDay(ms) {
  if (ms == null) return '';
  const t = Number(ms);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toISOString().slice(0, 10);
}

function Badge({ state }) {
  const s = KEY_STATES[state] || KEY_STATES['no-groups'];
  return (
    <span style={{
      display: 'inline-block', padding: '1px 7px', borderRadius: 999, fontSize: 11,
      border: `1px solid ${TONE[s.tone]}55`, color: TONE[s.tone], background: `${TONE[s.tone]}18`,
      whiteSpace: 'nowrap',
    }}>{s.label}</span>
  );
}

/** 발급·수정 폼. 컴포넌트를 렌더 함수 밖에 둔다 — 안에 두면 매 렌더마다 새 타입이 되어
 *  입력이 포커스를 잃는다(v2.416 리뷰 확정). */
function KeyForm({ form, setForm, groups, endpoints, vcenters, defaults, editing }) {
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggle = (arr, v) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const warn = fullScopeWarning(form.vcenters, endpoints);
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <label style={{ display: 'grid', gap: 3 }}>
        <span className="muted" style={{ fontSize: 12 }}>이름 (어느 포탈이 쓰는 키인지)</span>
        <input className="input" value={form.name} disabled={editing}
          onChange={(e) => set('name', e.target.value)} placeholder="예: 그룹 통합 대시보드" />
        {editing ? <span className="muted" style={{ fontSize: 11 }}>이름은 바꾸지 않습니다 — 감사 기록의 식별자입니다.</span> : null}
      </label>

      <div style={{ display: 'grid', gap: 4 }}>
        <span className="muted" style={{ fontSize: 12 }}>허용 분류 (거부 기본값)</span>
        <div className="muted" style={{ fontSize: 11 }}><BoldText text={DIRECTION_NOTE} /></div>
        {groups.map((g) => (
          <label key={g.key} style={{ display: 'flex', gap: 7, alignItems: 'flex-start', fontSize: 12 }}>
            <input type="checkbox" checked={form.groups.includes(g.key)}
              onChange={() => set('groups', toggle(form.groups, g.key))} style={{ marginTop: 3 }} />
            <span>
              <b>{g.label}</b>
              <span className="muted" style={{ marginLeft: 6 }}>{g.desc}</span>
            </span>
          </label>
        ))}
        {!form.groups.length ? (
          <div style={{ color: TONE.warn, fontSize: 11 }}>
            <BoldText text={groupsText([], groups)} />
          </div>
        ) : null}
      </div>

      <div style={{ display: 'grid', gap: 4 }}>
        <span className="muted" style={{ fontSize: 12 }}>vCenter 범위 (고르지 않으면 전체)</span>
        <div style={{ maxHeight: 132, overflow: 'auto', border: '1px solid #ffffff14', borderRadius: 6, padding: 6 }}>
          {(vcenters || []).length === 0
            ? <span className="muted" style={{ fontSize: 11 }}>vCenter 목록을 읽지 못했습니다 — 범위를 지정하지 않으면 전체입니다.</span>
            : vcenters.map((v) => (
              <label key={v.id} style={{ display: 'block', fontSize: 12 }}>
                <input type="checkbox" checked={form.vcenters.includes(v.id)}
                  onChange={() => set('vcenters', toggle(form.vcenters, v.id))} /> {v.name || v.id}
              </label>
            ))}
        </div>
        <span className="muted" style={{ fontSize: 11 }}>{scopeText(form.vcenters)}</span>
        {warn ? <div style={{ color: TONE.warn, fontSize: 11 }}><BoldText text={warn.text} /></div> : null}
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <label style={{ display: 'grid', gap: 3, minWidth: 0 }}>
          <span className="muted" style={{ fontSize: 12 }}>만료일 (비우면 무기한)</span>
          <input className="input" type="date" style={{ minWidth: 0 }}
            value={form.expiresDay} onChange={(e) => set('expiresDay', e.target.value)} />
        </label>
        <label style={{ display: 'grid', gap: 3, minWidth: 0 }}>
          <span className="muted" style={{ fontSize: 12 }}>분당 상한</span>
          <input className="input" type="number" min="1" style={{ width: 110, minWidth: 0 }}
            value={form.rpm} onChange={(e) => set('rpm', e.target.value)} placeholder={String(defaults?.rpm ?? '')} />
        </label>
      </div>
      <div className="muted" style={{ fontSize: 11 }}>
        <BoldText text={expiryNote(dayToMs(form.expiresDay)).text} />
        {' · '}
        <BoldText text={rpmNote(form.rpm || defaults?.rpm)} />
      </div>

      <label style={{ display: 'grid', gap: 3 }}>
        <span className="muted" style={{ fontSize: 12 }}>메모 (선택)</span>
        <input className="input" value={form.note} onChange={(e) => set('note', e.target.value)}
          placeholder="담당자·용도" />
      </label>
    </div>
  );
}

const emptyForm = { name: '', groups: [], vcenters: [], expiresDay: '', rpm: '', note: '' };

export default function ApiKeys() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [editId, setEditId] = useState(null);
  const [issued, setIssued] = useState(null);      // 발급 직후 1회 표시
  const [vcenters, setVcenters] = useState([]);

  const load = async () => {
    try {
      const d = await fetchJson('/admin/api-keys');
      setData(d); setError(null);
    } catch (e) { setError(e); }
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    // vCenter 목록은 범위 선택용이다 — 못 읽어도 화면은 동작해야 한다(범위 미지정 = 전체).
    fetchJson('/vcenters').then((r) => setVcenters(Array.isArray(r) ? r : (r?.vcenters || []))).catch(() => setVcenters([]));
  }, []);

  // ⚠ `data?.keys || []` 를 useMemo 의 의존성에 바로 쓰면 매 렌더마다 새 배열이라 memo 가
  //   무의미해진다(eslint react-hooks/exhaustive-deps 지적) — 원본 참조를 의존성으로 둔다.
  const keys = useMemo(() => data?.keys || [], [data]);
  const kpi = useMemo(() => kpisOf(keys), [keys]);
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  const bodyOf = () => ({
    name: form.name, groups: form.groups, vcenters: form.vcenters,
    expiresAt: dayToMs(form.expiresDay), rpm: form.rpm === '' ? undefined : Number(form.rpm),
    note: form.note,
  });

  const submit = async () => {
    setBusy(true); setMsg(null);
    try {
      if (editId) {
        const r = await patchJson(`/admin/api-keys/${editId}`, bodyOf());
        if (!r.ok) throw new Error(r.reason || '수정할 수 없습니다.');
        setMsg({ tone: 'ok', text: '수정했습니다.', issues: r.issues || [] });
        setEditId(null); setForm(emptyForm);
      } else {
        const r = await postJson('/admin/api-keys', bodyOf());
        if (!r.ok) throw new Error(r.reason || '발급할 수 없습니다.');
        // ⚠ 평문은 여기서만 받는다 — 모달을 닫으면 복구할 수 없다.
        setIssued({ plaintext: r.plaintext, key: r.key, issues: r.issues || [] });
        setForm(emptyForm);
      }
      await load();
    } catch (e) { setMsg({ tone: 'bad', text: String(e.message || e) }); }
    finally { setBusy(false); }
  };

  const revoke = async (k) => {
    if (!window.confirm(`‘${k.name}’ 키를 폐기합니다. 상대 포탈의 조회가 즉시 멈추고 같은 값은 다시 살아나지 않습니다. 계속할까요?`)) return;
    setBusy(true); setMsg(null);
    try {
      const r = await postJson(`/admin/api-keys/${k.id}/revoke`, {});
      if (!r.ok) throw new Error(r.reason || '폐기할 수 없습니다.');
      setMsg({ tone: 'ok', text: `‘${k.name}’ 을 폐기했습니다.` });
      await load();
    } catch (e) { setMsg({ tone: 'bad', text: String(e.message || e) }); }
    finally { setBusy(false); }
  };

  const remove = async (k) => {
    if (!window.confirm(`‘${k.name}’ 기록을 완전히 삭제합니다(감사 흔적도 사라집니다). 계속할까요?`)) return;
    setBusy(true); setMsg(null);
    try {
      const r = await delJson(`/admin/api-keys/${k.id}`);
      if (!r.ok) throw new Error(r.reason || '삭제할 수 없습니다.');
      setMsg({ tone: 'ok', text: '삭제했습니다.' }); await load();
    } catch (e) { setMsg({ tone: 'bad', text: String(e.message || e) }); }
    finally { setBusy(false); }
  };

  const togglePublicDocs = async (enabled) => {
    setBusy(true); setMsg(null);
    try {
      const r = await putJson('/admin/api-keys/public-docs', { enabled });
      if (!r.ok) throw new Error(r.reason || '바꿀 수 없습니다.');
      setMsg({ tone: 'ok', text: enabled ? '안내 페이지를 공개했습니다.' : '안내 페이지를 비공개로 바꿨습니다(그 주소는 404 입니다).' });
      await load();
    } catch (e) { setMsg({ tone: 'bad', text: String(e.message || e) }); }
    finally { setBusy(false); }
  };

  const startEdit = (k) => {
    setEditId(k.id);
    setForm({
      name: k.name, groups: [...(k.groups || [])], vcenters: [...(k.vcenters || [])],
      expiresDay: msToDay(k.expiresAt), rpm: String(k.rpm ?? ''), note: k.note || '',
    });
  };

  return (
    // ⚠ minWidth:0 — flex/grid 자식의 기본 min-width:auto 때문에 안쪽 표가 카드를 밀어
    //   늘려 400px 에서 페이지가 가로로 넘친다(v2.520·v2.556 규약).
    <div style={{ display: 'grid', gap: 14, minWidth: 0 }}>
      <div className="card" style={{ minWidth: 0 }}>
        <h3 style={{ marginTop: 0 }}>연동 키 (외부 포탈 조회 API)</h3>
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.7 }}>
          <BoldText text={READONLY_NOTE} /><br />
          <BoldText text={DIRECTION_NOTE} />
        </div>
        <div className="kpis" style={{ marginTop: 10 }}>
          {[['합계', kpi.total, 'muted'], ['사용중', kpi.live, 'ok'],
            ['폐기', kpi.revoked, 'muted'], ['만료', kpi.expired, 'bad'],
            ['분류 없음', kpi['no-groups'], 'warn']].map(([label, v, tone]) => (
            <div className="kpi" key={label}>
              <div className="muted" style={{ fontSize: 11 }}>{label}</div>
              {/* ⚠ 0 인 칸을 경고색으로 칠하지 말 것 — 숫자는 '문제 없음' 이라 하고 색은
                  '문제 있음' 이라 말하게 된다(사람은 색을 먼저 읽는다. v2.556 규약). */}
              <div style={{ fontSize: 20, color: v ? TONE[tone] : TONE.muted }}>{v}</div>
            </div>
          ))}
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          합계 = 사용중 + 폐기 + 만료 + 분류 없음 (칸이 겹치지 않습니다)
        </div>
      </div>

      {msg ? (
        <div className="card" style={{ minWidth: 0, borderColor: `${TONE[msg.tone === 'ok' ? 'ok' : 'bad']}55` }}>
          <div style={{ color: TONE[msg.tone === 'ok' ? 'ok' : 'bad'] }}>{msg.text}</div>
          {(msg.issues || []).map((s, i) => (
            <div key={i} className="muted" style={{ fontSize: 11 }}>· {s}</div>
          ))}
        </div>
      ) : null}

      {issued ? (
        <div className="card" style={{ minWidth: 0, borderColor: `${TONE.warn}66` }}>
          <h4 style={{ marginTop: 0, color: TONE.warn }}>발급된 키 — 지금 한 번만 보입니다</h4>
          <div style={{ fontSize: 12, marginBottom: 8 }}><BoldText text={ONCE_NOTE} /></div>
          <pre style={{
            userSelect: 'all', background: '#0b1220', border: '1px solid #ffffff1f', borderRadius: 6,
            padding: '8px 10px', overflowX: 'auto', margin: 0, fontSize: 13,
          }}>{issued.plaintext}</pre>
          <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
            지문 {issued.key?.fp || '(읽지 못함)'} · {scopeText(issued.key?.vcenters)} ·{' '}
            {groupsText(issued.key?.groups, data.groups)}
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>사용 예시</div>
          <pre style={{
            background: '#0b1220', border: '1px solid #ffffff14', borderRadius: 6,
            padding: '6px 9px', overflowX: 'auto', margin: '2px 0 0', fontSize: 12,
          }}>{curlExample(baseUrl)}</pre>
          {(issued.issues || []).map((s, i) => (
            <div key={i} style={{ color: TONE.warn, fontSize: 11, marginTop: 4 }}>· {s}</div>
          ))}
          <div style={{ marginTop: 10 }}>
            <button className="btn" onClick={() => setIssued(null)}>옮겨 적었습니다 — 닫기</button>
          </div>
        </div>
      ) : null}

      {/*
        * 공개 안내 페이지 on/off (v2.564) — **로그인 없이 보이는 면**이라 발급과 같은 등급으로
        * 게이트한다(adminOnly + 설정 소유자). 끄면 그 경로는 404 다.
        */}
      <div className="card" style={{ minWidth: 0 }}>
        <h4 style={{ marginTop: 0 }}>공개 API 안내 페이지</h4>
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.7 }}>
          <BoldText text={'로그인 없이 볼 수 있는 API 안내 화면입니다(주소 **#/api-docs**). 연동 담당자가 계정 없이 엔드포인트·필드·예시·샘플을 보고, 자기 키를 넣어 직접 호출해 볼 수 있습니다.'} />
          <br />
          <BoldText text={'이 페이지에는 **운영 데이터가 없습니다** — 샘플은 손으로 지어낸 값이고, 공개 API 8개만 다룹니다(포탈 내부 API 는 싣지 않습니다).'} />
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 10, fontSize: 13 }}>
          <input type="checkbox" checked={!!data.publicDocs?.stored} disabled={busy}
            onChange={(e) => togglePublicDocs(e.target.checked)} style={{ marginTop: 3 }} />
          <span>안내 페이지를 공개합니다(끄면 그 주소는 <b>404</b> 입니다)</span>
        </label>
        {data.publicDocs?.forcedOffByEnv ? (
          <div style={{ color: TONE.warn, fontSize: 11, marginTop: 6 }}>
            <BoldText text={'⚠ 이 서버는 환경변수 **PUBLIC_API_DOCS=false** 로 강제 꺼짐 상태입니다 — 위 설정을 켜도 페이지는 열리지 않습니다.'} />
          </div>
        ) : null}
        {data.publicDocs?.updatedAt ? (
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            마지막 변경 {new Date(data.publicDocs.updatedAt).toLocaleString()} · {data.publicDocs.updatedBy || '(미상)'}
          </div>
        ) : null}
        <div style={{ marginTop: 8 }}>
          <a className="btn" href="#/api-docs" target="_blank" rel="noreferrer"
            style={{ display: 'inline-block', textDecoration: 'none' }}>안내 페이지 열기 ↗</a>
        </div>
      </div>

      <div className="card" style={{ minWidth: 0 }}>
        <h4 style={{ marginTop: 0 }}>{editId ? '키 수정' : '새 키 발급'}</h4>
        <KeyForm form={form} setForm={setForm} groups={data.groups || []}
          endpoints={data.endpoints || []} vcenters={vcenters}
          defaults={data.defaults} editing={!!editId} />
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn primary" disabled={busy || !form.name.trim()} onClick={submit}
            title={!form.name.trim() ? '이름은 필수입니다 — 나중에 어느 포탈의 키인지 알 수 없습니다.' : ''}>
            {busy ? '처리 중…' : (editId ? '수정 저장' : '발급')}
          </button>
          {editId ? (
            <button className="btn" disabled={busy} onClick={() => { setEditId(null); setForm(emptyForm); }}>취소</button>
          ) : null}
        </div>
        {!editId ? (
          <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
            키 값은 발급 직후 한 번만 표시됩니다 — 서버는 해시만 보관합니다.
          </div>
        ) : null}
      </div>

      <div className="card" style={{ minWidth: 0 }}>
        <h4 style={{ marginTop: 0 }}>발급된 키 {keys.length}개</h4>
        {/* ⚠ 표는 가로 스크롤 컨테이너로 감싼다 — 열이 8개라 감싸지 않으면 400px 에서
            페이지를 밀어낸다(v2.549·v2.552 규약). */}
        {/* ⚠⚠ 가로 스크롤 컨테이너로 감싸는 것만으로는 부족하다 — 표에 `minWidth` 가 없으면
            브라우저가 스크롤 대신 **열을 짜부라뜨려** 400px 에서 셀이 한두 글자 폭으로 세로로
            길어진다(v2.562 스크린샷 판독에서 발견. 넘침 0px 이라 수치로는 안 잡혔다). */}
        <div style={{ overflowX: 'auto', minWidth: 0 }}>
          <STable className="rpt-wrap" style={{ minWidth: 900 }}>
            <thead>
              <tr>
                <th>이름</th><th>상태</th><th>허용 분류</th><th>범위</th>
                <th>만료</th><th>분당 상한</th><th>사용</th><th data-nosort>작업</th>
              </tr>
            </thead>
            <tbody>
              {keys.length === 0 ? (
                <tr><td colSpan={8} className="muted">발급된 키가 없습니다 — 위에서 발급하세요.</td></tr>
              ) : keys.map((k) => {
                const st = keyState(k);
                const ex = expiryNote(k.expiresAt);
                const lu = lastUsedText(k.lastUsedAt, k.useCount);
                return (
                  <tr key={k.id}>
                    <td>
                      <div style={{ maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={`${k.name}\n지문 ${k.fp}\n${k.note || ''}`}>{k.name}</div>
                      <div className="muted" style={{ fontSize: 10 }}>{k.fp}</div>
                    </td>
                    <td data-sort={st}><Badge state={st} /></td>
                    <td style={{ maxWidth: 210, whiteSpace: 'normal' }}>
                      <BoldText text={groupsText(k.groups, data.groups)} />
                    </td>
                    <td data-sort={String((k.vcenters || []).length)}>{scopeText(k.vcenters)}</td>
                    <td data-sort={String(k.expiresAt ?? '')}
                      style={{ color: ex.kind === 'past' ? TONE.bad : ex.kind === 'soon' ? TONE.warn : undefined }}>
                      {ex.kind === 'none' ? '무기한' : `${msToDay(k.expiresAt)} (${ex.text.split(' —')[0]})`}
                    </td>
                    <td className="right">{k.rpm}</td>
                    <td data-sort={String(k.lastUsedAt ?? 0)}
                      style={{ color: lu.kind === 'never' ? TONE.muted : undefined }}>{lu.text}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 5 }}>
                        {/* ⚠ '수정' 은 잠그지 않는다 — 범위를 고치는 것이 바로 그 순간 필요한 조치다(v2.529). */}
                        <button className="btn" onClick={() => startEdit(k)}>수정</button>
                        {k.revokedAt
                          ? <button className="btn" disabled={busy} onClick={() => remove(k)}>삭제</button>
                          : <button className="btn" disabled={busy} onClick={() => revoke(k)}>폐기</button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
        </div>
        {/* 긴 설명은 표 아래 각주 1회 — 행마다 반복하면 같은 문단이 화면을 덮는다(v2.509 규약). */}
        <div className="muted" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.7 }}>
          · <b>폐기</b>는 되돌릴 수 없습니다 — 행은 감사 흔적으로 남고 같은 값은 다시 살아나지 않습니다.<br />
          · <b>삭제</b>는 폐기한 키만 할 수 있습니다(산 키를 실수로 지우지 않게).<br />
          · <b>사용</b>이 ‘아직 사용된 적 없습니다’ 인 것은 이상이 아닙니다 — 발급 직후일 수 있습니다.<br />
          · 상대 포탈은 <b>GET /api/v1/</b> 로 이 키가 쓸 수 있는 목록을,{' '}
          <b>GET /api/v1/openapi.json</b> 으로 규격을 스스로 확인할 수 있습니다.
          {staleGroups(keys, data.groups).length ? (
            <>
              <br />· <span style={{ color: TONE.warn }}>
                <b>(무효)</b> 로 표시된 분류({staleGroups(keys, data.groups).join(', ')})는 지금 이 포탈에
                없는 분류입니다 — 그 분류로는 <b>아무 경로도 열리지 않습니다</b>. 키를 수정해 현재 분류를
                고르세요(기록은 지우지 않았습니다).
              </span>
            </>
          ) : null}
        </div>
      </div>

      <div className="card" style={{ minWidth: 0 }}>
        <h4 style={{ marginTop: 0 }}>공개된 엔드포인트 {(data.endpoints || []).length}개 (전부 조회)</h4>
        <div style={{ overflowX: 'auto', minWidth: 0 }}>
          <STable className="rpt-wrap" style={{ minWidth: 880 }}>
            <thead><tr><th>경로</th><th>분류</th><th>설명</th><th>필드</th></tr></thead>
            <tbody>
              {(data.endpoints || []).map((e) => (
                <tr key={e.path}>
                  <td style={{ whiteSpace: 'nowrap' }}>{e.method} {e.path}</td>
                  <td>{(data.groups || []).find((g) => g.key === e.group)?.label || e.group}</td>
                  <td style={{ maxWidth: 260, whiteSpace: 'normal' }}>
                    {e.summary}
                    {e.requiresFullScope ? <span style={{ color: TONE.warn }}> · 범위 지정 키는 403</span> : null}
                  </td>
                  <td className="muted" style={{ maxWidth: 260, whiteSpace: 'normal', fontSize: 11 }}>
                    {(e.fields || []).join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </STable>
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.7 }}>
          · 응답의 수치가 <b>null</b> 이면 <b>0 이 아니라 ‘읽지 못했다’</b> 는 뜻입니다 — 0 으로 읽으면 거짓이 됩니다.<br />
          · 목록이 상한에 걸리면 <b>meta.truncated</b> 와 <b>meta.omitted</b> 로 밝힙니다(조용히 자르지 않습니다).<br />
          · 첫 수집이 끝나지 않았으면 빈 배열이 아니라 <b>503</b> 입니다 — ‘데이터가 없다’ 와 구분하세요.
        </div>
      </div>
    </div>
  );
}
