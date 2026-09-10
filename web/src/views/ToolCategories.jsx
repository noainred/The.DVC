import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, sendJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import { TOOLS } from './specialToolsList.js';
import { uncategorizedKeys, categoriesOf } from './toolSections.js';

/**
 * 설정 › 특수 기능 카테고리(v2.455, admin 전용) — 사용자 요구사항:
 * "특수기능에 기능이 너무 많아서 카테고리로 묶어 보여줄 수 있게. 서버/네트워크/스토리지/가상화 등
 *  사용자가 각 기능을 카테고리에 선택해 포함. **1개 기능을 중복해서 여러 카테고리에 넣을 수 있게.**"
 *
 * 실제로 도구가 76개다. 카테고리를 켜면 특수 기능 화면이 섹션으로 나뉘고, 끄면 원래대로 돌아간다.
 * 한 도구를 여러 카테고리에 넣는 것이 **정상 동작**이며, 카드에 소속 카테고리 수를 배지로 보여준다.
 *
 * ⚠️ 훅은 전부 최상단 — 조기 return 뒤 useState 는 React #310 크래시를 만든다(v2.202 실제 사고).
 */
export default function ToolCategories() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [showUncat, setShowUncat] = useState(true);
  const [collapseOthers, setCollapseOthers] = useState(false);
  const [cats, setCats] = useState([]);
  const [sel, setSel] = useState('');        // 편집 중인 카테고리 id
  const [q, setQ] = useState('');            // 도구 검색
  const inited = useRef(false);

  useEffect(() => {
    fetchJson('/admin/tool-categories').then((r) => {
      setD(r);
      if (!inited.current && r?.settings) {
        inited.current = true;
        setEnabled(!!r.settings.enabled);
        setShowUncat(r.settings.showUncategorized !== false);
        setCollapseOthers(!!r.settings.collapseOthers);
        setCats((r.settings.categories || []).map((c) => ({ ...c, tools: [...(c.tools || [])] })));
        setSel((r.settings.categories || [])[0]?.id || '');
      }
      setErr(null);
    }).catch((e) => setErr(e.message));
  }, []);

  // 카드로 노출되는 도구만 대상으로 한다(topTab 승격 항목은 특수 기능 화면에 없다).
  const allTools = useMemo(() => TOOLS.filter((t) => !t.topTab), []);
  const cfg = useMemo(() => ({ categories: cats }), [cats]);
  const uncat = useMemo(() => uncategorizedKeys(cfg, allTools.map((t) => t.k)), [cfg, allTools]);
  const ql = q.trim().toLowerCase();
  const listed = ql
    ? allTools.filter((t) => t.label.toLowerCase().includes(ql) || t.k.includes(ql) || (t.desc || '').toLowerCase().includes(ql))
    : allTools;

  const cur = cats.find((c) => c.id === sel) || null;
  const inCur = new Set(cur?.tools || []);

  const addCat = () => {
    const n = cats.length + 1;
    const id = `cat${n}${Date.now().toString(36).slice(-3)}`;
    setCats([...cats, { id, label: `카테고리 ${n}`, icon: '📁', enabled: true, tools: [] }]);
    setSel(id);
  };
  const patchCat = (id, p) => setCats((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)));
  const delCat = (id) => { setCats((cs) => cs.filter((c) => c.id !== id)); if (sel === id) setSel(''); };
  const move = (id, dir) => setCats((cs) => {
    const i = cs.findIndex((c) => c.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= cs.length) return cs;
    const n = [...cs];
    [n[i], n[j]] = [n[j], n[i]];
    return n;
  });
  const toggleTool = (k) => {
    if (!cur) return;
    patchCat(cur.id, { tools: inCur.has(k) ? cur.tools.filter((x) => x !== k) : [...cur.tools, k] });
  };

  const loadPreset = async () => {
    if (cats.length && !window.confirm('현재 카테고리 구성을 추천 분류로 바꿉니다. 계속할까요?\n(저장을 누르기 전에는 반영되지 않습니다)')) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetchJson('/admin/tool-categories/preset');
      setCats((r.categories || []).map((c) => ({ ...c, tools: [...(c.tools || [])] })));
      setSel((r.categories || [])[0]?.id || '');
      setMsg('추천 분류를 불러왔습니다. 확인 후 저장을 누르세요.');
    } catch (e) { setMsg(`오류: ${e.message}`); }
    finally { setBusy(false); }
  };

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await sendJson('/admin/tool-categories', 'PUT', {
        enabled, showUncategorized: showUncat, collapseOthers, categories: cats,
      });
      setMsg('저장되었습니다. 특수 기능 화면을 새로 열면 반영됩니다.');
      if (r?.settings) setD((p) => ({ ...p, settings: r.settings }));
    } catch (e) { setMsg(`오류: ${e.message}`); }
    finally { setBusy(false); }
  };

  if (err && !d) return <ErrorBox message={err} />;
  if (!d) return <Loading />;

  const placedCount = cats.reduce((n, c) => n + c.tools.length, 0);

  return (
    <div className="card" style={{ padding: 16 }}>
      <h3 style={{ marginTop: 0 }}>특수 기능 카테고리</h3>
      <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.7, marginTop: -4 }}>
        특수 기능이 <b>{allTools.length}개</b>라 한 화면에 다 깔면 찾기 어렵습니다. 카테고리로 묶어 섹션별로 보여줍니다.
        <br />
        <b>한 기능을 여러 카테고리에 중복해서 넣을 수 있습니다</b> — 예를 들어 'ESXi 온도'는 서버이면서 가상화입니다.
        어느 카테고리에도 없는 기능은 <b>'기타'</b>로 모여 사라지지 않습니다.
      </p>

      <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap', margin: '12px 0' }}>
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <b>카테고리 보기 사용</b>
        </label>
        <span className="muted" style={{ fontSize: 12 }}>(끄면 지금처럼 한 그리드로 보입니다)</span>
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 12.5 }}>
          <input type="checkbox" checked={showUncat} onChange={(e) => setShowUncat(e.target.checked)} /> 분류 안 된 기능을 '기타'로 표시
        </label>
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 12.5 }}>
          <input type="checkbox" checked={collapseOthers} onChange={(e) => setCollapseOthers(e.target.checked)} /> 첫 카테고리만 펼치고 시작
        </label>
      </div>

      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        카테고리 {cats.length}개 · 배치 {placedCount}건(중복 포함) · <b style={{ color: uncat.length ? '#fb0' : undefined }}>분류 안 됨 {uncat.length}개</b>
        {cats.length === 0 && <> — <button className="logout-btn" style={{ padding: '2px 10px', fontSize: 11 }} disabled={busy} onClick={loadPreset}>추천 분류로 시작</button></>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px,300px) 1fr', gap: 16, alignItems: 'start' }}>
        {/* ── 카테고리 목록 ── */}
        <div>
          <div className="flex gap" style={{ alignItems: 'center', marginBottom: 6 }}>
            <b style={{ fontSize: 13 }}>카테고리</b>
            <button className="logout-btn" style={{ padding: '2px 10px', fontSize: 11, marginLeft: 'auto' }} onClick={addCat}>+ 추가</button>
            {cats.length > 0 && <button className="logout-btn" style={{ padding: '2px 10px', fontSize: 11 }} disabled={busy} onClick={loadPreset}>추천 분류</button>}
          </div>
          {cats.length === 0 && <div className="muted" style={{ fontSize: 12.5, padding: '10px 0' }}>카테고리가 없습니다. '추천 분류로 시작' 또는 '+ 추가'를 누르세요.</div>}
          <div style={{ display: 'grid', gap: 6 }}>
            {cats.map((c, i) => (
              <div key={c.id} className="card" style={{ padding: 8, borderColor: sel === c.id ? 'var(--accent, #2e90fa)' : undefined }}>
                <div className="flex gap" style={{ alignItems: 'center' }}>
                  <input className="input" style={{ width: 44, textAlign: 'center' }} value={c.icon || ''} maxLength={4}
                    onChange={(e) => patchCat(c.id, { icon: e.target.value })} title="아이콘(이모지)" />
                  <input className="input" style={{ flex: 1, minWidth: 0 }} value={c.label}
                    onChange={(e) => patchCat(c.id, { label: e.target.value })} />
                </div>
                <div className="flex gap" style={{ alignItems: 'center', marginTop: 6, fontSize: 11.5 }}>
                  <button className="tab" style={{ padding: '2px 8px', fontSize: 11, background: sel === c.id ? 'rgba(46,144,250,.18)' : undefined }}
                    onClick={() => setSel(c.id)}>{c.tools.length}개 편집</button>
                  <label className="flex gap muted" style={{ alignItems: 'center' }}>
                    <input type="checkbox" checked={c.enabled !== false} onChange={(e) => patchCat(c.id, { enabled: e.target.checked })} /> 표시
                  </label>
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
                    <button className="logout-btn" style={{ padding: '1px 7px', fontSize: 11 }} disabled={i === 0} onClick={() => move(c.id, -1)} title="위로">↑</button>
                    <button className="logout-btn" style={{ padding: '1px 7px', fontSize: 11 }} disabled={i === cats.length - 1} onClick={() => move(c.id, 1)} title="아래로">↓</button>
                    <button className="logout-btn" style={{ padding: '1px 7px', fontSize: 11 }} onClick={() => delCat(c.id)} title="삭제">✕</button>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── 도구 선택 ── */}
        <div>
          <div className="flex gap" style={{ alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
            <b style={{ fontSize: 13 }}>
              {cur ? <>‘{cur.icon} {cur.label}’ 에 포함할 기능</> : '기능 목록'}
            </b>
            {cur && <span className="muted" style={{ fontSize: 12 }}>{cur.tools.length}개 선택됨</span>}
            <input className="input" style={{ marginLeft: 'auto', width: 200 }} placeholder="기능 검색"
              value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {!cur && <div className="muted" style={{ fontSize: 12.5, padding: '10px 0' }}>왼쪽에서 카테고리를 고르면 여기서 기능을 넣고 뺄 수 있습니다.</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(240px,1fr))', gap: 6, maxHeight: 460, overflowY: 'auto' }}>
            {listed.map((t) => {
              const belongs = categoriesOf(cfg, t.k);
              const on = inCur.has(t.k);
              return (
                <label key={t.k} className="card" title={t.desc}
                  style={{ padding: '7px 9px', display: 'flex', gap: 8, alignItems: 'flex-start', cursor: cur ? 'pointer' : 'default',
                    opacity: cur ? 1 : 0.6, borderColor: on ? 'var(--accent, #2e90fa)' : undefined }}>
                  <input type="checkbox" checked={on} disabled={!cur} onChange={() => toggleTool(t.k)} style={{ marginTop: 2 }} />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ fontSize: 12.5 }}>{t.icon} {t.label}</span>
                    <span className="muted" style={{ display: 'block', fontSize: 11, marginTop: 2 }}>
                      {belongs.length === 0
                        ? <span style={{ color: '#fb0' }}>분류 안 됨</span>
                        : belongs.length === 1 ? belongs[0]
                          : <span title={belongs.join(', ')}>{belongs.length}개 카테고리: {belongs.join(', ').slice(0, 40)}</span>}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex gap" style={{ alignItems: 'center', marginTop: 18, flexWrap: 'wrap' }}>
        <button className="logout-btn" style={{ padding: '7px 16px' }} disabled={busy} onClick={save}>{busy ? '저장 중…' : '저장'}</button>
        {msg && <span className="muted" style={{ fontSize: 12.5, color: msg.startsWith('오류') ? '#f0a' : undefined }}>{msg}</span>}
      </div>
    </div>
  );
}
