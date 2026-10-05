/**
 * vcenter/updateSession.js — 인벤토리 속성을 '바뀐 것만' 받는다(v2.705 — B1, WaitForUpdatesEx). **기본 꺼짐**(`VC_WAIT_UPDATES=true` 로 켠다).
 *
 * 왜: 주기 수집은 매 주기 전체 인벤토리 속성(수천 VM × 수십 경로)을 다시 받는다. vSphere PropertyCollector 의 필터 + 버전으로
 *     직전 버전 이후 바뀐 속성만 받으면 회선·vCenter 부하가 줄어든다(30초 주기에서 대부분의 VM 은 그대로다).
 *
 * 설계(정직 기록 — 실장비 vCenter 로 확인하지 못했다. 가짜 vCenter 로 enter/modify/leave·잘림·세션 만료·폴백을 확인했다):
 *  · vCenter 마다 **오래 사는 세션 하나**(주 수집 세션과 별도)를 둔다 — 주 수집은 매 주기 로그인·로그아웃하므로 필터를 들고 있을 수 없다.
 *    켜면 vCenter 마다 세션이 하나 더 열려 있다(그 대가를 문서·설정 설명이 말한다).
 *  · 전용 PropertyCollector(CreatePropertyCollector)에 필터를 만든다 — 같은 세션의 기본 수집기를 다른 코드가 쓰더라도 섞이지 않게.
 *  · WaitForUpdatesEx(maxWaitSeconds=0) — 기다리지 않는다(주기 수집 안에서 부른다). 첫 호출(버전 '')은 전체가 enter 로 온다.
 *  · 바뀐 속성 이름이 **요청한 경로와 정확히 같을 때만** 그 값을 바꾼다. 더 깊은 경로(`config.hardware.device[4000].backing` 처럼)나
 *    배열 원소 추가(op add)로 오면 그 객체를 '다시 읽음' 으로 표시하고 그 주기에 그 객체만 RetrieveProperties 로 다시 읽는다
 *    — 부분 변경을 직접 합치다 틀리면 **오류 없이 틀린 값**이 된다.
 *  · 실패(세션 만료·필터 소실·버전 오류·잘림 상한·그 밖)는 상태를 버리고 **던진다** — 호출자가 그 주기를 예전 전체 조회로 받는다.
 *    로그인 실패는 `failUntil` 동안 다시 시도하지 않는다(같은 계정으로 실패 로그인을 쌓지 않는다 — v2.541 규약).
 *  · 드리프트 방지: `VC_WAIT_UPDATES_FULL_MS`(기본 6시간)마다 상태를 버리고 처음부터 받는다. 쓰지 않은 세션은 15분 뒤 정리한다.
 */
import { parseObjectContent, xmlUnescape } from './soapParse.js';
import { config } from '../config.js';
import { credHashOf } from '../util/authGuard.js';

// 접속처 + 자격증명 지문 — 둘 중 하나가 바뀌면 세션을 버린다(옛 세션이 옛 주소·계정으로 남지 않게).
const accessKey = (vc) => `${vc?.host || ''}|${credHashOf(vc)}`;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const IDLE_MS = 15 * 60_000;
const FAIL_BACKOFF_MS = 30 * 60_000;

/** @type {Map<string, any>} vc.id → 세션 상태 */
const sessions = new Map();

const specKeyOf = (types, specs) => JSON.stringify([types, specs.map((s) => [s.type, s.paths])]);

/** UpdateSet XML → { version, truncated, objects:[{kind, type, ref, changes:[{name, op, val, hasVal}]}] } — 순수. 결과가 없으면 null. */
export function parseUpdateSet(xml) {
  if (typeof xml !== 'string') return null;
  const a = xml.indexOf('<returnval>');
  if (a < 0) return null;
  const b = xml.lastIndexOf('</returnval>');
  const body = b > a ? xml.slice(a + 11, b) : xml.slice(a + 11);
  const version = /^\s*<version>([^<]{0,512})<\/version>/.exec(body)?.[1] ?? null;
  const objects = [];
  let i = 0;
  for (;;) {
    const s = body.indexOf('<objectSet>', i);
    if (s < 0) break;
    const e = body.indexOf('</objectSet>', s);
    if (e < 0) break;
    const blk = body.slice(s + 11, e);
    i = e + 12;
    const kind = /<kind>([a-z]{1,16})<\/kind>/.exec(blk)?.[1] || '';
    const objM = /<obj type="([^"]{1,128})">([^<]{1,256})<\/obj>/.exec(blk);
    if (!objM) continue;
    const changes = [];
    const csRe = /<changeSet>\s*<name>([^<]{1,512})<\/name>\s*<op>([A-Za-z]{1,16})<\/op>(?:\s*<val(?:\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/val>))?\s*<\/changeSet>/g;
    let m;
    while ((m = csRe.exec(blk))) {
      const hasVal = m[0].includes('<val');
      const raw = m[3] ?? '';
      changes.push({ name: m[1], op: m[2], hasVal, val: raw.indexOf('<') === -1 ? xmlUnescape(raw) : raw });
    }
    objects.push({ kind, type: objM[1], ref: objM[2], changes });
  }
  // 잘림 표지는 objectSet 뒤에 온다(UpdateSet: version, filterSet*, truncated)
  const truncated = /<truncated>true<\/truncated>/.test(body.slice(i));
  return { version, truncated, objects };
}

