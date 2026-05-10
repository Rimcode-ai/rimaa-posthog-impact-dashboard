/* PostHog Engineering Impact dashboard, client boot.
   Renders Leadership Brief + Explore + Ask AI from data.json (slim) and data.full.json (lazy).
   Tailwind handles layout. This file handles render, hash routing, the network viz, the compare radar. */

(function () {
  "use strict";

  // ---------- constants ----------
  var SIGNAL_KEYS = ["surviving_code", "review_leverage", "cross_area", "incident_work", "review_centrality"];
  var SIGNAL_LABEL = {
    surviving_code: "code",
    review_leverage: "review",
    cross_area: "breadth",
    incident_work: "incidents",
    review_centrality: "central"
  };
  var SIGNAL_COLOR = {
    surviving_code: "#0ea5e9",
    review_leverage: "#8b5cf6",
    cross_area: "#10b981",
    incident_work: "#f43f5e",
    review_centrality: "#f59e0b"
  };
  var STAT_LABEL = {
    surviving_code: "lines (capped)",
    review_leverage: "deep reviews",
    cross_area: "areas",
    incident_work: "incident PRs",
    review_centrality: "PageRank"
  };

  // ---------- module-scope ----------
  var d3Module = null;
  var d3Promise = null;
  var fullPromise = null;
  var fullData = null;
  var slim = null;
  var compareSelections = []; // up to 2 logins
  var sortState = { key: "score", dir: "desc" };
  var weightsState = null;

  // ---------- utilities ----------
  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
  function fmt(n, d) {
    if (n === null || n === undefined || isNaN(n)) return "-";
    if (d === undefined) d = 0;
    return Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function pct(x, d) { d = d === undefined ? 1 : d; return (x * 100).toFixed(d) + "%"; }
  function el(tag, props, children) {
    var n = document.createElement(tag);
    if (props) {
      for (var k in props) {
        if (k === "class") n.className = props[k];
        else if (k === "html") n.innerHTML = props[k];
        else if (k === "text") n.textContent = props[k];
        else if (k === "style") n.setAttribute("style", props[k]);
        else if (k.indexOf("on") === 0 && typeof props[k] === "function") n.addEventListener(k.slice(2), props[k]);
        else if (props[k] !== null && props[k] !== undefined) n.setAttribute(k, props[k]);
      }
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (c === null || c === undefined) return;
        n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      });
    }
    return n;
  }
  function avatar(login, size) {
    size = size || 80;
    var img = el("img", {
      src: "https://avatars.githubusercontent.com/" + login + "?s=" + size,
      alt: login,
      width: size, height: size,
      loading: "lazy",
      decoding: "async",
      class: "rounded-full bg-slate-100"
    });
    return img;
  }
  function ghLink(login, content, extraClass) {
    return el("a", {
      href: "https://github.com/" + login,
      target: "_blank",
      rel: "noopener",
      class: "font-semibold text-slate-900 hover:text-sky-700 " + (extraClass || "")
    }, content || login);
  }

  // Minimal markdown for exec_brief: [text](url) and **bold**, everything else as plain text.
  function renderInlineMd(text) {
    var frag = document.createDocumentFragment();
    var rest = text;
    var re = /(\*\*([^*]+)\*\*)|(\[([^\]]+)\]\(([^)]+)\))/;
    while (rest.length) {
      var m = rest.match(re);
      if (!m) { frag.appendChild(document.createTextNode(rest)); break; }
      if (m.index > 0) frag.appendChild(document.createTextNode(rest.slice(0, m.index)));
      if (m[1]) {
        var b = el("strong"); b.textContent = m[2]; frag.appendChild(b);
      } else {
        var a = el("a", { href: m[5], target: "_blank", rel: "noopener", class: "text-sky-700 hover:underline" });
        a.textContent = m[4]; frag.appendChild(a);
      }
      rest = rest.slice(m.index + m[0].length);
    }
    return frag;
  }

  // ---------- header meta line ----------
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function buildMetaLine(d) {
    var t = new Date(d.generated_at);
    var s = t.getUTCFullYear() + "-" + pad(t.getUTCMonth() + 1) + "-" + pad(t.getUTCDate())
          + " " + pad(t.getUTCHours()) + ":" + pad(t.getUTCMinutes()) + " UTC";
    return d.n_prs + " merged PRs · " + d.n_eligible + " eligible engineers · Updated at " + s;
  }

  // ---------- Tabs / hash routing ----------
  var TABS = ["brief", "explore", "ask"];
  function activateTab(name) {
    if (TABS.indexOf(name) === -1) name = "brief";
    if (name === "ask" && !window.ASSISTANT_URL) name = "brief";
    TABS.forEach(function (t) {
      var sec = document.getElementById("tab-" + t);
      if (!sec) return;
      sec.classList.toggle("hidden", t !== name);
    });
    $$("#pill-nav .pill").forEach(function (p) {
      p.classList.toggle("is-active", p.dataset.tab === name);
      p.setAttribute("aria-selected", p.dataset.tab === name ? "true" : "false");
    });
    if (name === "explore") onExploreActivate();
  }
  function readHash() {
    var h = (location.hash || "#brief").replace(/^#/, "");
    if (h === "methodology") { openMethodology(); return; }
    activateTab(h);
  }

  // ---------- Methodology modal ----------
  var modalLastFocus = null;
  function openMethodology() {
    var m = $("#methodology-modal");
    m.classList.remove("hidden");
    m.setAttribute("aria-hidden", "false");
    modalLastFocus = document.activeElement;
    document.body.style.overflow = "hidden";
    $("#methodology-close").focus();
    document.addEventListener("keydown", trapFocus, true);
  }
  function closeMethodology() {
    var m = $("#methodology-modal");
    m.classList.add("hidden");
    m.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    document.removeEventListener("keydown", trapFocus, true);
    if (modalLastFocus && modalLastFocus.focus) modalLastFocus.focus();
    if (location.hash === "#methodology") {
      history.replaceState(null, "", "#brief");
      activateTab("brief");
    }
  }
  function trapFocus(ev) {
    var m = $("#methodology-modal");
    if (m.classList.contains("hidden")) return;
    if (ev.key === "Escape") { ev.preventDefault(); closeMethodology(); return; }
    if (ev.key !== "Tab") return;
    var focusables = $$("#methodology-modal a[href], #methodology-modal button:not([disabled]), #methodology-modal [tabindex]:not([tabindex='-1'])");
    if (!focusables.length) return;
    var first = focusables[0], last = focusables[focusables.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  }
  function fillMethodologyBody() {
    var body = $("#methodology-body");
    body.innerHTML = "";
    if (!window.ASSISTANT_URL) {
      body.appendChild(el("p", { class: "text-xs text-slate-500" }, "Assistant: deferred for this run."));
    }
    var paras = [
      "This dashboard ranks active PostHog engineers in the trailing 90 days using a five-signal composite. We compute z-scores per signal across the eligible cohort, weight them, sum, and min-max normalize the result to a 0..100 score.",
      "Composite formula: score = w_code * z(surviving_code) + w_review * z(review_leverage) + w_breadth * z(cross_area) + w_incidents * z(incident_work) + w_central * z(review_centrality).",
      "Default weights: code 25%, review 25%, breadth 15%, incidents 20%, central 15%."
    ];
    paras.forEach(function (p) { body.appendChild(el("p", null, p)); });

    var sigDefs = el("div", null);
    sigDefs.appendChild(el("h3", { class: "font-semibold text-slate-900 mb-1" }, "Signal definitions"));
    var ul = el("ul", { class: "list-disc ml-5 flex flex-col gap-1" });
    [
      ["Surviving code", "Lines added that remain in HEAD, capped per PR."],
      ["Review leverage", "Substantive approvals authored on teammates' PRs (S2 + S5 contributes 40% of the composite)."],
      ["Cross-area breadth", "Distinct top-level areas an engineer touched in the window."],
      ["Incident work", "Merged PRs labelled or titled as fixes, regressions, hotfixes, or reverts."],
      ["Review centrality", "PageRank on the directed reviewer-author graph among eligible engineers."]
    ].forEach(function (r) { ul.appendChild(el("li", null, [el("strong", null, r[0] + ": "), r[1]])); });
    sigDefs.appendChild(ul);
    body.appendChild(sigDefs);

    body.appendChild(el("div", null, [
      el("h3", { class: "font-semibold text-slate-900 mb-1" }, "Eligibility"),
      el("p", null, "An engineer is eligible if they merged at least 3 PRs in the window and are not on the bot exclusion list.")
    ]));

    body.appendChild(el("div", null, [
      el("h3", { class: "font-semibold text-slate-900 mb-1" }, "Signal 3 exclusion list"),
      el("p", null, "The breadth signal ignores generic top-level areas. Excluded: .github, ci, scripts, tests, docs-only, and other non-product paths.")
    ]));

    var callouts = el("div", { class: "rounded-md bg-slate-50 border border-slate-200 p-3 flex flex-col gap-2" });
    callouts.appendChild(el("p", null, [el("strong", null, "Review-work share: "), "S2 (review leverage) and S5 (review centrality) together account for 40% of the composite at default weights."]));
    callouts.appendChild(el("p", null, [el("strong", null, "S1 cap, worked example: "), "the surviving-code signal caps per-PR contribution. A 12,000-line PR contributes the same as a 2,000-line PR."]));
    callouts.appendChild(el("p", null, [el("strong", null, "Revert multiplier: "), "incident-work credit is multiplied by 0.40 on PRs that were later reverted."]));
    body.appendChild(callouts);
  }

  // ---------- Render: header ----------
  function renderHeader(d) {
    $("#meta-line").textContent = buildMetaLine(d);
  }

  // ---------- Render: exec card ----------
  function renderExec(d) {
    var ul = $("#exec-bullets");
    ul.innerHTML = "";
    d.exec_brief.forEach(function (line) {
      var li = el("li", { class: "pl-3 border-l-2 border-sky-300" });
      li.appendChild(renderInlineMd(line));
      ul.appendChild(li);
    });
  }

  // ---------- Render: KPI tiles ----------
  function renderKPIs(d) {
    var host = $("#kpi-tiles");
    host.innerHTML = "";
    var tiles = [
      { label: "Merged PRs", value: fmt(d.n_prs) },
      { label: "Engineers ranked", value: fmt(d.n_eligible) },
      { label: "Signals combined", value: "5" },
      { label: "Top score", value: fmt(d.top5[0].score, 1), suffix: "/100" }
    ];
    tiles.forEach(function (t) {
      host.appendChild(el("div", { class: "kpi-tile" }, [
        el("div", { class: "text-[11px] uppercase tracking-wider text-slate-500" }, t.label),
        el("div", { class: "text-2xl font-semibold text-slate-900" }, [
          t.value,
          t.suffix ? el("span", { class: "text-sm text-slate-400 font-medium ml-1" }, t.suffix) : null
        ])
      ]));
    });
  }

  // ---------- Render: signal legend ----------
  function renderLegend(host) {
    host.innerHTML = "";
    SIGNAL_KEYS.forEach(function (k) {
      host.appendChild(el("span", { class: "inline-flex items-center gap-1.5", style: "color:" + SIGNAL_COLOR[k] }, [
        el("span", { class: "swatch" }),
        el("span", { class: "text-slate-600" }, SIGNAL_LABEL[k])
      ]));
    });
  }

  // ---------- Render: Sparkline ----------
  function sparkline(values, color, w, h) {
    w = w || 110; h = h || 28;
    var max = Math.max.apply(null, values), min = Math.min.apply(null, values);
    if (max === min) max = min + 1;
    var n = values.length;
    var pts = values.map(function (v, i) {
      var x = (i / (n - 1)) * (w - 2) + 1;
      var y = h - 1 - ((v - min) / (max - min)) * (h - 2);
      return [x, y];
    });
    var pathLine = "M " + pts.map(function (p) { return p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" L ");
    var pathArea = pathLine + " L " + (w - 1) + "," + (h - 1) + " L 1," + (h - 1) + " Z";
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", w); svg.setAttribute("height", h); svg.setAttribute("viewBox", "0 0 " + w + " " + h);
    svg.setAttribute("aria-hidden", "true");
    var area = document.createElementNS("http://www.w3.org/2000/svg", "path");
    area.setAttribute("d", pathArea); area.setAttribute("fill", color); area.setAttribute("fill-opacity", "0.18");
    var line = document.createElementNS("http://www.w3.org/2000/svg", "path");
    line.setAttribute("d", pathLine); line.setAttribute("fill", "none");
    line.setAttribute("stroke", color); line.setAttribute("stroke-width", "1.5");
    line.setAttribute("stroke-linejoin", "round"); line.setAttribute("stroke-linecap", "round");
    svg.appendChild(area); svg.appendChild(line);
    return svg;
  }

  // ---------- Render: Top-5 cards ----------
  function momentumChip(m) {
    var label = (m && m.label) || "steady";
    var glyph = "▶", cls = "bg-slate-100 text-slate-600";
    if (label === "accelerating") { glyph = "▲"; cls = "bg-emerald-50 text-emerald-700"; }
    else if (label === "cooling") { glyph = "▼"; cls = "bg-rose-50 text-rose-700"; }
    var span = el("span", {
      class: "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] " + cls,
      title: "last-7d vs prior-83d, z=" + (m && m.z !== undefined ? m.z : "0")
    }, [glyph + " " + label]);
    return span;
  }

  function contribBar(eng) {
    var pos = SIGNAL_KEYS.map(function (k) {
      var w = (slim.weights && slim.weights[k]) || 0;
      var z = (eng.z && eng.z[k]) || 0;
      return { key: k, val: Math.max(0, w * z) };
    });
    var total = pos.reduce(function (s, p) { return s + p.val; }, 0);
    var bar = el("div", { class: "contrib-bar" });
    if (total <= 0) {
      bar.appendChild(el("span", { style: "width:100%;background:#e2e8f0" }));
      return bar;
    }
    pos.forEach(function (p) {
      if (p.val <= 0) return;
      var w = (p.val / total) * 100;
      bar.appendChild(el("span", {
        style: "width:" + w.toFixed(2) + "%;background:" + SIGNAL_COLOR[p.key],
        title: SIGNAL_LABEL[p.key] + " · " + ((slim.weights[p.key] || 0) * 100).toFixed(0) + "% · z=" + (eng.z[p.key] !== undefined ? eng.z[p.key].toFixed(2) : "0")
      }));
    });
    return bar;
  }

  function statTile(eng, key) {
    var label = STAT_LABEL[key];
    var color = SIGNAL_COLOR[key];
    var v;
    if (key === "review_centrality") v = (eng.metrics[key] || 0).toFixed(3);
    else v = fmt(eng.metrics[key]);
    var dom = eng.primary_signal === key;
    var tile = el("div", {
      class: "stat-tile" + (dom ? " is-dominant" : ""),
      style: "color:" + color
    }, [
      el("div", { class: "text-[11px] uppercase tracking-wider", style: "color:" + color }, label),
      el("div", { class: "text-base font-semibold text-slate-900" }, v)
    ]);
    return tile;
  }

  function linkIconSvg() {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", "12"); svg.setAttribute("height", "12"); svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    var p1 = document.createElementNS(ns, "path");
    p1.setAttribute("d", "M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5");
    var p2 = document.createElementNS(ns, "path");
    p2.setAttribute("d", "M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5");
    svg.appendChild(p1); svg.appendChild(p2);
    return svg;
  }

  function revertGlyph() {
    return document.createTextNode("↩ ");
  }

  function renderEngineerCard(eng) {
    var dom = eng.primary_signal;
    var domColor = SIGNAL_COLOR[dom] || "#0ea5e9";
    var card = el("article", { class: "eng-card flex flex-col gap-3" });

    // top row
    var topRow = el("div", { class: "flex gap-3" });
    topRow.appendChild(avatar(eng.login, 80));
    var topRight = el("div", { class: "flex-1 min-w-0 flex flex-col gap-2" });

    var line1 = el("div", { class: "flex items-center justify-between gap-3 flex-wrap" });
    var headerLeft = el("div", { class: "flex items-center gap-2 flex-wrap" });
    headerLeft.appendChild(el("span", { class: "inline-flex items-center text-[11px] font-semibold bg-slate-900 text-white rounded px-1.5 py-0.5" }, "#" + eng.rank));
    headerLeft.appendChild(ghLink(eng.login, eng.login));
    headerLeft.appendChild(el("span", { class: "text-slate-300" }, "·"));
    headerLeft.appendChild(el("span", { class: "text-sm text-slate-600" }, fmt(eng.metrics.pr_count) + " merged PRs"));
    headerLeft.appendChild(momentumChip(eng.momentum));
    line1.appendChild(headerLeft);

    var headerRight = el("div", { class: "flex items-center gap-3" });
    headerRight.appendChild(sparkline(eng.weekly, domColor, 110, 28));
    headerRight.appendChild(el("div", { class: "text-right leading-tight" }, [
      el("div", { class: "text-2xl font-semibold text-slate-900" }, [fmt(eng.score, 1), el("span", { class: "text-sm text-slate-400 font-medium ml-1" }, "/100")]),
      el("div", { class: "text-[10px] text-slate-400" }, "composite z = " + fmt(eng.raw_composite, 2))
    ]));
    line1.appendChild(headerRight);
    topRight.appendChild(line1);

    topRight.appendChild(el("div", { class: "text-sm text-slate-800 font-medium" }, eng.headline));
    topRight.appendChild(el("div", { class: "text-sm text-slate-600" }, eng.one_liner));

    if (eng.peer_phrase) {
      topRight.appendChild(el("div", null, [
        el("span", {
          class: "inline-flex items-center gap-1.5 rounded-full bg-slate-50 border border-slate-200 px-2 py-0.5 text-xs",
          style: "color:" + domColor
        }, [
          el("span", { class: "swatch" }),
          el("span", { class: "text-slate-700" }, eng.peer_phrase)
        ])
      ]));
    }

    topRow.appendChild(topRight);
    card.appendChild(topRow);

    card.appendChild(contribBar(eng));

    // stat tiles row
    var tileRow = el("div", { class: "grid grid-cols-2 sm:grid-cols-5 gap-2" });
    SIGNAL_KEYS.forEach(function (k) { tileRow.appendChild(statTile(eng, k)); });
    card.appendChild(tileRow);

    // signature contribution
    var sig = el("div", { class: "signature-block", style: "color:" + domColor });
    sig.appendChild(el("div", { class: "text-[11px] font-semibold tracking-wider", style: "color:" + domColor }, "SIGNATURE CONTRIBUTION"));
    if (eng.signature_pr) {
      sig.appendChild(el("a", {
        href: eng.signature_pr.url, target: "_blank", rel: "noopener",
        class: "block text-sm font-medium text-slate-900 hover:text-sky-700 mt-1"
      }, eng.signature_pr.title));
    }
    var areaWrap = el("div", { class: "flex flex-wrap gap-1 mt-2" });
    (eng.areas || []).forEach(function (a) {
      areaWrap.appendChild(el("span", { class: "text-[11px] bg-white border border-slate-200 text-slate-600 rounded-full px-2 py-0.5" }, a));
    });
    sig.appendChild(areaWrap);
    card.appendChild(sig);

    // ALSO NOTABLE
    var alt = (eng.top_prs && eng.top_prs[1] && eng.signature_pr && eng.top_prs[1].number !== eng.signature_pr.number)
      ? eng.top_prs[1]
      : (eng.top_prs && eng.top_prs[0]);
    if (alt) {
      var also = el("div", null, [
        el("div", { class: "text-[11px] font-semibold tracking-wider text-slate-500" }, "ALSO NOTABLE"),
        el("a", {
          href: alt.url, target: "_blank", rel: "noopener",
          class: "block text-sm text-slate-800 hover:text-sky-700"
        }, alt.title)
      ]);
      card.appendChild(also);
    }

    // quality footer
    var q = eng.quality || {};
    var revRose = q.revert_rate > 0.05;
    var qFoot = el("div", { class: "border-t border-slate-100 pt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500" });
    var qLeft = el("div", { class: "flex items-center gap-3" });
    var revertSpan = el("span", {
      title: q.revert_count + " of " + eng.metrics.pr_count + " merged PRs were reverted"
    });
    revertSpan.appendChild(revertGlyph());
    revertSpan.appendChild(document.createTextNode((q.revert_count || 0) + " reverts ("));
    revertSpan.appendChild(el("span", { class: revRose ? "text-rose-600 font-medium" : "" }, pct(q.revert_rate || 0)));
    revertSpan.appendChild(document.createTextNode(")"));
    qLeft.appendChild(revertSpan);

    var linkSpan = el("span", {
      class: "inline-flex items-center gap-1",
      title: (q.issue_link_count || 0) + " of " + eng.metrics.pr_count + " merged PRs reference an issue"
    });
    linkSpan.appendChild(linkIconSvg());
    linkSpan.appendChild(document.createTextNode(" " + (q.issue_link_count || 0) + " issue-linked (" + pct(q.issue_link_rate || 0) + ")"));
    qLeft.appendChild(linkSpan);
    qFoot.appendChild(qLeft);

    qFoot.appendChild(el("div", { class: "text-[11px] text-slate-400", title: "These do not affect the composite score." }, "quality signals · informational only, not in the score"));
    card.appendChild(qFoot);

    return card;
  }

  function renderTop5(d) {
    renderLegend($("#signal-legend"));
    var host = $("#top5-cards");
    host.innerHTML = "";
    d.top5.forEach(function (e) { host.appendChild(renderEngineerCard(e)); });
  }

  // ---------- Why not just count PRs? ----------
  function renderVolTable(d) {
    var top5Logins = (d.top5 || []).map(function (e) { return e.login; });
    var host = $("#vol-table");
    host.innerHTML = "";
    var tbl = el("table", { class: "w-full text-sm" });
    var thead = el("thead", { class: "text-[11px] uppercase tracking-wider text-slate-500" });
    thead.appendChild(el("tr", null, [
      el("th", { class: "text-left py-1 pr-2" }, "by PRs"),
      el("th", { class: "text-left py-1 pr-2" }, "engineer"),
      el("th", { class: "text-right py-1 pr-2" }, "PRs"),
      el("th", { class: "text-right py-1" }, "impact")
    ]));
    tbl.appendChild(thead);
    var tbody = el("tbody");
    (d.by_pr_count || []).slice(0, 5).forEach(function (r) {
      var inImpactTop5 = top5Logins.indexOf(r.login) !== -1;
      var deltaCell;
      if (r.delta < -1) {
        deltaCell = el("span", { class: "text-emerald-700", title: "rises " + Math.abs(r.delta) + " by impact" }, "▲" + Math.abs(r.delta));
      } else if (r.delta > 1) {
        deltaCell = el("span", { class: "text-rose-700", title: "drops " + r.delta + " by impact" }, "▼" + r.delta);
      } else {
        deltaCell = el("span", { class: "text-slate-400", title: "within 1 of impact rank" }, "·");
      }
      var loginCell = el("td", { class: "py-1 pr-2" }, [
        ghLink(r.login, r.login, "text-sm"),
        inImpactTop5 ? el("span", { class: "ml-1 text-emerald-600", title: "also in top-5 by impact" }, "✓") : null
      ]);
      tbody.appendChild(el("tr", { class: "border-t border-slate-100" }, [
        el("td", { class: "py-1 pr-2 text-slate-500" }, "#" + r.rank_by_prs),
        loginCell,
        el("td", { class: "py-1 pr-2 text-right" }, fmt(r.pr_count)),
        el("td", { class: "py-1 text-right" }, [
          el("span", { class: "text-slate-500 mr-1" }, "#" + r.rank_by_impact),
          deltaCell
        ])
      ]));
    });
    tbl.appendChild(tbody);
    host.appendChild(tbl);
  }

  // ---------- Area leaders ----------
  function renderAreaLeaders(d) {
    var host = $("#area-leaders");
    host.innerHTML = "";
    (d.area_leaders || []).slice(0, 6).forEach(function (a) {
      var leaderCount = a.leader.pr_count;
      var runners = a.runners_up || [];
      var totalListed = leaderCount + runners.reduce(function (s, r) { return s + (r.pr_count || 0); }, 0);
      var share = totalListed > 0 ? leaderCount / totalListed : 0;
      var row = el("div", { class: "flex items-center justify-between gap-2 text-sm" }, [
        el("span", { class: "text-slate-500 w-20 shrink-0" }, a.area),
        el("span", { class: "flex-1 truncate" }, ghLink(a.leader.login, a.leader.login, "text-sm")),
        el("span", { class: "text-slate-700 tabular-nums" }, (share * 100).toFixed(0) + "%")
      ]);
      host.appendChild(row);
    });
  }

  // ---------- Network panel ----------
  function loadD3() {
    if (d3Module) return Promise.resolve(d3Module);
    if (d3Promise) return d3Promise;
    d3Promise = import("https://cdn.jsdelivr.net/npm/d3@7/+esm").then(function (m) { d3Module = m; return m; });
    return d3Promise;
  }

  function renderNetworkLegend() {
    var host = $("#net-legend");
    if (!host) return;
    host.innerHTML = "";
    SIGNAL_KEYS.forEach(function (k) {
      host.appendChild(el("span", { class: "inline-flex items-center gap-1.5", style: "color:" + SIGNAL_COLOR[k] }, [
        el("span", { class: "swatch" }),
        el("span", { class: "text-slate-600" }, SIGNAL_LABEL[k])
      ]));
    });
  }

  function renderNetwork(d) {
    var host = $("#net-host");
    if (!host) return;
    var graph = d.graph || { nodes: [], edges: [] };
    if (!graph.nodes.length) { host.textContent = "(no graph)"; return; }

    loadD3().then(function (d3) {
      var rect = host.getBoundingClientRect();
      var W = Math.max(280, rect.width || 320), H = 320;
      var nodes = graph.nodes.map(function (n) { return Object.assign({}, n); });
      var edges = graph.edges.map(function (e) { return Object.assign({}, e); });

      var minC = Math.min.apply(null, nodes.map(function (n) { return n.centrality; }));
      var maxC = Math.max.apply(null, nodes.map(function (n) { return n.centrality; }));
      var radius = function (c) {
        if (maxC === minC) return 22;
        return 14 + ((c - minC) / (maxC - minC)) * 18;
      };
      nodes.forEach(function (n) { n.r = radius(n.centrality); });

      host.innerHTML = "";
      var svg = d3.select(host).append("svg").attr("viewBox", "0 0 " + W + " " + H);

      var defs = svg.append("defs");
      defs.append("marker")
        .attr("id", "arrow")
        .attr("viewBox", "0 -5 10 10")
        .attr("refX", 16).attr("refY", 0)
        .attr("markerWidth", 8).attr("markerHeight", 8)
        .attr("orient", "auto")
        .append("path")
        .attr("d", "M0,-5L10,0L0,5")
        .attr("fill", "#94a3b8");

      var bg = svg.append("rect")
        .attr("x", 0).attr("y", 0).attr("width", W).attr("height", H)
        .attr("fill", "transparent");

      var maxW = Math.max.apply(null, edges.map(function (e) { return e.weight; }));

      var linkSel = svg.append("g").selectAll("line")
        .data(edges).enter().append("line")
        .attr("stroke", "#94a3b8")
        .attr("stroke-opacity", 0.6)
        .attr("stroke-width", function (e) { return 0.8 + (e.weight / maxW) * 3.4; })
        .attr("marker-end", "url(#arrow)");

      var labelSel = svg.append("g").selectAll("text.net-edge-label")
        .data(edges).enter().append("text")
        .attr("class", "net-edge-label")
        .attr("text-anchor", "middle")
        .text(function (e) { return e.weight; });

      var nodeG = svg.append("g").selectAll("g.node")
        .data(nodes).enter().append("g")
        .attr("class", "node")
        .style("cursor", "pointer");

      nodeG.append("circle")
        .attr("r", function (n) { return n.r; })
        .attr("fill", function (n) { return SIGNAL_COLOR[n.primary_signal] || "#0ea5e9"; })
        .attr("fill-opacity", 0.85)
        .attr("stroke", "#ffffff")
        .attr("stroke-width", 2);

      nodeG.append("title").text(function (n) {
        return n.login + " · #" + n.rank + " impact · " + n.pr_count + " PRs · PageRank " + n.centrality.toFixed(3) + "\nDominant signal: " + n.primary_signal;
      });

      nodeG.append("text")
        .attr("class", "net-node-label")
        .attr("text-anchor", "middle")
        .attr("dy", function (n) { return n.r + 12; })
        .text(function (n) { return n.login; });

      nodeG.on("click", function (event, n) {
        event.stopPropagation();
        var neighbors = {};
        neighbors[n.login] = true;
        edges.forEach(function (e) {
          var s = (typeof e.source === "object") ? e.source.login : e.source;
          var t = (typeof e.target === "object") ? e.target.login : e.target;
          if (s === n.login) neighbors[t] = true;
          if (t === n.login) neighbors[s] = true;
        });
        nodeG.selectAll("circle")
          .attr("fill-opacity", function (nn) { return neighbors[nn.login] ? 0.95 : 0.18; });
        nodeG.selectAll("text.net-node-label")
          .attr("fill-opacity", function (nn) { return neighbors[nn.login] ? 1 : 0.18; });
        linkSel.attr("stroke-opacity", function (e) {
          var s = (typeof e.source === "object") ? e.source.login : e.source;
          var t = (typeof e.target === "object") ? e.target.login : e.target;
          return (s === n.login || t === n.login) ? 0.85 : 0.12;
        });
        labelSel.attr("fill-opacity", function (e) {
          var s = (typeof e.source === "object") ? e.source.login : e.source;
          var t = (typeof e.target === "object") ? e.target.login : e.target;
          return (s === n.login || t === n.login) ? 1 : 0.18;
        });
      });

      bg.on("click", function () {
        nodeG.selectAll("circle").attr("fill-opacity", 0.85);
        nodeG.selectAll("text.net-node-label").attr("fill-opacity", 1);
        linkSel.attr("stroke-opacity", 0.6);
        labelSel.attr("fill-opacity", 1);
      });

      var sim = d3.forceSimulation(nodes)
        .force("link", d3.forceLink(edges).id(function (d) { return d.login; }).distance(110))
        .force("charge", d3.forceManyBody().strength(-380))
        .force("x", d3.forceX(W / 2).strength(0.06))
        .force("y", d3.forceY(H / 2).strength(0.06))
        .force("collide", d3.forceCollide().radius(function (n) { return n.r + 18; }))
        .alphaMin(0.02)
        .on("tick", function () {
          nodes.forEach(function (n) {
            n.x = Math.max(14 + n.r, Math.min(W - 14 - n.r, n.x));
            n.y = Math.max(22 + n.r, Math.min(H - 14 - n.r, n.y));
          });
          linkSel
            .attr("x1", function (e) { return e.source.x; }).attr("y1", function (e) { return e.source.y; })
            .attr("x2", function (e) { return e.target.x; }).attr("y2", function (e) { return e.target.y; });
          labelSel
            .attr("x", function (e) { return (e.source.x + e.target.x) / 2; })
            .attr("y", function (e) { return (e.source.y + e.target.y) / 2 - 2; });
          nodeG.attr("transform", function (n) { return "translate(" + n.x + "," + n.y + ")"; });
        });
      // sim runs to alphaMin and then stops naturally
    });
  }

  function setupNetworkObserver(d) {
    var host = $("#net-host");
    if (!host) return;
    if (!("IntersectionObserver" in window)) { renderNetworkLegend(); renderNetwork(d); return; }
    renderNetworkLegend();
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          renderNetwork(d);
          io.disconnect();
        }
      });
    }, { rootMargin: "150px" });
    io.observe(host);
  }

  // ---------- Explore tab ----------
  function defaultWeightsPct() {
    var w = (slim && slim.weights) || { surviving_code: 0.25, review_leverage: 0.25, cross_area: 0.15, incident_work: 0.20, review_centrality: 0.15 };
    var out = {};
    SIGNAL_KEYS.forEach(function (k) { out[k] = Math.round((w[k] || 0) * 100); });
    return out;
  }

  function buildSliders() {
    var host = $("#sliders");
    host.innerHTML = "";
    SIGNAL_KEYS.forEach(function (k) {
      var row = el("div", { class: "flex flex-col gap-1" });
      row.appendChild(el("div", { class: "flex items-center justify-between text-xs" }, [
        el("span", { class: "inline-flex items-center gap-1.5", style: "color:" + SIGNAL_COLOR[k] }, [
          el("span", { class: "swatch" }),
          el("span", { class: "text-slate-700" }, SIGNAL_LABEL[k])
        ]),
        el("span", { class: "tabular-nums text-slate-600", id: "wval-" + k }, weightsState[k] + "%")
      ]));
      var input = el("input", {
        type: "range", min: "0", max: "50", step: "1", value: weightsState[k],
        id: "wsl-" + k,
        class: "w-full"
      });
      input.addEventListener("input", function () {
        weightsState[k] = parseInt(input.value, 10);
        $("#wval-" + k).textContent = weightsState[k] + "%";
        rerankAndRender();
      });
      row.appendChild(input);
      host.appendChild(row);
    });
  }

  function normalizedWeights() {
    var sum = SIGNAL_KEYS.reduce(function (s, k) { return s + (weightsState[k] || 0); }, 0);
    var out = {};
    if (sum <= 0) return slim.weights || { surviving_code: 0.25, review_leverage: 0.25, cross_area: 0.15, incident_work: 0.20, review_centrality: 0.15 };
    SIGNAL_KEYS.forEach(function (k) { out[k] = (weightsState[k] || 0) / sum; });
    return out;
  }

  function rerankAndRender() {
    if (!fullData || !fullData.engineers) return;
    var w = normalizedWeights();
    var rows = fullData.engineers.map(function (e) {
      var c = 0;
      SIGNAL_KEYS.forEach(function (k) { c += (w[k] || 0) * ((e.z && e.z[k]) || 0); });
      return Object.assign({ _composite: c }, e);
    });
    rows.sort(function (a, b) { return b._composite - a._composite; });
    var min = rows[rows.length - 1]._composite, max = rows[0]._composite;
    rows.forEach(function (r, i) {
      r._rank = i + 1;
      r._score = (max === min) ? 100 : ((r._composite - min) / (max - min)) * 100;
    });
    renderReweightedTop5(rows);
    renderExploreTable(rows);
  }

  function renderReweightedTop5(rows) {
    var host = $("#reweighted-top5");
    host.innerHTML = "";
    rows.slice(0, 5).forEach(function (r) {
      host.appendChild(el("li", { class: "flex items-center gap-2" }, [
        avatar(r.login, 24),
        ghLink(r.login, r.login, "text-sm"),
        el("span", { class: "ml-auto tabular-nums text-slate-700" }, r._score.toFixed(1))
      ]));
    });
  }

  function applySort(rows) {
    var k = sortState.key, dir = sortState.dir === "asc" ? 1 : -1;
    var get = {
      rank: function (r) { return r._rank; },
      login: function (r) { return r.login.toLowerCase(); },
      score: function (r) { return r._score; },
      prs: function (r) { return r.metrics.pr_count; },
      surv: function (r) { return r.metrics.surviving_code; },
      rev: function (r) { return r.metrics.review_leverage; },
      areas: function (r) { return r.metrics.cross_area; },
      inc: function (r) { return r.metrics.incident_work; },
      cent: function (r) { return r.metrics.review_centrality; },
      revrate: function (r) { return r.quality && r.quality.revert_rate; },
      linkrate: function (r) { return r.quality && r.quality.issue_link_rate; }
    }[k] || function (r) { return r._score; };
    rows.sort(function (a, b) {
      var av = get(a), bv = get(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return rows;
  }

  function renderExploreTable(rows) {
    var q = ($("#explore-search").value || "").toLowerCase();
    var filtered = rows.filter(function (r) { return !q || r.login.toLowerCase().indexOf(q) !== -1; });
    filtered = applySort(filtered.slice());
    var slice = filtered.slice(0, 200);
    var tbody = $("#explore-tbody");
    tbody.innerHTML = "";
    slice.forEach(function (r) {
      var checked = compareSelections.indexOf(r.login) !== -1;
      var disabled = compareSelections.length >= 2 && !checked;
      var tr = el("tr", { class: "hover:bg-slate-50" + (checked ? " is-selected" : "") + (disabled ? " is-disabled" : "") });
      var cb = el("input", { type: "checkbox" });
      if (checked) cb.checked = true;
      if (disabled) cb.disabled = true;
      cb.addEventListener("change", function () { onCompareToggle(r.login, cb.checked); });
      tr.appendChild(el("td", { class: "px-2 py-1.5" }, cb));
      tr.appendChild(el("td", { class: "px-2 py-1.5 text-slate-500" }, "#" + r._rank));
      tr.appendChild(el("td", { class: "px-2 py-1.5" }, [
        el("span", { class: "inline-flex items-center gap-2" }, [avatar(r.login, 20), ghLink(r.login, r.login, "text-sm")])
      ]));
      tr.appendChild(el("td", { class: "px-2 py-1.5 text-right tabular-nums font-medium" }, r._score.toFixed(1)));
      tr.appendChild(el("td", { class: "px-2 py-1.5 text-right tabular-nums" }, fmt(r.metrics.pr_count)));
      tr.appendChild(el("td", { class: "px-2 py-1.5 text-right tabular-nums" }, fmt(r.metrics.surviving_code)));
      tr.appendChild(el("td", { class: "px-2 py-1.5 text-right tabular-nums" }, fmt(r.metrics.review_leverage)));
      tr.appendChild(el("td", { class: "px-2 py-1.5 text-right tabular-nums" }, fmt(r.metrics.cross_area)));
      tr.appendChild(el("td", { class: "px-2 py-1.5 text-right tabular-nums" }, fmt(r.metrics.incident_work)));
      tr.appendChild(el("td", { class: "px-2 py-1.5 text-right tabular-nums" }, (r.metrics.review_centrality || 0).toFixed(3)));
      var revRate = (r.quality && r.quality.revert_rate) || 0;
      tr.appendChild(el("td", { class: "px-2 py-1.5 text-right tabular-nums " + (revRate > 0.05 ? "text-rose-600 font-medium" : "") }, pct(revRate)));
      tr.appendChild(el("td", { class: "px-2 py-1.5 text-right tabular-nums" }, pct((r.quality && r.quality.issue_link_rate) || 0)));
      tbody.appendChild(tr);
    });
    if (!slice.length) {
      tbody.appendChild(el("tr", null, el("td", { colspan: "12", class: "px-3 py-6 text-center text-slate-500" }, "no engineers match")));
    }
  }

  function onCompareToggle(login, checked) {
    var idx = compareSelections.indexOf(login);
    if (checked) {
      if (idx === -1 && compareSelections.length < 2) compareSelections.push(login);
    } else {
      if (idx !== -1) compareSelections.splice(idx, 1);
    }
    rerankAndRender();
    renderCompareDrawer();
  }

  // ---------- Compare drawer ----------
  function findEngineer(login) {
    if (!fullData) return null;
    for (var i = 0; i < fullData.engineers.length; i++) {
      if (fullData.engineers[i].login === login) return fullData.engineers[i];
    }
    return null;
  }

  function renderCompareCard(eng, accent) {
    var host = el("div", { class: "rounded-lg border border-slate-200 p-3 flex flex-col gap-2", style: "border-top: 3px solid " + accent });
    host.appendChild(el("div", { class: "flex items-center gap-2" }, [
      avatar(eng.login, 36),
      el("div", null, [
        ghLink(eng.login, eng.login, "text-base"),
        el("div", { class: "text-xs text-slate-500" }, "score " + fmt(eng.score, 1) + " · primary " + (SIGNAL_LABEL[eng.primary_signal] || eng.primary_signal))
      ])
    ]));
    host.appendChild(el("div", { class: "text-sm text-slate-700" }, eng.headline));

    var grid = el("div", { class: "grid grid-cols-2 gap-2 text-xs" });
    [
      ["Lines (capped)", fmt(eng.metrics.surviving_code)],
      ["Deep reviews", fmt(eng.metrics.review_leverage)],
      ["Areas", fmt(eng.metrics.cross_area)],
      ["Incidents", fmt(eng.metrics.incident_work)],
      ["PageRank", (eng.metrics.review_centrality || 0).toFixed(3)],
      ["PRs", fmt(eng.metrics.pr_count)]
    ].forEach(function (kv) {
      grid.appendChild(el("div", { class: "flex justify-between" }, [
        el("span", { class: "text-slate-500" }, kv[0]),
        el("span", { class: "tabular-nums" }, kv[1])
      ]));
    });
    host.appendChild(grid);

    var q = eng.quality || {};
    host.appendChild(el("div", { class: "text-xs text-slate-500" }, "reverts " + pct(q.revert_rate || 0) + " · issue-linked " + pct(q.issue_link_rate || 0)));

    var areas = el("div", { class: "flex flex-wrap gap-1" });
    (eng.areas || []).forEach(function (a) {
      areas.appendChild(el("span", { class: "text-[11px] bg-slate-50 border border-slate-200 text-slate-600 rounded-full px-2 py-0.5" }, a));
    });
    host.appendChild(areas);

    var prs = el("div", { class: "flex flex-col gap-1 text-xs" });
    (eng.top_prs || []).slice(0, 3).forEach(function (p) {
      prs.appendChild(el("a", { href: p.url, target: "_blank", rel: "noopener", class: "text-sky-700 hover:underline truncate" },
        p.title + "  +" + fmt(p.additions) + "/-" + fmt(p.deletions)));
    });
    host.appendChild(prs);

    return host;
  }

  function renderRadar(d3, hostEl, engA, engB) {
    var W = 240, H = 240, cx = W / 2, cy = H / 2;
    var r = Math.min(W, H) / 2 - 24;
    var Z_MIN = -1.5, Z_MAX = 2.5;
    var keys = SIGNAL_KEYS.slice();
    var n = keys.length;

    hostEl.innerHTML = "";
    var svgWrap = el("div", null);
    hostEl.appendChild(svgWrap);

    var svg = d3.select(svgWrap).append("svg").attr("viewBox", "0 0 " + W + " " + H).attr("width", "100%").attr("height", H);

    // rings at 0.33, 0.67, 1.0
    [0.33, 0.67, 1.0].forEach(function (t) {
      svg.append("circle").attr("cx", cx).attr("cy", cy).attr("r", r * t)
        .attr("fill", "none").attr("stroke", "#e2e8f0").attr("stroke-width", 1);
    });

    // axes
    keys.forEach(function (k, i) {
      var ang = -Math.PI / 2 + (i / n) * Math.PI * 2;
      var x = cx + Math.cos(ang) * r, y = cy + Math.sin(ang) * r;
      svg.append("line").attr("x1", cx).attr("y1", cy).attr("x2", x).attr("y2", y).attr("stroke", "#e2e8f0");
      var lx = cx + Math.cos(ang) * (r + 12), ly = cy + Math.sin(ang) * (r + 12);
      svg.append("text").attr("class", "radar-axis-label").attr("x", lx).attr("y", ly)
        .attr("text-anchor", "middle").attr("dominant-baseline", "middle").text(SIGNAL_LABEL[k]);
    });

    function shape(eng) {
      return keys.map(function (k, i) {
        var z = (eng.z && eng.z[k]) || 0;
        var t = (Math.max(Z_MIN, Math.min(Z_MAX, z)) - Z_MIN) / (Z_MAX - Z_MIN);
        var ang = -Math.PI / 2 + (i / n) * Math.PI * 2;
        return [cx + Math.cos(ang) * r * t, cy + Math.sin(ang) * r * t];
      });
    }
    function poly(pts) { return pts.map(function (p) { return p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" "); }

    var aPts = shape(engA), bPts = shape(engB);
    svg.append("polygon").attr("points", poly(aPts)).attr("fill", "#0ea5e9").attr("fill-opacity", 0.25).attr("stroke", "#0ea5e9").attr("stroke-width", 1.5);
    svg.append("polygon").attr("points", poly(bPts)).attr("fill", "#8b5cf6").attr("fill-opacity", 0.25).attr("stroke", "#8b5cf6").attr("stroke-width", 1.5);

    var legend = el("div", { class: "flex items-center justify-center gap-3 text-xs text-slate-600 mt-1" }, [
      el("span", { class: "inline-flex items-center gap-1.5", style: "color:#0ea5e9" }, [el("span", { class: "swatch" }), el("span", { class: "text-slate-700" }, engA.login)]),
      el("span", { class: "inline-flex items-center gap-1.5", style: "color:#8b5cf6" }, [el("span", { class: "swatch" }), el("span", { class: "text-slate-700" }, engB.login)])
    ]);
    hostEl.appendChild(legend);
  }

  function renderCompareDrawer() {
    var drawer = $("#compare-drawer");
    var body = $("#compare-body");
    body.innerHTML = "";

    if (compareSelections.length === 0) {
      drawer.classList.remove("is-open");
      return;
    }
    drawer.classList.add("is-open");

    var engA = findEngineer(compareSelections[0]);
    var engB = compareSelections[1] ? findEngineer(compareSelections[1]) : null;

    if (engA) body.appendChild(renderCompareCard(engA, "#0ea5e9"));
    if (engB) body.appendChild(renderCompareCard(engB, "#8b5cf6"));
    else body.appendChild(el("div", { class: "rounded-lg border border-dashed border-slate-200 p-3 text-sm text-slate-500" }, "Pick a second engineer to compare."));

    var radarHost = el("div", { class: "rounded-lg border border-slate-200 p-3 flex flex-col" });
    radarHost.appendChild(el("div", { class: "text-[11px] font-semibold tracking-wider text-slate-500 mb-1" }, "Z-SCORE RADAR"));
    body.appendChild(radarHost);

    if (engA && engB) {
      loadD3().then(function (d3) { renderRadar(d3, radarHost, engA, engB); });
    } else {
      radarHost.appendChild(el("div", { class: "text-xs text-slate-500" }, "Radar appears once two engineers are selected."));
    }
  }

  function setupCompareActions() {
    $("#compare-close").addEventListener("click", function () {
      compareSelections = [];
      renderCompareDrawer();
      rerankAndRender();
    });
    $("#compare-copy").addEventListener("click", function () {
      if (compareSelections.length < 2) return;
      var a = findEngineer(compareSelections[0]);
      var b = findEngineer(compareSelections[1]);
      if (!a || !b) return;
      var lines = [
        "*PostHog Impact compare*",
        "[@" + a.login + "] score " + a.score.toFixed(1) + " · primary " + a.primary_signal,
        "[@" + b.login + "] score " + b.score.toFixed(1) + " · primary " + b.primary_signal,
        "Lines (capped): " + a.metrics.surviving_code + " vs " + b.metrics.surviving_code +
        " · Deep reviews: " + a.metrics.review_leverage + " vs " + b.metrics.review_leverage +
        " · Areas: " + a.metrics.cross_area + " vs " + b.metrics.cross_area +
        " · Incidents: " + a.metrics.incident_work + " vs " + b.metrics.incident_work +
        " · PageRank: " + a.metrics.review_centrality.toFixed(3) + " vs " + b.metrics.review_centrality.toFixed(3)
      ];
      var text = lines.join("\n");
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(function () { /* swallow */ });
      }
    });
  }

  // ---------- Demo preselection ----------
  function pickDemoPair() {
    if (!fullData || !fullData.engineers) return null;
    var top = fullData.engineers.filter(function (e) { return e.rank <= 30; });
    var best = null;
    for (var i = 0; i < top.length; i++) {
      for (var j = i + 1; j < top.length; j++) {
        var a = top[i], b = top[j];
        if (a.primary_signal === b.primary_signal) continue;
        var d2 = 0;
        SIGNAL_KEYS.forEach(function (k) {
          var dz = (a.z[k] || 0) - (b.z[k] || 0);
          d2 += dz * dz;
        });
        if (!best || d2 > best.d) best = { a: a.login, b: b.login, d: d2 };
      }
    }
    return best;
  }

  function setupDemoLink() {
    var demoEl = $("#compare-demo");
    var pair = pickDemoPair();
    if (!pair) return;
    demoEl.classList.remove("hidden");
    demoEl.textContent = "Compare these two: " + pair.a + " vs " + pair.b;
    demoEl.addEventListener("click", function (ev) {
      ev.preventDefault();
      compareSelections = [pair.a, pair.b];
      rerankAndRender();
      renderCompareDrawer();
    });
  }

  // ---------- Explore activation ----------
  function onExploreActivate() {
    if (fullPromise) return;
    fullPromise = fetch("data.full.json").then(function (r) { return r.json(); }).then(function (j) {
      fullData = j;
      buildSliders();
      rerankAndRender();
      setupDemoLink();
    }).catch(function () {
      $("#explore-tbody").innerHTML = "<tr><td colspan=\"12\" class=\"px-3 py-6 text-center text-rose-600\">Failed to load full data</td></tr>";
    });
  }

  // ---------- Ask AI ----------
  function setupAsk(d) {
    if (!window.ASSISTANT_URL) {
      var pill = $("#ask-pill");
      if (pill) pill.parentNode.removeChild(pill);
      var sec = $("#tab-ask");
      if (sec) sec.parentNode.removeChild(sec);
      return;
    }
    var pillsHost = $("#suggested-pills");
    pillsHost.innerHTML = "";
    (d.suggested_questions || []).forEach(function (q) {
      var b = el("button", { type: "button", class: "qpill" }, q);
      b.addEventListener("click", function () { $("#ask-input").value = q; $("#ask-input").focus(); });
      pillsHost.appendChild(b);
    });
    $("#ask-submit").addEventListener("click", askSubmit);
  }

  function askSubmit() {
    var q = ($("#ask-input").value || "").trim();
    if (!q) return;
    var spin = $("#ask-spinner"), ans = $("#ask-answer");
    spin.classList.remove("hidden");
    ans.textContent = "";
    fetch(window.ASSISTANT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: q, data: slim })
    }).then(function (r) {
      if (r.status !== 200) throw new Error("status " + r.status);
      return r.json();
    }).then(function (j) {
      spin.classList.add("hidden");
      if (!j || typeof j.answer !== "string") { ans.textContent = "Live LLM unavailable, please try again."; return; }
      ans.textContent = j.answer;
    }).catch(function () {
      spin.classList.add("hidden");
      ans.textContent = "Live LLM unavailable, please try again.";
    });
  }

  // ---------- Reset weights ----------
  function setupReset() {
    $("#reset-weights").addEventListener("click", function (ev) {
      ev.preventDefault();
      weightsState = defaultWeightsPct();
      SIGNAL_KEYS.forEach(function (k) {
        var el = $("#wsl-" + k); if (el) el.value = weightsState[k];
        var lab = $("#wval-" + k); if (lab) lab.textContent = weightsState[k] + "%";
      });
      rerankAndRender();
    });
  }

  // ---------- Sort header ----------
  function setupSort() {
    $$("#explore-table thead th[data-sort]").forEach(function (th) {
      th.addEventListener("click", function () {
        var k = th.dataset.sort;
        if (sortState.key === k) sortState.dir = (sortState.dir === "asc" ? "desc" : "asc");
        else { sortState.key = k; sortState.dir = (k === "login" ? "asc" : "desc"); }
        $$("#explore-table thead th[data-sort]").forEach(function (t) {
          t.classList.toggle("is-sorted", t.dataset.sort === sortState.key);
          t.setAttribute("data-dir", t.dataset.sort === sortState.key ? (sortState.dir === "asc" ? "▲" : "▼") : "");
        });
        rerankAndRender();
      });
    });
  }

  // ---------- Boot ----------
  function getBootData() {
    var inline = document.getElementById("boot-data");
    if (inline) {
      try { return Promise.resolve(JSON.parse(inline.textContent)); } catch (e) { /* fall through */ }
    }
    return fetch("data.json").then(function (r) { return r.json(); });
  }

  function boot() {
    fillMethodologyBody();
    $("#open-methodology").addEventListener("click", function (ev) { ev.preventDefault(); openMethodology(); });
    $("#methodology-close").addEventListener("click", closeMethodology);
    $("#methodology-backdrop").addEventListener("click", closeMethodology);

    $("#copy-digest-btn").addEventListener("click", function () {
      console.debug("copy digest pending");
    });
    $("#explore-search").addEventListener("input", rerankAndRender);

    setupSort();
    setupReset();
    setupCompareActions();

    window.addEventListener("hashchange", readHash);

    getBootData().then(function (d) {
      slim = d;
      weightsState = defaultWeightsPct();
      renderHeader(d);
      renderExec(d);
      renderTop5(d);
      renderKPIs(d);
      renderVolTable(d);
      renderAreaLeaders(d);
      setupNetworkObserver(d);
      setupAsk(d);
      readHash();
    }).catch(function (err) {
      console.error("boot failed", err);
      $("#meta-line").textContent = "data unavailable";
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
