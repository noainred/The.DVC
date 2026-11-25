import React, { useEffect, useState } from 'react';
import { fetchJson, putJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import { presetsForSpec, rangeText, timeoutSpecs, timerSpecs, unsetNote, msLabel, effectiveFor, lagText, toBody } from './storageIntervals.js';
import { STable } from '../components/STable.jsx';
import Select from '../components/Select.jsx';
import { requireChanged } from './changeResult.js'; // v2.732 B5-03: 400 본문을 '저장되었습니다' 로 읽지 않는다
import { unreadMarkOf, saveLockedByUnread } from './settingsUnread.js';   // 112회차: 못 읽은 동안의 조회(빈 폼)로 저장하지 않는다
import { SettingsUnreadBanner } from './SettingsUnreadBanner.jsx';

/**
 * 스토리지 수집 주기(중앙 → 엣지 배포, v2.409 — 사용자 요구
 * '중앙에서 엣지의 스토리지 수집 주기를 설정할 수 있는 기능 설정에 추가').
 *
 * 구조상 중앙은 엣지에 명령을 밀어넣을 수 없다(엣지는 NAT/폐쇄망 뒤 — 아웃바운드 pull 만).
 * 그래서 여기서 저장한 값은 엣지가 **다음 설정 pull 때 가져가서** 적용한다. 화면에서도 그
 * 지연을 숨기지 않고 표시한다(즉시 적용처럼 보이면 '설정했는데 안 바뀐다'는 오해가 생긴다).
 */
// 셀 컴포넌트는 **렌더 함수 밖**에 둔다 — 안에서 정의하면 매 렌더마다 새 타입이 되어 <Select sort={false}> 가
// 언마운트/재마운트되고 값을 고른 직후 포커스를 잃는다(v2.416 리뷰 확정).
// v2.598 WEBUI-2598-09: 중앙(직접 수집) 행은 엣지가 아니다 — 상속 끝의 값은 '엣지 로컬' 이 아니라 중앙 자신의
//   env·기본값이고, 중앙은 자기에게 push·설정 pull 을 하지 않으므로 그 두 칸은 적용 대상이 아니다.
const CENTRAL_NA_KEYS = new Set(['pushMs', 'configPullMs']);
/*
 * v3.41.1 — 표 폭(Chromium 판독으로 찾은 기존 결함): 표의 칸은 기본이 한 줄(`white-space: nowrap`)이라 대상 칸이 설명 한 줄 길이(471px)만큼
 *   벌어지고, 선택 칸도 긴 첫 선택지(‘미지정(엣지 로컬)’ · ‘상속(중앙 기본(env))’)만큼 넓어져, 주기 표가 1440px 에서도 본문 폭(896px)을 넘어
 *   영역 · 노드 부하 · 반영 지연 열이 가로 스크롤해야만 보였다. 400px 에서는 대상 칸 하나가 화면을 다 차지했다.
 *   · 대상 칸 · 머리글 · 반영 지연 칸은 줄바꿈한다(WRAP_TD · WRAP_TH).
 *   · 첫 선택지는 짧게(‘미지정’ · ‘상속’) — 무엇을 물려받는지는 칸 아래 줄이 말한다(unsetNote).
 *   · 대상 칸은 왼쪽에 고정한다(STICKY_TD) — 좁은 화면에서 가로로 밀어도 어느 행인지 보인다. 고정 칸은 **불투명 배경**이어야 한다(뒤 칸이 비친다).
 */
// 줄바꿈은 **낱말 단위**(`word-break: keep-all`) — 기본값은 한글을 글자 사이 어디서나 끊어 ‘지연(최/대)’ · ‘1시간 5/분’ 이 됐다(Chromium 판독).
const WRAP_TD = { whiteSpace: 'normal', wordBreak: 'keep-all', minWidth: 120 };
const WRAP_TH = { whiteSpace: 'normal', wordBreak: 'keep-all', lineHeight: 1.35 };
const CELL_TD = { paddingLeft: 8, paddingRight: 8 };
// 고정 칸의 배경은 그 행의 배경과 **같은 불투명 색**이어야 한다 — 그래서 표 바탕(TABLE_BG)과 전역 행(GLOBAL_ROW)도 같은 변수로 못 박는다
//   (표 바탕이 투명이면 고정 칸만 밝은 상자로 떠 보인다 — Chromium 판독).
const TABLE_BG = { background: 'var(--panel)' };
const GLOBAL_ROW = { background: 'var(--panel-2)' };
const STICKY_TD = { ...WRAP_TD, position: 'sticky', left: 0, zIndex: 1, background: 'var(--panel)' };
const STICKY_TD_GLOBAL = { ...STICKY_TD, background: 'var(--panel-2)' };
const STICKY_TH = { ...WRAP_TH, minWidth: 120, left: 0, zIndex: 3 };
/** 대기 시간 표 — 열이 둘뿐이라 대상 칸에 폭을 주어 선택 칸이 이름 바로 옆에 오게 한다(안 주면 선택 칸이 표 오른쪽 끝으로 밀린다). */
const TIMEOUT_TARGET_W = { width: '38%' };
function inheritTail(target) {
  return target === '' ? '중앙 기본(env)' : '엣지 로컬';
}

function Cell({ target, form, s, globalForm, setCell }) {
  const inheritedFrom = target === '__global__' ? null : globalForm[s.key];
  const cur = form[s.key] ?? '';
  const presets = presetsForSpec(s);   // v3.39.0: 사양의 선택지·상한(PowerScale SSH 명령 대기 1~5분 · 노드 부하 표본 60분)을 따른다
  // 파일 직접 편집 등으로 프리셋에 없는 값이 들어오면 옵션을 하나 만들어 보여준다 — 없으면 브라우저가
  // 첫 옵션('미지정')을 표시해 '미지정'으로 읽힌다(상태에는 값이 남아 저장 시 유지되는데 화면만 다름).
  const extra = cur && !presets.some((p) => String(p.ms) === String(cur)) ? [{ ms: Number(cur), label: `${msLabel(Number(cur))} (직접 지정)` }] : [];
  return (
    <Select sort={false} className="input" style={{ minWidth: 88, width: '100%', maxWidth: 200 }} value={cur}
      onChange={(e) => setCell(target, s.key, e.target.value)}
      title={`${s.label}\n${rangeText(s)}\n${s.hint}`}>
      {/* v3.41.1: 첫 선택지는 짧게 — 긴 글자가 선택 칸(=열) 폭을 정한다. 무엇을 물려받는지는 칸 아래 줄(unsetNote)과 툴팁이 말한다. */}
      <option value="" title={target === '__global__' ? '미지정 — 그 엣지의 로컬 설정을 그대로 둡니다' : `상속 — ${inheritedFrom ? `전역 기본 ${msLabel(Number(inheritedFrom))}` : inheritTail(target)}`}>
        {target === '__global__' ? '미지정' : '상속'}
      </option>
      {[...extra, ...presets].map((p) => <option key={p.ms} value={String(p.ms)}>{p.label}</option>)}
    </Select>
  );
}

export default function StorageIntervals() {
  // ⚠ 훅은 전부 조기 return 위에 — 조기 반환 뒤에 훅을 추가하면 React #310 으로 화면이
  //   통째로 크래시한다(v2.202 실제 사고, CLAUDE.md 프론트 회귀 방지).
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [globalForm, setGlobalForm] = useState({});
  const [agentForms, setAgentForms] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const fill = (d) => {
    const str = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, String(v)]));
    setGlobalForm(str(d.config?.global));
    const rows = {};
    for (const a of ['', ...(d.agents || [])]) rows[a] = str(d.config?.agents?.[a]);
    // 파일에만 있고 현재 알려진 엣지 목록엔 없는 이름(연결이 끊긴 엣지)도 보여준다 — 안 보이면
    // 저장 시 조용히 사라진다(전체 교체 저장이므로).
    for (const a of Object.keys(d.config?.agents || {})) if (!(a in rows)) rows[a] = str(d.config.agents[a]);
    setAgentForms(rows);
  };

  const load = async () => {
    try { const d = await fetchJson('/tools/storage/intervals'); setData(d); fill(d); setError(null); }
    catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  if (error && !data) return <ErrorBox message={error} />;  // 데이터 보유 중 폴링 오류로 화면을 갈아치우지 않음
  if (!data) return <Loading />;

  const spec = data.spec || [];
  // v3.39.0: 주기(타이머) 항목은 위 표에, 시한 항목(PowerScale SSH 명령 대기)은 아래 '대기 시간' 표에 — 사양의 `timer: false` 가 가른다.
  const timerSpec = timerSpecs(spec);
  const timeoutSpec = timeoutSpecs(spec);
  const envDefaults = data.central?.env || {};
  const targets = [{ key: '', label: '중앙(직접 수집)', hint: '수집 주체를 지정하지 않은 장비 — 중앙 포탈이 직접 접속해 수집한다. 저장 즉시 적용된다.' },
    ...Object.keys(agentForms).filter((a) => a !== '').sort().map((a) => ({ key: a, label: a, hint: `엣지 '${a}' 가 수집하는 장비. 다음 설정 pull 때 적용된다.` }))];

  const setCell = (target, key, v) => {
    if (target === '__global__') setGlobalForm((p) => ({ ...p, [key]: v }));
    else setAgentForms((p) => ({ ...p, [target]: { ...(p[target] || {}), [key]: v } }));
  };

  // 112회차(106회차가 남긴 것): 서버가 주기 파일을 못 읽은 동안의 조회는 빈 지정이다 — 그 빈 폼의 저장(전체 교체)이 다시 읽힌 뒤 엣지별 주기를 전부 지웠다.
  //   읽기 오류면 저장을 잠근다(서버도 409). 조회(load)는 늘 폼을 다시 채우므로 ‘다시 확인’ 으로 읽힌 뒤에는 저장된 값이 보인다.
  const unread = unreadMarkOf(data);
  const saveLocked = saveLockedByUnread(unread);
  const save = async () => {
    if (saveLocked) return;
    setBusy(true); setMsg(null);
    try {
      // v2.732(점검 2회차 B5-03): 400 {ok:false, reason}(디스크 쓰기 실패)을 성공으로 읽으면 '저장되었습니다' 와 함께
      //   fill 이 옛 config 로 폼을 되돌렸다(입력이 사라진다). 판정한 뒤에만 폼을 바꾼다 — 실패면 입력을 그대로 둔다.
      const r = requireChanged(await putJson('/tools/storage/intervals', toBody(globalForm, agentForms)));
      setData((p) => ({ ...p, ...r, loadError: null }));   // 112회차: 저장 성공 = 표지 해제(손상 뒤의 저장)
      fill({ ...data, ...r });
      setMsg((r.issues?.length ? `저장됨(보정 ${r.issues.length}건: ${r.issues.join(' / ')}). ` : '저장되었습니다. ') + (r.note || ''));
    } catch (e) { setMsg(`저장 실패: ${e.message}`); }
    finally { setBusy(false); }
  };


  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>⏱ 스토리지 수집 주기 · 대기 시간</div>
      <SettingsUnreadBanner le={unread} what="스토리지 수집 주기" save="저장" onRecheck={load} busy={busy} />

      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 13, lineHeight: 1.7 }}>
          각 법인(엣지)이 스토리지 장비를 얼마나 자주 수집하고 중앙으로 올릴지를 <b>중앙에서</b> 정합니다.
          예전에는 엣지 서버의 <code>portal.env</code> 를 직접 고치고 재시작해야 했습니다.
          <div className="muted" style={{ marginTop: 6 }}>
            • <b>미지정</b>은 그 엣지의 로컬 설정(portal.env)을 그대로 둔다는 뜻입니다 — 지정한 항목만 배포됩니다.<br />
            • 엣지 반영은 <b>즉시가 아닙니다</b>. 그 엣지의 <b>설정 수신(pull) 주기</b>만큼 걸릴 수 있습니다(중앙은 엣지에 명령을 밀어넣을 수 없는 구조 — 엣지가 가지러 옵니다).<br />
            • 엣지에서 <code>STORAGE_INTERVALS_LOCAL=1</code> 을 켜 두면 그 엣지는 중앙 값을 무시합니다(현장 고정).<br />
            • 하한(수집·push·pull 60초 / 영역 수집 10분)은 서버가 강제합니다. 그 밑으로는 이전 주기가 끝나기 전에 다음 주기가 와서 실효가 없습니다.
          </div>
        </div>
      </div>

      <div className="table-wrap" style={TABLE_BG}>
        <STable>
          <thead>
            <tr>
              <th style={STICKY_TH}>대상</th>
              {timerSpec.map((s) => <th key={s.key} title={s.hint} style={WRAP_TH}>{s.label}</th>)}
              <th style={WRAP_TH} title="장비 수집 주기 + 중앙 전송(push) 주기 — 장비의 변화가 중앙 화면에 늦어도 이만큼 안에 보인다는 뜻.">중앙 반영 지연(최대)</th>
            </tr>
          </thead>
          <tbody>
            <tr style={GLOBAL_ROW}>
              <td style={STICKY_TD_GLOBAL}><b>전역 기본</b><div className="muted" style={{ fontSize: 11 }}>모든 엣지 + 중앙에 적용(개별 지정이 우선)</div></td>
              {timerSpec.map((s) => (
                <td key={s.key} style={CELL_TD}>
                  <Cell target="__global__" form={globalForm} s={s} globalForm={globalForm} setCell={setCell} />
                  <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{unsetNote(s.key, '__global__', globalForm, {})}</div>
                </td>
              ))}
              <td className="muted" style={WRAP_TD}>{lagText(effectiveFor(globalForm, {}), envDefaults)}</td>
            </tr>
            {targets.map((t) => {
              const form = agentForms[t.key] || {};
              const eff = effectiveFor(globalForm, form);
              return (
                <tr key={t.key || '__central__'}>
                  <td style={STICKY_TD}><b>{t.label}</b><div className="muted" style={{ fontSize: 11 }}>{t.hint}</div></td>
                  {timerSpec.map((s) => (t.key === '' && CENTRAL_NA_KEYS.has(s.key)
                    ? <td key={s.key} className="muted" style={{ ...CELL_TD, fontSize: 12 }} title="중앙은 자기 자신에게 push·설정 pull 을 하지 않습니다.">해당 없음</td>
                    : (
                    <td key={s.key} style={CELL_TD}>
                      <Cell target={t.key} form={form} s={s} globalForm={globalForm} setCell={setCell} />
                      <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{unsetNote(s.key, t.key, globalForm, form)}</div>
                    </td>
                  )))}
                  <td className="muted" style={WRAP_TD}>{lagText(eff, envDefaults, { isEdge: t.key !== '' })}</td>
                </tr>
              );
            })}
          </tbody>
        </STable>
      </div>

      {/* v3.39.0 — 대기 시간(시한) 항목은 주기 표와 **따로** 그린다. 처음에는 주기 표의 열로 넣었는데, 그 표는 1440px 에서도 가로로 넘쳐
          (대상 칸의 설명이 한 줄이라 넓다) 새 열이 스크롤해야만 보였다(Chromium 판독). 같은 폼 · 같은 저장 버튼이다 — 값은 한 번에 저장된다.
          대상 칸은 줄바꿈을 허용한다(400px 에서 선택 칸이 화면 밖으로 밀리지 않게). 숫자는 서버 사양(spec)에서 온다. */}
      {timeoutSpec.length > 0 && (
        <>
          <div className="section-title">⏳ 대기 시간(timeout)</div>
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="muted" style={{ fontSize: 13, lineHeight: 1.7 }}>
              {timeoutSpec.map((s) => (
                <div key={s.key}>
                  • <b>{s.label}</b> — 주기가 아니라 <b>대기 시간</b>입니다. PowerScale(Isilon) SSH 수집에서 isi 명령 하나의 응답을 이 시간까지 기다립니다({rangeText(s)}).
                  응답이 느린 클러스터가 시간 초과로 수집에 실패하면 그 법인(엣지) 행에서 늘리세요. 장비 한 대의 전체 수집 시한도 이 값에 맞춰 함께 늘어납니다.
                  미지정이면 그 엣지의 로컬 값(없으면 기본 {msLabel(s.def)})을 씁니다.
                </div>
              ))}
            </div>
          </div>
          <div className="table-wrap" style={TABLE_BG}>
            <STable>
              <thead>
                <tr>
                  <th style={{ ...STICKY_TH, ...TIMEOUT_TARGET_W }}>대상</th>
                  {timeoutSpec.map((s) => <th key={s.key} title={s.hint} style={WRAP_TH}>{s.label}</th>)}
                </tr>
              </thead>
              <tbody>
                <tr style={GLOBAL_ROW}>
                  <td style={STICKY_TD_GLOBAL}><b>전역 기본</b><div className="muted" style={{ fontSize: 11 }}>모든 엣지 + 중앙에 적용(개별 지정이 우선)</div></td>
                  {timeoutSpec.map((s) => (
                    <td key={s.key} style={CELL_TD}>
                      <Cell target="__global__" form={globalForm} s={s} globalForm={globalForm} setCell={setCell} />
                      <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{unsetNote(s.key, '__global__', globalForm, {})}</div>
                    </td>
                  ))}
                </tr>
                {targets.map((t) => {
                  const form = agentForms[t.key] || {};
                  return (
                    <tr key={t.key || '__central__'}>
                      <td style={STICKY_TD}><b>{t.label}</b><div className="muted" style={{ fontSize: 11 }}>{t.hint}</div></td>
                      {timeoutSpec.map((s) => (
                        <td key={s.key} style={CELL_TD}>
                          <Cell target={t.key} form={form} s={s} globalForm={globalForm} setCell={setCell} />
                          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{unsetNote(s.key, t.key, globalForm, form)}</div>
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </STable>
          </div>
        </>
      )}

      <div className="flex gap" style={{ marginTop: 12, alignItems: 'center' }}>
        <button className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} disabled={busy || saveLocked} onClick={save}>
          {busy ? '저장 중…' : '저장'}
        </button>
        <button className="tab" style={{ flex: 'none', padding: '8px 14px' }} disabled={busy} onClick={load}>되돌리기</button>
        {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
      </div>

      {/* 중앙 자신이 지금 쓰는 값 — '설정은 했는데 뭐가 먹고 있나'를 확인하는 창구.
          엣지의 실효값은 여기서 알 수 없다(엣지가 스스로 적용) — 스토리지 화면의 장비별
          수집 시각으로 확인해야 한다. 아는 척하지 않고 그대로 적는다. */}
      <div className="card" style={{ marginTop: 14 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>중앙 포탈이 지금 쓰는 값</div>
        <div className="flex gap wrap" style={{ fontSize: 12 }}>
          {(data.central?.effective || []).map((e) => (
            <span key={e.key} className="badge" title={`출처: ${e.from === 'central' ? '중앙 설정' : e.from === 'env' ? 'portal.env' : '코드 기본값'}`}>
              {e.label} <b>{msLabel(e.ms)}</b>
              <span className="muted"> ({e.from === 'central' ? '중앙 설정' : e.from === 'env' ? 'env' : '기본'})</span>
            </span>
          ))}
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          엣지가 실제로 어떤 주기로 돌고 있는지는 이 화면에서 알 수 없습니다(엣지가 스스로 적용).
          특수기능 › 스토리지 모니터링의 장비별 <b>수집 시각</b> 간격으로 확인하세요.
        </div>
      </div>
    </>
  );
}
