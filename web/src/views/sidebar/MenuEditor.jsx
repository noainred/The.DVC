/**
 * views/sidebar/MenuEditor.jsx — '메뉴 편집' 창(v2.726, 시안 ⑤)과 슈퍼 관리자 '배포' 창(시안 ⑥).
 *
 * 왼쪽: 내 메뉴 — 그룹·항목 ▲▼, 항목 ✕, 그룹 이름·삭제, '여기에 추가' 로 대상 그룹 지정, + 새 그룹.
 * 오른쪽: 특수 기능 목록(검색·분류 칩) — '+ 추가' 는 지정한 그룹 끝에 넣는다(이미 들어간 도구는 '✓ 그룹명').
 *         기본 메뉴 항목 중 내 메뉴에 없는 것(지운 것·업그레이드로 새로 생긴 것)도 같은 방법으로 다시 넣는다.
 * 저장은 `PUT /user-menu`(계정별 서버 저장) — 권한은 넓어지지 않는다(권한 없는 항목은 사이드바가 숨긴다). 편집 연산은
 * menuEdit.js(순수)가 소유한다. 배포(super_admin)는 저장된 내 메뉴를 보내므로 바뀐 것이 있으면 먼저 저장하게 한다.
 * v2.727(감사 A-01): `menuState !== 'ok'`(서버에서 메뉴를 못 읽음)이면 저장·삭제·복원·배포를 **잠그고 사유를 말한다** — 기본 메뉴 +
 *   편집으로 저장하면 저장돼 있던 내 메뉴가 통째로 사라진다. 다시 읽기에 성공하면 편집 중이던 것을 서버 메뉴 기준으로 되돌린다.
 * v2.727(감사 A-04): '추가 대상' 은 그룹 **id** 로 든다(인덱스면 ▲▼·삭제 뒤 다른 그룹에 들어갔다). A-05: '바뀐 항목'·저장 활성은
 *   저장 결과 기준(`changesToSave`). A-10: 배포자 이름이 응답에 없으면(viewer) '슈퍼 관리자' 로 말한다.
 * ⚠ 문구에 백틱·`**` 를 쓰지 않는다(BoldText 규약). 대문자 변환 금지. 표는 쓰지 않는다(목록이라 STable 대상 아님).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, ErrorBox, Loading } from '../../components/ui.jsx';
import { fetchJson, postJson, putJson, delJson, can, toolAllowed, getCurrentUser } from '../../api.js';
import { fmtAgo } from '../../util/fmt.js';
import { lockReasonOf } from '../toolVisibility.js';
import { Icon, iconNameOf } from './sidebarIcons.jsx';
import { missingDefaults } from './sideMenu.js';
import {
  toEditable, toStored, defaultEditable, moveGroup, moveItem, removeItem, addItem, newGroup, renameGroup, removeGroup,
  changesToSave, firstGroupId, prevNoteText, distNoteText, lockedNoteText, availableTools, filterTools, countItems, LIMITS,
} from './menuEdit.js';

const SOURCE_TEXT = { mine: '내 메뉴', distributed: '배포된 메뉴', default: '포탈 기본 메뉴', unknown: '메뉴를 읽지 못했습니다' };
/** v2.727(A-14): 기본값을 렌더마다 새 객체로 만들지 않는다(useMemo(tools) 가 매 렌더 무효가 됐다). */
const NO_OVERRIDES = Object.freeze({});

