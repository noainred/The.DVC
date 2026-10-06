// IpmsSettings.jsx — IP관리 › IPMS 설정(무시 대역 · 공인/사설 분류 · 스캔 대역 안내). v2.639 에 IpamSettings.jsx(853줄)에서 나눴다.
// ② vCenter별 스캔 대역은 v2.691 에 '스캔 대역·설정'(에이전트별)으로 합쳐졌다 — 여기서는 그 페이지로 안내만 한다.
import React, { useEffect, useState } from 'react';
import { fetchJson, putJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { useIpamDraft } from './useIpamDraft.js'; // v2.636: 편집 초안 — 페이지를 옮기거나 대장이 다시 로딩돼도 입력이 남는다
import { DraftBanner } from './IpamDraftBanner.jsx';
import { Frame } from './ipamShared.jsx';
import { RangeCheck, RangeMsg, RANGE_TA } from './VcScanRangeEditor.jsx';
import { checkRangeList, ipmsSettingsErrors, normalizeRangeText, sameIpmsSettings, serverInvalidText, vcenterOptionLabel, vcenterOptions } from './ipmsRangeText.js';
import Select from '../../components/Select.jsx';

const SECTION = { border: '1px solid var(--border)', borderRadius: 10, padding: 12, minWidth: 0 };

export function IpmsSettings({ onClose, asPage = false, access = 'unknown' }) {
  // v2.636: 폼 값은 편집 초안(ipms:settings) — 저장 전까지 다른 페이지로 옮겨도 남는다.
  const d = useIpamDraft('ipms:settings');
  const s = d.value;
  const setS = d.set;
  const [loadErr, setLoadErr] = useState(null); // 조회 실패(403 이면 HttpError 그대로 — 권한 안내로 그린다)
  const [meta, setMeta] = useState({});         // v2.637: invalidSaved·orphanVcenters·omittedOutOfScope
  const [vcs, setVcs] = useState(null);         // null = 아직 모름(실패와 구분)
  const [vcsErr, setVcsErr] = useState(null);
  const [vc, setVc] = useState('');
  const [msg, setMsg] = useState(null);         // { ok, text, list? } 하나의 모양
  const [saving, setSaving] = useState(false);
  const metaOf = (r) => ({ invalidSaved: r?.invalidSaved || [], orphanVcenters: r?.orphanVcenters || [], omittedOutOfScope: r?.omittedOutOfScope || 0 });
  // v2.637: vCenter 목록 조회 실패를 삼키지 않는다 — 예전 `.catch(() => {})` 는 선택기가 비어 vc 가 '' 인 채로
  //   'vCenter별 무시 대역' 입력이 `vcenters['']` 에 저장됐다(어느 vCenter 에도 적용되지 않는다 — 오류 없이 사라지는 입력).
  const loadVcs = () => fetchJson('/vcenters')
    .then((list) => { const arr = Array.isArray(list) ? list : []; setVcs(arr); setVcsErr(null); if (arr[0]) setVc((cur) => cur || arr[0].id); })
    .catch((e) => setVcsErr(e?.message || String(e)));
  useEffect(() => {
    fetchJson('/admin/ipam/settings').then((r) => { d.load(r.settings); setMeta(metaOf(r)); }).catch((e) => setLoadErr(e));
    loadVcs();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // 등록 목록이 비었거나 실패했어도 설정에만 남은(삭제된) vCenter 가 있으면 그것을 고를 수 있어야 한다 — 선택이 빈 채로 두지 않는다.
  useEffect(() => {
    if (vc) return;
    const first = (vcs || [])[0]?.id || (meta.orphanVcenters || [])[0];
    if (first) setVc(first);
  }, [vcs, meta, vc]);

  const nameOf = (id) => (vcs || []).find((v) => v.id === id)?.name || id;
  if (!s) return <Frame asPage={asPage} title="IPMS 설정" onClose={onClose}>{loadErr ? <ErrorBox message={loadErr} /> : <Loading />}</Frame>;

  const opts = vcenterOptions(vcs, s, d.base, meta.orphanVcenters);
  const cur = opts.find((o) => o.id === vc) || null;
  const errors = ipmsSettingsErrors(s, nameOf);
  const realDirty = !!d.dirty && !sameIpmsSettings(s, d.base);
  const globalText = (s.global || []).join('\n');
  const vcText = (s.vcenters?.[vc] || []).join('\n');
  const publicText = (s.publicRanges || []).join('\n');
  const privateText = (s.privateRanges || []).join('\n');
  // v2.639(D8): 쉼표는 줄바꿈으로 — 서버 무시·분류 목록은 줄 단위라 쉼표 줄은 400 이 된다. 입력 시점에 정규화해 줄 번호가 textarea 와 같게.
  const linesOf = (t) => normalizeRangeText(t).split('\n');
  const setGlobal = (t) => setS({ ...s, global: linesOf(t) });
  const setVcText = (t) => { if (!vc) return; setS({ ...s, vcenters: { ...(s.vcenters || {}), [vc]: linesOf(t) } }); };
  const setPublic = (t) => setS({ ...s, publicRanges: linesOf(t) });
  const setPrivate = (t) => setS({ ...s, privateRanges: linesOf(t) });
  const save = async () => {
    if (errors.length) return; // 버튼 잠금의 이중 방어 — 서버도 같은 판정으로 400 을 준다
    setMsg(null); setSaving(true);
    try {
      const r = await putJson('/admin/ipam/settings', s);
      if (r.ok) {
        d.saved(r.settings || s);   // 서버가 정리한 값으로(빈 줄 제거 등) — 초안을 지운다
        setMeta(metaOf(r));
        // v2.611 LEFT2611-02: 범위 제한 계정의 전역 대역 변경은 적용하지 않는다 — 조용히 닫지 않고 사유를 보인다.
        if (r.ignoredReason) setMsg({ ok: false, text: `저장했습니다(범위 안 vCenter 대역만). ${r.ignoredReason}` });
        else if (asPage) setMsg({ ok: true, text: '저장했습니다 — 대장·검색·공유 DB 는 다음 수집 주기에 새 대역으로 다시 만들어집니다.' });
        else onClose();
      } else {
        // v2.637: 400 은 `reason` 이다 — 예전에는 `r.error` 만 읽어 서버 사유 대신 '저장 실패' 만 보였다.
        setMsg({ ok: false, text: r.reason || r.error || '저장하지 못했습니다', list: (r.invalid || []).map((x) => serverInvalidText(x, nameOf)) });
      }
    } catch (e) { setMsg({ ok: false, text: e?.message || String(e) }); } finally { setSaving(false); }
  };
  const saveTitle = errors.length ? `형식 오류 ${errors.length}줄을 먼저 고치세요 — ${errors.slice(0, 3).map((e) => `${e.where} ${e.line}행`).join(', ')}` : undefined;
  const gridCols = asPage ? 'repeat(auto-fit, minmax(min(460px, 100%), 1fr))' : '1fr';

  return (
    <Frame asPage={asPage} title="IPMS 설정 — 무시 대역 · vCenter 스캔 대역 · 공인/사설 분류" onClose={onClose} width={620}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.7 }}>
        형식: CIDR(<code>10.0.0.0/24</code>, 마스크 /8~/32) · 범위(<code>10.0.0.1-10.0.0.50</code> 또는 <code>10.0.0.1-50</code>) · 단일 IP — 한 줄에 하나.
        입력하는 동안 칸 아래에 오류(✕ — 저장을 막음)와 경고(△ — 저장은 됨)를 보여 줍니다.
      </div>
      <DraftBanner d={d} />
      <RangeMsg m={msg} />
      {meta.invalidSaved?.length > 0 && (
        <div className="banner warn" style={{ marginBottom: 8, whiteSpace: 'normal' }}>
          저장돼 있지만 <b>적용되지 않는 줄 {meta.invalidSaved.length}개</b>가 있습니다(이전 버전에서 검사 없이 저장된 값). 고치거나 지운 뒤 저장하세요.
          <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12 }}>{meta.invalidSaved.slice(0, 10).map((x, i) => <li key={i}>{serverInvalidText(x, nameOf)}</li>)}</ul>
        </div>
      )}
      {meta.omittedOutOfScope > 0 && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>권한 범위 밖 vCenter {meta.omittedOutOfScope}곳의 무시 대역은 보이지 않으며 저장해도 그대로 유지됩니다.</div>}

      <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 12 }}>
        <section style={SECTION}>
          <b style={{ fontSize: 13 }}>① 무시 대역</b>
          <div className="muted" style={{ fontSize: 11, margin: '2px 0 8px' }}>여기 입력한 대역의 IP 는 IP 관리대장·검색·공유 DB 에서 제외됩니다.</div>
          <label style={{ display: 'block', fontSize: 12 }}>전체(모든 vCenter)
            <textarea className="input" rows={5} value={globalText} onChange={(e) => setGlobal(e.target.value)} placeholder={'10.255.0.0/16\n8.8.8.8'} style={RANGE_TA} aria-label="전체 무시 대역" />
          </label>
          <RangeCheck check={checkRangeList(s.global || [])} />
          <div className="flex gap wrap" style={{ alignItems: 'center', margin: '12px 0 4px' }}>
            <span style={{ fontSize: 12 }}>vCenter별</span>
            <Select className="select" value={vc} onChange={(e) => setVc(e.target.value)} style={{ maxWidth: '100%', minWidth: 0 }} disabled={!opts.length} aria-label="vCenter 선택">
              {!opts.length && <option value="">{vcs == null && !vcsErr ? '불러오는 중…' : 'vCenter 없음'}</option>}
              {opts.map((o) => <option key={o.id} value={o.id}>{vcenterOptionLabel(o)}</option>)}
            </Select>
          </div>
          {vcsErr && (
            <div className="banner warn" style={{ marginBottom: 6, whiteSpace: 'normal' }}>
              vCenter 목록을 불러오지 못했습니다({vcsErr}) — 목록 없이 입력하면 어느 vCenter 에도 적용되지 않으므로 칸을 잠갔습니다.
              <button className="logout-btn" style={{ padding: '2px 10px', fontSize: 12, marginLeft: 8 }} onClick={loadVcs}>다시 불러오기</button>
            </div>
          )}
          <textarea className="input" rows={5} value={vcText} disabled={!vc} onChange={(e) => setVcText(e.target.value)} placeholder={'172.16.0.0/12'} style={RANGE_TA} aria-label="vCenter별 무시 대역" />
          {vc && <RangeCheck check={checkRangeList(s.vcenters?.[vc] || [])} />}
          {cur?.orphan && <div style={{ fontSize: 11, marginTop: 4, color: 'var(--amber)' }}>이 vCenter 는 등록 목록에 없습니다(삭제됨) — 이 대역은 어느 IP 에도 적용되지 않습니다. 칸을 비우고 저장하면 정리됩니다.</div>}
          {vc && !cur?.orphan && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>선택한 <b>{cur?.name || vc}</b> 에서만 위 대역을 숨깁니다. ● 는 저장하지 않은 변경이 있는 vCenter 입니다.</div>}
        </section>

        {/* vCenter별 스캔 대역 — 사전 정리 + 주기 스캔(rangeStore). 저장 버튼이 따로다(편집기 안). ① 의 vCenter 선택과 연동. */}
        <section style={SECTION}>
          <b style={{ fontSize: 13 }}>② 스캔 대역</b>
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.7, marginTop: 4 }}>
            v2.691 부터 스캔 대역은 <b>에이전트별</b>로 한 곳에서 관리합니다 — 예전 vCenter 별 스캔 대역은 그 vCenter 를 수집하는 에이전트로 옮겼습니다
            (중앙 직접 수집은 ‘이 포탈에서 직접’, 엣지 위임은 그 엣지). iDRAC 대역·VM 대역 가져오기도 그 페이지에 있습니다.
          </div>
          <a className="logout-btn" href="#/ipam/scan" style={{ display: 'inline-block', marginTop: 8, padding: '6px 12px', textDecoration: 'none', color: 'inherit' }}>🛰️ 스캔 대역·설정 페이지로</a>
        </section>
      </div>

      <section style={{ ...SECTION, marginTop: 12 }}>
        <b style={{ fontSize: 13 }}>③ 공인 / 사설 IP 분류</b>
        <div className="muted" style={{ fontSize: 11, margin: '2px 0 10px' }}>관리대장의 <b>분류</b> 열에 쓰입니다. 명시한 대역이 우선이고(둘 다 해당하면 사설), 해당 없으면 RFC1918(10/8·172.16/12·192.168/16)은 <b>사설</b>, 그 외는 <b>공인</b>입니다.</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <label style={{ display: 'block', fontSize: 12 }}>공인(Public) 대역
              <textarea className="input" rows={4} value={publicText} onChange={(e) => setPublic(e.target.value)} placeholder={'203.0.113.0/24\n8.8.8.8'} style={RANGE_TA} aria-label="공인 대역" />
            </label>
            <RangeCheck check={checkRangeList(s.publicRanges || [])} />
          </div>
          <div style={{ minWidth: 0 }}>
            <label style={{ display: 'block', fontSize: 12 }}>사설(Private) 대역
              <textarea className="input" rows={4} value={privateText} onChange={(e) => setPrivate(e.target.value)} placeholder={'100.64.0.0/10\n10.0.0.0/8'} style={RANGE_TA} aria-label="사설 대역" />
            </label>
            <RangeCheck check={checkRangeList(s.privateRanges || [])} />
          </div>
        </div>
      </section>

      <div className="flex gap wrap" style={{ marginTop: 12, alignItems: 'center', paddingTop: 10, borderTop: '1px solid var(--border)' }}>
        <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} disabled={saving || errors.length > 0} title={saveTitle} onClick={save}>{saving ? '저장 중…' : `①·③ 저장${realDirty ? ' ●' : ''}`}</button>
        {!asPage && <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={onClose}>취소</button>}
        <span className="muted" style={{ fontSize: 11 }}>
          {errors.length ? <span style={{ color: 'var(--red)' }}>형식 오류 {errors.length}줄 — 고친 뒤 저장할 수 있습니다. </span> : realDirty ? '저장하지 않은 변경이 있습니다. ' : '변경 없음. '}
          무시 대역·공인/사설 분류를 함께 저장합니다(② 스캔 대역은 따로).
        </span>
      </div>
    </Frame>
  );
}
