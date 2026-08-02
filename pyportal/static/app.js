/* 글로벌 데이터센터 서비스 허브 — 프런트엔드(프레임워크·번들러·차트 라이브러리 없음)
 *
 * 규칙 1: 사용자 입력(이름/URL/설명/태그)은 전부 textContent 로만 넣는다.
 *         innerHTML 로 조립하면 바로가기 이름 한 줄로 XSS 가 열린다.
 * 규칙 2: 설정 관련 API 는 전부 X-Settings-Token 헤더가 필요하다. 401 이 오면
 *         조용히 실패하지 말고 로그인 모달을 띄운다.
 */
(function () {
  "use strict";

  var HUB_TOKEN_KEY = "hub_token";
  var SETTINGS_TOKEN_KEY = "hub_settings_token";
  var TABS = ["dashboard", "datacenters", "health", "settings"];
  var SETTINGS_PANES = ["shortcuts", "datacenters", "users", "backup"];

  var SETTINGS_META = {
    shortcuts: { title: "바로가기 관리", desc: "이름과 URL만 입력하면 대시보드에 바로가기가 생성됩니다." },
    datacenters: { title: "데이터센터 구성", desc: "사이트 목록·좌표·랙 수·상태를 직접 관리합니다. 지도와 통계에 즉시 반영됩니다." },
    users: { title: "사용자 구성 및 설정", desc: "설정 화면에 들어올 수 있는 계정과 역할을 관리합니다." },
    backup: { title: "현재 설정 백업", desc: "설정 파일 스냅샷을 만들고, 주기와 보관 수량을 정합니다." }
  };

  var CATEGORY_CLASS = {
    "Monitoring & Metrics": "cat-monitoring",
    "Infrastructure & DCIM": "cat-infra",
    "Network & Traffic": "cat-network",
    "Security & IAM": "cat-security",
    "Incidents & Operations": "cat-incident",
    "Storage & Backup": "cat-storage",
    "Custom Shortcuts": "cat-custom"
  };

  var REGION_COLOR = { APAC: "#38bdf8", EMEA: "#34d399", AMER: "#a78bfa", LATAM: "#fbbf24" };
  var HEALTH_LABEL = { healthy: "정상", warning: "확인 필요", unreachable: "응답 없음", blocked: "차단됨" };
  var STATUS_LABEL = { operational: "정상 운영", degraded: "일부 저하", maintenance: "점검 중" };

  var state = {
    tab: "dashboard",
    settingsPane: "shortcuts",
    shortcuts: [],
    datacenters: [],
    dcSummary: null,
    categories: [],
    meta: null,
    session: null,
    category: "ALL",
    region: "ALL",
    search: "",
    dcSearch: "",
    selectedDcId: null,
    health: {},
    healthList: [],
    healthCheckedAt: "",
    historyRange: "24h",
    historyTarget: "",
    history: null,
    settings: null,
    users: [],
    backups: [],
    editingId: null,
    editingDcId: null,
    busy: false,
    pendingPane: null
  };

  /* ---------------- DOM 헬퍼 ---------------- */

  function $(id) { return document.getElementById(id); }

  function el(tag, opts, children) {
    var node = document.createElement(tag);
    opts = opts || {};
    if (opts.className) node.className = opts.className;
    if (opts.text != null) node.textContent = String(opts.text);
    if (opts.title) node.title = opts.title;
    if (opts.href) node.href = opts.href;
    if (opts.type) node.type = opts.type;
    if (opts.value != null) node.value = opts.value;
    if (opts.hidden) node.hidden = true;
    if (opts.attrs) Object.keys(opts.attrs).forEach(function (k) { node.setAttribute(k, opts.attrs[k]); });
    if (opts.on) Object.keys(opts.on).forEach(function (e) { node.addEventListener(e, opts.on[e]); });
    (children || []).forEach(function (child) { if (child) node.appendChild(child); });
    return node;
  }

  function svgEl(tag, attrs) {
    var node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.keys(attrs || {}).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    return node;
  }

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  var toastTimer = null;
  function toast(message, kind) {
    var box = $("toast");
    box.textContent = message;
    box.className = "toast " + (kind || "");
    box.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.hidden = true; }, 3400);
  }

  function setMsg(id, text, kind) {
    var node = $(id);
    if (!node) return;
    node.textContent = text || "";
    node.className = "form-msg" + (kind ? " " + kind : "");
  }

  function bytes(size) {
    if (!size && size !== 0) return "-";
    if (size < 1024) return size + " B";
    if (size < 1048576) return (size / 1024).toFixed(1) + " KB";
    return (size / 1048576).toFixed(1) + " MB";
  }

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  function stampLabel(seconds, range) {
    var d = new Date(seconds * 1000);
    if (range === "7d" || range === "30d") return (d.getMonth() + 1) + "/" + d.getDate();
    if (range === "24h" || range === "6h") return pad(d.getHours()) + ":" + pad(d.getMinutes());
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  function fullStamp(seconds) {
    var d = new Date(seconds * 1000);
    return (d.getMonth() + 1) + "/" + d.getDate() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  /* ---------------- API ---------------- */

  function hubToken() { return window.localStorage.getItem(HUB_TOKEN_KEY) || ""; }
  function settingsToken() { return window.localStorage.getItem(SETTINGS_TOKEN_KEY) || ""; }

  function api(path, options) {
    options = options || {};
    var headers = { "Accept": "application/json" };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (hubToken()) headers["X-Hub-Token"] = hubToken();
    if (settingsToken()) headers["X-Settings-Token"] = settingsToken();

    return fetch(path, {
      method: options.method || "GET",
      headers: headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401 && data.code === "settings_login_required") {
          clearSession();
          if (!options.quiet) openLogin();
          throw new Error(data.error || "설정 로그인이 필요합니다.");
        }
        if (res.status === 401 && data.code === "hub_token_required") {
          $("token-modal").hidden = false;
          throw new Error(data.error || "접근 토큰이 필요합니다.");
        }
        if (!res.ok || data.success === false) {
          throw new Error(data.error || ("요청 실패 (HTTP " + res.status + ")"));
        }
        return data;
      });
    });
  }

  /* ---------------- 세션 / 설정 메뉴 ---------------- */

  function clearSession() {
    state.session = null;
    window.localStorage.removeItem(SETTINGS_TOKEN_KEY);
    renderSessionUi();
  }

  function renderSessionUi() {
    var logged = !!state.session;
    $("settings-lock").textContent = logged ? "⚙" : "🔒";
    $("menu-user").textContent = logged
      ? state.session.username + " (" + state.session.role + ")"
      : "로그인 필요";
    $("btn-logout").hidden = !logged;
    $("settings-who").textContent = logged
      ? state.session.username + " · " + state.session.role
      : "";
    var adminOnly = document.querySelectorAll("[data-admin-only]");
    for (var i = 0; i < adminOnly.length; i += 1) {
      adminOnly[i].disabled = !(logged && state.session.role === "admin");
    }
  }

  function openMenu(open) {
    $("settings-panel").hidden = !open;
    $("btn-settings").setAttribute("aria-expanded", open ? "true" : "false");
  }

  function openLogin(pane) {
    state.pendingPane = pane || state.pendingPane || "shortcuts";
    $("login-msg").textContent = "";
    $("login-input").value = "";
    $("login-modal").hidden = false;
    setTimeout(function () { $("login-input").focus(); }, 30);
  }

  function submitLogin() {
    var password = $("login-input").value;
    if (!password) { setMsg("login-msg", "비밀번호를 입력하세요.", "err"); return; }
    $("login-submit").disabled = true;
    api("/api/settings/session", { method: "POST", body: { password: password }, quiet: true })
      .then(function (data) {
        window.localStorage.setItem(SETTINGS_TOKEN_KEY, data.token);
        state.session = data.user;
        $("login-modal").hidden = true;
        renderSessionUi();
        toast(data.user.username + " 계정으로 설정에 로그인했습니다.", "ok");
        goSettings(state.pendingPane || "shortcuts");
        loadSettings();
      })
      .catch(function (err) { setMsg("login-msg", err.message, "err"); })
      .then(function () { $("login-submit").disabled = false; });
  }

  function logout() {
    api("/api/settings/session", { method: "DELETE", quiet: true }).catch(function () {});
    clearSession();
    openMenu(false);
    toast("로그아웃했습니다.");
    if (state.tab === "settings") navigate("dashboard");
  }

  /** 설정이 필요한 동작 앞에 세운다. 로그인 상태면 실행, 아니면 로그인 모달. */
  function requireSession(action) {
    if (state.session) { action(); return; }
    openLogin();
  }

  function goSettings(pane) {
    if (SETTINGS_PANES.indexOf(pane) === -1) pane = "shortcuts";
    state.settingsPane = pane;
    window.location.hash = "#/settings/" + pane;
  }

  /* ---------------- 공통 계산 ---------------- */

  function categoryLabel(key) {
    for (var i = 0; i < state.categories.length; i += 1) {
      if (state.categories[i].key === key) return state.categories[i].label;
    }
    return key;
  }

  function dcById(id) {
    for (var i = 0; i < state.datacenters.length; i += 1) {
      if (state.datacenters[i].id === id) return state.datacenters[i];
    }
    return null;
  }

  function shortcutById(id) {
    for (var i = 0; i < state.shortcuts.length; i += 1) {
      if (state.shortcuts[i].id === id) return state.shortcuts[i];
    }
    return null;
  }

  function matchesSearch(sc, query) {
    if (!query) return true;
    var haystack = [sc.name, sc.url, sc.description, (sc.tags || []).join(" "),
      categoryLabel(sc.category)].join(" ").toLowerCase();
    return haystack.indexOf(query.toLowerCase()) !== -1;
  }

  function visibleShortcuts() {
    return state.shortcuts.filter(function (sc) {
      var byCategory = state.category === "ALL" || sc.category === state.category;
      return byCategory && matchesSearch(sc, state.search);
    });
  }

  /* ---------------- 바로가기 카드 ---------------- */

  function healthBadge(sc) {
    var result = state.health[sc.id];
    if (!result) return null;
    var text = HEALTH_LABEL[result.status] || result.status;
    if (result.statusCode) text += " · " + result.statusCode;
    if (result.status === "healthy" && result.latencyMs != null) text += " · " + result.latencyMs + "ms";
    return el("span", { className: "sc-health h-" + result.status, text: text,
                        title: result.message || "" });
  }

  function shortcutCard(sc) {
    var dc = sc.datacenterId && sc.datacenterId !== "all" ? dcById(sc.datacenterId) : null;

    var badges = [el("span", {
      className: "badge " + (CATEGORY_CLASS[sc.category] || "cat-custom"),
      text: categoryLabel(sc.category)
    })];
    if (dc) badges.push(el("span", { className: "badge badge-dc", text: dc.code }));
    if (sc.createdViaSettings) badges.push(el("span", { className: "badge badge-user", text: "사용자 추가" }));

    var favBtn = el("button", {
      className: "iconbtn" + (sc.isFavorite ? " on" : ""), text: "★", type: "button",
      title: sc.isFavorite ? "즐겨찾기 해제" : "즐겨찾기 등록",
      on: { click: function () { requireSession(function () { toggleFavorite(sc); }); } }
    });
    var editBtn = el("button", {
      className: "iconbtn", text: "✎", type: "button", title: "수정",
      on: { click: function () { requireSession(function () { startEdit(sc.id); }); } }
    });
    var delBtn = el("button", {
      className: "iconbtn danger", text: "🗑", type: "button", title: "삭제",
      on: { click: function () { requireSession(function () { removeShortcut(sc); }); } }
    });

    return el("article", { className: "sc-card" }, [
      el("div", {}, [
        el("div", { className: "sc-top" }, [
          el("div", { className: "sc-ident" }, [
            el("div", { className: "sc-icon", text: sc.icon || "🔗" }),
            el("div", {}, [
              el("div", { className: "sc-badges" }, badges),
              el("div", { className: "sc-name", text: sc.name })
            ])
          ]),
          el("div", { className: "sc-actions" }, [favBtn, editBtn, delBtn])
        ]),
        el("p", { className: "sc-desc", text: sc.description || "" }),
        el("div", { className: "sc-tags" }, (sc.tags || []).map(function (tag) {
          return el("span", { className: "tag", text: "#" + tag });
        }))
      ]),
      el("div", { className: "sc-foot" }, [
        el("span", { className: "sc-url", text: sc.url.replace(/^https?:\/\//, ""), title: sc.url }),
        el("div", { className: "sc-actions" }, [
          healthBadge(sc),
          el("a", { className: "btn btn-primary btn-sm", text: "바로가기 ↗", href: sc.url,
                    attrs: { target: "_blank", rel: "noopener noreferrer" } })
        ])
      ])
    ]);
  }

  /* ---------------- 대시보드 ---------------- */

  function renderDashboard() {
    var favorites = state.shortcuts.filter(function (sc) { return sc.isFavorite; });
    var showFavorites = favorites.length > 0 && !state.search && state.category === "ALL";
    $("favorites-section").hidden = !showFavorites;
    if (showFavorites) {
      $("favorites-count").textContent = favorites.length + "개";
      var favGrid = $("favorites-grid");
      clear(favGrid);
      favorites.forEach(function (sc) { favGrid.appendChild(shortcutCard(sc)); });
    }

    var pills = $("category-pills");
    clear(pills);
    [{ key: "ALL", label: "전체 서비스" }].concat(state.categories).forEach(function (entry) {
      var count = entry.key === "ALL" ? state.shortcuts.length
        : state.shortcuts.filter(function (sc) { return sc.category === entry.key; }).length;
      pills.appendChild(el("button", {
        className: "pill" + (state.category === entry.key ? " active" : ""), type: "button",
        on: { click: function () { state.category = entry.key; renderDashboard(); } }
      }, [el("span", { text: entry.label }), el("span", { className: "pill-count", text: String(count) })]));
    });

    var list = visibleShortcuts();
    $("result-summary").textContent = "조회 결과 " + list.length + "개 / 전체 " + state.shortcuts.length + "개";
    $("clear-search").hidden = !state.search;

    var grid = $("shortcut-grid");
    clear(grid);
    list.forEach(function (sc) { grid.appendChild(shortcutCard(sc)); });
    $("shortcut-empty").hidden = list.length > 0;
    grid.hidden = list.length === 0;
  }

  /* ---------------- 데이터센터 화면 ---------------- */

  function projectX(lng) { return (Number(lng) + 180) / 360 * 1000; }
  function projectY(lat) { return (90 - Number(lat)) / 180 * 460; }

  function renderMap(list) {
    var svg = $("dc-map");
    clear(svg);

    for (var lng = -150; lng <= 150; lng += 30) {
      svg.appendChild(svgEl("line", { class: "map-grid-line", x1: projectX(lng), y1: 0,
                                      x2: projectX(lng), y2: 460 }));
    }
    for (var lat = -60; lat <= 60; lat += 30) {
      svg.appendChild(svgEl("line", { class: "map-grid-line", x1: 0, y1: projectY(lat),
                                      x2: 1000, y2: projectY(lat) }));
    }

    var zones = [
      { label: "AMER", lng: [-170, -50], lat: [72, 12] },
      { label: "EMEA", lng: [-25, 60], lat: [70, -38] },
      { label: "APAC", lng: [60, 180], lat: [58, -48] },
      { label: "LATAM", lng: [-95, -33], lat: [10, -57] }
    ];
    zones.forEach(function (zone) {
      var x = projectX(zone.lng[0]);
      var y = projectY(zone.lat[0]);
      svg.appendChild(svgEl("rect", { class: "map-zone", x: x, y: y,
                                      width: projectX(zone.lng[1]) - x,
                                      height: projectY(zone.lat[1]) - y, rx: 16 }));
      var label = svgEl("text", { class: "map-zone-label", x: x + 10, y: y + 20 });
      label.textContent = zone.label;
      svg.appendChild(label);
    });

    list.forEach(function (dc) {
      var x = projectX(dc.lng);
      var y = projectY(dc.lat);
      var color = REGION_COLOR[dc.region] || "#60a5fa";
      var group = svgEl("g", { class: "map-dot" + (state.selectedDcId === dc.id ? " selected" : "") });
      group.appendChild(svgEl("circle", { class: "halo", cx: x, cy: y, r: 11, fill: color }));
      group.appendChild(svgEl("circle", { class: "core", cx: x, cy: y, r: 4.5, fill: color }));
      var label = svgEl("text", { x: x + 8, y: y + 3.5 });
      label.textContent = dc.code;
      group.appendChild(label);
      var tip = svgEl("title", {});
      tip.textContent = dc.code + " · " + dc.city + " (" + dc.country + ")";
      group.appendChild(tip);
      group.addEventListener("click", function () { state.selectedDcId = dc.id; renderDatacenters(); });
      svg.appendChild(group);
    });

    var legend = $("map-legend");
    clear(legend);
    Object.keys(REGION_COLOR).forEach(function (region) {
      // 인라인 style 은 CSP(style-src 'self')에 막힌다 — 색은 클래스로 준다.
      legend.appendChild(el("span", {}, [
        el("i", { className: "lg-" + region }), el("span", { text: region })
      ]));
    });
    $("map-caption").textContent = list.length + "개 사이트 표시";
  }

  function dcDetail(dc) {
    var box = $("dc-detail");
    clear(box);
    if (!dc) {
      box.appendChild(el("p", { className: "muted", text: "좌측 목록이나 지도에서 데이터센터를 선택하세요." }));
      return;
    }
    var linked = state.shortcuts.filter(function (sc) { return sc.datacenterId === dc.id; });
    var global = state.shortcuts.filter(function (sc) {
      return !sc.datacenterId || sc.datacenterId === "all";
    });

    box.appendChild(el("h3", { text: dc.code + " · " + dc.name }));
    box.appendChild(el("p", { className: "muted", text: dc.city + " · " + dc.country }));

    [["리전", dc.region], ["상태", STATUS_LABEL[dc.status] || dc.status], ["PUE", String(dc.pue)],
     ["랙 수", Number(dc.racks).toLocaleString()], ["관리 대역", dc.primarySubnet || "-"],
     ["좌표", Number(dc.lat).toFixed(2) + ", " + Number(dc.lng).toFixed(2)]
    ].forEach(function (row) {
      box.appendChild(el("div", { className: "kv" }, [
        el("span", { text: row[0] }), el("span", { text: row[1] })
      ]));
    });

    box.appendChild(el("div", { className: "section-head", text: "이 센터 전용 링크 (" + linked.length + ")" }));
    var wrap = el("div", { className: "dc-links" });
    if (!linked.length) {
      wrap.appendChild(el("p", { className: "muted",
        text: "전용 링크가 없습니다. 설정 › 바로가기 관리에서 '연결 데이터센터'를 지정하세요." }));
    }
    linked.forEach(function (sc) {
      wrap.appendChild(el("a", { className: "dc-link", href: sc.url,
        attrs: { target: "_blank", rel: "noopener noreferrer" } },
        [el("span", { text: sc.icon || "🔗" }), el("span", { text: sc.name })]));
    });
    box.appendChild(wrap);

    box.appendChild(el("div", { className: "section-head", text: "전체 공통 링크 (" + global.length + ")" }));
    var globalWrap = el("div", { className: "dc-links" });
    global.slice(0, 6).forEach(function (sc) {
      globalWrap.appendChild(el("a", { className: "dc-link", href: sc.url,
        attrs: { target: "_blank", rel: "noopener noreferrer" } },
        [el("span", { text: sc.icon || "🔗" }), el("span", { text: sc.name })]));
    });
    box.appendChild(globalWrap);
  }

  function renderDatacenters() {
    var stats = $("dc-stats");
    clear(stats);
    var sum = state.dcSummary;
    if (sum) {
      [["운영 데이터센터", sum.operational + " / " + sum.total, "정상 가동", "v-emerald"],
       ["평균 PUE", String(sum.avgPue), "에너지 효율", "v-blue"],
       ["총 운용 랙", Number(sum.racks).toLocaleString(), "서버 랙", "v-indigo"],
       ["연동 서비스 링크", state.shortcuts.length + "개", "포탈 등록", "v-amber"]
      ].forEach(function (row) {
        stats.appendChild(el("div", { className: "stat" }, [
          el("div", { className: "stat-label", text: row[0] }),
          el("div", { className: "stat-value " + row[3], text: row[1] }),
          el("div", { className: "stat-note", text: row[2] })
        ]));
      });
    }

    var regionPills = $("region-pills");
    clear(regionPills);
    ["ALL"].concat((state.meta && state.meta.regions) || []).forEach(function (region) {
      var count = region === "ALL" ? state.datacenters.length
        : state.datacenters.filter(function (dc) { return dc.region === region; }).length;
      regionPills.appendChild(el("button", {
        className: "pill" + (state.region === region ? " active" : ""), type: "button",
        on: { click: function () { state.region = region; renderDatacenters(); } }
      }, [el("span", { text: region === "ALL" ? "전체" : region }),
          el("span", { className: "pill-count", text: String(count) })]));
    });

    var query = state.dcSearch.toLowerCase();
    var list = state.datacenters.filter(function (dc) {
      var byRegion = state.region === "ALL" || dc.region === state.region;
      var bySearch = !query ||
        [dc.name, dc.city, dc.country, dc.code].join(" ").toLowerCase().indexOf(query) !== -1;
      return byRegion && bySearch;
    });

    renderMap(list);

    var listBox = $("dc-list");
    clear(listBox);
    list.forEach(function (dc) {
      listBox.appendChild(el("button", {
        className: "dc-card" + (state.selectedDcId === dc.id ? " active" : ""), type: "button",
        on: { click: function () { state.selectedDcId = dc.id; renderDatacenters(); } }
      }, [
        el("div", { className: "dc-card-top" }, [
          el("span", { className: "dc-code", text: dc.code }),
          el("span", { className: "status-dot st-" + dc.status, title: STATUS_LABEL[dc.status] || dc.status })
        ]),
        el("div", { className: "dc-name", text: dc.city }),
        el("div", { className: "dc-meta" }, [
          el("span", { text: dc.region }), el("span", { text: "PUE " + dc.pue }),
          el("span", { text: dc.racks + " racks" })
        ])
      ]));
    });
    if (!list.length) {
      listBox.appendChild(el("p", { className: "muted", text: "조건에 맞는 데이터센터가 없습니다." }));
    }
    dcDetail(dcById(state.selectedDcId) || list[0] || null);
  }

  /* ---------------- 차트 ---------------- */

  /**
   * 시계열 SVG 렌더러. 라이브러리 없이 필요한 만큼만 그린다.
   * accessor 가 null 을 돌려주면 그 구간은 선을 끊는다(데이터 없음 = 0 이 아니다).
   */
  function drawSeries(svg, series, accessor, opts) {
    clear(svg);
    var box = svg.viewBox.baseVal;
    var W = box.width || 1000;
    var H = box.height || 180;
    var padL = 54, padR = 14, padT = 16, padB = 26;
    var innerW = W - padL - padR;
    var innerH = H - padT - padB;

    var points = series.points || [];
    var values = points.map(accessor).filter(function (v) { return v != null; });
    var maxValue = opts.max != null ? opts.max : Math.max.apply(null, values.concat([0]));
    if (!isFinite(maxValue) || maxValue <= 0) maxValue = opts.fallbackMax || 1;
    if (opts.max == null) maxValue = maxValue * 1.15;
    var minValue = opts.min != null ? opts.min : 0;

    var span = Math.max(1, series.to - series.from);
    function sx(ts) { return padL + ((ts - series.from) / span) * innerW; }
    function sy(value) {
      var ratio = (value - minValue) / (maxValue - minValue || 1);
      return padT + innerH - Math.max(0, Math.min(1, ratio)) * innerH;
    }

    // 가로 눈금 4개 + 값 라벨
    for (var i = 0; i <= 4; i += 1) {
      var value = minValue + (maxValue - minValue) * (i / 4);
      var y = sy(value);
      svg.appendChild(svgEl("line", { class: "chart-grid", x1: padL, y1: y, x2: W - padR, y2: y }));
      var label = svgEl("text", { class: "chart-axis", x: padL - 8, y: y + 3.5,
                                  "text-anchor": "end" });
      label.textContent = opts.formatY ? opts.formatY(value) : Math.round(value);
      svg.appendChild(label);
    }

    // 세로 시간 라벨 5개
    for (var t = 0; t <= 4; t += 1) {
      var ts = series.from + (span * t) / 4;
      var x = sx(ts);
      svg.appendChild(svgEl("line", { class: "chart-grid chart-grid-v", x1: x, y1: padT,
                                      x2: x, y2: padT + innerH }));
      var tLabel = svgEl("text", { class: "chart-axis", x: x, y: H - 8, "text-anchor": "middle" });
      tLabel.textContent = stampLabel(ts, series.range);
      svg.appendChild(tLabel);
    }

    if (!points.length) return;

    // 값이 있는 구간만 이어 그린다.
    var segments = [];
    var current = [];
    points.forEach(function (point) {
      var value = accessor(point);
      if (value == null) {
        if (current.length) segments.push(current);
        current = [];
        return;
      }
      current.push({ x: sx(point.ts), y: sy(value), point: point, value: value });
    });
    if (current.length) segments.push(current);

    segments.forEach(function (segment) {
      var line = segment.map(function (p, index) {
        return (index === 0 ? "M" : "L") + p.x.toFixed(1) + " " + p.y.toFixed(1);
      }).join(" ");

      if (opts.area && segment.length > 1) {
        var baseY = padT + innerH;
        var areaPath = line + " L" + segment[segment.length - 1].x.toFixed(1) + " " + baseY +
                       " L" + segment[0].x.toFixed(1) + " " + baseY + " Z";
        svg.appendChild(svgEl("path", { d: areaPath, fill: opts.area, stroke: "none" }));
      }
      svg.appendChild(svgEl("path", {
        d: line, fill: "none", stroke: opts.color, "stroke-width": 2,
        "stroke-linejoin": "round", "stroke-linecap": "round"
      }));
      // 점이 적으면 마커를 찍어 값이 보이게 한다.
      if (segment.length <= 40) {
        segment.forEach(function (p) {
          var dot = svgEl("circle", { cx: p.x, cy: p.y, r: 2.6, fill: opts.color });
          var tip = svgEl("title", {});
          tip.textContent = fullStamp(p.point.ts) + " · " +
            (opts.formatTip ? opts.formatTip(p.value, p.point) : p.value);
          dot.appendChild(tip);
          svg.appendChild(dot);
        });
      }
    });

    // 실패 구간 표시(가용률 차트에서만)
    if (opts.markFailures) {
      points.forEach(function (point) {
        if (!point.total || point.up >= point.total) return;
        var x = sx(point.ts);
        var mark = svgEl("rect", { x: x - 2, y: padT, width: 4, height: innerH,
                                   fill: "rgba(251,113,133,0.16)" });
        var tip = svgEl("title", {});
        tip.textContent = fullStamp(point.ts) + " · 실패 " + (point.total - point.up) + "건";
        mark.appendChild(tip);
        svg.appendChild(mark);
      });
    }
  }

  /* ---------------- 링크 점검 화면 ---------------- */

  function renderRangePills() {
    var pills = $("range-pills");
    clear(pills);
    var ranges = (state.meta && state.meta.historyRanges) || [];
    ranges.forEach(function (range) {
      pills.appendChild(el("button", {
        className: "pill" + (state.historyRange === range.key ? " active" : ""), type: "button",
        text: range.label,
        on: { click: function () {
          state.historyRange = range.key;
          renderRangePills();
          loadHistory();          // 기간을 고르면 즉시 해당 데이터를 불러온다
        } }
      }));
    });

    var select = $("history-target");
    var previous = state.historyTarget;
    clear(select);
    select.appendChild(el("option", { value: "", text: "전체 링크 합계" }));
    state.shortcuts.forEach(function (sc) {
      select.appendChild(el("option", { value: sc.id, text: sc.name }));
    });
    select.value = previous || "";
  }

  function renderHealth() {
    renderRangePills();

    var series = state.history;
    var stats = $("health-stats");
    clear(stats);
    var summary = (series && series.summary) || {};
    [["가용률", summary.uptimePct == null ? "-" : summary.uptimePct + "%", "정상 응답 비율", "v-emerald"],
     ["평균 지연", summary.avgLatencyMs == null ? "-" : summary.avgLatencyMs + "ms", "정상 응답 기준", "v-blue"],
     ["최대 지연", summary.maxLatencyMs == null ? "-" : summary.maxLatencyMs + "ms", "구간 최대", "v-indigo"],
     ["실패", String(summary.failures == null ? "-" : summary.failures), "비정상 응답 수", "v-rose"],
     ["표본", String(summary.samples == null ? "-" : summary.samples), "저장된 점검 수", "v-amber"]
    ].forEach(function (row) {
      stats.appendChild(el("div", { className: "stat" }, [
        el("div", { className: "stat-label", text: row[0] }),
        el("div", { className: "stat-value " + row[3], text: row[1] }),
        el("div", { className: "stat-note", text: row[2] })
      ]));
    });

    var hasPoints = !!(series && series.points && series.points.length);
    $("chart-empty").hidden = hasPoints;
    $("chart-uptime").hidden = !hasPoints;
    $("chart-latency").hidden = !hasPoints;

    if (hasPoints) {
      $("chart-caption").textContent = series.rangeLabel + " · 구간 " +
        (series.bucketSeconds >= 3600 ? (series.bucketSeconds / 3600) + "시간"
          : series.bucketSeconds >= 60 ? (series.bucketSeconds / 60) + "분"
          : series.bucketSeconds + "초") +
        " · " + series.points.length + "개 구간" +
        (state.historyTarget ? " · " + (shortcutById(state.historyTarget) || {}).name : "");

      drawSeries($("chart-uptime"), series, function (p) { return p.uptimePct; }, {
        color: "#34d399", area: "rgba(52,211,153,0.14)", min: 0, max: 100,
        formatY: function (v) { return Math.round(v) + "%"; },
        formatTip: function (v, p) { return "가용률 " + v + "% (" + p.up + "/" + p.total + ")"; },
        markFailures: true
      });

      drawSeries($("chart-latency"), series, function (p) { return p.avgLatencyMs; }, {
        color: "#60a5fa", area: "rgba(96,165,250,0.12)", fallbackMax: 100,
        formatY: function (v) { return Math.round(v) + "ms"; },
        formatTip: function (v) { return "평균 " + v + "ms"; }
      });
    }

    var body = $("health-tbody");
    clear(body);
    state.healthList.forEach(function (row) {
      var sc = shortcutById(row.id);
      body.appendChild(el("tr", {}, [
        el("td", { text: sc ? sc.name : "(삭제됨)" }),
        el("td", { className: "url", text: row.url, title: row.url }),
        el("td", {}, [el("span", { className: "sc-health h-" + row.status,
                                   text: HEALTH_LABEL[row.status] || row.status })]),
        el("td", { text: row.statusCode ? String(row.statusCode) : "-" }),
        el("td", { text: row.latencyMs != null ? row.latencyMs + "ms" : "-" }),
        el("td", { className: "muted", text: row.message || "" })
      ]));
    });
    var hasRows = state.healthList.length > 0;
    $("health-empty").hidden = hasRows;
    $("health-table").hidden = !hasRows;

    var auto = state.settings && state.settings.health;
    $("health-time").textContent = (state.healthCheckedAt ? "최근 점검 " + state.healthCheckedAt : "")
      + (auto ? "  ·  자동 점검 " + (auto.autoEnabled ? auto.intervalMinutes + "분 주기" : "꺼짐") : "");
  }

  function loadHistory() {
    var url = "/api/health/history?range=" + encodeURIComponent(state.historyRange) +
      (state.historyTarget ? "&id=" + encodeURIComponent(state.historyTarget) : "");
    return api(url).then(function (data) {
      state.history = data;
      renderHealth();
    }).catch(function (err) { toast(err.message, "err"); });
  }

  function loadLatest() {
    return api("/api/health/latest").then(function (data) {
      state.healthList = data.results || [];
      state.health = {};
      state.healthList.forEach(function (row) { if (row.id) state.health[row.id] = row; });
    }).catch(function () {});
  }

  function runHealthCheck() {
    if (state.busy) return;
    if (!state.shortcuts.length) { toast("점검할 바로가기가 없습니다.", "err"); return; }
    state.busy = true;
    $("btn-check-now").disabled = true;
    toast("링크 점검 중…");

    api("/api/health/check", { method: "POST", body: {} })
      .then(function (data) {
        if (data.skipped) { toast("이미 점검이 진행 중입니다. 잠시 후 갱신됩니다."); }
        state.healthList = data.results || [];
        state.healthCheckedAt = new Date().toLocaleTimeString();
        state.health = {};
        state.healthList.forEach(function (row) { if (row.id) state.health[row.id] = row; });
        var down = state.healthList.filter(function (r) { return r.status !== "healthy"; }).length;
        if (!data.skipped) {
          toast(down === 0 ? "전체 " + state.healthList.length + "개 링크 정상"
                           : state.healthList.length + "개 중 " + down + "개 확인 필요",
                down === 0 ? "ok" : "err");
        }
        return loadHistory();
      })
      .then(function () { renderAll(); })
      .catch(function (err) { toast(err.message, "err"); })
      .then(function () { state.busy = false; $("btn-check-now").disabled = false; });
  }

  /* ---------------- 설정: 공통 ---------------- */

  function renderSettingsTabs() {
    var wrap = $("settings-tabs");
    clear(wrap);
    SETTINGS_PANES.forEach(function (pane) {
      wrap.appendChild(el("button", {
        className: "pill" + (state.settingsPane === pane ? " active" : ""), type: "button",
        text: SETTINGS_META[pane].title,
        on: { click: function () { goSettings(pane); } }
      }));
    });
    SETTINGS_PANES.forEach(function (pane) {
      $("pane-" + pane).hidden = pane !== state.settingsPane;
    });
    $("settings-title").textContent = SETTINGS_META[state.settingsPane].title;
    $("settings-desc").textContent = SETTINGS_META[state.settingsPane].desc;
  }

  function loadSettings() {
    if (!state.session) return Promise.resolve();
    return api("/api/settings").then(function (data) {
      state.settings = data.settings;
      state.users = data.users || [];
      state.backupStatus = data.backup;
      state.choices = data.choices;
      state.initialPasswordFile = data.initialPasswordFile;
      state.backups = (data.backup && data.backup.count) ? state.backups : state.backups;
      return api("/api/settings/backups");
    }).then(function (data) {
      state.backups = data.backups || [];
      state.backupStatus = data.status || state.backupStatus;
      renderSettings();
    }).catch(function (err) {
      if (err.message.indexOf("로그인") === -1) toast(err.message, "err");
    });
  }

  function renderSettings() {
    renderSettingsTabs();
    renderShortcutSettings();
    renderDcSettings();
    renderUserSettings();
    renderBackupSettings();
  }

  /* ---------------- 설정 1: 바로가기 ---------------- */

  function fillFormSelects() {
    var categorySelect = $("f-category");
    var keepCategory = categorySelect.value;
    clear(categorySelect);
    state.categories.forEach(function (cat) {
      categorySelect.appendChild(el("option", { value: cat.key, text: cat.label }));
    });
    categorySelect.value = keepCategory || "Custom Shortcuts";

    var dcSelect = $("f-datacenter");
    var keepDc = dcSelect.value;
    clear(dcSelect);
    dcSelect.appendChild(el("option", { value: "all", text: "전체 공통 (모든 DC)" }));
    state.datacenters.forEach(function (dc) {
      dcSelect.appendChild(el("option", { value: dc.id, text: dc.code + " · " + dc.city }));
    });
    dcSelect.value = keepDc || "all";

    var regionSelect = $("d-region");
    if (regionSelect && !regionSelect.options.length) {
      ((state.meta && state.meta.regions) || ["APAC", "EMEA", "AMER", "LATAM"]).forEach(function (r) {
        regionSelect.appendChild(el("option", { value: r, text: r }));
      });
    }
  }

  function resetForm() {
    state.editingId = null;
    $("shortcut-form").reset();
    $("f-category").value = "Custom Shortcuts";
    $("f-datacenter").value = "all";
    $("form-title").textContent = "새 바로가기 등록";
    $("form-submit").textContent = "바로가기 생성";
    $("form-cancel").hidden = true;
    setMsg("form-msg", "");
  }

  function startEdit(id) {
    var sc = shortcutById(id);
    if (!sc) return;
    state.editingId = id;
    $("f-name").value = sc.name;
    $("f-url").value = sc.url;
    $("f-category").value = sc.category;
    $("f-icon").value = sc.icon || "";
    $("f-description").value = sc.description || "";
    $("f-tags").value = (sc.tags || []).join(", ");
    $("f-datacenter").value = sc.datacenterId || "all";
    $("f-favorite").checked = !!sc.isFavorite;
    $("form-title").textContent = "바로가기 수정";
    $("form-submit").textContent = "수정 저장";
    $("form-cancel").hidden = false;
    setMsg("form-msg", "");
    goSettings("shortcuts");
    $("f-name").focus();
  }

  function renderShortcutSettings() {
    $("settings-count").textContent = "(" + state.shortcuts.length + "개)";
    var body = $("settings-tbody");
    clear(body);
    if (!state.shortcuts.length) {
      body.appendChild(el("tr", {}, [el("td", { className: "muted", text: "등록된 바로가기가 없습니다.",
                                               attrs: { colspan: "4" } })]));
      return;
    }
    state.shortcuts.forEach(function (sc) {
      body.appendChild(el("tr", {}, [
        el("td", {}, [
          el("span", { text: (sc.icon || "🔗") + " " }), el("strong", { text: sc.name }),
          sc.isFavorite ? el("span", { className: "badge badge-user", text: "★" }) : null
        ]),
        el("td", { className: "url", text: sc.url, title: sc.url }),
        el("td", {}, [el("span", { className: "badge " + (CATEGORY_CLASS[sc.category] || "cat-custom"),
                                   text: categoryLabel(sc.category) })]),
        el("td", {}, [el("div", { className: "row-actions" }, [
          el("button", { className: "btn btn-ghost btn-sm", type: "button", text: "수정",
                         on: { click: function () { startEdit(sc.id); } } }),
          el("button", { className: "btn btn-danger btn-sm", type: "button", text: "삭제",
                         on: { click: function () { removeShortcut(sc); } } })
        ])])
      ]));
    });
  }

  /* ---------------- 설정 2: 데이터센터 ---------------- */

  function resetDcForm() {
    state.editingDcId = null;
    $("dc-form").reset();
    $("dc-form-title").textContent = "데이터센터 추가";
    $("dc-form-submit").textContent = "데이터센터 추가";
    $("dc-form-cancel").hidden = true;
    $("d-id").disabled = false;
    setMsg("dc-form-msg", "");
  }

  function startDcEdit(dc) {
    state.editingDcId = dc.id;
    $("d-code").value = dc.code;
    $("d-id").value = dc.id;
    $("d-id").disabled = true;          // ID 는 바로가기가 참조하므로 고정
    $("d-name").value = dc.name;
    $("d-city").value = dc.city;
    $("d-country").value = dc.country;
    $("d-region").value = dc.region;
    $("d-status").value = dc.status;
    $("d-pue").value = dc.pue;
    $("d-racks").value = dc.racks;
    $("d-lat").value = dc.lat;
    $("d-lng").value = dc.lng;
    $("d-subnet").value = dc.primarySubnet || "";
    $("dc-form-title").textContent = "데이터센터 수정";
    $("dc-form-submit").textContent = "수정 저장";
    $("dc-form-cancel").hidden = false;
    setMsg("dc-form-msg", "");
    $("d-code").focus();
  }

  function renderDcSettings() {
    $("dc-count").textContent = "(" + state.datacenters.length + "개)";
    var body = $("dc-tbody");
    clear(body);
    state.datacenters.forEach(function (dc) {
      body.appendChild(el("tr", {}, [
        el("td", {}, [el("strong", { text: dc.code })]),
        el("td", {}, [el("div", { text: dc.name }),
                      el("div", { className: "muted", text: dc.city + " · " + dc.country })]),
        el("td", { text: dc.region }),
        el("td", {}, [el("span", { className: "badge badge-dc",
                                   text: STATUS_LABEL[dc.status] || dc.status })]),
        el("td", {}, [el("div", { className: "row-actions" }, [
          el("button", { className: "btn btn-ghost btn-sm", type: "button", text: "수정",
                         on: { click: function () { startDcEdit(dc); } } }),
          el("button", { className: "btn btn-danger btn-sm", type: "button", text: "삭제",
                         on: { click: function () { deleteDc(dc); } } })
        ])])
      ]));
    });
  }

  function submitDcForm(event) {
    event.preventDefault();
    var payload = {
      code: $("d-code").value, name: $("d-name").value, city: $("d-city").value,
      country: $("d-country").value, region: $("d-region").value, status: $("d-status").value,
      pue: $("d-pue").value || 1.2, racks: $("d-racks").value || 0,
      lat: $("d-lat").value || 0, lng: $("d-lng").value || 0,
      primarySubnet: $("d-subnet").value
    };
    if (!state.editingDcId && $("d-id").value) payload.id = $("d-id").value;
    if (!payload.code.trim() || !payload.name.trim()) {
      setMsg("dc-form-msg", "코드와 이름은 필수입니다.", "err");
      return;
    }
    var request = state.editingDcId
      ? api("/api/settings/datacenters/" + encodeURIComponent(state.editingDcId),
            { method: "PUT", body: payload })
      : api("/api/settings/datacenters", { method: "POST", body: payload });

    request.then(function (data) {
      state.datacenters = data.datacenters;
      resetDcForm();
      fillFormSelects();
      toast("데이터센터를 저장했습니다.", "ok");
      return api("/api/datacenters");
    }).then(function (data) {
      state.dcSummary = data.summary;
      renderAll();
    }).catch(function (err) { setMsg("dc-form-msg", err.message, "err"); });
  }

  function deleteDc(dc) {
    if (!window.confirm("'" + dc.code + " · " + dc.name + "' 데이터센터를 삭제할까요?\n" +
                        "이 센터에 연결된 바로가기는 '전체 공통'으로 바뀝니다.")) return;
    api("/api/settings/datacenters/" + encodeURIComponent(dc.id), { method: "DELETE" })
      .then(function (data) {
        state.datacenters = data.datacenters;
        if (state.selectedDcId === dc.id) state.selectedDcId = null;
        fillFormSelects();
        toast("삭제했습니다.", "ok");
        return api("/api/datacenters");
      })
      .then(function (data) { state.dcSummary = data.summary; renderAll(); })
      .catch(function (err) { toast(err.message, "err"); });
  }

  /* ---------------- 설정 3: 사용자 ---------------- */

  function renderUserSettings() {
    $("user-count").textContent = "(" + state.users.length + "명)";
    var body = $("user-tbody");
    clear(body);
    state.users.forEach(function (user) {
      var isMe = state.session && state.session.username === user.username;
      body.appendChild(el("tr", {}, [
        el("td", {}, [el("strong", { text: user.username }),
                      isMe ? el("span", { className: "badge badge-user", text: "나" }) : null]),
        el("td", {}, [el("span", { className: "badge " + (user.role === "admin" ? "cat-security" : "cat-infra"),
                                   text: user.role })]),
        el("td", {}, [el("span", { className: "sc-health " + (user.enabled ? "h-healthy" : "h-blocked"),
                                   text: user.enabled ? "사용" : "중지" })]),
        el("td", {}, [el("div", { className: "row-actions" }, [
          el("button", { className: "btn btn-ghost btn-sm", type: "button", text: "비번 변경",
                         on: { click: function () { changeUserPassword(user); } } }),
          el("button", { className: "btn btn-ghost btn-sm", type: "button",
                         text: user.enabled ? "중지" : "사용",
                         on: { click: function () { toggleUser(user); } } }),
          el("button", { className: "btn btn-danger btn-sm", type: "button", text: "삭제",
                         on: { click: function () { deleteUser(user); } } })
        ])])
      ]));
    });

    $("initial-password-note").textContent = state.initialPasswordFile
      ? "초기 비밀번호 파일이 아직 남아 있습니다: " + state.initialPasswordFile +
        " — 비밀번호를 변경하면 자동 삭제됩니다."
      : "초기 비밀번호 파일은 삭제된 상태입니다.";
  }

  function changeUserPassword(user) {
    var password = window.prompt("'" + user.username + "' 계정의 새 비밀번호 (8자 이상)");
    if (password == null) return;
    api("/api/settings/users/" + encodeURIComponent(user.username) + "/password",
        { method: "POST", body: { password: password } })
      .then(function () {
        toast("비밀번호를 변경했습니다. 해당 계정은 다시 로그인해야 합니다.", "ok");
        if (state.session && state.session.username === user.username) {
          clearSession();
          navigate("dashboard");
        }
        return loadSettings();
      })
      .catch(function (err) { toast(err.message, "err"); });
  }

  function toggleUser(user) {
    api("/api/settings/users/" + encodeURIComponent(user.username),
        { method: "PUT", body: { enabled: !user.enabled } })
      .then(function (data) { state.users = data.users; renderUserSettings(); })
      .catch(function (err) { toast(err.message, "err"); });
  }

  function deleteUser(user) {
    if (!window.confirm("'" + user.username + "' 계정을 삭제할까요?")) return;
    api("/api/settings/users/" + encodeURIComponent(user.username), { method: "DELETE" })
      .then(function (data) { state.users = data.users; renderUserSettings(); toast("삭제했습니다.", "ok"); })
      .catch(function (err) { toast(err.message, "err"); });
  }

  function submitUserForm(event) {
    event.preventDefault();
    api("/api/settings/users", { method: "POST", body: {
      username: $("u-name").value, role: $("u-role").value, password: $("u-password").value
    } }).then(function (data) {
      state.users = data.users;
      $("user-form").reset();
      setMsg("user-form-msg", "추가했습니다.", "ok");
      renderUserSettings();
    }).catch(function (err) { setMsg("user-form-msg", err.message, "err"); });
  }

  /* ---------------- 설정 4: 백업 ---------------- */

  function fillIntervalSelect(select, choices, formatter) {
    clear(select);
    (choices || []).forEach(function (minutes) {
      select.appendChild(el("option", { value: String(minutes), text: formatter(minutes) }));
    });
  }

  function minutesLabel(minutes) {
    if (minutes < 60) return minutes + "분마다";
    if (minutes < 1440) return (minutes / 60) + "시간마다";
    if (minutes === 1440) return "하루 1회";
    return (minutes / 1440) + "일마다";
  }

  function renderBackupSettings() {
    if (!state.settings) return;
    var choices = state.choices || {};
    fillIntervalSelect($("b-interval"), choices.backupIntervalMinutes, minutesLabel);
    fillIntervalSelect($("h-interval"), choices.healthIntervalMinutes, minutesLabel);

    $("b-enabled").checked = !!state.settings.backup.enabled;
    $("b-interval").value = String(state.settings.backup.intervalMinutes);
    $("b-keep").value = state.settings.backup.keep;
    $("h-enabled").checked = !!state.settings.health.autoEnabled;
    $("h-interval").value = String(state.settings.health.intervalMinutes);

    $("backup-count").textContent = "(" + state.backups.length + "개)";
    var status = state.backupStatus || {};
    $("backup-status").textContent = "저장 위치 " + (status.directory || "-") +
      " · 총 " + bytes(status.totalBytes || 0) +
      (status.latest ? " · 최근 " + fullStamp(status.latest.modifiedTs) : " · 백업 없음");

    var body = $("backup-tbody");
    clear(body);
    if (!state.backups.length) {
      body.appendChild(el("tr", {}, [el("td", { className: "muted", text: "백업이 없습니다.",
                                               attrs: { colspan: "4" } })]));
      return;
    }
    state.backups.forEach(function (entry) {
      body.appendChild(el("tr", {}, [
        el("td", {}, [el("span", { text: entry.name }),
                      el("span", { className: "badge " + (entry.reason === "auto" ? "cat-monitoring" : "cat-custom"),
                                   text: entry.reason === "auto" ? "자동" : "수동" })]),
        el("td", { text: fullStamp(entry.modifiedTs) }),
        el("td", { text: bytes(entry.sizeBytes) }),
        el("td", {}, [el("div", { className: "row-actions" }, [
          el("button", { className: "btn btn-ghost btn-sm", type: "button", text: "받기",
                         on: { click: function () { downloadBackup(entry); } } }),
          el("button", { className: "btn btn-ghost btn-sm", type: "button", text: "복원",
                         on: { click: function () { restoreBackup(entry); } } }),
          el("button", { className: "btn btn-danger btn-sm", type: "button", text: "삭제",
                         on: { click: function () { deleteBackup(entry); } } })
        ])])
      ]));
    });
  }

  function saveBackupSettings() {
    api("/api/settings/backup", { method: "PUT", body: {
      enabled: $("b-enabled").checked,
      intervalMinutes: Number($("b-interval").value),
      keep: Number($("b-keep").value)
    } }).then(function (data) {
      state.settings = data.settings;
      setMsg("backup-msg", "저장했습니다.", "ok");
      return loadSettings();
    }).catch(function (err) { setMsg("backup-msg", err.message, "err"); });
  }

  function saveHealthSettings() {
    api("/api/settings/health", { method: "PUT", body: {
      autoEnabled: $("h-enabled").checked,
      intervalMinutes: Number($("h-interval").value)
    } }).then(function (data) {
      state.settings = data.settings;
      setMsg("health-cfg-msg", "저장했습니다.", "ok");
    }).catch(function (err) { setMsg("health-cfg-msg", err.message, "err"); });
  }

  function backupNow() {
    setMsg("backup-msg", "백업 중…");
    api("/api/settings/backups", { method: "POST", body: {} })
      .then(function (data) {
        state.backups = data.backups || [];
        state.backupStatus = data.status;
        setMsg("backup-msg", data.backup.name + " 생성", "ok");
        renderBackupSettings();
      })
      .catch(function (err) { setMsg("backup-msg", err.message, "err"); });
  }

  function downloadBackup(entry) {
    // 링크로 열면 X-Settings-Token 이 실리지 않는다 — 받아서 Blob 으로 내려준다.
    fetch("/api/settings/backups/" + encodeURIComponent(entry.name), {
      headers: { "X-Settings-Token": settingsToken(), "X-Hub-Token": hubToken() }
    }).then(function (res) {
      if (!res.ok) throw new Error("다운로드 실패 (HTTP " + res.status + ")");
      return res.blob();
    }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var anchor = el("a", { href: url, attrs: { download: entry.name } });
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    }).catch(function (err) { toast(err.message, "err"); });
  }

  function restoreBackup(entry) {
    if (!window.confirm(entry.name + " 시점으로 설정을 되돌립니다.\n" +
                        "(되돌리기 직전 상태도 자동으로 백업됩니다)\n계속할까요?")) return;
    api("/api/settings/backups/" + encodeURIComponent(entry.name) + "/restore",
        { method: "POST", body: {} })
      .then(function (data) {
        state.shortcuts = data.shortcuts || state.shortcuts;
        state.datacenters = data.datacenters || state.datacenters;
        state.users = data.users || state.users;
        state.settings = data.settings || state.settings;
        toast("복원했습니다: " + (data.restored || []).join(", "), "ok");
        return loadSettings();
      })
      .then(function () { return api("/api/datacenters"); })
      .then(function (data) { state.dcSummary = data.summary; applyShortcuts(state.shortcuts); })
      .catch(function (err) { toast(err.message, "err"); });
  }

  function deleteBackup(entry) {
    if (!window.confirm(entry.name + " 백업을 삭제할까요?")) return;
    api("/api/settings/backups/" + encodeURIComponent(entry.name), { method: "DELETE" })
      .then(function (data) {
        state.backups = data.backups || [];
        state.backupStatus = data.status;
        renderBackupSettings();
      })
      .catch(function (err) { toast(err.message, "err"); });
  }

  /* ---------------- 바로가기 변경 ---------------- */

  function applyShortcuts(list) {
    state.shortcuts = list || [];
    $("tab-count").textContent = String(state.shortcuts.length);
    $("footer-meta").textContent = "바로가기 " + state.shortcuts.length + "개 · 데이터센터 "
      + state.datacenters.length + "개" + (state.meta ? " · v" + state.meta.version : "");
    renderAll();
  }

  function toggleFavorite(sc) {
    api("/api/shortcuts/" + encodeURIComponent(sc.id),
        { method: "PUT", body: { isFavorite: !sc.isFavorite } })
      .then(function (data) { applyShortcuts(data.shortcuts); })
      .catch(function (err) { toast(err.message, "err"); });
  }

  function removeShortcut(sc) {
    if (!window.confirm("'" + sc.name + "' 바로가기를 삭제할까요?")) return;
    api("/api/shortcuts/" + encodeURIComponent(sc.id), { method: "DELETE" })
      .then(function (data) {
        if (state.editingId === sc.id) resetForm();
        applyShortcuts(data.shortcuts);
        toast("삭제했습니다.", "ok");
      })
      .catch(function (err) { toast(err.message, "err"); });
  }

  function submitForm(event) {
    event.preventDefault();
    var payload = {
      name: $("f-name").value, url: $("f-url").value, category: $("f-category").value,
      icon: $("f-icon").value, description: $("f-description").value, tags: $("f-tags").value,
      datacenterId: $("f-datacenter").value, isFavorite: $("f-favorite").checked
    };
    if (!payload.name.trim() || !payload.url.trim()) {
      setMsg("form-msg", "이름과 URL은 필수입니다.", "err");
      return;
    }
    var editing = state.editingId;
    var request = editing
      ? api("/api/shortcuts/" + encodeURIComponent(editing), { method: "PUT", body: payload })
      : api("/api/shortcuts", { method: "POST", body: payload });

    $("form-submit").disabled = true;
    request.then(function (data) {
      applyShortcuts(data.shortcuts);
      resetForm();
      toast(editing ? "수정했습니다." : "바로가기를 만들었습니다. 대시보드에서 확인하세요.", "ok");
      if (!editing) navigate("dashboard");
    }).catch(function (err) {
      setMsg("form-msg", err.message, "err");
    }).then(function () { $("form-submit").disabled = false; });
  }

  function resetShortcuts() {
    if (!window.confirm("등록된 바로가기를 모두 지우고 기본 링크로 되돌립니다. 계속할까요?")) return;
    api("/api/shortcuts/reset", { method: "POST", body: {} })
      .then(function (data) { applyShortcuts(data.shortcuts); toast("기본값으로 복원했습니다.", "ok"); })
      .catch(function (err) { toast(err.message, "err"); });
  }

  function exportJson() {
    api("/api/shortcuts").then(function (data) {
      var blob = new Blob([JSON.stringify(data.shortcuts, null, 2)],
                          { type: "application/json;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var anchor = el("a", { href: url, attrs: { download: "dc-service-shortcuts.json" } });
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
      toast("JSON 파일로 내보냈습니다.", "ok");
    }).catch(function (err) { toast(err.message, "err"); });
  }

  function importJson(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try { parsed = JSON.parse(String(reader.result)); }
      catch (e) { toast("JSON 파일을 해석할 수 없습니다.", "err"); return; }
      api("/api/import", { method: "POST", body: { shortcuts: parsed } })
        .then(function (data) {
          applyShortcuts(data.shortcuts);
          toast(data.shortcuts.length + "개를 가져왔습니다.", "ok");
        })
        .catch(function (err) { toast(err.message, "err"); });
    };
    reader.readAsText(file);
  }

  /* ---------------- 라우팅 ---------------- */

  function navigate(tab) {
    if (TABS.indexOf(tab) === -1) tab = "dashboard";
    var target = "#/" + tab;
    if (window.location.hash !== target) { window.location.hash = target; return; }
    applyTab(tab);
  }

  function applyTab(tab, pane) {
    state.tab = tab;
    if (pane) state.settingsPane = pane;
    TABS.forEach(function (name) { $("view-" + name).hidden = name !== tab; });
    var links = document.querySelectorAll(".tab");
    for (var i = 0; i < links.length; i += 1) {
      links[i].classList.toggle("active", links[i].getAttribute("data-tab") === tab);
    }
    $("btn-settings").classList.toggle("active", tab === "settings");
    renderAll();
    if (tab === "health" && !state.history) loadHistory();
    if (tab === "settings") loadSettings();
  }

  function onHashChange() {
    var raw = (window.location.hash || "").replace(/^#\/?/, "");
    var parts = raw.split("/");
    var tab = TABS.indexOf(parts[0]) === -1 ? "dashboard" : parts[0];
    if (tab === "settings" && !state.session) {
      // 로그인 전에는 설정 화면을 열지 않는다(서버도 차단하지만 화면부터 막는다).
      openLogin(parts[1]);
      applyTab("dashboard");
      return;
    }
    applyTab(tab, parts[1]);
  }

  function renderAll() {
    if (state.tab === "dashboard") renderDashboard();
    else if (state.tab === "datacenters") renderDatacenters();
    else if (state.tab === "health") renderHealth();
    else if (state.tab === "settings") renderSettings();
  }

  /* ---------------- 부트스트랩 ---------------- */

  function bindEvents() {
    $("search-input").addEventListener("input", function (event) {
      state.search = event.target.value;
      if (state.tab !== "dashboard") navigate("dashboard");
      else renderDashboard();
    });
    $("clear-search").addEventListener("click", function () {
      state.search = "";
      $("search-input").value = "";
      renderDashboard();
    });
    $("dc-search").addEventListener("input", function (event) {
      state.dcSearch = event.target.value;
      renderDatacenters();
    });

    // 설정 메뉴
    $("btn-settings").addEventListener("click", function (event) {
      event.stopPropagation();
      if (!state.session) { openLogin(); return; }
      openMenu($("settings-panel").hidden);
    });
    document.addEventListener("click", function (event) {
      if (!$("settings-menu").contains(event.target)) openMenu(false);
    });
    var menuItems = document.querySelectorAll("[data-settings]");
    for (var i = 0; i < menuItems.length; i += 1) {
      (function (button) {
        button.addEventListener("click", function () {
          openMenu(false);
          goSettings(button.getAttribute("data-settings"));
        });
      })(menuItems[i]);
    }
    $("btn-logout").addEventListener("click", logout);
    $("empty-settings").addEventListener("click", function () {
      requireSession(function () { goSettings("shortcuts"); });
    });

    // 로그인 모달
    $("login-submit").addEventListener("click", submitLogin);
    $("login-cancel").addEventListener("click", function () { $("login-modal").hidden = true; });
    $("login-input").addEventListener("keydown", function (event) {
      if (event.key === "Enter") submitLogin();
    });

    // 링크 점검
    $("btn-check-now").addEventListener("click", runHealthCheck);
    $("history-target").addEventListener("change", function (event) {
      state.historyTarget = event.target.value;
      loadHistory();
    });

    // 설정 폼
    $("shortcut-form").addEventListener("submit", submitForm);
    $("form-cancel").addEventListener("click", resetForm);
    $("btn-reset").addEventListener("click", resetShortcuts);
    $("btn-export").addEventListener("click", exportJson);
    $("btn-import").addEventListener("click", function () { $("import-file").click(); });
    $("import-file").addEventListener("change", function (event) {
      var file = event.target.files && event.target.files[0];
      if (file) importJson(file);
      event.target.value = "";
    });

    $("dc-form").addEventListener("submit", submitDcForm);
    $("dc-form-cancel").addEventListener("click", resetDcForm);
    $("btn-dc-reset").addEventListener("click", function () {
      if (!window.confirm("데이터센터 목록을 기본 28개로 되돌립니다. 계속할까요?")) return;
      api("/api/settings/datacenters/reset", { method: "POST", body: {} })
        .then(function (data) {
          state.datacenters = data.datacenters;
          fillFormSelects();
          toast("기본 28개로 복원했습니다.", "ok");
          return api("/api/datacenters");
        })
        .then(function (data) { state.dcSummary = data.summary; renderAll(); })
        .catch(function (err) { toast(err.message, "err"); });
    });

    $("user-form").addEventListener("submit", submitUserForm);
    $("b-save").addEventListener("click", saveBackupSettings);
    $("b-now").addEventListener("click", backupNow);
    $("h-save").addEventListener("click", saveHealthSettings);

    $("token-save").addEventListener("click", function () {
      var value = $("token-input").value.trim();
      if (!value) return;
      window.localStorage.setItem(HUB_TOKEN_KEY, value);
      $("token-modal").hidden = true;
      bootstrap();
    });

    window.addEventListener("hashchange", onHashChange);
  }

  function bootstrap() {
    Promise.all([api("/api/meta", { quiet: true }), api("/api/datacenters"), api("/api/shortcuts")])
      .then(function (results) {
        state.meta = results[0];
        state.categories = results[0].categories || [];
        state.session = results[0].session || null;
        state.initialPasswordFile = results[0].initialPasswordFile;
        state.datacenters = results[1].datacenters || [];
        state.dcSummary = results[1].summary || null;
        if (!state.selectedDcId && state.datacenters.length) {
          state.selectedDcId = state.datacenters[0].id;
        }
        $("dc-count-chip").textContent = state.datacenters.length + "개 DC";
        fillFormSelects();
        renderSessionUi();
        applyShortcuts(results[2].shortcuts || []);
        return loadLatest();
      })
      .then(function () {
        onHashChange();
        if (state.session) loadSettings();
      })
      .catch(function (err) {
        if (err.message.indexOf("토큰") === -1) toast(err.message, "err");
      });

    // 링크 점검 화면을 보고 있으면 주기적으로 최신 데이터를 당겨온다.
    if (!bootstrap.timer) {
      bootstrap.timer = setInterval(function () {
        if (state.tab !== "health" || document.hidden) return;
        loadLatest().then(function () { return loadHistory(); });
      }, 30000);
    }
  }

  bindEvents();
  bootstrap();
})();
