/* 글로벌 데이터센터 서비스 허브 — 프런트엔드(프레임워크·번들러 없음)
 *
 * 사용자 입력(이름/URL/설명/태그)은 전부 textContent 로만 넣는다. innerHTML 로 조립하면
 * 바로가기 이름 한 줄로 XSS 가 열린다.
 */
(function () {
  "use strict";

  var TOKEN_KEY = "hub_token";
  var TABS = ["dashboard", "datacenters", "health", "settings"];

  var CATEGORY_CLASS = {
    "Monitoring & Metrics": "cat-monitoring",
    "Infrastructure & DCIM": "cat-infra",
    "Network & Traffic": "cat-network",
    "Security & IAM": "cat-security",
    "Incidents & Operations": "cat-incident",
    "Storage & Backup": "cat-storage",
    "Custom Shortcuts": "cat-custom"
  };

  var REGION_COLOR = {
    APAC: "#38bdf8",
    EMEA: "#34d399",
    AMER: "#a78bfa",
    LATAM: "#fbbf24"
  };

  var HEALTH_LABEL = {
    healthy: "정상",
    warning: "확인 필요",
    unreachable: "응답 없음",
    blocked: "차단됨"
  };

  var state = {
    tab: "dashboard",
    shortcuts: [],
    datacenters: [],
    dcSummary: null,
    categories: [],
    meta: null,
    category: "ALL",
    region: "ALL",
    search: "",
    dcSearch: "",
    selectedDcId: null,
    health: {},            // shortcutId -> result
    healthList: [],
    healthCheckedAt: "",
    editingId: null,
    busy: false
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
    if (opts.attrs) {
      Object.keys(opts.attrs).forEach(function (key) { node.setAttribute(key, opts.attrs[key]); });
    }
    if (opts.on) {
      Object.keys(opts.on).forEach(function (evt) { node.addEventListener(evt, opts.on[evt]); });
    }
    (children || []).forEach(function (child) {
      if (child) node.appendChild(child);
    });
    return node;
  }

  function svgEl(tag, attrs) {
    var node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.keys(attrs || {}).forEach(function (key) { node.setAttribute(key, attrs[key]); });
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  var toastTimer = null;
  function toast(message, kind) {
    var box = $("toast");
    box.textContent = message;
    box.className = "toast " + (kind || "");
    box.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.hidden = true; }, 3200);
  }

  /* ---------------- API ---------------- */

  function token() { return window.localStorage.getItem(TOKEN_KEY) || ""; }

  function api(path, options) {
    options = options || {};
    var headers = { "Accept": "application/json" };
    if (options.body) headers["Content-Type"] = "application/json";
    var stored = token();
    if (stored) headers["X-Hub-Token"] = stored;

    return fetch(path, {
      method: options.method || "GET",
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    }).then(function (res) {
      if (res.status === 401) {
        $("token-modal").hidden = false;
        throw new Error("접근 토큰이 필요합니다.");
      }
      return res.json().catch(function () {
        throw new Error("서버 응답을 해석할 수 없습니다.");
      }).then(function (data) {
        if (!res.ok || data.success === false) {
          throw new Error(data.error || ("요청 실패 (HTTP " + res.status + ")"));
        }
        return data;
      });
    });
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
    var label = HEALTH_LABEL[result.status] || result.status;
    var text = label;
    if (result.statusCode) text += " · " + result.statusCode;
    if (result.status === "healthy" && result.latencyMs != null) text += " · " + result.latencyMs + "ms";
    return el("span", {
      className: "sc-health h-" + result.status,
      text: text,
      title: result.message || ""
    });
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
      className: "iconbtn" + (sc.isFavorite ? " on" : ""),
      text: "★",
      type: "button",
      title: sc.isFavorite ? "즐겨찾기 해제" : "즐겨찾기 등록",
      on: { click: function () { toggleFavorite(sc); } }
    });
    var editBtn = el("button", {
      className: "iconbtn", text: "✎", type: "button", title: "수정",
      on: { click: function () { startEdit(sc.id); } }
    });
    var delBtn = el("button", {
      className: "iconbtn danger", text: "🗑", type: "button", title: "삭제",
      on: { click: function () { removeShortcut(sc); } }
    });

    var launch = el("a", {
      className: "btn btn-primary btn-sm",
      text: "바로가기 ↗",
      href: sc.url,
      attrs: { target: "_blank", rel: "noopener noreferrer" }
    });

    var tags = el("div", { className: "sc-tags" },
      (sc.tags || []).map(function (tag) { return el("span", { className: "tag", text: "#" + tag }); }));

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
        tags
      ]),
      el("div", { className: "sc-foot" }, [
        el("span", { className: "sc-url", text: sc.url.replace(/^https?:\/\//, ""), title: sc.url }),
        el("div", { className: "sc-actions" }, [healthBadge(sc), launch])
      ])
    ]);
  }

  /* ---------------- 대시보드 ---------------- */

  function renderDashboard() {
    var favorites = state.shortcuts.filter(function (sc) { return sc.isFavorite; });
    var favSection = $("favorites-section");
    var showFavorites = favorites.length > 0 && !state.search && state.category === "ALL";
    favSection.hidden = !showFavorites;
    if (showFavorites) {
      $("favorites-count").textContent = favorites.length + "개";
      var favGrid = $("favorites-grid");
      clear(favGrid);
      favorites.forEach(function (sc) { favGrid.appendChild(shortcutCard(sc)); });
    }

    var pills = $("category-pills");
    clear(pills);
    var entries = [{ key: "ALL", label: "전체 서비스" }].concat(state.categories);
    entries.forEach(function (entry) {
      var count = entry.key === "ALL"
        ? state.shortcuts.length
        : state.shortcuts.filter(function (sc) { return sc.category === entry.key; }).length;
      pills.appendChild(el("button", {
        className: "pill" + (state.category === entry.key ? " active" : ""),
        type: "button",
        on: { click: function () { state.category = entry.key; renderDashboard(); } }
      }, [
        el("span", { text: entry.label }),
        el("span", { className: "pill-count", text: String(count) })
      ]));
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

    // 경위도 격자 — 좌표 감각을 주는 최소 배경(외부 지도 타일을 받지 않는다).
    for (var lng = -150; lng <= 150; lng += 30) {
      svg.appendChild(svgEl("line", {
        class: "map-grid-line", x1: projectX(lng), y1: 0, x2: projectX(lng), y2: 460
      }));
    }
    for (var lat = -60; lat <= 60; lat += 30) {
      svg.appendChild(svgEl("line", {
        class: "map-grid-line", x1: 0, y1: projectY(lat), x2: 1000, y2: projectY(lat)
      }));
    }

    // 리전 경계 상자 — 경도/위도를 그대로 투영해 점 위치와 어긋나지 않게 계산한다.
    var zones = [
      { label: "AMER", lng: [-170, -50], lat: [72, 12] },
      { label: "EMEA", lng: [-25, 60], lat: [70, -38] },
      { label: "APAC", lng: [60, 180], lat: [58, -48] },
      { label: "LATAM", lng: [-95, -33], lat: [10, -57] }
    ];
    zones.forEach(function (zone) {
      var x = projectX(zone.lng[0]);
      var y = projectY(zone.lat[0]);
      var w = projectX(zone.lng[1]) - x;
      var h = projectY(zone.lat[1]) - y;
      svg.appendChild(svgEl("rect", {
        class: "map-zone", x: x, y: y, width: w, height: h, rx: 16
      }));
      var label = svgEl("text", { class: "map-zone-label", x: x + 10, y: y + 20 });
      label.textContent = zone.label;
      svg.appendChild(label);
    });

    list.forEach(function (dc) {
      var x = projectX(dc.lng);
      var y = projectY(dc.lat);
      var color = REGION_COLOR[dc.region] || "#60a5fa";
      var group = svgEl("g", {
        class: "map-dot" + (state.selectedDcId === dc.id ? " selected" : "")
      });
      group.appendChild(svgEl("circle", { class: "halo", cx: x, cy: y, r: 11, fill: color }));
      group.appendChild(svgEl("circle", { class: "core", cx: x, cy: y, r: 4.5, fill: color }));
      var label = svgEl("text", { x: x + 8, y: y + 3.5 });
      label.textContent = dc.code;
      group.appendChild(label);
      var tooltip = svgEl("title", {});
      tooltip.textContent = dc.code + " · " + dc.city + " (" + dc.country + ")";
      group.appendChild(tooltip);
      group.addEventListener("click", function () {
        state.selectedDcId = dc.id;
        renderDatacenters();
      });
      svg.appendChild(group);
    });

    var legend = $("map-legend");
    clear(legend);
    Object.keys(REGION_COLOR).forEach(function (region) {
      var mark = el("i");
      mark.style.background = REGION_COLOR[region];
      legend.appendChild(el("span", {}, [mark, el("span", { text: region })]));
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

    var linked = state.shortcuts.filter(function (sc) {
      return sc.datacenterId === dc.id;
    });
    var global = state.shortcuts.filter(function (sc) {
      return !sc.datacenterId || sc.datacenterId === "all";
    });

    box.appendChild(el("h3", { text: dc.code + " · " + dc.name }));
    box.appendChild(el("p", { className: "muted", text: dc.city + " · " + dc.country }));

    var rows = [
      ["리전", dc.region],
      ["상태", dc.status],
      ["PUE", String(dc.pue)],
      ["랙 수", Number(dc.racks).toLocaleString()],
      ["관리 대역", dc.primarySubnet || "-"],
      ["좌표", Number(dc.lat).toFixed(2) + ", " + Number(dc.lng).toFixed(2)]
    ];
    rows.forEach(function (row) {
      box.appendChild(el("div", { className: "kv" }, [
        el("span", { text: row[0] }), el("span", { text: row[1] })
      ]));
    });

    box.appendChild(el("div", { className: "section-head", text: "이 센터 전용 링크 (" + linked.length + ")" }));
    var linkWrap = el("div", { className: "dc-links" });
    if (linked.length === 0) {
      linkWrap.appendChild(el("p", { className: "muted", text: "전용 링크가 없습니다. 설정에서 '연결 데이터센터'를 지정해 추가하세요." }));
    }
    linked.forEach(function (sc) {
      linkWrap.appendChild(el("a", {
        className: "dc-link", href: sc.url, attrs: { target: "_blank", rel: "noopener noreferrer" }
      }, [el("span", { text: sc.icon || "🔗" }), el("span", { text: sc.name })]));
    });
    box.appendChild(linkWrap);

    box.appendChild(el("div", { className: "section-head", text: "전체 공통 링크 (" + global.length + ")" }));
    var globalWrap = el("div", { className: "dc-links" });
    global.slice(0, 6).forEach(function (sc) {
      globalWrap.appendChild(el("a", {
        className: "dc-link", href: sc.url, attrs: { target: "_blank", rel: "noopener noreferrer" }
      }, [el("span", { text: sc.icon || "🔗" }), el("span", { text: sc.name })]));
    });
    box.appendChild(globalWrap);
  }

  function renderDatacenters() {
    var stats = $("dc-stats");
    clear(stats);
    var sum = state.dcSummary;
    if (sum) {
      [
        ["운영 데이터센터", sum.operational + " / " + sum.total, "정상 가동", "v-emerald"],
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
    var regions = ["ALL"].concat((state.meta && state.meta.regions) || []);
    regions.forEach(function (region) {
      var count = region === "ALL"
        ? state.datacenters.length
        : state.datacenters.filter(function (dc) { return dc.region === region; }).length;
      regionPills.appendChild(el("button", {
        className: "pill" + (state.region === region ? " active" : ""),
        type: "button",
        on: { click: function () { state.region = region; renderDatacenters(); } }
      }, [
        el("span", { text: region === "ALL" ? "전체" : region }),
        el("span", { className: "pill-count", text: String(count) })
      ]));
    });

    var query = state.dcSearch.toLowerCase();
    var list = state.datacenters.filter(function (dc) {
      var byRegion = state.region === "ALL" || dc.region === state.region;
      var bySearch = !query || [dc.name, dc.city, dc.country, dc.code].join(" ").toLowerCase().indexOf(query) !== -1;
      return byRegion && bySearch;
    });

    renderMap(list);

    var listBox = $("dc-list");
    clear(listBox);
    list.forEach(function (dc) {
      listBox.appendChild(el("button", {
        className: "dc-card" + (state.selectedDcId === dc.id ? " active" : ""),
        type: "button",
        on: { click: function () { state.selectedDcId = dc.id; renderDatacenters(); } }
      }, [
        el("div", { className: "dc-card-top" }, [
          el("span", { className: "dc-code", text: dc.code }),
          el("span", { className: "status-dot st-" + dc.status, title: dc.status })
        ]),
        el("div", { className: "dc-name", text: dc.city }),
        el("div", { className: "dc-meta" }, [
          el("span", { text: dc.region }),
          el("span", { text: "PUE " + dc.pue }),
          el("span", { text: dc.racks + " racks" })
        ])
      ]));
    });
    if (list.length === 0) {
      listBox.appendChild(el("p", { className: "muted", text: "조건에 맞는 데이터센터가 없습니다." }));
    }

    dcDetail(dcById(state.selectedDcId) || list[0] || null);
  }

  /* ---------------- 링크 점검 화면 ---------------- */

  function renderHealth() {
    var counts = { healthy: 0, warning: 0, unreachable: 0, blocked: 0 };
    state.healthList.forEach(function (row) {
      if (counts[row.status] != null) counts[row.status] += 1;
    });
    var latencies = state.healthList
      .filter(function (row) { return row.status === "healthy" && row.latencyMs != null; })
      .map(function (row) { return row.latencyMs; });
    var avg = latencies.length
      ? Math.round(latencies.reduce(function (a, b) { return a + b; }, 0) / latencies.length)
      : null;

    var stats = $("health-stats");
    clear(stats);
    [
      ["정상", String(counts.healthy), "2xx/3xx", "v-emerald"],
      ["확인 필요", String(counts.warning), "4xx/5xx", "v-amber"],
      ["응답 없음", String(counts.unreachable), "연결 실패", "v-rose"],
      ["차단됨", String(counts.blocked), "SSRF 가드", "v-indigo"],
      ["평균 지연", avg == null ? "-" : avg + "ms", "정상 응답 기준", "v-blue"]
    ].forEach(function (row) {
      stats.appendChild(el("div", { className: "stat" }, [
        el("div", { className: "stat-label", text: row[0] }),
        el("div", { className: "stat-value " + row[3], text: row[1] }),
        el("div", { className: "stat-note", text: row[2] })
      ]));
    });

    var body = $("health-tbody");
    clear(body);
    state.healthList.forEach(function (row) {
      var sc = null;
      for (var i = 0; i < state.shortcuts.length; i += 1) {
        if (state.shortcuts[i].id === row.id) { sc = state.shortcuts[i]; break; }
      }
      body.appendChild(el("tr", {}, [
        el("td", { text: sc ? sc.name : "(삭제됨)" }),
        el("td", { className: "url", text: row.url, title: row.url }),
        el("td", {}, [el("span", {
          className: "sc-health h-" + row.status,
          text: HEALTH_LABEL[row.status] || row.status
        })]),
        el("td", { text: row.statusCode ? String(row.statusCode) : "-" }),
        el("td", { text: row.latencyMs != null ? row.latencyMs + "ms" : "-" }),
        el("td", { className: "muted", text: row.message || "" })
      ]));
    });

    var hasRows = state.healthList.length > 0;
    $("health-empty").hidden = hasRows;
    $("health-table").hidden = !hasRows;
    $("health-time").textContent = state.healthCheckedAt ? "점검 시각 " + state.healthCheckedAt : "";
  }

  /* ---------------- 설정 화면 ---------------- */

  function fillFormSelects() {
    var categorySelect = $("f-category");
    clear(categorySelect);
    state.categories.forEach(function (cat) {
      categorySelect.appendChild(el("option", { value: cat.key, text: cat.label }));
    });
    categorySelect.value = "Custom Shortcuts";

    var dcSelect = $("f-datacenter");
    clear(dcSelect);
    dcSelect.appendChild(el("option", { value: "all", text: "전체 공통 (모든 DC)" }));
    state.datacenters.forEach(function (dc) {
      dcSelect.appendChild(el("option", { value: dc.id, text: dc.code + " · " + dc.city }));
    });
  }

  function resetForm() {
    state.editingId = null;
    $("shortcut-form").reset();
    $("f-category").value = "Custom Shortcuts";
    $("f-datacenter").value = "all";
    $("form-title").textContent = "새 바로가기 등록";
    $("form-submit").textContent = "바로가기 생성";
    $("form-cancel").hidden = true;
    $("form-msg").textContent = "";
    $("form-msg").className = "form-msg";
  }

  function startEdit(id) {
    var sc = null;
    for (var i = 0; i < state.shortcuts.length; i += 1) {
      if (state.shortcuts[i].id === id) { sc = state.shortcuts[i]; break; }
    }
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
    $("form-msg").textContent = "";
    navigate("settings");
    $("f-name").focus();
  }

  function renderSettings() {
    $("settings-count").textContent = "(" + state.shortcuts.length + "개)";
    var body = $("settings-tbody");
    clear(body);

    if (state.shortcuts.length === 0) {
      body.appendChild(el("tr", {}, [
        el("td", { className: "muted", text: "등록된 바로가기가 없습니다.", attrs: { colspan: "4" } })
      ]));
      return;
    }

    state.shortcuts.forEach(function (sc) {
      body.appendChild(el("tr", {}, [
        el("td", {}, [
          el("span", { text: (sc.icon || "🔗") + " " }),
          el("strong", { text: sc.name }),
          sc.isFavorite ? el("span", { className: "badge badge-user", text: "★" }) : null
        ]),
        el("td", { className: "url", text: sc.url, title: sc.url }),
        el("td", {}, [el("span", {
          className: "badge " + (CATEGORY_CLASS[sc.category] || "cat-custom"),
          text: categoryLabel(sc.category)
        })]),
        el("td", {}, [el("div", { className: "row-actions" }, [
          el("button", {
            className: "btn btn-ghost btn-sm", type: "button", text: "수정",
            on: { click: function () { startEdit(sc.id); } }
          }),
          el("button", {
            className: "btn btn-danger btn-sm", type: "button", text: "삭제",
            on: { click: function () { removeShortcut(sc); } }
          })
        ])])
      ]));
    });
  }

  /* ---------------- 데이터 변경 ---------------- */

  function applyShortcuts(list) {
    state.shortcuts = list || [];
    $("tab-count").textContent = String(state.shortcuts.length);
    $("footer-meta").textContent = "바로가기 " + state.shortcuts.length + "개 · 데이터센터 "
      + state.datacenters.length + "개"
      + (state.meta ? " · v" + state.meta.version : "");
    renderAll();
  }

  function toggleFavorite(sc) {
    api("/api/shortcuts/" + encodeURIComponent(sc.id), {
      method: "PUT", body: { isFavorite: !sc.isFavorite }
    }).then(function (data) {
      applyShortcuts(data.shortcuts);
    }).catch(function (err) { toast(err.message, "err"); });
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
    var msg = $("form-msg");
    var payload = {
      name: $("f-name").value,
      url: $("f-url").value,
      category: $("f-category").value,
      icon: $("f-icon").value,
      description: $("f-description").value,
      tags: $("f-tags").value,
      datacenterId: $("f-datacenter").value,
      isFavorite: $("f-favorite").checked
    };
    if (!payload.name.trim() || !payload.url.trim()) {
      msg.textContent = "이름과 URL은 필수입니다.";
      msg.className = "form-msg err";
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
      msg.textContent = err.message;
      msg.className = "form-msg err";
    }).then(function () {
      $("form-submit").disabled = false;
    });
  }

  function runHealthCheck() {
    if (state.busy) return;
    if (state.shortcuts.length === 0) {
      toast("점검할 바로가기가 없습니다.", "err");
      return;
    }
    state.busy = true;
    $("btn-check-all").disabled = true;
    $("btn-check-all-2").disabled = true;
    toast("링크 점검 중…");

    api("/api/health/check", { method: "POST", body: {} })
      .then(function (data) {
        state.healthList = data.results || [];
        state.healthCheckedAt = data.checkedAt || "";
        state.health = {};
        state.healthList.forEach(function (row) {
          if (row.id) state.health[row.id] = row;
        });
        renderAll();
        var down = state.healthList.filter(function (row) { return row.status !== "healthy"; }).length;
        toast(down === 0
          ? "전체 " + state.healthList.length + "개 링크 정상"
          : state.healthList.length + "개 중 " + down + "개 확인 필요", down === 0 ? "ok" : "err");
        navigate("health");
      })
      .catch(function (err) { toast(err.message, "err"); })
      .then(function () {
        state.busy = false;
        $("btn-check-all").disabled = false;
        $("btn-check-all-2").disabled = false;
      });
  }

  function resetShortcuts() {
    if (!window.confirm("등록된 바로가기를 모두 지우고 기본 링크로 되돌립니다. 계속할까요?")) return;
    api("/api/shortcuts/reset", { method: "POST" })
      .then(function (data) { applyShortcuts(data.shortcuts); toast("기본값으로 복원했습니다.", "ok"); })
      .catch(function (err) { toast(err.message, "err"); });
  }

  function exportJson() {
    // 링크로 직접 열면 X-Hub-Token 헤더가 실리지 않는다 — 받아서 Blob 으로 내려준다.
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
      try {
        parsed = JSON.parse(String(reader.result));
      } catch (e) {
        toast("JSON 파일을 해석할 수 없습니다.", "err");
        return;
      }
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
    if (window.location.hash !== "#/" + tab) {
      window.location.hash = "#/" + tab;
      return;              // hashchange 가 다시 부른다
    }
    applyTab(tab);
  }

  function applyTab(tab) {
    state.tab = tab;
    TABS.forEach(function (name) {
      $("view-" + name).hidden = name !== tab;
    });
    var links = document.querySelectorAll(".tab");
    for (var i = 0; i < links.length; i += 1) {
      links[i].classList.toggle("active", links[i].getAttribute("data-tab") === tab);
    }
    renderAll();
  }

  function onHashChange() {
    var raw = (window.location.hash || "").replace(/^#\/?/, "");
    applyTab(TABS.indexOf(raw) === -1 ? "dashboard" : raw);
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
    $("btn-check-all").addEventListener("click", runHealthCheck);
    $("btn-check-all-2").addEventListener("click", runHealthCheck);
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
    $("token-save").addEventListener("click", function () {
      var value = $("token-input").value.trim();
      if (!value) return;
      window.localStorage.setItem(TOKEN_KEY, value);
      $("token-modal").hidden = true;
      bootstrap();
    });
    window.addEventListener("hashchange", onHashChange);
  }

  function bootstrap() {
    Promise.all([api("/api/meta"), api("/api/datacenters"), api("/api/shortcuts")])
      .then(function (results) {
        state.meta = results[0];
        state.categories = results[0].categories || [];
        state.datacenters = results[1].datacenters || [];
        state.dcSummary = results[1].summary || null;
        if (!state.selectedDcId && state.datacenters.length) {
          state.selectedDcId = state.datacenters[0].id;
        }
        $("dc-count-chip").textContent = state.datacenters.length + "개 DC";
        fillFormSelects();
        applyShortcuts(results[2].shortcuts || []);
      })
      .catch(function (err) {
        if (err.message.indexOf("토큰") === -1) toast(err.message, "err");
      });
  }

  bindEvents();
  onHashChange();
  bootstrap();
})();