/** 한 객체에 변경을 적용한다(순수 — 객체를 바꾼다). @returns {boolean} 다시 읽어야 하면 true */
export function applyChanges(obj, changes, paths) {
  let dirty = false;
  for (const c of changes) {
    if (paths.has(c.name)) {
      if (c.op === 'assign') { if (c.hasVal) obj.props[c.name] = c.val; else delete obj.props[c.name]; }
      else if (c.op === 'remove' || c.op === 'indirectRemove') delete obj.props[c.name];
      else dirty = true;            // add — 배열 원소 단위 변경은 다시 읽는다
    } else dirty = true;            // 요청 경로보다 깊은(또는 모르는) 이름 — 직접 합치지 않는다
  }
  return dirty;
}

async function destroy(st) {
  if (!st) return;
  try { if (st.collector) await st.client.callRaw(`<DestroyPropertyCollector xmlns="urn:vim25"><_this type="PropertyCollector">${esc(st.collector)}</_this></DestroyPropertyCollector>`, { ignoreExternal: true }); } catch { /* best effort */ }
  try { await st.client.logout(); } catch { /* best effort */ }
}

async function sweep(now) {
  for (const [id, st] of sessions) {
    if (!st.busy && st.client && now - st.lastUsed > IDLE_MS) { sessions.delete(id); await destroy(st); }
  }
}

async function openSession(vc, types, specs, now, makeClient) {
  const client = makeClient(vc);
  await client.login();
  const pc = client.sc.propertyCollector;
  const cx = await client.callRaw(`<CreatePropertyCollector xmlns="urn:vim25"><_this type="PropertyCollector">${esc(pc)}</_this></CreatePropertyCollector>`);
  const collector = /<returnval type="PropertyCollector">([^<]+)<\/returnval>/.exec(cx)?.[1];
  if (!collector) { await client.logout(); throw new Error('CreatePropertyCollector 응답을 읽지 못했습니다'); }
  const st = { client, collector: xmlUnescape(collector), version: '', objs: new Map(), specKey: specKeyOf(types, specs), credHash: accessKey(vc),
    pathsByType: new Map(specs.map((s) => [s.type, new Set(s.paths)])), createdAt: now, lastFullAt: now, lastUsed: now, busy: false, stats: {} };
  try {
    const typeXml = types.map((t) => `<type>${esc(t)}</type>`).join('');
    const vx = await client.callRaw(`<CreateContainerView xmlns="urn:vim25"><_this type="ViewManager">${esc(client.sc.viewManager)}</_this>`
      + `<container type="Folder">${esc(client.sc.rootFolder)}</container>${typeXml}<recursive>true</recursive></CreateContainerView>`);
    const view = /<returnval type="ContainerView">([^<]+)<\/returnval>/.exec(vx)?.[1];
    if (!view) throw new Error('CreateContainerView 응답을 읽지 못했습니다');
    const propSets = specs.map((s) => `<propSet><type>${esc(s.type)}</type>${s.paths.map((p) => `<pathSet>${esc(p)}</pathSet>`).join('')}</propSet>`).join('');
    const fx = await client.callRaw(`<CreateFilter xmlns="urn:vim25"><_this type="PropertyCollector">${esc(st.collector)}</_this><spec>${propSets}`
      + `<objectSet><obj type="ContainerView">${view}</obj><skip>true</skip>`
      + `<selectSet xsi:type="TraversalSpec"><name>view</name><type>ContainerView</type><path>view</path><skip>false</skip></selectSet>`
      + `</objectSet></spec><partialUpdates>false</partialUpdates></CreateFilter>`);
    if (!/<returnval type="PropertyFilter">/.test(fx)) throw new Error('CreateFilter 응답을 읽지 못했습니다');
  } catch (err) { await destroy(st); throw err; }
  return st;
}

/**
 * 인벤토리 객체를 증분으로 받는다. 반환 모양은 retrieveProperties 와 같다(`[{type, ref, props}]` — 사본).
 * 실패하면 던진다(호출자가 전체 조회로 받는다).
 */
