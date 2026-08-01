import React, { useEffect, useRef, useState } from 'react';
import { geoEquirectangular, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import geoData from 'world-atlas/countries-110m.json';

// ─────────────────────────────────────────────────────────────────────────────
// 로그인 화면 테마 10종 — 로그인마다 랜덤으로 하나가 표시된다(재미 요소).
// 공통 입력/제출 로직은 Login.jsx 가 소유하고, 각 테마에는 폼 바인딩 객체 f 만 넘긴다.
// 시각 차이는 배경 + CSS 변수(팔레트/폰트/라운드)로 낸다. 공통 필드는 AuthFields 로 재사용.
// ─────────────────────────────────────────────────────────────────────────────

const RESTRICT = 'RESTRICTED SYSTEM — Authorized operators only. 모든 인증 시도와 세션은 기록·감사됩니다. OTP 등록 계정은 Google OTP 6자리 코드로 로그인합니다.';

// 공통 입력 블록 — 모든 테마가 동일한 계정/비번/세션유지/제출을 공유(스타일만 테마별).
export function AuthFields({ f, title = 'Operator Sign In', sub = 'Authenticate to enter the monitoring console.', btn = 'AUTHENTICATE', idLabel = 'OPERATOR ID', pwLabel = 'PASSWORD', head }) {
  return (
    <>
      {head && <div className="lt-head">{head}</div>}
      <div className="lt-card-body">
        <h2 className="lt-title">{title}</h2>
        <div className="lt-sub">{sub}</div>

        {f.welcome && !f.notice && <div className="lt-welcome"><b>{f.welcome}</b>님 환영합니다 👋</div>}
        {f.notice && <div className="lt-notice">{f.notice}</div>}

        <label className="lt-lab">{idLabel}</label>
        <input className="lt-input" autoFocus autoComplete="username" value={f.username}
          onChange={(e) => f.setUsername(e.target.value)} placeholder="admin" />

        <label className="lt-lab">{pwLabel}</label>
        <div className="lt-pw">
          <input className="lt-input" style={{ paddingRight: 62 }} type={f.showPw ? 'text' : 'password'}
            autoComplete="one-time-code" value={f.password}
            onChange={(e) => f.setPassword(e.target.value)} placeholder="비밀번호 또는 6자리 OTP" />
          <button type="button" className="lt-show" onClick={() => f.setShowPw((v) => !v)}>{f.showPw ? 'HIDE' : 'SHOW'}</button>
        </div>

        <div className="lt-row">
          <label className="lt-keep">
            <input type="checkbox" checked={f.keep} onChange={(e) => f.setKeep(e.target.checked)} />
            <span className="lt-check" />KEEP SESSION · 8H
          </label>
          <button type="button" className="lt-forgot" onClick={f.toggleForgot}>FORGOT PASSWORD?</button>
        </div>
        {f.forgotInfo && <div className="lt-hint">비밀번호 초기화는 포탈 관리자에게 요청하세요 (사용자 관리 → 비밀번호 재설정). 체크 해제 시 브라우저를 닫으면 자동 로그아웃됩니다.</div>}

        {f.error && <div className="lt-error">{f.error}</div>}

        <button className="lt-btn" type="submit" disabled={f.busy || !f.username || !f.password}>
          {f.busy ? 'AUTHENTICATING…' : `${btn} →`}
        </button>

        <div className="lt-restrict">{RESTRICT}</div>
      </div>
    </>
  );
}

// 카드 하나를 화면 중앙에 놓는 공통 래퍼(대부분의 테마가 사용).
function Centered({ cls, bg, children, f, fields }) {
  return (
    <div className={`lt ${cls}`}>
      {bg}
      <form className="lt-card" onSubmit={f.submit}>{fields}</form>
      {children}
    </div>
  );
}

/* ───────────────────────── 배경 컴포넌트 ───────────────────────── */

// ① 도트 월드맵(Davinci 오리지널) — 육지 실루엣을 하프톤 도트로, 주요 사이트는 펄스 마커.
const SITES = [
  { code: 'PDX', lon: -122.68, lat: 45.52 }, { code: 'IAD', lon: -77.45, lat: 38.95 },
  { code: 'GRU', lon: -46.47, lat: -23.43 }, { code: 'LHR', lon: -0.45, lat: 51.47 },
  { code: 'FRA', lon: 8.57, lat: 50.03 }, { code: 'ICN', lon: 126.45, lat: 37.46 },
  { code: 'NRT', lon: 140.39, lat: 35.77 },
];
function DotMap() {
  const wrapRef = useRef(null); const canvasRef = useRef(null);
  const [markers, setMarkers] = useState([]);
  useEffect(() => {
    const land = feature(geoData, geoData.objects.countries);
    const draw = () => {
      const wrap = wrapRef.current, canvas = canvasRef.current;
      if (!wrap || !canvas) return;
      const w = wrap.clientWidth, h = wrap.clientHeight;
      if (!w || !h) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
      const projection = geoEquirectangular().fitExtent([[-w * 0.06, -h * 0.14], [w * 1.06, h * 1.34]], { type: 'Sphere' });
      const off = document.createElement('canvas'); off.width = w; off.height = h;
      const octx = off.getContext('2d', { willReadFrequently: true });
      const path = geoPath(projection, octx);
      octx.fillStyle = '#fff'; octx.beginPath(); path(land); octx.fill();
      const img = octx.getImageData(0, 0, w, h).data;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
      const step = Math.max(7, Math.round(w / 225));
      for (let y = Math.floor(step / 2); y < h; y += step) {
        for (let x = Math.floor(step / 2); x < w; x += step) {
          if (!img[(y * w + x) * 4 + 3]) continue;
          const rnd = ((x * 73856093) ^ (y * 19349663)) >>> 0;
          const a = 0.2 + ((rnd % 100) / 100) * 0.3;
          const r = step * (0.2 + ((rnd >> 8) % 60) / 100 * 0.12);
          ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(125, 150, 175, ${a.toFixed(2)})`; ctx.fill();
        }
      }
      setMarkers(SITES.map((s) => { const [mx, my] = projection([s.lon, s.lat]) || [0, 0]; return { ...s, x: mx, y: my }; })
        .filter((m) => m.x > 8 && m.x < w - 8 && m.y > 8 && m.y < h - 8));
    };
    draw();
    const ro = new ResizeObserver(draw);
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={wrapRef} className="dv-map" aria-hidden="true">
      <canvas ref={canvasRef} />
      {markers.map((m) => (
        <div key={m.code} className="dv-marker" style={{ left: m.x, top: m.y }}>
          <span className="dv-marker-ring" /><span className="dv-marker-dot" /><span className="dv-marker-label">{m.code}</span>
        </div>
      ))}
    </div>
  );
}

// ② 매트릭스 코드 레인.
function MatrixRain({ color = '#22c55e' }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let raf, cols, drops, w, h; const font = 16;
    const chars = 'アカサタナ0123456789ABCDEFﾊﾋﾌﾍﾎ01'.split('');
    const resize = () => {
      w = canvas.width = canvas.clientWidth; h = canvas.height = canvas.clientHeight;
      cols = Math.ceil(w / font); drops = Array.from({ length: cols }, () => Math.floor(Math.random() * -20));
    };
    resize();
    let last = 0;
    const loop = (t) => {
      raf = requestAnimationFrame(loop);
      if (t - last < 55) return; last = t; // ~18fps (부하 최소)
      ctx.fillStyle = 'rgba(0,0,0,0.09)'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = color; ctx.font = `${font}px monospace`;
      for (let i = 0; i < cols; i++) {
        const ch = chars[Math.floor(Math.random() * chars.length)];
        ctx.fillText(ch, i * font, drops[i] * font);
        if (drops[i] * font > h && Math.random() > 0.975) drops[i] = 0;
        drops[i]++;
      }
    };
    raf = requestAnimationFrame(loop);
    const ro = new ResizeObserver(resize); ro.observe(canvas);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [color]);
  return <canvas ref={ref} className="lt-canvas" aria-hidden="true" />;
}

// ③ 스타필드(별이 흐르는 우주).
function Starfield() {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let raf, w, h, stars;
    const resize = () => {
      w = canvas.width = canvas.clientWidth; h = canvas.height = canvas.clientHeight;
      stars = Array.from({ length: Math.min(220, Math.round(w * h / 9000)) }, () => ({
        x: Math.random() * w, y: Math.random() * h, z: Math.random() * 1 + 0.2, r: Math.random() * 1.3 + 0.3,
      }));
    };
    resize();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      ctx.clearRect(0, 0, w, h);
      for (const s of stars) {
        s.y += s.z * 0.35; if (s.y > h) { s.y = 0; s.x = Math.random() * w; }
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(199,210,254,${0.25 + s.z * 0.5})`; ctx.fill();
      }
    };
    raf = requestAnimationFrame(loop);
    const ro = new ResizeObserver(resize); ro.observe(canvas);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);
  return <canvas ref={ref} className="lt-canvas" aria-hidden="true" />;
}

/* ───────────────────────── 10개 테마 ───────────────────────── */

// 좌측 히어로 + 우측 카드(도트맵) — Davinci 오리지널.
function ThemeDavinci({ f }) {
  return (
    <div className="lt lt-davinci lt-split">
      <DotMap />
      <div className="lt-topbar">
        <div className="lt-brand"><div className="lt-logo"><i /></div>
          <div><div className="lt-brand-title">THE DAVINCI</div><div className="lt-brand-sub">GLOBAL INFRASTRUCTURE MONITOR</div></div>
        </div>
        <div className="lt-netstat"><i />NETWORK STATUS · NOMINAL</div>
      </div>
      <div className="lt-split-main">
        <div className="lt-hero">
          <div className="lt-hero-label"><b>▸</b>GLOBAL INFRASTRUCTURE CONSOLE</div>
          <h1>Eyes on every rack,<br />in every region.</h1>
          <p>The Davinci streams live telemetry from 5,800+ VMs and 650+ servers across 28 vCenters worldwide — one console, zero blind spots.</p>
        </div>
        <form className="lt-card" onSubmit={f.submit}>
          <AuthFields f={f} head={<><span><b>&gt;_</b>SECURE ACCESS // AUTH-01</span><span>TLS 1.3</span></>} />
        </form>
      </div>
    </div>
  );
}

// 오로라 글래스.
function ThemeAurora({ f }) {
  return <Centered cls="lt-aurora" f={f} bg={<div className="lt-bg lt-aurora-bg" aria-hidden />}
    fields={<AuthFields f={f} title="Welcome back" sub="오로라 콘솔에 접속합니다." btn="SIGN IN" />} />;
}

// 레트로 터미널(CRT).
function ThemeTerminal({ f }) {
  return <Centered cls="lt-terminal" f={f} bg={<div className="lt-scan" aria-hidden />}
    fields={<AuthFields f={f} head="root@davinci:~# ./login --secure" title="ACCESS TERMINAL" sub="// awaiting operator credentials_" btn="CONNECT" idLabel="LOGIN" pwLabel="SECRET" />} />;
}

// 블루프린트 그리드.
function ThemeBlueprint({ f }) {
  return <Centered cls="lt-blueprint" f={f} bg={<div className="lt-bg lt-grid" aria-hidden />}
    fields={<AuthFields f={f} head={<><span>DWG · AUTH-SCHEMATIC</span><span>REV 2.1</span></>} title="Access Blueprint" sub="시스템 도면에 서명하여 진입합니다." btn="AUTHORIZE" />} />;
}

// 미니멀 라이트(코퍼레이트).
function ThemeMinimal({ f }) {
  return <Centered cls="lt-minimal" f={f} bg={null}
    fields={<AuthFields f={f} head={<span className="lt-mini-brand">◆ THE DAVINCI</span>} title="Sign in" sub="Monitoring console 로 로그인하세요." btn="CONTINUE" />} />;
}

// 네온 사이버펑크.
function ThemeNeon({ f }) {
  return <Centered cls="lt-neon" f={f} bg={<div className="lt-neon-floor" aria-hidden />}
    fields={<AuthFields f={f} head={<><span>◈ NIGHT CITY NODE</span><span>ONLINE</span></>} title="JACK IN" sub="네온 그리드에 연결합니다." btn="JACK IN" idLabel="HANDLE" />} />;
}

// 스타필드(우주).
function ThemeStarfield({ f }) {
  return <Centered cls="lt-star" f={f} bg={<Starfield />}
    fields={<AuthFields f={f} head={<><span>✦ ORBITAL CONTROL</span><span>SYNC OK</span></>} title="Mission Control" sub="궤도 관제 콘솔에 접속합니다." btn="LAUNCH" />} />;
}

// 매트릭스 레인.
function ThemeMatrix({ f }) {
  return <Centered cls="lt-matrix" f={f} bg={<MatrixRain color="#22c55e" />}
    fields={<AuthFields f={f} head="wake up, operator..." title="THE MATRIX" sub="follow the white rabbit_" btn="ENTER" idLabel="OPERATOR" pwLabel="KEY" />} />;
}

// 선셋 그라디언트.
function ThemeSunset({ f }) {
  return <Centered cls="lt-sunset" f={f} bg={<div className="lt-bg lt-sunset-bg" aria-hidden />}
    fields={<AuthFields f={f} title="Good to see you" sub="따뜻하게 맞이합니다 — 로그인하세요." btn="LET ME IN" />} />;
}

// 브루탈리스트(흑백).
function ThemeBrutalist({ f }) {
  return <Centered cls="lt-brutal" f={f} bg={null}
    fields={<AuthFields f={f} head="THE DAVINCI // NO NONSENSE" title="LOG IN." sub="계정과 비밀번호. 그게 전부." btn="GO" />} />;
}

/* ────────────── 추가 10종 — 'Infra Monitor Concepts' 세션(1b~1k) 포팅 ────────────── */
// 원본은 1920×1080 정적 시안. 폼은 공통 AuthFields 로 실동작하게 얹고, 배경/레이아웃/팔레트를 재현.

// 11) 1b Terminal Boot — 부트 시퀀스 로그 + tty 로그인 박스.
function ThemeBoot({ f }) {
  return (
    <div className="lt lt-boot">
      <div className="lt-scan" aria-hidden />
      <div className="boot-log" aria-hidden>
        <div>davinci-core v4.2.1 — boot sequence initiated</div>
        <div>[ OK ] telemetry bus ......... 28 vCenters linked</div>
        <div>[ OK ] node registry ......... 5,812 VMs · 654 hosts</div>
        <div>[ OK ] alert pipeline ........ latency 12ms</div>
        <div className="boot-auth">[ AUTH ] operator credentials required to continue_</div>
      </div>
      <form className="lt-card" onSubmit={f.submit}>
        <div className="boot-tty"><i /><i /><span>DAVINCI://AUTH</span><em>tty1</em></div>
        <AuthFields f={f} title="login: operator" sub="$ awaiting credentials_" btn="EXEC LOGIN" idLabel="$ OPERATOR_ID" pwLabel="$ PASSPHRASE / OTP" />
      </form>
      <div className="boot-status" aria-hidden><span>UPTIME 99.99%</span><span>ALERTS 0 CRIT</span><span>REGIONS 12/12 UP</span></div>
    </div>
  );
}

// 12) 1c Split Panel — 좌 브랜드 패널(빅타이포+통계) / 우 언더라인 폼.
function ThemeSplitPanel({ f }) {
  return (
    <div className="lt lt-splitp">
      <div className="sp-left">
        <div className="sp-brand"><i /><span>THE DAVINCI</span></div>
        <div className="sp-big">One console.<br />Zero blind spots.</div>
        <div className="sp-desc">Live telemetry from 5,800+ VMs and 650+ servers across 28 vCenters worldwide.</div>
        <div className="sp-stats">
          <div><b>5.8K</b><span>VMS ONLINE</span></div>
          <div><b>28</b><span>VCENTERS</span></div>
          <div><b>99.99</b><span>UPTIME %</span></div>
        </div>
        <div className="sp-ticker">
          <div><b>▸</b> icn-03 · rack B7 · thermal nominal</div>
          <div><b>▸</b> fra-01 · failover drill complete</div>
        </div>
      </div>
      <div className="sp-right">
        <form className="lt-card" onSubmit={f.submit}>
          <AuthFields f={f} head={<><span>SECURE ACCESS · TLS 1.3</span></>} title="Operator Sign In" sub="Authenticate to enter the monitoring console." />
        </form>
      </div>
    </div>
  );
}

// 13) 1d Radar Ops — 동심원 레이더 + 회전 스윕 + 중앙 카드.
function ThemeRadar({ f }) {
  return (
    <div className="lt lt-radar">
      <div className="rd-topbar" aria-hidden><span>THE DAVINCI ◆ RADAR</span><span>SCAN CYCLE 8.0s · 12 REGIONS · <b>ALL NOMINAL</b></span></div>
      <div className="rd-ring r1" aria-hidden /><div className="rd-ring r2" aria-hidden /><div className="rd-ring r3" aria-hidden />
      <div className="rd-sweep" aria-hidden />
      <span className="rd-blip" style={{ top: '27%', left: '33%' }} aria-hidden />
      <span className="rd-blip" style={{ top: '59%', left: '68%', animationDelay: '1s' }} aria-hidden />
      <span className="rd-blip amber" style={{ top: '72%', left: '40%', animationDelay: '.5s' }} aria-hidden />
      <form className="lt-card" onSubmit={f.submit}>
        <div className="rd-icon" aria-hidden>◉</div>
        <AuthFields f={f} title="Operator Access" sub="Radar console · clearance L2+" />
      </form>
    </div>
  );
}

// 14) 1e Light Console — 밝은 도트 그리드 데이라이트 모드, 좌 히어로 + 우 흰 카드.
function ThemeDaylight({ f }) {
  return (
    <div className="lt lt-daylight lt-hero-split">
      <div className="dl-topbar">
        <div className="dl-brand"><i><b /></i><div><div className="t">THE DAVINCI</div><div className="s">GLOBAL INFRASTRUCTURE MONITOR</div></div></div>
        <div className="dl-net"><i />NETWORK STATUS · NOMINAL</div>
      </div>
      <div className="hs-main">
        <div className="hs-hero">
          <div className="dl-label">▸ DAYLIGHT OPS MODE</div>
          <h1>Eyes on every rack, in every region.</h1>
          <p>Live telemetry from 5,800+ VMs and 650+ servers across 28 vCenters — in a console that's easy on the eyes, day or night.</p>
          <div className="dl-kpis"><span>● 5,812 VMS</span><span>● 654 HOSTS</span><span>● 0 CRITICAL</span></div>
        </div>
        <form className="lt-card" onSubmit={f.submit}>
          <AuthFields f={f} title="Operator Sign In" sub="Authenticate to enter the console." />
        </form>
      </div>
    </div>
  );
}

// 15) 1f Region Tiles — 리전 타일 월(어둡게) 뒤 '잠긴 콘솔' 카드.
const TILE_CODES = ['ICN', 'FRA', 'SIN', 'IAD', 'GRU', 'PDX', 'LHR', 'NRT', 'SYD', 'AMS', 'BOM', 'SFO'];
const TILE_LABELS = ['CPU LOAD', 'MEM PRESSURE', 'NET I/O', 'DISK IOPS', 'LATENCY MS', 'VMS ACTIVE'];
function ThemeRegionTiles({ f }) {
  const tiles = Array.from({ length: 30 }, (_, i) => ({
    code: `${TILE_CODES[i % 12]}-0${(i % 4) + 1}`,
    amber: i === 7 || i === 19,
    val: [412, 88, 97, 231, 12, 505][i % 6] + (i % 3 === 0 ? '%' : ''),
    label: TILE_LABELS[i % 6],
  }));
  return (
    <div className="lt lt-tiles">
      <div className="tw-wall" aria-hidden>
        {tiles.map((t, i) => (
          <div key={i} className="tw-tile">
            <div className="tw-head"><span>{t.code}</span><b style={{ color: t.amber ? '#e8b84a' : '#39d3b8' }}>●</b></div>
            <div><div className="tw-val">{t.val}</div><div className="tw-lab">{t.label}</div></div>
          </div>
        ))}
      </div>
      <div className="tw-vignette" aria-hidden />
      <form className="lt-card" onSubmit={f.submit}>
        <div className="tw-brand"><i /><span>THE DAVINCI</span></div>
        <AuthFields f={f} title="Console locked" sub="28 vCenters are reporting behind this screen. Sign in to unlock." btn="UNLOCK CONSOLE" />
      </form>
    </div>
  );
}

// 16) 1g Ultra Minimal — 중앙 초미니멀 + 하단 흐르는 티커.
const TICKER_ITEMS = ['icn-03 · thermal nominal', 'fra-01 · failover drill complete', 'sin-02 · uptime 99.99%', 'iad-04 · patch window 03:00 UTC', 'gru-01 · link restored'];
function ThemeUltraMinimal({ f }) {
  return (
    <div className="lt lt-ultra">
      <div className="um-topbar" aria-hidden><span>THE DAVINCI</span><span>UTC · <b>NOMINAL</b></span></div>
      <div className="um-gem" aria-hidden />
      <form className="lt-card" onSubmit={f.submit}>
        <AuthFields f={f} title="Sign in to the console" sub="5,812 VMs · 28 vCenters · one console" btn="AUTHENTICATE" />
      </form>
      <div className="um-ticker" aria-hidden>
        <div>{[...TICKER_ITEMS, ...TICKER_ITEMS].map((t, i) => <span key={i}>{t}</span>)}</div>
      </div>
    </div>
  );
}

// 17) 1h NOC Preview — 블러 처리된 차트보드 위 우측 패널 인증.
function ThemeNoc({ f }) {
  const charts = TILE_LABELS.map((title, i) => ({ title, bars: Array.from({ length: 8 }, (_, j) => 22 + ((i * 37 + j * 53) % 68)) }));
  return (
    <div className="lt lt-noc">
      <div className="noc-wall" aria-hidden>
        {charts.map((c) => (
          <div key={c.title} className="noc-chart">
            <div className="noc-title">{c.title}</div>
            <div className="noc-bars">{c.bars.map((b, j) => <i key={j} style={{ height: `${b}%` }} />)}</div>
          </div>
        ))}
      </div>
      <form className="lt-card noc-panel" onSubmit={f.submit}>
        <div className="tw-brand"><i /><span>THE DAVINCI</span></div>
        <AuthFields f={f} title="Your NOC is one login away." sub="Live boards resume exactly where you left them." btn="RESUME SESSION" />
      </form>
    </div>
  );
}

// 18) 1i Left Rail — 좌측 인증 레일 + 우측 라이브 토폴로지(SVG 곡선).
function ThemeLeftRail({ f }) {
  return (
    <div className="lt lt-rail">
      <form className="lt-card rail-card" onSubmit={f.submit}>
        <div className="rail-brand">◆ THE DAVINCI</div>
        <AuthFields f={f} title="Operator Sign In" sub="Authenticate to enter the console." />
      </form>
      <div className="rail-map" aria-hidden>
        <div className="rail-topline">LIVE TOPOLOGY · <b>11 UP</b> · <em>1 DEGRADED</em></div>
        <svg viewBox="0 0 1480 1080" preserveAspectRatio="xMidYMid slice">
          <path d="M 260 420 Q 560 150 900 350" stroke="rgba(57,211,184,.4)" strokeWidth="1.5" fill="none" strokeDasharray="4 6" />
          <path d="M 900 350 Q 1130 480 1240 640" stroke="rgba(57,211,184,.4)" strokeWidth="1.5" fill="none" strokeDasharray="4 6" />
          <path d="M 260 420 Q 500 720 820 780" stroke="rgba(232,184,74,.35)" strokeWidth="1.5" fill="none" strokeDasharray="4 6" />
          <circle cx="260" cy="420" r="5" fill="#39d3b8" /><circle cx="900" cy="350" r="5" fill="#39d3b8" />
          <circle cx="1240" cy="640" r="5" fill="#39d3b8" /><circle cx="820" cy="780" r="5" fill="#e8b84a" />
          <text x="280" y="408" fill="#7ba0a3" fontSize="15" fontFamily="monospace">PDX</text>
          <text x="918" y="338" fill="#7ba0a3" fontSize="15" fontFamily="monospace">FRA</text>
          <text x="1258" y="628" fill="#7ba0a3" fontSize="15" fontFamily="monospace">ICN</text>
          <text x="840" y="812" fill="#c9a13f" fontSize="15" fontFamily="monospace">GRU · DEGRADED</text>
        </svg>
        <div className="rail-log">
          <div>▸ icn-03 · rack B7 · thermal nominal</div>
          <div>▸ gru-01 · packet loss 2.1% · investigating</div>
        </div>
      </div>
    </div>
  );
}

// 19) 1j Amber Terminal — 야간 근무용 저휘도 앰버 콘솔.
function ThemeAmber({ f }) {
  return (
    <div className="lt lt-amber lt-hero-split">
      <div className="lt-scan" aria-hidden />
      <div className="am-topbar" aria-hidden><span>THE DAVINCI // NIGHT WATCH</span><span><b>●</b> NOMINAL</span></div>
      <div className="hs-main">
        <div className="hs-hero">
          <div className="am-label">▸ AMBER SHIFT CONSOLE</div>
          <h1>Quiet nights are earned, not lucky.</h1>
          <p>5,800+ VMs watched around the clock. Low-glare amber mode for overnight operators.</p>
          <div className="am-log">
            <div>▸ icn-03 · thermal nominal</div>
            <div>▸ fra-01 · failover drill complete</div>
          </div>
        </div>
        <form className="lt-card" onSubmit={f.submit}>
          <AuthFields f={f} head={<><span><b>&gt;_</b>AUTH-01 · TLS 1.3</span></>} title="Operator Sign In" sub="야간 교대 콘솔에 로그인합니다." />
        </form>
      </div>
    </div>
  );
}

// 20) 1k Data Wall — 상단 스탯바 + 99.99% 업타임 히트맵 + 우측 인증.
function ThemeDataWall({ f }) {
  const days = Array.from({ length: 31 }, (_, i) => (i === 21 ? '#e8b84a' : i % 5 === 4 ? '#1f5a4e' : '#155f52'));
  return (
    <div className="lt lt-wall">
      <div className="dw-topbar">
        <span className="dw-brand">◆ THE DAVINCI</span>
        <span className="dw-stats">VMS <b>5,812</b> · HOSTS <b>654</b> · VCENTERS <b>28</b> · CRIT <em>0</em></span>
      </div>
      <div className="dw-main">
        <div className="dw-hero" aria-hidden>
          <div className="dw-big">99.99<b>%</b></div>
          <div className="dw-sub">FLEET UPTIME · TRAILING 31 DAYS</div>
          <div className="dw-days">{days.map((c, i) => <i key={i} style={{ background: c }} />)}</div>
          <div className="dw-legend">■ nominal &nbsp;■ degraded window — one amber day in 31.</div>
          <div className="dw-log">
            <div>▸ icn-03 · rack B7 · thermal nominal</div>
            <div>▸ fra-01 · failover drill complete</div>
            <div>▸ sin-02 · uptime 99.99% · 31d window</div>
          </div>
        </div>
        <form className="lt-card" onSubmit={f.submit}>
          <AuthFields f={f} head={<><span><b>&gt;_</b>SECURE ACCESS // AUTH-01</span></>} title="Operator Sign In" sub="Authenticate to enter the monitoring console." />
        </form>
      </div>
    </div>
  );
}

export const THEMES = [
  { id: 'davinci', name: 'Davinci Map', Comp: ThemeDavinci },
  { id: 'aurora', name: 'Aurora Glass', Comp: ThemeAurora },
  { id: 'terminal', name: 'Retro Terminal', Comp: ThemeTerminal },
  { id: 'blueprint', name: 'Blueprint', Comp: ThemeBlueprint },
  { id: 'minimal', name: 'Minimal Light', Comp: ThemeMinimal },
  { id: 'neon', name: 'Neon City', Comp: ThemeNeon },
  { id: 'starfield', name: 'Orbital', Comp: ThemeStarfield },
  { id: 'matrix', name: 'Matrix Rain', Comp: ThemeMatrix },
  { id: 'sunset', name: 'Sunset', Comp: ThemeSunset },
  { id: 'brutalist', name: 'Brutalist', Comp: ThemeBrutalist },
  // 'Infra Monitor Concepts' 세션 포팅분(1b~1k)
  { id: 'boot', name: 'Terminal Boot', Comp: ThemeBoot },
  { id: 'splitpanel', name: 'Split Panel', Comp: ThemeSplitPanel },
  { id: 'radar', name: 'Radar Ops', Comp: ThemeRadar },
  { id: 'daylight', name: 'Light Console', Comp: ThemeDaylight },
  { id: 'tiles', name: 'Region Tiles', Comp: ThemeRegionTiles },
  { id: 'ultra', name: 'Ultra Minimal', Comp: ThemeUltraMinimal },
  { id: 'noc', name: 'NOC Preview', Comp: ThemeNoc },
  { id: 'rail', name: 'Left Rail', Comp: ThemeLeftRail },
  { id: 'amber', name: 'Amber Watch', Comp: ThemeAmber },
  { id: 'wall', name: 'Data Wall', Comp: ThemeDataWall },
];

/* ───────────────────────── 공통 + 테마별 CSS ───────────────────────── */
export const THEMES_CSS = `
.lt { position: fixed; inset: 0; overflow: auto; display: grid; place-items: center; padding: 40px 20px;
  box-sizing: border-box; color: var(--lt-text,#e6edf3);
  font-family: var(--lt-font, 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, 'Courier New', monospace); }
.lt * { box-sizing: border-box; }
.lt-canvas { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.lt-card { position: relative; z-index: 3; width: 100%; max-width: 420px; background: var(--lt-card, rgba(13,20,28,.93));
  border: 1px solid var(--lt-border,#223140); border-radius: var(--lt-radius,10px);
  box-shadow: var(--lt-shadow, 0 30px 90px rgba(0,0,0,.55)); backdrop-filter: var(--lt-blur, none); -webkit-backdrop-filter: var(--lt-blur, none); }
.lt-head { display: flex; justify-content: space-between; gap: 10px; padding: 12px 20px; border-bottom: 1px solid var(--lt-border,#1c2937);
  font-size: 10.5px; letter-spacing: .16em; color: var(--lt-dim,#64748b); }
.lt-head b { color: var(--lt-accent,#2dd4bf); font-weight: 400; margin-right: 6px; }
.lt-card-body { padding: 26px 26px 22px; }
.lt-title { margin: 0; font-size: 23px; font-weight: 700; color: var(--lt-title,#fff); letter-spacing: -.01em; }
.lt-sub { margin-top: 8px; font-size: 12.5px; color: var(--lt-dim,#8ea0b5); }
.lt-lab { display: block; margin: 20px 0 7px; font-size: 10.5px; letter-spacing: .22em; color: var(--lt-dim,#64748b); text-transform: uppercase; }
.lt-input { width: 100%; background: var(--lt-input,#0a1017); border: 1px solid var(--lt-border,#223140);
  border-radius: var(--lt-input-radius,6px); padding: 12px 14px; color: var(--lt-text,#e6edf3); font: inherit; font-size: 14px; }
.lt-input::placeholder { color: var(--lt-ph,#3d4e60); }
.lt-input:focus { outline: none; border-color: var(--lt-accent,#2dd4bf); box-shadow: 0 0 0 2px var(--lt-glow, rgba(45,212,191,.18)); }
.lt-pw { position: relative; }
.lt-show { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); background: none; border: none; cursor: pointer;
  font: inherit; font-size: 10.5px; letter-spacing: .16em; color: var(--lt-dim,#64748b); padding: 4px 6px; }
.lt-show:hover { color: var(--lt-accent,#2dd4bf); }
.lt-row { display: flex; justify-content: space-between; align-items: center; margin-top: 16px; gap: 10px; }
.lt-keep { display: flex; align-items: center; gap: 9px; cursor: pointer; font-size: 10.5px; letter-spacing: .14em; color: var(--lt-dim,#94a3b8); user-select: none; }
.lt-keep input { position: absolute; opacity: 0; }
.lt-check { width: 16px; height: 16px; flex: none; border: 1px solid var(--lt-accent,#2dd4bf); border-radius: 3px;
  display: flex; align-items: center; justify-content: center; font-size: 11px; color: var(--lt-accent-ink,#04120e); }
.lt-keep input:checked + .lt-check { background: var(--lt-accent,#2dd4bf); }
.lt-keep input:checked + .lt-check::after { content: '✓'; font-weight: 700; }
.lt-forgot { background: none; border: none; cursor: pointer; font: inherit; font-size: 10.5px; letter-spacing: .14em; color: var(--lt-dim,#64748b); padding: 0; }
.lt-forgot:hover { color: var(--lt-accent,#2dd4bf); }
.lt-btn { width: 100%; margin-top: 20px; padding: 14px; border: none; border-radius: var(--lt-btn-radius,6px); cursor: pointer;
  background: var(--lt-accent,#34e0b4); color: var(--lt-accent-ink,#052e25); font: inherit; font-size: 12.5px; font-weight: 700; letter-spacing: .28em; }
.lt-btn:hover:not(:disabled) { filter: brightness(1.08); }
.lt-btn:disabled { opacity: .45; cursor: default; }
.lt-restrict { margin-top: 20px; padding-top: 15px; border-top: 1px solid var(--lt-border,#1c2937);
  font-size: 10px; line-height: 1.85; letter-spacing: .03em; color: var(--lt-faint,#54657a); }
.lt-error { margin-top: 13px; font-size: 12px; color: #f87171; line-height: 1.6; }
.lt-notice { margin-top: 12px; font-size: 12px; color: #fbbf24; line-height: 1.6; }
.lt-welcome { margin-top: 12px; font-size: 12px; color: var(--lt-accent,#2dd4bf); }
.lt-hint { margin-top: 10px; font-size: 11px; color: var(--lt-dim,#64748b); line-height: 1.7; }
.lt-reshuffle { position: fixed; z-index: 6; right: 16px; bottom: 14px; background: rgba(0,0,0,.4);
  border: 1px solid rgba(255,255,255,.16); color: #cbd5e1; border-radius: 20px; padding: 7px 15px;
  font-size: 11px; letter-spacing: .1em; cursor: pointer; font-family: 'JetBrains Mono', monospace; }
.lt-reshuffle:hover { border-color: #94a3b8; color: #fff; }

/* ── 1) Davinci: 좌 히어로 + 우 카드 + 도트맵 ── */
.lt-davinci { --lt-card: rgba(13,20,28,.93); --lt-accent: #34e0b4; --lt-accent-ink: #052e25; --lt-glow: rgba(45,212,191,.15);
  display: block; background: #0a0e15; }
.lt-split .dv-map { position: absolute; inset: 0; pointer-events: none; }
.lt-split .dv-map canvas { display: block; }
.lt-split::after { content: ''; position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(ellipse at 30% 40%, transparent 40%, rgba(5,8,13,.55) 100%); }
.dv-marker { position: absolute; transform: translate(-50%,-50%); }
.dv-marker-dot { position: absolute; left: -3px; top: -3px; width: 6px; height: 6px; border-radius: 50%; background: #2dd4bf; box-shadow: 0 0 10px 2px rgba(45,212,191,.7); }
.dv-marker-ring { position: absolute; left: -11px; top: -11px; width: 22px; height: 22px; border-radius: 50%; border: 1px solid rgba(45,212,191,.55); animation: dvPulse 2.6s ease-out infinite; }
.dv-marker-label { position: absolute; left: 12px; top: -7px; font-size: 10px; letter-spacing: .12em; color: #9fb6c9; }
@keyframes dvPulse { 0% { transform: scale(.5); opacity: .9; } 100% { transform: scale(1.9); opacity: 0; } }
.lt-topbar { position: relative; z-index: 2; display: flex; justify-content: space-between; align-items: flex-start; padding: 26px 40px 0; }
.lt-brand { display: flex; gap: 14px; align-items: center; }
.lt-logo { width: 40px; height: 40px; border: 1px solid rgba(45,212,191,.55); border-radius: 9px; display: flex; align-items: center; justify-content: center; }
.lt-logo i { width: 12px; height: 12px; background: #2dd4bf; transform: rotate(45deg); border-radius: 2px; box-shadow: 0 0 12px rgba(45,212,191,.8); }
.lt-brand-title { font-size: 14px; font-weight: 700; letter-spacing: .38em; color: #fff; }
.lt-brand-sub { margin-top: 4px; font-size: 9.5px; letter-spacing: .32em; color: #5b6b7f; }
.lt-netstat { font-size: 10.5px; letter-spacing: .25em; color: #5b6b7f; display: flex; align-items: center; gap: 8px; padding-top: 6px; }
.lt-netstat i { width: 7px; height: 7px; border-radius: 50%; background: #2dd4bf; box-shadow: 0 0 8px rgba(45,212,191,.8); }
.lt-split-main { position: relative; z-index: 2; display: flex; align-items: center; gap: 64px; max-width: 1560px;
  margin: 0 auto; padding: 60px 56px 56px; min-height: calc(100vh - 92px); }
.lt-split .lt-hero { flex: 1; min-width: 0; }
.lt-hero-label { font-size: 11.5px; letter-spacing: .3em; color: #8ea0b5; }
.lt-hero-label b { color: #2dd4bf; margin-right: 10px; font-weight: 400; }
.lt-hero h1 { margin: 26px 0 0; font-size: clamp(38px,4.6vw,62px); font-weight: 700; line-height: 1.18; letter-spacing: -.01em; color: #fff; }
.lt-hero p { margin: 26px 0 0; max-width: 480px; font-size: 14.5px; line-height: 1.85; color: #8ea0b5; }
.lt-split .lt-card { width: 430px; flex: none; }
@media (max-width: 1080px) { .lt-split-main { flex-direction: column; align-items: stretch; gap: 36px; padding: 40px 22px; }
  .lt-split .lt-card { width: 100%; max-width: 460px; margin: 0 auto; } .lt-hero p { max-width: none; } }

/* ── 2) Aurora glass ── */
.lt-aurora { --lt-font: 'Inter', system-ui, sans-serif; --lt-accent: #c084fc; --lt-accent-ink: #1a0733; --lt-glow: rgba(192,132,252,.25);
  --lt-card: rgba(30,22,48,.55); --lt-border: rgba(192,132,252,.28); --lt-input: rgba(10,6,20,.5); --lt-blur: blur(14px);
  --lt-radius: 18px; --lt-title: #f5edff; --lt-text: #ede9fe; --lt-dim: #b9a9d9; --lt-shadow: 0 30px 90px rgba(60,20,110,.5); background: #120a1f; }
.lt-aurora-bg { position: absolute; inset: -20%; filter: blur(70px); opacity: .8;
  background: radial-gradient(40% 40% at 25% 30%, #7c3aed 0%, transparent 60%),
    radial-gradient(45% 45% at 78% 28%, #db2777 0%, transparent 60%),
    radial-gradient(50% 50% at 60% 85%, #2563eb 0%, transparent 60%); animation: auFloat 16s ease-in-out infinite alternate; }
@keyframes auFloat { 0% { transform: translate(-4%,-3%) scale(1); } 100% { transform: translate(5%,4%) scale(1.12); } }

/* ── 3) Retro terminal (CRT) ── */
.lt-terminal { --lt-accent: #33ff77; --lt-accent-ink: #00160a; --lt-glow: rgba(51,255,119,.25); --lt-card: rgba(0,14,6,.9);
  --lt-border: #12401f; --lt-input: #00160a; --lt-text: #7dffa8; --lt-title: #b8ffcf; --lt-dim: #3f9d63; --lt-faint: #2f7a4c;
  --lt-radius: 4px; --lt-input-radius: 2px; --lt-btn-radius: 2px; background: #000308; }
.lt-terminal .lt-card { box-shadow: 0 0 40px rgba(51,255,119,.12), inset 0 0 60px rgba(51,255,119,.04); }
.lt-terminal .lt-title { text-shadow: 0 0 12px rgba(51,255,119,.5); }
.lt-scan { position: absolute; inset: 0; pointer-events: none; opacity: .5;
  background: repeating-linear-gradient(rgba(51,255,119,.05) 0 1px, transparent 1px 3px); }

/* ── 4) Blueprint grid ── */
.lt-blueprint { --lt-accent: #38bdf8; --lt-accent-ink: #04121f; --lt-glow: rgba(56,189,248,.22); --lt-card: rgba(9,25,48,.92);
  --lt-border: #1e456f; --lt-input: rgba(5,16,32,.8); --lt-text: #dbeafe; --lt-title: #eaf4ff; --lt-dim: #7fa8d0; --lt-radius: 6px;
  background: #081a34; }
.lt-grid { position: absolute; inset: 0;
  background-image: linear-gradient(rgba(56,189,248,.10) 1px, transparent 1px), linear-gradient(90deg, rgba(56,189,248,.10) 1px, transparent 1px);
  background-size: 26px 26px; mask-image: radial-gradient(ellipse at center, #000 55%, transparent 100%); }

/* ── 5) Minimal light (corporate) ── */
.lt-minimal { --lt-font: 'Inter', system-ui, sans-serif; --lt-accent: #2563eb; --lt-accent-ink: #fff; --lt-glow: rgba(37,99,235,.15);
  --lt-card: #ffffff; --lt-border: #e2e8f0; --lt-input: #f8fafc; --lt-text: #0f172a; --lt-title: #0f172a; --lt-dim: #64748b; --lt-faint: #94a3b8;
  --lt-ph: #94a3b8; --lt-radius: 14px; --lt-shadow: 0 20px 60px rgba(15,23,42,.12); background: #eef2f7; }
.lt-minimal .lt-head { color: #475569; }
.lt-mini-brand { font-weight: 700; letter-spacing: .16em; color: #2563eb; }

/* ── 6) Neon cyberpunk ── */
.lt-neon { --lt-accent: #ff2bd6; --lt-accent-ink: #1a0016; --lt-glow: rgba(255,43,214,.3); --lt-card: rgba(14,4,24,.82);
  --lt-border: rgba(255,43,214,.4); --lt-input: rgba(5,1,10,.7); --lt-text: #f5d0ff; --lt-title: #fff; --lt-dim: #b98ecf; --lt-radius: 8px;
  background: #05010a; overflow: hidden; }
.lt-neon .lt-card { box-shadow: 0 0 30px rgba(255,43,214,.25), 0 0 60px rgba(34,211,238,.12); }
.lt-neon::before { content: ''; position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(55% 40% at 50% 100%, rgba(255,43,214,.22), transparent 70%),
    radial-gradient(40% 30% at 20% 0%, rgba(34,211,238,.14), transparent 70%); }
.lt-neon-floor { position: absolute; left: -30%; right: -30%; bottom: 0; height: 55%; pointer-events: none;
  background-image: linear-gradient(rgba(34,211,238,.9) 2px, transparent 2px), linear-gradient(90deg, rgba(255,43,214,.8) 2px, transparent 2px);
  background-size: 46px 46px; transform: perspective(340px) rotateX(60deg); transform-origin: 50% 100%;
  mask-image: linear-gradient(transparent 0%, #000 45%); opacity: .55; }

/* ── 7) Orbital starfield ── */
.lt-star { --lt-font: 'Inter', system-ui, sans-serif; --lt-accent: #818cf8; --lt-accent-ink: #0b1030; --lt-glow: rgba(129,140,248,.28);
  --lt-card: rgba(15,20,42,.68); --lt-border: rgba(129,140,248,.3); --lt-input: rgba(8,10,25,.6); --lt-blur: blur(10px);
  --lt-text: #e0e7ff; --lt-title: #fff; --lt-dim: #a5b4d6; --lt-radius: 16px;
  background: radial-gradient(ellipse at 50% 20%, #1e2a5a 0%, #070a18 60%); }

/* ── 8) Matrix rain ── */
.lt-matrix { --lt-accent: #22c55e; --lt-accent-ink: #04120a; --lt-glow: rgba(34,197,94,.25); --lt-card: rgba(0,12,4,.8);
  --lt-border: #0f3d22; --lt-input: rgba(0,20,8,.7); --lt-text: #9bf6c0; --lt-title: #d6ffe6; --lt-dim: #3f9d63; --lt-faint: #2f7a4c;
  --lt-radius: 4px; background: #000; }
.lt-matrix .lt-card { box-shadow: 0 0 40px rgba(34,197,94,.14); }

/* ── 9) Sunset gradient ── */
.lt-sunset { --lt-font: 'Inter', system-ui, sans-serif; --lt-accent: #fb923c; --lt-accent-ink: #3a1600; --lt-glow: rgba(251,146,60,.28);
  --lt-card: rgba(40,20,32,.5); --lt-border: rgba(255,190,150,.28); --lt-input: rgba(20,10,16,.42); --lt-blur: blur(12px);
  --lt-text: #ffe8d6; --lt-title: #fff; --lt-dim: #e6b6a2; --lt-radius: 18px; --lt-shadow: 0 30px 90px rgba(120,40,60,.4); background: #2a1020; }
.lt-sunset-bg { position: absolute; inset: 0; background: linear-gradient(135deg, #f97316 0%, #db2777 42%, #7c3aed 100%); opacity: .85; }
.lt-sunset-bg::after { content: ''; position: absolute; inset: 0; background: radial-gradient(60% 50% at 70% 15%, rgba(255,220,120,.6), transparent 60%); }

/* ── 10) Brutalist mono ── */
.lt-brutal { --lt-font: 'Inter', system-ui, sans-serif; --lt-accent: #ef4444; --lt-accent-ink: #fff; --lt-glow: rgba(239,68,68,.2);
  --lt-card: #ffffff; --lt-border: #111111; --lt-input: #fff; --lt-text: #111; --lt-title: #111; --lt-dim: #555; --lt-faint: #777;
  --lt-ph: #999; --lt-radius: 0; --lt-input-radius: 0; --lt-btn-radius: 0; --lt-shadow: 10px 10px 0 #111; background: #f5f5f0; }
.lt-brutal .lt-card { border-width: 2px; }
.lt-brutal .lt-head { border-bottom-width: 2px; font-weight: 700; color: #111; }
.lt-brutal .lt-title { font-size: 30px; font-weight: 800; letter-spacing: -.02em; }
.lt-brutal .lt-input { border-width: 2px; }
.lt-brutal .lt-btn { border: 2px solid #111; }

/* ═══ 'Infra Monitor Concepts' 세션 포팅분 (1b~1k) ═══ */
/* 공용: 좌 히어로 + 우 카드 분할 레이아웃(1e·1j 등) */
.lt-hero-split { display: block; padding: 0; }
.lt-hero-split .hs-main { position: relative; z-index: 2; display: flex; align-items: center; gap: 64px;
  max-width: 1560px; margin: 0 auto; padding: 60px 56px; min-height: calc(100vh - 110px); }
.lt-hero-split .hs-hero { flex: 1; min-width: 0; }
.lt-hero-split .hs-hero h1 { margin: 26px 0 0; font-size: clamp(36px, 4.3vw, 62px); font-weight: 700; line-height: 1.16; letter-spacing: -.02em; }
.lt-hero-split .hs-hero p { margin: 26px 0 0; max-width: 540px; font-size: 15px; line-height: 1.9; }
.lt-hero-split .lt-card { width: 440px; flex: none; }
@media (max-width: 1080px) { .lt-hero-split .hs-main { flex-direction: column; align-items: stretch; gap: 36px; padding: 32px 22px; }
  .lt-hero-split .lt-card { width: 100%; max-width: 460px; margin: 0 auto; } }

/* ── 11) 1b Terminal Boot ── */
.lt-boot { --lt-font: 'IBM Plex Mono', ui-monospace, monospace; --lt-accent: #39d3b8; --lt-accent-ink: #03110d; --lt-glow: rgba(57,211,184,.2);
  --lt-card: #070d0b; --lt-border: #1b3d36; --lt-input: #060b09; --lt-text: #c9e8df; --lt-title: #e6f5f0; --lt-dim: #2e6b5f; --lt-faint: #2e6b5f;
  --lt-ph: #3d5f57; --lt-radius: 2px; --lt-input-radius: 2px; --lt-btn-radius: 2px; background: #050807; }
.lt-boot .lt-scan { position: absolute; inset: 0; pointer-events: none; opacity: .6;
  background: repeating-linear-gradient(rgba(255,255,255,.02) 0 1px, transparent 1px 4px); }
.boot-log { position: absolute; top: 44px; left: 56px; right: 24px; color: #2e6b5f; font: 400 13px/2 'IBM Plex Mono', monospace; pointer-events: none; }
.boot-log .boot-auth { color: #39d3b8; }
.boot-tty { display: flex; align-items: center; gap: 8px; padding: 13px 20px; border-bottom: 1px solid #122b26; }
.boot-tty i { width: 10px; height: 10px; border-radius: 50%; background: #1b3d36; }
.boot-tty span { color: #39d3b8; font-size: 11px; letter-spacing: .3em; margin-left: 10px; }
.boot-tty em { margin-left: auto; color: #2e6b5f; font-size: 11px; font-style: normal; }
.boot-status { position: absolute; left: 0; right: 0; bottom: 0; border-top: 1px solid #122b26; padding: 15px 56px;
  display: flex; gap: 48px; color: #2e6b5f; font-size: 12px; letter-spacing: .15em; pointer-events: none; }
@media (max-width: 900px) { .boot-log { position: static; padding: 20px 22px 0; } .boot-status { display: none; } }

/* ── 12) 1c Split Panel ── */
.lt-splitp { --lt-accent: #39d3b8; --lt-accent-ink: #04231c; --lt-glow: rgba(57,211,184,.16); --lt-card: transparent;
  --lt-border: #22383f; --lt-input: transparent; --lt-text: #c9dedd; --lt-title: #eef7f4; --lt-dim: #5f8489; --lt-faint: #4a6b70;
  --lt-ph: #4a6b70; --lt-shadow: none; display: flex; place-items: stretch; padding: 0; background: #0c1219; }
.lt-splitp .sp-left { width: 46%; background: #101c26; border-right: 1px solid #1c2f3a; padding: 56px 64px;
  display: flex; flex-direction: column; min-height: 100vh; box-sizing: border-box; }
.sp-brand { display: flex; gap: 14px; align-items: center; color: #e8f4f1; font-weight: 800; letter-spacing: .32em; font-size: 15px; }
.sp-brand i { width: 38px; height: 38px; border-radius: 8px; background: #39d3b8; position: relative; }
.sp-brand i::after { content: ''; position: absolute; inset: 0; margin: auto; width: 12px; height: 12px; background: #0c1219; transform: rotate(45deg); }
.sp-big { color: #f2f8f6; font: 700 clamp(34px, 3.4vw, 58px)/1.2 'Inter', system-ui, sans-serif; letter-spacing: -.02em; margin-top: 9vh; }
.sp-desc { color: #84a3ac; font: 400 16px/1.9 'Inter', system-ui, sans-serif; margin-top: 24px; max-width: 520px; }
.sp-stats { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 1px; background: #1c2f3a; border: 1px solid #1c2f3a; margin-top: 7vh; }
.sp-stats > div { background: #101c26; padding: 20px; }
.sp-stats b { display: block; color: #39d3b8; font-size: 30px; font-weight: 700; }
.sp-stats span { display: block; color: #5c7d86; font-size: 10px; letter-spacing: .25em; margin-top: 8px; }
.sp-ticker { margin-top: auto; display: grid; gap: 10px; color: #496670; font-size: 12.5px; padding-top: 30px; }
.sp-ticker b { color: #39d3b8; font-weight: 400; margin-right: 6px; }
.lt-splitp .sp-right { flex: 1; display: grid; place-items: center; padding: 40px 24px;
  background-image: radial-gradient(circle, rgba(120,170,185,.12) 1.5px, transparent 1.5px); background-size: 22px 22px; }
.lt-splitp .lt-card { border: none; max-width: 460px; }
.lt-splitp .lt-card-body { padding: 0 10px; }
.lt-splitp .lt-input { border: none; border-bottom: 2px solid #22383f; border-radius: 0; padding: 14px 2px; }
.lt-splitp .lt-input:focus { box-shadow: none; border-bottom-color: #39d3b8; }
.lt-splitp .lt-head { border: none; padding: 0 10px 8px; }
.lt-splitp .lt-restrict { border-top-color: #1c2f3a; }
@media (max-width: 1080px) { .lt-splitp { flex-direction: column; } .lt-splitp .sp-left { width: 100%; min-height: 0; padding: 32px 26px; }
  .sp-big { margin-top: 26px; } .sp-stats { margin-top: 30px; } .sp-ticker { display: none; } .lt-splitp .sp-right { padding: 32px 20px; } }

/* ── 13) 1d Radar Ops ── */
.lt-radar { --lt-accent: #39d3b8; --lt-accent-ink: #04231c; --lt-glow: rgba(57,211,184,.2); --lt-card: rgba(7,12,16,.9);
  --lt-border: #1a3a35; --lt-input: #0a1216; --lt-text: #c9dedd; --lt-title: #eef7f4; --lt-dim: #6f9298; --lt-faint: #48666c;
  --lt-ph: #48666c; --lt-radius: 12px; --lt-input-radius: 8px; --lt-btn-radius: 8px; --lt-blur: blur(8px); background: #070b10; overflow: hidden; }
.rd-topbar { position: absolute; top: 0; left: 0; right: 0; display: flex; justify-content: space-between; padding: 30px 44px;
  color: #5c7d86; font-size: 11px; letter-spacing: .3em; pointer-events: none; }
.rd-topbar span:first-child { color: #e8f4f1; font-weight: 800; letter-spacing: .4em; }
.rd-topbar b { color: #39d3b8; font-weight: 400; }
.rd-ring { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); border-radius: 50%; pointer-events: none; }
.rd-ring.r1 { width: min(110vmin, 1100px); height: min(110vmin, 1100px); border: 1px solid rgba(57,211,184,.12); }
.rd-ring.r2 { width: min(80vmin, 800px); height: min(80vmin, 800px); border: 1px solid rgba(57,211,184,.18); }
.rd-ring.r3 { width: min(50vmin, 500px); height: min(50vmin, 500px); border: 1px solid rgba(57,211,184,.25); }
.rd-sweep { position: absolute; top: 50%; left: 50%; width: min(110vmin, 1100px); height: min(110vmin, 1100px);
  transform: translate(-50%,-50%); border-radius: 50%; pointer-events: none;
  background: conic-gradient(from 0deg, rgba(57,211,184,.22), transparent 70deg); animation: rdSweep 8s linear infinite; }
@keyframes rdSweep { from { transform: translate(-50%,-50%) rotate(0); } to { transform: translate(-50%,-50%) rotate(360deg); } }
.rd-blip { position: absolute; width: 6px; height: 6px; border-radius: 50%; background: #39d3b8; animation: rdBlink 3s infinite; pointer-events: none; }
.rd-blip.amber { background: #e8b84a; }
@keyframes rdBlink { 0%,100% { opacity: 1; } 50% { opacity: .15; } }
.rd-icon { width: 56px; height: 56px; margin: 26px auto 0; border-radius: 50%; border: 1px solid #39d3b8;
  display: flex; align-items: center; justify-content: center; color: #39d3b8; font-size: 22px; }
.lt-radar .lt-title, .lt-radar .lt-sub { text-align: center; }

/* ── 14) 1e Light Console (Daylight) ── */
.lt-daylight { --lt-font: 'Inter', system-ui, sans-serif; --lt-accent: #0d3b33; --lt-accent-ink: #d8f5ec; --lt-glow: rgba(13,159,130,.18);
  --lt-card: #ffffff; --lt-border: #dde5e2; --lt-input: #fff; --lt-text: #12211e; --lt-title: #101d1a; --lt-dim: #6e8681; --lt-faint: #8fa5a0;
  --lt-ph: #9db1ac; --lt-radius: 14px; --lt-input-radius: 8px; --lt-btn-radius: 8px; --lt-shadow: 0 20px 50px rgba(13,59,51,.08);
  background: #f4f6f5; background-image: radial-gradient(circle, rgba(20,60,55,.1) 1.5px, transparent 1.5px); background-size: 22px 22px;
  color: #101d1a; }
.dl-topbar { display: flex; justify-content: space-between; align-items: center; padding: 26px 48px;
  border-bottom: 1px solid #dde5e2; background: rgba(244,246,245,.9); }
.dl-brand { display: flex; gap: 14px; align-items: center; }
.dl-brand i { width: 40px; height: 40px; border-radius: 9px; background: #0d3b33; display: flex; align-items: center; justify-content: center; }
.dl-brand i b { width: 12px; height: 12px; background: #2fd0ae; transform: rotate(45deg); border-radius: 2px; }
.dl-brand .t { color: #12211e; font-weight: 800; letter-spacing: .32em; font-size: 14px; font-family: 'JetBrains Mono', monospace; }
.dl-brand .s { color: #6e8681; font-size: 9px; letter-spacing: .26em; margin-top: 4px; font-family: 'JetBrains Mono', monospace; }
.dl-net { display: flex; gap: 10px; align-items: center; color: #3e5b55; font-size: 11px; letter-spacing: .22em; font-family: 'JetBrains Mono', monospace; }
.dl-net i { width: 8px; height: 8px; border-radius: 50%; background: #0d9f82; }
.dl-label { color: #0d7a66; font-size: 12px; letter-spacing: .35em; font-family: 'JetBrains Mono', monospace; }
.lt-daylight .hs-hero h1 { color: #101d1a; }
.lt-daylight .hs-hero p { color: #4e6a64; }
.dl-kpis { display: flex; gap: 34px; margin-top: 48px; color: #3e5b55; font-size: 12px; font-family: 'JetBrains Mono', monospace; flex-wrap: wrap; }

/* ── 15) 1f Region Tiles ── */
.lt-tiles { --lt-accent: #39d3b8; --lt-accent-ink: #04231c; --lt-glow: rgba(57,211,184,.18); --lt-card: #0e161d;
  --lt-border: #223842; --lt-input: #0a1116; --lt-text: #c9dedd; --lt-title: #eef7f4; --lt-dim: #7d9ba0; --lt-faint: #5f8489;
  --lt-ph: #48666c; --lt-radius: 14px; --lt-input-radius: 8px; --lt-btn-radius: 8px; --lt-shadow: 0 40px 100px rgba(0,0,0,.7);
  background: #0a0e13; overflow: hidden; }
.tw-wall { position: absolute; inset: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  grid-auto-rows: 150px; gap: 1px; background: #141d26; filter: brightness(.55); pointer-events: none; }
.tw-tile { background: #0d141b; padding: 18px 20px; display: flex; flex-direction: column; justify-content: space-between; }
.tw-head { display: flex; justify-content: space-between; color: #6f9298; font-size: 12px; letter-spacing: .15em; font-weight: 600; }
.tw-val { color: #c9dedd; font-size: 22px; font-weight: 700; }
.tw-lab { color: #48666c; font-size: 9px; letter-spacing: .2em; margin-top: 5px; }
.tw-vignette { position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(ellipse 50% 60% at 50% 50%, rgba(10,14,19,.35), rgba(10,14,19,.92)); }
.tw-brand { display: flex; gap: 12px; align-items: center; padding: 24px 26px 0; color: #e8f4f1; font-weight: 800; letter-spacing: .32em; font-size: 13px; }
.tw-brand i { width: 34px; height: 34px; border-radius: 8px; background: #39d3b8; position: relative; flex: none; }
.tw-brand i::after { content: ''; position: absolute; inset: 0; margin: auto; width: 10px; height: 10px; background: #0a0e13; transform: rotate(45deg); }

/* ── 16) 1g Ultra Minimal ── */
.lt-ultra { --lt-accent: #39d3b8; --lt-accent-ink: #04231c; --lt-glow: rgba(57,211,184,.14); --lt-card: transparent;
  --lt-border: #1e2c32; --lt-input: transparent; --lt-text: #c7d8d5; --lt-title: #eef4f2; --lt-dim: #3d5158; --lt-faint: #31454d;
  --lt-ph: #3d5158; --lt-shadow: none; background: #07090b; }
.um-topbar { position: absolute; top: 0; left: 0; right: 0; display: flex; justify-content: space-between; padding: 32px 52px;
  color: #3d5158; font-size: 11px; letter-spacing: .4em; pointer-events: none; }
.um-topbar span:first-child { color: #c7d8d5; }
.um-topbar b { color: #39d3b8; font-weight: 400; }
.um-gem { position: absolute; top: calc(50% - 300px); left: 50%; width: 10px; height: 10px; background: #39d3b8;
  transform: translateX(-50%) rotate(45deg); animation: umPulse 2.5s infinite; }
@keyframes umPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(57,211,184,.5); } 50% { box-shadow: 0 0 0 10px rgba(57,211,184,0); } }
.lt-ultra .lt-card { border: none; max-width: 430px; }
.lt-ultra .lt-title { text-align: center; font-weight: 500; letter-spacing: -.01em; }
.lt-ultra .lt-sub { text-align: center; }
.lt-ultra .lt-input { border: none; border-bottom: 1px solid #1e2c32; border-radius: 0; padding: 12px 0; }
.lt-ultra .lt-input:focus { box-shadow: none; border-bottom-color: #39d3b8; }
.lt-ultra .lt-btn { background: transparent; border: 1px solid #39d3b8; color: #39d3b8; letter-spacing: .45em; }
.lt-ultra .lt-btn:hover:not(:disabled) { background: #39d3b8; color: #04231c; filter: none; }
.lt-ultra .lt-restrict { border-top-color: #131c21; text-align: center; }
.um-ticker { position: absolute; left: 0; right: 0; bottom: 0; border-top: 1px solid #131c21; padding: 14px 0;
  overflow: hidden; white-space: nowrap; pointer-events: none; }
.um-ticker > div { display: inline-flex; gap: 70px; color: #31454d; font-size: 12px; animation: umTicker 30s linear infinite; padding-right: 70px; }
@keyframes umTicker { from { transform: translateX(0); } to { transform: translateX(-50%); } }

/* ── 17) 1h NOC Preview ── */
.lt-noc { --lt-accent: #2fbfa6; --lt-accent-ink: #04231c; --lt-glow: rgba(47,191,166,.2); --lt-card: rgba(10,15,20,.96);
  --lt-border: #1c3038; --lt-input: #0a1116; --lt-text: #c9dedd; --lt-title: #eef7f4; --lt-dim: #7d9ba0; --lt-faint: #48666c;
  --lt-ph: #48666c; --lt-radius: 0; --lt-input-radius: 8px; --lt-btn-radius: 8px; --lt-shadow: none;
  background: #0b1016; overflow: hidden; place-items: stretch end; padding: 0; }
.noc-wall { position: absolute; inset: 0; padding: 44px; display: grid; grid-template-columns: repeat(3, 1fr);
  grid-template-rows: 1fr 1fr; gap: 20px; filter: blur(3px) brightness(.6); pointer-events: none; }
.noc-chart { background: #101823; border: 1px solid #1c2a38; border-radius: 10px; padding: 22px; display: flex; flex-direction: column; }
.noc-title { color: #6f8fa0; font-size: 11px; letter-spacing: .25em; font-weight: 600; }
.noc-bars { flex: 1; display: flex; align-items: flex-end; gap: 9px; margin-top: 18px; }
.noc-bars i { flex: 1; background: linear-gradient(180deg, #2fbfa6, #155f52); border-radius: 3px 3px 0 0; }
.lt-noc .noc-panel { position: relative; margin-left: auto; width: min(520px, 100%); min-height: 100vh; max-width: none;
  border-top: none; border-bottom: none; border-right: none; border-left: 1px solid #1c3038; backdrop-filter: blur(10px);
  display: flex; flex-direction: column; justify-content: center; box-sizing: border-box; }
.lt-noc .lt-btn { background: linear-gradient(180deg, #2fbfa6, #1e9a85); }
@media (max-width: 900px) { .lt-noc .noc-panel { width: 100%; border-left: none; } }

/* ── 18) 1i Left Rail ── */
.lt-rail { --lt-accent: #39d3b8; --lt-accent-ink: #04231c; --lt-glow: rgba(57,211,184,.18); --lt-card: #0d151d;
  --lt-border: #1b2b35; --lt-input: #0a1116; --lt-text: #c9dedd; --lt-title: #eef7f4; --lt-dim: #5f8489; --lt-faint: #42606a;
  --lt-ph: #48666c; --lt-radius: 0; --lt-input-radius: 6px; --lt-btn-radius: 6px; --lt-shadow: none;
  display: flex; place-items: stretch; padding: 0; background: #0a1017; }
.lt-rail .rail-card { width: 440px; flex: none; max-width: none; min-height: 100vh; border-top: none; border-left: none; border-bottom: none;
  border-right: 1px solid #1b2b35; display: flex; flex-direction: column; justify-content: center; box-sizing: border-box; }
.rail-brand { padding: 26px 26px 0; color: #e8f4f1; font-weight: 800; letter-spacing: .35em; font-size: 14px; }
.rail-map { flex: 1; position: relative; overflow: hidden; min-height: 40vh;
  background-image: radial-gradient(circle, rgba(120,170,185,.13) 1.5px, transparent 1.5px); background-size: 20px 20px; }
.rail-map::after { content: ''; position: absolute; inset: 0; background: radial-gradient(ellipse 70% 60% at 50% 45%, transparent, rgba(10,16,23,.9)); }
.rail-map svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.rail-topline { position: absolute; top: 30px; right: 40px; z-index: 2; color: #5c7d86; font-size: 11px; letter-spacing: .25em; }
.rail-topline b { color: #39d3b8; font-weight: 400; }
.rail-topline em { color: #e8b84a; font-style: normal; }
.rail-log { position: absolute; bottom: 30px; left: 40px; z-index: 2; display: grid; gap: 9px; color: #4a6b70; font-size: 12px; }
@media (max-width: 1080px) { .lt-rail { flex-direction: column; } .lt-rail .rail-card { width: 100%; min-height: 0; border-right: none; border-bottom: 1px solid #1b2b35; }
  .rail-map { min-height: 340px; } }

/* ── 19) 1j Amber Watch ── */
.lt-amber { --lt-font: 'IBM Plex Mono', ui-monospace, monospace; --lt-accent: #e8a64a; --lt-accent-ink: #1a1004; --lt-glow: rgba(232,166,74,.2);
  --lt-card: rgba(18,13,7,.92); --lt-border: #3d2c14; --lt-input: #0e0a05; --lt-text: #f0d9b0; --lt-title: #f5e3c2; --lt-dim: #8a6a3d; --lt-faint: #6e5530;
  --lt-ph: #6e5530; --lt-radius: 8px; --lt-input-radius: 6px; --lt-btn-radius: 6px;
  background: #0c0906; background-image: radial-gradient(circle, rgba(232,166,74,.1) 1.5px, transparent 1.5px); background-size: 20px 20px; }
.lt-amber .lt-scan { position: absolute; inset: 0; pointer-events: none;
  background: repeating-linear-gradient(0deg, rgba(0,0,0,.16) 0 2px, transparent 2px 5px); }
.am-topbar { position: relative; z-index: 2; display: flex; justify-content: space-between; padding: 28px 48px 0;
  color: #8a6a3d; font-size: 11px; letter-spacing: .3em; }
.am-topbar span:first-child { color: #f0d9b0; font-weight: 700; letter-spacing: .4em; }
.am-topbar b { color: #e8a64a; font-weight: 400; }
.am-label { color: #e8a64a; font-size: 12px; letter-spacing: .45em; }
.lt-amber .hs-hero h1 { color: #f5e3c2; }
.lt-amber .hs-hero p { color: #a5834f; }
.am-log { margin-top: 48px; display: grid; gap: 9px; color: #6e5530; font-size: 13px; }

/* ── 20) 1k Data Wall ── */
.lt-wall { --lt-accent: #2fbfa6; --lt-accent-ink: #04231c; --lt-glow: rgba(47,191,166,.2); --lt-card: transparent;
  --lt-border: #22333d; --lt-input: #0a1116; --lt-text: #c9dedd; --lt-title: #eef7f4; --lt-dim: #5f8489; --lt-faint: #48666c;
  --lt-ph: #48666c; --lt-radius: 0; --lt-input-radius: 8px; --lt-btn-radius: 8px; --lt-shadow: none;
  display: block; padding: 0; background: #080c11; }
.dw-topbar { display: flex; justify-content: space-between; align-items: center; padding: 24px 48px;
  border-bottom: 1px solid #16222c; flex-wrap: wrap; gap: 10px; }
.dw-brand { color: #e8f4f1; font-weight: 800; letter-spacing: .4em; font-size: 14px; }
.dw-stats { color: #5c7d86; font-size: 11.5px; letter-spacing: .12em; white-space: nowrap; }
.dw-stats b { color: #c9dedd; font-weight: 600; }
.dw-stats em { color: #39d3b8; font-style: normal; }
.dw-main { display: flex; min-height: calc(100vh - 75px); }
.dw-hero { flex: 1; border-right: 1px solid #16222c; padding: 6vh 64px; display: flex; flex-direction: column; justify-content: center; }
.dw-big { color: #f2f8f6; font-size: clamp(56px, 6.5vw, 100px); font-weight: 700; letter-spacing: -.03em; line-height: 1.05; }
.dw-big b { color: #39d3b8; }
.dw-sub { color: #5c7d86; font-size: 13px; letter-spacing: .3em; margin-top: 18px; }
.dw-days { display: grid; grid-template-columns: repeat(31, 1fr); gap: 4px; margin-top: 44px; max-width: 640px; }
.dw-days i { height: 40px; border-radius: 2px; }
.dw-legend { color: #42606a; font-size: 12px; margin-top: 18px; }
.dw-log { margin-top: 6vh; display: grid; gap: 10px; color: #4a6b70; font-size: 13px; }
.lt-wall .lt-card { width: min(560px, 46%); flex: none; max-width: none; border: none; display: flex; flex-direction: column; justify-content: center; }
.lt-wall .lt-btn { background: linear-gradient(180deg, #2fbfa6, #1e9a85); }
@media (max-width: 1080px) { .dw-main { flex-direction: column; } .dw-hero { border-right: none; border-bottom: 1px solid #16222c; padding: 32px 26px; }
  .dw-log { display: none; } .lt-wall .lt-card { width: 100%; } }
`;