export default function MenuEditor({ user, data, resolved, catalog = [], menuState = 'ok', onRetry, onClose, onChanged }) {
  const isAdmin = user?.role === 'admin';
  const [groups, setGroups] = useState(() => toEditable(resolved?.groups || []));
  const baseline = useMemo(() => toEditable(resolved?.groups || []), [resolved]);
  const [targetId, setTargetId] = useState(() => firstGroupId(toEditable(resolved?.groups || [])));
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('all');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState(null);
  const [note, setNote] = useState('');
  const [showDist, setShowDist] = useState(false);
  const [newName, setNewName] = useState('');

  // 조회 실패/불러오는 중이면 잠근다. 잠겼다가 풀리면(다시 읽기 성공) 편집본을 서버 메뉴 기준으로 되돌린다 — 잠긴 동안의 편집은
  // 틀린 바탕(기본 메뉴) 위의 것이라 그대로 저장하면 안 된다.
  const locked = menuState !== 'ok';
  const wasLocked = useRef(locked);
  useEffect(() => {
    if (wasLocked.current && !locked) {
      const fresh = toEditable(resolved?.groups || []);
      setGroups(fresh);
      setTargetId(firstGroupId(fresh));
      setNote('서버에서 메뉴를 다시 읽었습니다 — 편집 중이던 내용은 서버 메뉴 기준으로 되돌렸습니다.');
    }
    wasLocked.current = locked;
  }, [locked, resolved]);

  const changed = changesToSave(baseline, groups);
  const items = countItems(groups);
  const overrides = data?.overrides || NO_OVERRIDES;
  const lockOf = (t) => lockReasonOf(t, { isAdmin, toolsAllowed: getCurrentUser()?.toolsAllowed ?? null, can, toolAllowed });
  const tools = useMemo(() => availableTools(catalog, groups, { overrides, lockOf }), [catalog, groups, overrides]); // eslint-disable-line react-hooks/exhaustive-deps
  const cats = Array.isArray(data?.categories) ? data.categories : [];
  const catSet = cat !== 'all' ? new Set((cats.find((c) => c.id === cat)?.tools) || []) : null;
  const shownTools = filterTools(tools.filter((t) => !catSet || catSet.has(t.k)), q);
  const missing = missingDefaults(groups);
  const target = groups.findIndex((g) => g.id === targetId);
  const targetGroup = target >= 0 && !groups[target].tab ? groups[target] : null;
  const targetLabel = targetGroup ? targetGroup.label : '(그룹을 고르세요)';

  const apply = (r) => { if (r.ok === false) { setNote(r.reason || ''); return; } setNote(''); setGroups(r.groups); };
  const add = (item) => { if (!targetGroup) { setNote('왼쪽에서 "여기에 추가" 로 대상 그룹을 먼저 고르세요'); return; } apply(addItem(groups, target, item)); };
  const addGroup = () => { const r = newGroup(groups, newName); apply(r); if (r.ok) { setTargetId(r.groups[r.gi].id); setNewName(''); } };
  const delGroup = (gi) => {
    const r = removeGroup(groups, gi);
    apply(r);
    if (r.ok && groups[gi]?.id === targetId) setTargetId(firstGroupId(r.groups));
  };

  const save = async () => {
    if (locked) { setNote(lockedNoteText(menuState)); return; }
    setBusy('save'); setErr(null); setNote('');
    try {
      const r = await putJson('/user-menu', { menu: toStored(groups) });
      if (r?.ok === false) { setNote(r.reason || '저장하지 못했습니다'); return; }
      onChanged?.('saved', r);
      onClose?.();
    } catch (e) { setErr(e); } finally { setBusy(''); }
  };
  const useDistributedOrDefault = async () => {
    if (locked) return;
    setBusy('clear'); setErr(null);
    try { await delJson('/user-menu'); onChanged?.('cleared'); onClose?.(); } catch (e) { setErr(e); } finally { setBusy(''); }
  };
  const restorePrev = async () => {
    if (locked) return;
    setBusy('restore'); setErr(null);
    try { await postJson('/user-menu/restore-prev'); onChanged?.('restored'); onClose?.(); } catch (e) { setErr(e); } finally { setBusy(''); }
  };

  const src = resolved?.source || 'default';
  const prev = data?.prev || null;
  const dist = data?.distributed || null;
  const lockTitle = locked ? lockedNoteText(menuState) : undefined;

  return (
    <Modal title="메뉴 편집" onClose={onClose} width={1120}>
      <div className="me">
        <div className="me-head">
          <div className="me-head-l">
            <span className="me-src">{SOURCE_TEXT[src] || src}</span>
            <span className="me-meta">그룹 {groups.filter((g) => g.tab || (g.children || []).length).length} · 항목 {items} · 바뀐 항목 <b>{changed}</b></span>
            {data?.username && <span className="me-meta">· {data.username}</span>}
          </div>
          <div className="me-head-r">
            <button type="button" className="btn" disabled={!!busy || locked} title={lockTitle} onClick={() => { setGroups(defaultEditable(catalog)); setNote('포탈 기본 메뉴로 되돌렸습니다 — 저장을 눌러야 적용됩니다'); }}>기본 메뉴로 되돌리기</button>
            {prev && <button type="button" className="btn" disabled={!!busy || locked} onClick={restorePrev} title={lockTitle || prevNoteText(prev, prev.at ? fmtAgo(prev.at) : null)}>{prev.mode === 'save' ? '저장 전 메뉴 복원' : '이전 메뉴 복원'}</button>}
            {src === 'mine' && (dist ? <button type="button" className="btn" disabled={!!busy || locked} title={lockTitle} onClick={useDistributedOrDefault}>배포된 메뉴로 바꾸기</button>
              : <button type="button" className="btn" disabled={!!busy || locked} title={lockTitle} onClick={useDistributedOrDefault}>내 메뉴 삭제(기본 메뉴 사용)</button>)}
            {data?.canDistribute && <button type="button" className="btn" disabled={!!busy || locked || changed > 0} title={lockTitle || (changed > 0 ? '바뀐 것이 있습니다 — 먼저 저장한 뒤 배포할 수 있습니다' : '내 메뉴(저장된 것)를 전체 사용자에게 배포')} onClick={() => setShowDist(true)}>전체 사용자에게 배포…</button>}
            <button type="button" className="btn" disabled={!!busy} onClick={onClose}>취소</button>
            <button type="button" className="btn primary" disabled={!!busy || locked || changed === 0} title={lockTitle} onClick={save}>{busy === 'save' ? '저장 중…' : '저장'}</button>
          </div>
        </div>
        {locked && (
          <div className="banner warn me-locked">
            {lockedNoteText(menuState)}
            {menuState === 'error' && onRetry && <> <button type="button" className="btn btn-sm" onClick={onRetry}>다시 시도</button></>}
          </div>
        )}
        {err && <ErrorBox error={err} />}
        {note && <div className="banner warn">{note}</div>}
        {dist && src !== 'distributed' && <div className="me-hint muted">{distNoteText(dist, dist.at ? fmtAgo(dist.at) : null)}</div>}

        <div className="me-body">
          <section className="me-left">
            <div className="me-sec-head">
              <span>내 메뉴</span>
              <span className="me-newgroup">
                <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="새 그룹 이름" maxLength={LIMITS.label} aria-label="새 그룹 이름"
                  onKeyDown={(e) => { if (e.key === 'Enter') addGroup(); }} />
                <button type="button" className="btn" onClick={addGroup}>+ 새 그룹</button>
              </span>
            </div>
            <div className="me-groups">
              {groups.map((g, gi) => (
                <div key={g.id} className={`me-group${g.id === targetId ? ' target' : ''}${g.tab ? ' single' : ''}`}>
                  <div className="me-group-head">
                    <Icon name={iconNameOf(g.id)} size={15} className="me-gico" />
                    {g.tab ? <span className="me-gname">{g.label}</span>
                      : <input className="me-gname me-gname-in" value={g.label} aria-label={`${g.label} 그룹 이름`} maxLength={LIMITS.label}
                        onChange={(e) => setGroups(renameGroup(groups, gi, e.target.value))} />}
                    <span className="me-gcount">{g.tab ? '단독' : `${(g.children || []).length}개`}</span>
                    <span className="me-gbtns">
                      {!g.tab && <button type="button" className={`btn btn-sm${g.id === targetId ? ' primary' : ''}`} aria-pressed={g.id === targetId} onClick={() => setTargetId(g.id)}>{g.id === targetId ? '추가 대상' : '여기에 추가'}</button>}
                      <button type="button" className="btn btn-sm" aria-label="위로" disabled={gi === 0} onClick={() => setGroups(moveGroup(groups, gi, -1))}>▲</button>
                      <button type="button" className="btn btn-sm" aria-label="아래로" disabled={gi === groups.length - 1} onClick={() => setGroups(moveGroup(groups, gi, 1))}>▼</button>
                      {!g.tab && <button type="button" className="btn btn-sm" aria-label="그룹 삭제" title="그룹을 지웁니다 — 안의 항목은 오른쪽 '기본 메뉴 항목' 으로 돌아갑니다" onClick={() => delGroup(gi)}>✕</button>}
                    </span>
                  </div>
                  {!g.tab && (
                    <ul className="me-items" role="list">
                      {(g.children || []).map((c, ii) => (
                        <li key={c.key} className="me-item">
                          <span className="me-idot" aria-hidden="true" />
                          <span className="me-ilabel">{c.label}</span>
                          {c.fromTools && <span className="me-tag">특수 기능</span>}
                          {isAdmin && c.adminOnly && <Icon name="lock" size={11} className="me-lock" title="관리자 전용" />}
                          <span className="me-ibtns">
                            <button type="button" className="btn btn-sm" aria-label="위로" disabled={ii === 0} onClick={() => setGroups(moveItem(groups, gi, ii, -1))}>▲</button>
                            <button type="button" className="btn btn-sm" aria-label="아래로" disabled={ii === g.children.length - 1} onClick={() => setGroups(moveItem(groups, gi, ii, 1))}>▼</button>
                            <button type="button" className="btn btn-sm" aria-label="빼기" onClick={() => setGroups(removeItem(groups, gi, ii))}>✕</button>
                          </span>
                        </li>
                      ))}
                      {!(g.children || []).length && <li className="me-item-empty muted">비어 있는 그룹은 저장할 때 제외됩니다 — 오른쪽에서 기능을 더하세요.</li>}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section className="me-right">
            <div className="me-sec-head"><span>기능을 골라 <b>{targetLabel}</b> 그룹에 넣습니다</span></div>
            <div className="me-search">
              <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="기능 이름·키·설명·옛 이름 검색" aria-label="기능 검색" />
            </div>
            {cats.length > 0 && (
              <div className="me-chips">
                <button type="button" className={`me-chip${cat === 'all' ? ' on' : ''}`} onClick={() => setCat('all')}>전체</button>
                {cats.map((c) => <button type="button" key={c.id} className={`me-chip${cat === c.id ? ' on' : ''}`} onClick={() => setCat(c.id)}>{c.icon ? `${c.icon} ` : ''}{c.label}</button>)}
              </div>
            )}
            {missing.length > 0 && (
              <div className="me-missing">
                <div className="me-sub-head">기본 메뉴 항목 중 내 메뉴에 없는 것 {missing.length}개 <span className="muted">(지운 것 · 업그레이드로 새로 생긴 것)</span></div>
                <div className="me-tools">
                  {missing.map((m) => (
                    <div key={m.key} className="me-tool">
                      <div className="me-tool-body">
                        <div className="me-tool-name">{m.label}</div>
                        <div className="me-tool-desc muted">기본 자리: {m.groupLabel}</div>
                      </div>
                      <button type="button" className="btn btn-sm" onClick={() => add({ key: m.key, id: m.id, label: m.label, ...(m.tab ? { tab: m.tab } : { tool: m.tool, ...(m.seg ? { seg: m.seg } : {}) }) })}>+ 추가</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="me-sub-head">특수 기능 {shownTools.length}개{q || cat !== 'all' ? ` (전체 ${tools.length}개 중)` : ''}</div>
            <div className="me-tools">
              {shownTools.map((t) => (
                <div key={t.k} className={`me-tool${t.placedLabel ? ' placed' : ''}`}>
                  <div className="me-tool-body">
                    <div className="me-tool-name">{t.icon ? `${t.icon} ` : ''}{t.label}{t.lock && <Icon name="lock" size={11} className="me-lock" title={t.lock} />}</div>
                    <div className="me-tool-desc muted">{t.desc}</div>
                  </div>
                  {t.placedLabel
                    ? <span className="me-placed">✓ {t.placedLabel}</span>
                    : <button type="button" className="btn btn-sm" onClick={() => add(t.item)}>+ 추가</button>}
                </div>
              ))}
              {!shownTools.length && <div className="muted" style={{ padding: 8 }}>맞는 기능이 없습니다.</div>}
            </div>
            <div className="me-foot muted">
              메뉴에 넣어도 권한은 넓어지지 않습니다 — 권한이 없는 항목은 사이드바에 보이지 않습니다. 메뉴에서 뺀 화면도 특수 기능 카드·주소로는 그대로 열립니다.
              업그레이드로 늘어난 화면은 저장된 메뉴에 자동으로 들어가지 않습니다(위 '기본 메뉴 항목' 목록에서 더하세요).
            </div>
          </section>
        </div>
      </div>
      {showDist && <DistributeDialog onClose={() => setShowDist(false)} onDone={() => { setShowDist(false); onChanged?.('distributed'); }} />}
    </Modal>
  );
}

/** 시안 ⑥ — 전체 사용자에게 배포(강제 적용 / 유지). super_admin 전용(서버 게이트가 집행한다). */
export function DistributeDialog({ onClose, onDone }) {
  const [st, setSt] = useState(null);
  const [err, setErr] = useState(null);
  const [mode, setMode] = useState('force');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  useEffect(() => {
    let alive = true;
    fetchJson('/user-menu/distribute').then((r) => { if (alive) setSt(r); }).catch((e) => { if (alive) setErr(e); });
    return () => { alive = false; };
  }, []);
  const run = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await postJson('/user-menu/distribute', { mode });
      if (r?.ok === false) { setErr(new Error(r.reason || '배포하지 못했습니다')); return; }
      setResult(r);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const clear = async () => {
    setBusy(true); setErr(null);
    try { await delJson('/user-menu/distribute'); setResult({ cleared: true }); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const last = st?.distributed || null;
  return (
    <Modal title="내 메뉴를 전체 사용자에게 배포" onClose={result ? onDone : onClose} width={720}>
      <div className="me-dist">
        <div className="me-dist-eyebrow">슈퍼 관리자 전용</div>
        {err && <ErrorBox error={err} />}
        {!st && !err && <Loading label="배포 현황" />}
        {st && !result && (
          <>
            <div className="me-dist-card">
              <div><b>배포할 메뉴</b> — 지금 저장된 내 메뉴{st.hasMine ? '' : ' (저장된 내 메뉴가 없습니다 — 먼저 저장하세요)'}</div>
              <div className="muted">대상: 로컬 계정 <b>{st.users}</b>명 · 직접 만든 메뉴가 있는 사용자 <b>{st.custom}</b>명{st.custom > st.customKnown ? ` (그중 ${st.custom - st.customKnown}명은 AD 등 로컬 목록 밖)` : ''}</div>
              <div className="muted">AD 계정은 로그인해야 이름이 생기므로 미리 셀 수 없습니다 — 배포 메뉴는 그들에게도 적용됩니다.</div>
            </div>
            <fieldset className="me-dist-modes">
              <legend>직접 만든 메뉴가 있는 사용자에게</legend>
              <label className={`me-dist-mode${mode === 'force' ? ' on' : ''}`}>
                <input type="radio" name="dist-mode" value="force" checked={mode === 'force'} onChange={() => setMode('force')} />
                <span><b>강제 적용</b> — 그 사용자의 메뉴도 이 메뉴로 바꿉니다. 직전 메뉴는 보관되어 '이전 메뉴 복원' 으로 되찾을 수 있습니다.</span>
              </label>
              <label className={`me-dist-mode${mode === 'keep' ? ' on' : ''}`}>
                <input type="radio" name="dist-mode" value="keep" checked={mode === 'keep'} onChange={() => setMode('keep')} />
                <span><b>유지</b> — 직접 만든 사용자는 자기 메뉴를 그대로 씁니다(편집 화면의 '배포된 메뉴로 바꾸기' 로 바꿀 수 있습니다). 내 메뉴가 없는 사용자만 이 메뉴를 받습니다.</span>
              </label>
            </fieldset>
            <div className="me-dist-last muted">
              {last ? <>마지막 배포: {last.by || '슈퍼 관리자'} · {last.at ? fmtAgo(last.at) : '—'} · {last.mode === 'force' ? '강제 적용' : '유지'} · 그룹 {last.groups} · 강제 적용 {last.counts?.forced ?? 0}명</> : '마지막 배포 없음'}
              {' · '}배포 기록과 감사 로그가 남습니다. 권한은 바뀌지 않습니다(권한 없는 항목은 그 사용자에게 보이지 않습니다).
            </div>
            <div className="me-dist-btns">
              {last && <button type="button" className="btn" disabled={busy} onClick={clear} title="배포 메뉴를 거둡니다 — 내 메뉴가 없는 사용자는 포탈 기본 메뉴로 돌아갑니다">배포 철회</button>}
              <span style={{ flex: 1 }} />
              <button type="button" className="btn" disabled={busy} onClick={onClose}>취소</button>
              <button type="button" className="btn primary" disabled={busy || !st.hasMine} onClick={run}>{busy ? '배포 중…' : (mode === 'force' ? '강제 적용으로 배포' : '유지로 배포')}</button>
            </div>
          </>
        )}
        {result && (
          <div className="me-dist-card">
            {result.cleared ? <div><b>배포를 철회했습니다.</b> 내 메뉴가 없는 사용자는 포탈 기본 메뉴를 봅니다.</div>
              : <div><b>배포했습니다.</b> 대상 {result.counts?.users ?? 0}명 · 직접 만든 메뉴 {result.counts?.custom ?? 0}명 · 강제 적용 {result.counts?.forced ?? 0}명 ({result.mode === 'force' ? '강제 적용' : '유지'})</div>}
            <div className="me-dist-btns"><span style={{ flex: 1 }} /><button type="button" className="btn primary" onClick={onDone}>닫기</button></div>
          </div>
        )}
      </div>
    </Modal>
  );
}