export async function inventoryViaUpdates(vc, types, specs, { makeClient, signal = null, now = Date.now() } = {}) {
  if (typeof makeClient !== 'function') throw new Error('makeClient 가 필요합니다');   // soapClient 를 import 하지 않는다(순환 방지)
  await sweep(now);
  let st = sessions.get(vc.id);
  if (st?.failUntil && now < st.failUntil && st.credHash === accessKey(vc)) throw new Error(st.lastError || '증분 수집 세션을 잠시 쉽니다');
  if (st?.busy) throw new Error('증분 수집 세션이 사용 중입니다');
  const key = specKeyOf(types, specs);
  if (st && (!st.client || st.specKey !== key || st.credHash !== accessKey(vc) || now - st.lastFullAt > config.vcWaitUpdatesFullMs)) {
    sessions.delete(vc.id); await destroy(st); st = null;
  }
  if (!st) {
    try { st = await openSession(vc, types, specs, now, makeClient); }
    catch (err) {
      sessions.set(vc.id, { failUntil: now + FAIL_BACKOFF_MS, lastError: String(err?.message || err).slice(0, 300), credHash: accessKey(vc), lastUsed: now });
      throw err;
    }
    sessions.set(vc.id, st);
  }
  st.busy = true; st.lastUsed = now; st.client.signal = signal;
  const initial = st.version === '';
  let changed = 0; let pages = 0;
  try {
    const dirty = new Map();   // ref → type
    for (;;) {
      if (++pages > config.vcPropsMaxPages) throw new Error(`증분 조회 페이지가 ${config.vcPropsMaxPages}개를 넘었습니다`);
      const xml = await st.client.callRaw(`<WaitForUpdatesEx xmlns="urn:vim25"><_this type="PropertyCollector">${esc(st.collector)}</_this>`
        + `<version>${esc(st.version)}</version><options><maxWaitSeconds>0</maxWaitSeconds><maxObjectUpdates>${config.vcPropsPageSize}</maxObjectUpdates></options></WaitForUpdatesEx>`);
      const up = parseUpdateSet(xml);
      if (!up) break;                                    // 바뀐 것 없음
      if (up.version == null) throw new Error('WaitForUpdatesEx 응답에 version 이 없습니다');
      for (const o of up.objects) {
        changed += 1;
        if (o.kind === 'leave') { st.objs.delete(o.ref); dirty.delete(o.ref); continue; }
        let cur = st.objs.get(o.ref);
        if (o.kind === 'enter' || !cur) { cur = { type: o.type, ref: o.ref, props: {} }; st.objs.set(o.ref, cur); }
        const paths = st.pathsByType.get(o.type) || new Set();
        if (applyChanges(cur, o.changes, paths)) dirty.set(o.ref, o.type);
      }
      st.version = up.version;
      if (!up.truncated) break;
    }
    // 부분 변경이 온 객체는 그 객체만 다시 읽는다(타입별로 묶어서)
    const byType = new Map();
    for (const [ref, type] of dirty) { if (!byType.has(type)) byType.set(type, []); byType.get(type).push(ref); }
    let refetched = 0;
    for (const [type, refs] of byType) {
      const paths = [...(st.pathsByType.get(type) || [])];
      if (!paths.length) continue;
      const fresh = await st.client.retrieveManyObjectProps(type, refs, paths);
      const seen = new Set();
      for (const f of fresh) { seen.add(f.ref); st.objs.set(f.ref, { type: f.type, ref: f.ref, props: f.props }); refetched += 1; }
      for (const r of refs) if (!seen.has(r)) st.objs.delete(r);   // 그 사이 사라진 객체
    }
    st.stats = { at: now, mode: initial ? 'initial' : 'incremental', changed, refetched, objects: st.objs.size, pages };
    st.lastError = null;
    return [...st.objs.values()].map((o) => ({ type: o.type, ref: o.ref, props: { ...o.props } }));
  } catch (err) {
    sessions.delete(vc.id);
    const e = { lastError: String(err?.message || err).slice(0, 300), lastUsed: now, credHash: st.credHash };
    if (err?.authFailed) e.failUntil = now + FAIL_BACKOFF_MS;   // 세션 로그인이 거부됐으면 쉬기
    sessions.set(vc.id, e);
    await destroy(st);
    throw err;
  } finally {
    st.busy = false; st.client.signal = null;
  }
}

/** 화면·진단용 — 비밀 없음. */
export function updateSessionStatus() {
  const out = {};
  for (const [id, st] of sessions) {
    out[id] = { active: !!st.client, version: st.client ? (st.version ? 'set' : 'none') : null, objects: st.objs?.size ?? null,
      stats: st.stats || null, lastError: st.lastError || null, failUntil: st.failUntil || null };
  }
  return { enabled: !!config.vcWaitUpdates, sessions: out };
}

/** 테스트·종료용. */
export async function closeAllUpdateSessions() {
  const all = [...sessions.values()]; sessions.clear();
  for (const st of all) if (st.client) await destroy(st);
}
