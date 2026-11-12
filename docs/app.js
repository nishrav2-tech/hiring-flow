/* Hiring Flow dashboard. Reads and writes the hf_ tables in Supabase.
   Jay's decisions are stored in candidate doc.jay; the scheduled runs read them and act. */
(function () {
  const CFG = window.HF_CONFIG || {};
  const TZ = CFG.TIMEZONE || "America/Chicago";
  const DEMO = new URLSearchParams(location.search).has("demo");
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => (/^https?:\/\//i.test(String(u || "")) ? String(u) : "");

  const STAGES = [
    ["applied", "Applied"], ["queued", "Invite approved"], ["assessment", "Assessment out"],
    ["graded", "Scored"], ["video", "Video invite sent"], ["no_submit", "Did not submit"],
    ["out", "Not moving forward"], ["archived", "Previous round"],
  ];
  const STAGE_LABEL = Object.fromEntries(STAGES);

  let sb = null, user = null;
  const S = { view: "home", roles: [], roleId: null, cands: [], posts: [], events: [], tab: "overview", sort: { k: "stage", dir: 1 } };

  // ---------- helpers ----------
  const fmtDate = (d) => {
    if (!d) return "";
    const dt = new Date(String(d).length === 10 ? d + "T12:00:00Z" : d);
    if (isNaN(dt)) return esc(d);
    return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: TZ });
  };
  const todayStr = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  const daysBetween = (a, b) => Math.round((new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 864e5);
  const toast = (msg) => { const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.add("hidden"), 2600); };
  const role = () => S.roles.find((r) => r.id === S.roleId) || { id: null, doc: {} };
  const current = () => S.cands.filter((c) => c.doc.stage !== "archived");
  const pill = (stage) => `<span class="pill p-${esc(stage)}">${esc(STAGE_LABEL[stage] || stage)}</span>`;
  const jay = (c) => c.doc.jay || {};

  function effectiveStage(c) {
    const d = c.doc, j = jay(c);
    if (j.removed) return "out";
    if (d.stage === "applied" && j.assessment === "approved") return "queued";
    return d.stage || "applied";
  }

  // What needs Jay, per candidate (null when nothing)
  function needFor(c) {
    const d = c.doc, j = jay(c), st = effectiveStage(c);
    if (st === "graded" && !j.video) return { k: "video", text: "Scored: decide on video invite" };
    if (st === "graded" && j.video === "approved" && !d.videoSent) return { k: "pending", text: "Video approved: sends next run" };
    if (st === "queued") return { k: "pending", text: "Assessment approved: sends next run" };
    const none = (v) => !v || /^none found/i.test(String(v).trim());
    if (st === "applied" && d.all3Yes === "Yes" && !j.assessment && !j.removed && !none(d.sales) && !none(d.realEstate) && d.fit !== "Weak")
      return { k: "assess", text: d.fit === "Strong" ? "Qualifies: assessment goes out next pull" : "Borderline: approve assessment?" };
    return null;
  }

  // ---------- next run times (Central) ----------
  function nextRun(days, hh, mm) {
    const now = new Date();
    for (let i = 0; i < 9; i++) {
      const probe = new Date(now.getTime() + i * 864e5);
      const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(probe).map((p) => [p.type, p.value]));
      const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
      if (!days.includes(wd)) continue;
      const nowMin = +parts.hour * 60 + +parts.minute;
      if (i === 0 && nowMin >= hh * 60 + mm) continue;
      return `${parts.weekday} ${parts.month}/${parts.day}, ${hh > 12 ? hh - 12 : hh}:${String(mm).padStart(2, "0")} ${hh >= 12 ? "PM" : "AM"} CT`;
    }
    return "";
  }

  // ---------- data ----------
  async function loadAll() {
    if (DEMO) {
      const j = await (await fetch("demo-data.json")).json();
      S.roles = j.roles; S.allCands = j.candidates; S.allPosts = j.postings; S.allEvents = j.events;
    } else {
      const [r, c, p, e] = await Promise.all([
        sb.from("hf_roles").select("*").order("id"),
        sb.from("hf_candidates").select("*"),
        sb.from("hf_postings").select("*"),
        sb.from("hf_events").select("*").order("at", { ascending: false }).limit(300),
      ]);
      for (const x of [r, c, p, e]) if (x.error) throw x.error;
      S.roles = r.data; S.allCands = c.data; S.allPosts = p.data; S.allEvents = e.data;
    }
    S.loaded = true;
    route();
  }

  // ---------- routing: #/ = all roles, #/role/<id> = one role ----------
  function route() {
    const m = location.hash.match(/^#\/role\/([^/?#]+)/);
    const id = m ? decodeURIComponent(m[1]) : null;
    if (id && S.loaded && !S.roles.find((r) => r.id === id)) { location.replace("#/"); return; }
    const changed = id !== S.roleId;
    S.view = id ? "role" : "home"; S.roleId = id;
    if (changed) { closeAll(); setTab("overview"); window.scrollTo(0, 0); }
    if (S.loaded) pick();
  }
  function pick() {
    S.cands = (S.allCands || []).filter((x) => x.role_id === S.roleId);
    S.posts = (S.allPosts || []).filter((x) => x.role_id === S.roleId);
    S.events = (S.allEvents || []).filter((x) => x.role_id === S.roleId).sort((a, b) => (a.at < b.at ? 1 : -1));
    render();
  }

  async function saveDecision(c, patch, eventText) {
    const j = Object.assign({}, jay(c), patch, { at: new Date().toISOString(), by: user ? user.email : "demo" });
    if (DEMO) { c.doc.jay = j; render(); openCand(c.id); toast("Saved (demo, not stored)"); return; }
    const { data: fresh, error: e1 } = await sb.from("hf_candidates").select("doc").eq("id", c.id).single();
    if (e1) return toast("Could not save: " + e1.message);
    const doc = Object.assign({}, fresh.doc, { jay: j });
    const { error } = await sb.from("hf_candidates").update({ doc }).eq("id", c.id);
    if (error) return toast("Could not save: " + error.message);
    c.doc = doc;
    await sb.from("hf_events").insert({ role_id: S.roleId, doc: { kind: "Jay decision", text: `${c.doc.name}: ${eventText}`, source: "dashboard" } });
    toast("Saved. The next run will act on it.");
    await loadAll(); openCand(c.id);
  }

  // ---------- render ----------
  function render() {
    $("#home").classList.toggle("hidden", S.view !== "home");
    $("#roleView").classList.toggle("hidden", S.view !== "role");
    if (S.view === "home") { document.title = "Hiring Flow · Utopian Capital"; return renderHome(); }
    const r = role(), d = r.doc || {};
    document.title = (d.title || "Role") + " · Hiring Flow";
    $("#crumbRole").textContent = d.title || "";
    $("#roleTitle").textContent = d.title || "No role selected";
    $("#roleSub").textContent = [d.location, d.status ? "Status: " + d.status : "", d.syncedAt ? "Last synced " + new Date(d.syncedAt).toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " CT" : ""].filter(Boolean).join(" · ");
    const banner = $("#roleBanner");
    if (r.id && d.automation !== "on") {
      banner.innerHTML = `<b>Waiting for Claude to set this role up.</b> ${d.setupRequestedAt ? "Requested " + fmtDate(d.setupRequestedAt) + ". " : ""}Tell Claude <i>"set up hiring flow for ${esc(d.title || "this role")}"</i> and it will take over the LinkedIn and Indeed posts, screeners, assessment and scheduled runs. Daily runs also list roles waiting for setup.`;
      banner.classList.remove("hidden");
    }
    else banner.classList.add("hidden");
    const needN = current().filter((c) => { const n = needFor(c); return n && n.k !== "pending"; }).length;
    $('#tabs [data-tab="overview"]').innerHTML = "Overview" + (needN ? `<span class="count">${needN}</span>` : "");
    renderOverview(); renderCandidates(); renderPostings(); renderWorkflow();
  }

  function roleStats(r) {
    const cands = (S.allCands || []).filter((c) => c.role_id === r.id && c.doc.stage !== "archived");
    const posts = (S.allPosts || []).filter((p) => p.role_id === r.id);
    const latest = {};
    posts.forEach((p) => { const k = p.doc.platform || "Post"; if (!latest[k] || String(p.doc.posted || "") > String(latest[k].doc.posted || "")) latest[k] = p; });
    return {
      applicants: cands.length,
      needs: cands.filter((c) => { const n = needFor(c); return n && n.k !== "pending"; }).length,
      out: cands.filter((c) => ["assessment", "queued"].includes(effectiveStage(c))).length,
      scored: cands.filter((c) => c.doc.score != null).length,
      posts: Object.values(latest),
    };
  }
  function roleNextRun(d) {
    if (d.automation !== "on") return "";
    const times = (d.cadence || []).map((c) => /daily/i.test(c.name) ? nextRun([1, 2, 3, 4, 5], 8, 4) : /pull/i.test(c.name) ? nextRun([1, 3, 5], 9, 4) : "").filter(Boolean);
    return times[0] || "";
  }
  function roleStatus(d) {
    if (/closed|filled|paused/i.test(d.status || "")) return ["p-applied", d.status.charAt(0).toUpperCase() + d.status.slice(1)];
    if (d.automation === "on") return ["p-ok", "Running"];
    return ["p-warn", "Waiting for setup"];
  }
  function renderHome() {
    const order = (r) => (/closed|filled/i.test(r.doc.status || "") ? 2 : r.doc.automation === "on" ? 0 : 1);
    const roles = S.roles.slice().sort((a, b) => order(a) - order(b) || String(a.doc.title).localeCompare(String(b.doc.title)));
    const cards = roles.map((r) => {
      const d = r.doc || {}, st = roleStats(r), [cls, label] = roleStatus(d), next = roleNextRun(d);
      const posts = st.posts.length ? st.posts.map((p) => `${esc(p.doc.platform)}: ${esc(p.doc.status || "Unknown")}`).join(" · ") : "No posts yet";
      return `<a class="card rolecard" href="#/role/${encodeURIComponent(r.id)}">
        <div class="head"><div><h3>${esc(d.title || r.id)}</h3><div class="loc">${esc(d.location || "")}</div></div><span class="pill ${cls}">${esc(label)}</span></div>
        <div class="rolestats">
          <div><b>${st.applicants}</b><span>Applicants</span></div>
          <div class="${st.needs ? "attn" : ""}"><b>${st.needs}</b><span>Need you</span></div>
          <div><b>${st.out}</b><span>Tests out</span></div>
          <div><b>${st.scored}</b><span>Scored</span></div>
        </div>
        <div class="foot"><div><b>Posts</b> ${posts}</div><div>${next ? "<b>Next run</b> " + esc(next) : d.automation === "on" ? "" : "Claude will set up the posts and runs"}</div></div>
      </a>`;
    });
    cards.push(`<button class="card addcard" type="button" id="addRoleCard"><span class="plus" aria-hidden="true">+</span><b>New role</b><span class="sub">Add the job and its LinkedIn and Indeed links</span></button>`);
    $("#roleGrid").innerHTML = cards.join("");
    $("#addRoleCard").onclick = newRole;
    $("#homeSub").textContent = S.roles.length ? "Every job you're hiring for. Open one to see its candidates, postings and runs."
      : "No roles yet. Add one to get started. If you expected to see roles, your login may not be on the Hiring Flow member list.";
  }

  function renderOverview() {
    const cur = current();
    const st = (s) => cur.filter((c) => effectiveStage(c) === s).length;
    const passed = cur.filter((c) => c.doc.all3Yes === "Yes").length;
    const sent = cur.filter((c) => c.doc.assessmentSent).length;
    const submitted = cur.filter((c) => c.doc.score != null).length;
    const video = st("video");
    const needs = cur.map((c) => [c, needFor(c)]).filter(([, n]) => n);
    const decide = needs.filter(([, n]) => n.k !== "pending").length;
    $("#kpis").innerHTML = [
      ["Applicants", cur.length, "this round"],
      ["Passed all 3 screeners", passed, cur.length ? Math.round((passed / cur.length) * 100) + "% of applicants" : ""],
      ["Assessments out", st("assessment") + st("queued"), st("queued") ? st("queued") + " approved, sending next run" : "waiting on candidates"],
      ["Scored", submitted, sent ? `${submitted} of ${sent} sent submitted` : ""],
      ["Video invites sent", video, ""],
      ["Needs your decision", decide, decide ? "see list below" : "all clear", decide ? "attn" : ""],
    ].map(([l, v, h, cls]) => `<div class="card kpi ${cls || ""}"><div class="label">${esc(l)}</div><div class="val">${esc(v)}</div><div class="hint">${esc(h)}</div></div>`).join("");

    const max = Math.max(cur.length, 1);
    const rows = [
      ["Applied", cur.length, "", ""], ["Passed screeners", passed, "", ""],
      ["Assessment sent", sent, "", "assessment"], ["Submitted and scored", submitted, "gold", "graded"],
      ["Video invite sent", video, "", "video"], ["Did not submit", st("no_submit"), "grey", "no_submit"],
    ];
    $("#funnel").innerHTML = rows.map(([l, n, cls, f]) => `<div class="row" data-stage="${f}"><span class="lbl">${esc(l)}</span><div class="bar"><i class="${cls}" style="width:${n ? Math.max((n / max) * 100, 2) : 0}%"></i></div><span class="n">${n}</span></div>`).join("");
    $$("#funnel .row").forEach((el) => el.onclick = () => { $("#fStage").value = el.dataset.stage; $("#fRound").value = "current"; setTab("candidates"); });

    const order = { video: 0, assess: 1, pending: 2 };
    needs.sort((a, b) => order[a[1].k] - order[b[1].k] || (b[0].doc.score || 0) - (a[0].doc.score || 0));
    $("#needs").innerHTML = needs.length ? needs.map(([c, n]) => `<div class="item" data-id="${esc(c.id)}"><div class="who"><b>${esc(c.doc.name)}</b><div>${esc(n.text)}${c.doc.location ? " · " + esc(c.doc.location) : ""}</div></div>${c.doc.score != null ? `<span class="score">${esc(c.doc.score)}</span>` : ""}<button class="btn sm">Open</button></div>`).join("") : `<div class="empty">Nothing needs you right now.</div>`;

    const out = cur.filter((c) => effectiveStage(c) === "assessment").sort((a, b) => String(a.doc.deadline).localeCompare(String(b.doc.deadline)));
    const today = todayStr();
    $("#outList").innerHTML = out.length ? out.map((c) => {
      const due = c.doc.extendedTo || c.doc.deadline; const left = due ? daysBetween(today, due) : null;
      const tag = left == null ? "" : left < 0 ? `<span class="pill p-bad">past due</span>` : left === 0 ? `<span class="pill p-warn">due today</span>` : `<span class="pill p-ok">${left}d left</span>`;
      return `<div class="item" data-id="${esc(c.id)}"><div class="who"><b>${esc(c.doc.name)}</b><div>Sent ${fmtDate(c.doc.assessmentSent)} · due ${fmtDate(c.doc.deadline)}${c.doc.reminderSent ? " · reminded " + fmtDate(c.doc.reminderSent) : ""}</div></div>${tag}</div>`;
    }).join("") : `<div class="empty">No assessments waiting on candidates.</div>`;

    $("#recent").innerHTML = eventsHtml(S.events.slice(0, 7));
    $$("#needs .item, #outList .item").forEach((el) => el.onclick = () => openCand(el.dataset.id));
  }

  function eventsHtml(evs) {
    return evs.length ? evs.map((e) => `<div class="item"><time>${fmtDate(e.doc.date || e.at)}</time><div class="who"><b>${esc(e.doc.kind || "")}</b><div style="white-space:normal">${esc(e.doc.text || "")}</div></div></div>`).join("") : `<div class="empty">No activity yet.</div>`;
  }

  function renderCandidates() {
    const fs = $("#fStage");
    if (fs.options.length === 1) fs.insertAdjacentHTML("beforeend", STAGES.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join(""));
    const q = $("#q").value.trim().toLowerCase(), stg = fs.value, rnd = $("#fRound").value, scr = $("#fScreen").value;
    let rows = S.cands.filter((c) => {
      const d = c.doc, est = effectiveStage(c);
      if (rnd === "current" && est === "archived") return false;
      if (rnd === "archived" && est !== "archived") return false;
      if (stg && est !== stg) return false;
      if (scr && d.all3Yes !== scr) return false;
      if (q && ![d.name, d.email, d.location, d.sales, d.realEstate, d.notes].join(" ").toLowerCase().includes(q)) return false;
      return true;
    });
    const { k, dir } = S.sort, stageIdx = Object.fromEntries(STAGES.map(([s], i) => [s, i]));
    rows.sort((a, b) => {
      let x, y;
      if (k === "stage") { x = stageIdx[effectiveStage(a)]; y = stageIdx[effectiveStage(b)]; }
      else if (k === "score") { x = a.doc.score ?? -1; y = b.doc.score ?? -1; }
      else if (k === "fit") { const f = { Strong: 0, Possible: 1, Weak: 2 }; x = f[a.doc.fit] ?? 3; y = f[b.doc.fit] ?? 3; }
      else { x = String(a.doc[k] ?? ""); y = String(b.doc[k] ?? ""); }
      return (x > y ? 1 : x < y ? -1 : 0) * dir || String(a.doc.name).localeCompare(String(b.doc.name));
    });
    $("#cTable").innerHTML = rows.map((c) => {
      const d = c.doc, est = effectiveStage(c);
      const scr = d.all3Yes === "Yes" ? `<span class="yes">All 3 Yes</span>` : d.all3Yes === "No" ? `<span class="no">No</span>` : "";
      return `<tr data-id="${esc(c.id)}"><td><b>${esc(d.name)}</b><div class="muted">${esc(d.source || "")}</div></td><td>${pill(est)}${needFor(c) && needFor(c).k !== "pending" ? ` <span class="pill p-warn">needs you</span>` : ""}</td><td>${esc(d.fit || "")}</td><td>${scr}</td><td>${esc(d.location || "")}</td><td><div class="clip" title="${esc(d.sales || "")}">${esc(d.sales || d.prevStage || "")}</div></td><td>${d.score != null ? `<span class="score">${esc(d.score)}</span>` : ""}</td><td>${fmtDate(d.extendedTo || d.deadline)}</td></tr>`;
    }).join("") || `<tr><td colspan="8" class="empty">No candidates match.</td></tr>`;
    $("#cCount").textContent = `${rows.length} shown`;
    $$("#cTable tr[data-id]").forEach((tr) => tr.onclick = () => openCand(tr.dataset.id));
  }

  function renderPostings() {
    const d = role().doc || {}, min = d.repostMinDays || { linkedin: 0, indeed: 0 }, today = todayStr();
    const posts = S.posts.slice().sort((a, b) => String(b.doc.posted).localeCompare(String(a.doc.posted)));
    $("#posts").innerHTML = posts.length ? posts.map((p) => {
      const x = p.doc, status = String(x.status || "");
      const setup = /setup|requested/i.test(status);
      const cls = /active|open|reposted/i.test(status) ? "p-ok" : (setup || /paused|needs/i.test(status)) ? "p-warn" : "p-bad";
      const live = x.posted ? daysBetween(String(x.posted).slice(0, 10), today) : null;
      const m = min[String(x.platform || "").toLowerCase()] ?? 0;
      const eligible = live != null && live >= m;
      const url = safeUrl(x.url);
      return `<div class="card post"><div class="top"><span class="platform">${esc(x.platform)}</span><span class="pill ${cls}">${esc(status || "Unknown")}</span></div>
        <dl class="kv"><dt>Title</dt><dd>${esc(x.title || "")}</dd><dt>Location</dt><dd>${esc(x.location || "")}</dd>
        <dt>Posted</dt><dd>${fmtDate(x.posted)}${live != null ? ` (${live} days)` : ""}</dd>
        <dt>Applicants</dt><dd>${esc(x.applicants ?? "")}</dd><dt>Last checked</dt><dd>${fmtDate(x.lastChecked)}</dd>
        <dt>Repost</dt><dd>${setup ? "Waiting for Claude" : /paused|closed|expired/i.test(status) ? (eligible ? "Next run reposts it (reworded)" : `After ${m} days live`) : "Not needed"}</dd></dl>
        ${x.notes ? `<p class="sub" style="margin-top:8px;font-size:12.5px">${esc(x.notes)}</p>` : ""}
        ${url ? `<p style="margin:8px 0 0"><a href="${esc(url)}" target="_blank" rel="noopener">${setup ? "Open link" : "Open post"}</a></p>` : ""}</div>`;
    }).join("") : `<div class="empty">No postings recorded for this role yet.</div>`;
  }

  function renderWorkflow() {
    const d = role().doc || {}, cur = current();
    const n = (f) => cur.filter(f).length;
    const steps = [
      ["Day 0", "Applies", "LinkedIn or Indeed", cur.length],
      ["Next Mon/Wed/Fri", "Screened", "3 screeners + experience", n((c) => c.doc.all3Yes === "Yes")],
      ["Same run", "Assessment sent", `${d.deadlineDays || 5} days to finish`, n((c) => !!c.doc.assessmentSent)],
      ["Day after deadline", "Reminder", "1-day extension", n((c) => !!c.doc.reminderSent)],
      ["When submitted", "Scored", `${d.videoThreshold || 89}+ recommended`, n((c) => c.doc.score != null)],
      ["Your call", "Video invite", "Hireflix, 48 hours", n((c) => effectiveStage(c) === "video")],
    ];
    $("#flow").innerHTML = steps.map(([dd, t, s, c], i) => `${i ? '<span class="arrow">›</span>' : ""}<div class="step"><div class="d">${esc(dd)}</div><div class="t">${esc(t)}</div><div class="d">${esc(s)}</div><div class="n">${c}</div></div>`).join("");
    const cad = d.cadence || [];
    const nexts = { "Daily deadline run": nextRun([1, 2, 3, 4, 5], 8, 4), "Applicant pull": nextRun([1, 3, 5], 9, 4) };
    $("#runs").innerHTML = cad.length ? cad.map((c) => `<div class="card run"><h2 style="margin-bottom:4px">${esc(c.name)}</h2><div class="when">${esc(c.when)}</div><p style="margin:6px 0 0">${esc(c.does)}</p>${nexts[c.name] ? `<div class="next">Next: ${esc(nexts[c.name])}</div>` : ""}</div>`).join("") : `<div class="card empty">No scheduled runs for this role yet.</div>`;
    $("#rules").innerHTML = (d.rules || []).map((r) => `<li>${esc(r)}</li>`).join("") || "<li>None recorded</li>";
    $("#criteria").textContent = d.criteria || "";
    $("#screeners").innerHTML = (d.screeners || []).map((s) => `<li>${esc(s)}</li>`).join("");
    $("#log").innerHTML = eventsHtml(S.events.slice(0, 40));
  }

  // ---------- candidate drawer ----------
  function openCand(id) {
    const c = S.cands.find((x) => x.id === id); if (!c) return;
    const d = c.doc, j = jay(c), est = effectiveStage(c), r = role().doc || {};
    const sec = d.sections || {}, mins = { comm: 22, drive: 21, coach: 17, time: 10 };
    const secHtml = d.score != null ? `<div class="secs">${[["comm", "Comm /30"], ["drive", "Drive /30"], ["coach", "Coach /25"], ["time", "Time /15"]].map(([k, l]) => `<div class="${sec[k] != null && sec[k] < mins[k] ? "low" : ""}"><b>${esc(sec[k] ?? "")}</b><span>${l}</span></div>`).join("")}</div>` : "";
    const scr = d.screeners || {};
    const tl = [["Applied", d.applied], ["Added", d.added], ["Assessment sent", d.assessmentSent], ["Deadline", d.deadline], ["Reminder", d.reminderSent], ["Extended to", d.extendedTo], ["Video sent", d.videoSent]].filter(([, v]) => v);
    const acts = [];
    if (est === "applied") acts.push(`<button class="btn primary" data-act="approveA">Approve assessment</button>`);
    if (est === "queued" && j.assessment) acts.push(`<button class="btn" data-act="undoA">Undo approval</button>`);
    if (est === "graded" && j.video !== "approved") acts.push(`<button class="btn primary" data-act="approveV">Approve video invite</button>`);
    if (est === "graded" && !j.video) acts.push(`<button class="btn" data-act="holdV">Not now</button>`);
    if (j.video && !d.videoSent) acts.push(`<button class="btn" data-act="undoV">Undo video decision</button>`);
    if (est !== "out" && est !== "archived") acts.push(`<button class="btn danger" data-act="remove">Remove from pipeline</button>`);
    if (j.removed) acts.push(`<button class="btn" data-act="restore">Restore</button>`);
    const resume = safeUrl(d.resumeUrl);
    $("#drawer").innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start"><div><h3>${esc(d.name)}</h3><p class="sub">${esc(d.location || "")}${d.source ? " · " + esc(d.source) : ""}</p></div><button class="btn sm" id="closeDrawer" aria-label="Close">Close</button></div>
      <p style="margin:10px 0 0">${pill(est)} ${d.fit ? `<span class="pill p-applied">Fit: ${esc(d.fit)}</span>` : ""} ${d.score != null ? `<span class="pill p-graded">Score ${esc(d.score)}</span>` : ""}</p>
      ${(() => { const n = needFor(c); return n ? `<div class="banner" style="margin-top:12px">${esc(n.text)}</div>` : ""; })()}
      <section><div class="actions">${acts.join("") || '<span class="sub">No actions at this stage.</span>'}</div>
        ${j.at ? `<p class="sub" style="margin-top:8px;font-size:12.5px">Your last decision: ${esc([j.assessment && "assessment " + j.assessment, j.video && "video " + j.video, j.removed && "removed"].filter(Boolean).join(", "))} (${fmtDate(j.at)})</p>` : ""}
        <p class="sub" style="margin-top:6px;font-size:12px">Decisions are picked up by the next scheduled run, which sends the email. Video invites only go to people you approve here or in the run.</p></section>
      ${d.score != null ? `<section><div class="label">Assessment</div><div><span class="score" style="font-size:22px">${esc(d.score)}</span> <span class="sub">${esc(d.interpretation || "")} · ${esc(d.flags || "")}</span></div>${secHtml}<p class="sub" style="font-size:12px;margin-top:6px">${(d.score >= (r.videoThreshold || 89) && /all sections pass/i.test(d.flags || "")) ? "Recommended for a video invite." : "Below the recommendation line; your call."}</p></section>` : ""}
      <section><div class="label">Contact</div><div>${esc(d.email || "")}</div><div>${esc(d.phone || "")}</div>${resume ? `<p style="margin:6px 0 0"><a href="${esc(resume)}" target="_blank" rel="noopener">Open application and resume</a></p>` : ""}</section>
      ${d.sales || d.realEstate ? `<section><div class="label">Sales experience</div><p style="margin:0 0 10px">${esc(d.sales || "")}</p><div class="label">Real estate experience</div><p style="margin:0">${esc(d.realEstate || "")}</p></section>` : ""}
      ${scr.cold || scr.partTime || scr.commission ? `<section><div class="label">Screening answers</div><dl class="kv"><dt>Cold calling</dt><dd>${esc(scr.cold || "")}</dd><dt>Part-time + CRM</dt><dd>${esc(scr.partTime || "")}</dd><dt>Commission</dt><dd>${esc(scr.commission || "")}</dd></dl></section>` : ""}
      ${d.fitNotes ? `<section><div class="label">Fit notes</div><p style="margin:0">${esc(d.fitNotes)}</p></section>` : ""}
      ${d.prevStage ? `<section><div class="label">Previous round</div><p style="margin:0">${esc(d.prevStage)}${d.score != null ? " · score " + esc(d.score) : ""}</p></section>` : ""}
      ${tl.length ? `<section><div class="label">Timeline</div><ul class="timeline">${tl.map(([l, v]) => `<li><span>${fmtDate(v)}</span>${esc(l)}</li>`).join("")}</ul></section>` : ""}
      <section class="form"><div class="label">Your note</div><textarea id="jNote" placeholder="Private note for you and Claude">${esc(j.note || "")}</textarea><div style="margin-top:8px"><button class="btn sm" data-act="note">Save note</button></div></section>
      ${d.notes ? `<section><div class="label">Run notes</div><p style="margin:0;font-size:12.5px;color:var(--ink-2);white-space:pre-wrap">${esc(String(d.notes).split(" | ").join("\n"))}</p></section>` : ""}`;
    $("#drawer").classList.remove("hidden"); $("#scrim").classList.remove("hidden");
    $("#closeDrawer").onclick = closeAll;
    $$("#drawer [data-act]").forEach((b) => b.onclick = () => {
      const a = b.dataset.act;
      if (a === "approveA") saveDecision(c, { assessment: "approved" }, "approved for the assessment");
      if (a === "undoA") saveDecision(c, { assessment: null }, "assessment approval undone");
      if (a === "approveV") saveDecision(c, { video: "approved" }, "approved for a video invite");
      if (a === "holdV") saveDecision(c, { video: "not now" }, "video invite: not now");
      if (a === "undoV") saveDecision(c, { video: null }, "video decision undone");
      if (a === "remove" && confirmBox(`Remove ${d.name} from the pipeline? No email is sent.`)) saveDecision(c, { removed: true }, "removed from pipeline");
      if (a === "restore") saveDecision(c, { removed: false }, "restored to pipeline");
      if (a === "note") saveDecision(c, { note: $("#jNote").value.trim() }, "note updated");
    });
  }
  const confirmBox = (msg) => window.confirm(msg);
  function closeAll() { $("#drawer").classList.add("hidden"); $("#modal").classList.add("hidden"); $("#scrim").classList.add("hidden"); }

  // ---------- new role ----------
  function newRole() {
    $("#drawer").classList.add("hidden");
    $("#modal").innerHTML = `<h2 style="font:400 22px var(--serif)">New role</h2><p class="sub">Add the job and where it's posted. Claude takes it from there: posts or takes over the listings, screens applicants, sends the assessment and sets up the scheduled runs.</p>
      <form class="form" id="roleForm" novalidate>
        <label for="nrTitle">Job title</label><input id="nrTitle" name="title" required placeholder="Dispositions Manager">
        <div class="row2">
          <div><label for="nrLoc">Location</label><input id="nrLoc" name="location" placeholder="Houston, TX (remote OK)"></div>
          <div><label for="nrPay">Pay</label><input id="nrPay" name="pay" placeholder="Commission only, part-time"></div>
        </div>
        <fieldset><legend>Job posts</legend>
          <label for="nrLi">LinkedIn link</label><input id="nrLi" name="linkedin" type="url" inputmode="url" placeholder="https://www.linkedin.com/...">
          <label for="nrIn">Indeed link</label><input id="nrIn" name="indeed" type="url" inputmode="url" placeholder="https://employers.indeed.com/...">
          <p class="hint">Paste the job post links if they're already up. Leave them blank and Claude will create free posts from the description below.</p>
          <label for="nrDesc">Job description</label><textarea id="nrDesc" name="description" style="min-height:96px" placeholder="What the role does, hours, pay, what you're looking for"></textarea>
        </fieldset>
        <fieldset><legend>Screening</legend>
          <label for="nrCrit">Who gets through</label><textarea id="nrCrit" name="criteria" placeholder="Sales experience and real estate experience. Any country."></textarea>
          <label for="nrScr">Screening questions (one per line)</label><textarea id="nrScr" name="screeners" placeholder="Comfortable with commission-based pay?"></textarea>
          <div class="row2">
            <div><label for="nrAss">Assessment link (optional)</label><input id="nrAss" name="assessmentLink" type="url" inputmode="url"></div>
            <div><label for="nrVid">Video interview link (optional)</label><input id="nrVid" name="videoLink" type="url" inputmode="url"></div>
          </div>
          <label for="nrThr">Video recommendation score</label><input id="nrThr" name="videoThreshold" type="number" value="89" min="0" max="100" step="1" style="max-width:120px">
        </fieldset>
        <label for="nrNotes">Notes for Claude (optional)</label><textarea id="nrNotes" name="notes" placeholder="Anything else Claude should know when setting this up"></textarea>
        <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end"><button type="button" class="btn" id="cancelRole">Cancel</button><button class="btn primary" type="submit" id="createRole">Create role</button></div>
        <div class="err" id="roleErr" role="alert"></div></form>`;
    $("#modal").classList.remove("hidden"); $("#scrim").classList.remove("hidden");
    $("#nrTitle").focus();
    $("#cancelRole").onclick = closeAll;
    $("#roleForm").onsubmit = async (ev) => {
      ev.preventDefault();
      const f = Object.fromEntries(Array.from(new FormData(ev.target).entries()).map(([k, v]) => [k, String(v).trim()]));
      const err = (m) => { $("#roleErr").textContent = m; };
      const id = f.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
      if (!id) return err("Enter a job title.");
      if (S.roles.find((r) => r.id === id)) return err("A role with that name already exists.");
      for (const k of ["linkedin", "indeed", "assessmentLink", "videoLink"]) if (f[k] && !safeUrl(f[k])) return err("Links need to start with https://");
      const now = new Date().toISOString();
      const doc = { title: f.title, location: f.location, pay: f.pay, status: "open", automation: "not set up", setupRequestedAt: now,
        links: { linkedin: f.linkedin || null, indeed: f.indeed || null }, description: f.description, notesForClaude: f.notes,
        criteria: f.criteria, screeners: f.screeners.split("\n").map((x) => x.trim()).filter(Boolean),
        assessmentLink: f.assessmentLink || null, videoLink: f.videoLink || null, videoThreshold: Number(f.videoThreshold) || 89, deadlineDays: 5,
        repostMinDays: { linkedin: 3, indeed: 7 }, cadence: [],
        rules: ["No video link without Jay's approval by name", "Anything ready after 5 PM CT waits for Jay: send now or next morning", "No rejection emails", "Never pay, promote or sponsor a job post"],
        createdAt: now, createdBy: user ? user.email : "demo" };
      const posts = [["LinkedIn", f.linkedin], ["Indeed", f.indeed]].map(([platform, url]) => ({ id: `${id}:${platform.toLowerCase()}-initial`, role_id: id,
        doc: { platform, title: f.title, location: f.location, status: "Setup requested", url: url || null, lastChecked: todayStr(),
          notes: url ? "Link added by Jay. Claude will check it and take over this post." : "No link yet. Claude will create the first free post." } }));
      const ev0 = { role_id: id, doc: { kind: "Role created", text: `${f.title} added on the dashboard. Waiting for Claude to set up posts and runs.`, source: "dashboard" } };
      if (DEMO) { S.roles.push({ id, doc }); S.allPosts = (S.allPosts || []).concat(posts); closeAll(); location.hash = "#/role/" + encodeURIComponent(id); toast("Role created (demo, not stored)"); return; }
      $("#createRole").disabled = true;
      const { error } = await sb.from("hf_roles").insert({ id, doc });
      if (error) { $("#createRole").disabled = false; return err(error.message); }
      const r2 = await sb.from("hf_postings").insert(posts);
      await sb.from("hf_events").insert(ev0);
      closeAll(); await loadAll();
      location.hash = "#/role/" + encodeURIComponent(id);
      toast(r2.error ? "Role created, but the post links did not save: " + r2.error.message : "Role created. Tell Claude to set it up.");
    };
  }

  // ---------- tabs & events ----------
  function setTab(t) {
    S.tab = t;
    $$("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
    ["overview", "candidates", "postings", "workflow"].forEach((k) => $("#t-" + k).classList.toggle("hidden", k !== t));
    if (t === "candidates") renderCandidates();
  }
  function bind() {
    $$("#tabs button").forEach((b) => b.onclick = () => setTab(b.dataset.tab));
    ["#q", "#fStage", "#fRound", "#fScreen"].forEach((s) => $(s).addEventListener("input", renderCandidates));
    $$("th[data-sort]").forEach((th) => th.onclick = () => { const k = th.dataset.sort; S.sort = { k, dir: S.sort.k === k ? -S.sort.dir : (k === "score" ? -1 : 1) }; renderCandidates(); });
    window.addEventListener("hashchange", route);
    $("#newRoleBtn").onclick = newRole;
    $("#scrim").onclick = closeAll;
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAll(); });
    $("#signOut").onclick = async () => { if (sb) await sb.auth.signOut(); location.reload(); };
  }

  // ---------- auth ----------
  async function start() {
    bind();
    if (DEMO) { $("#app").classList.remove("hidden"); $("#signOut").classList.add("hidden"); await loadAll(); return; }
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
    const { data } = await sb.auth.getSession();
    if (data.session) return enter(data.session);
    $("#login").classList.remove("hidden");
    sb.auth.onAuthStateChange((_e, session) => { if (session && !user) enter(session); });
    $("#loginForm").onsubmit = async (ev) => {
      ev.preventDefault();
      const email = $("#lEmail").value.trim(), pass = $("#lPass").value;
      $("#loginMsg").textContent = "";
      const res = pass ? await sb.auth.signInWithPassword({ email, password: pass })
        : await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname, shouldCreateUser: false } });
      if (res.error) $("#loginMsg").textContent = res.error.message;
      else if (!pass) $("#loginMsg").textContent = "Check your email for the sign-in link.";
    };
  }
  async function enter(session) {
    user = session.user;
    $("#login").classList.add("hidden"); $("#app").classList.remove("hidden");
    try { await loadAll(); } catch (e) { S.view = "home"; render(); $("#homeSub").textContent = "Could not load data: " + (e.message || String(e)); return; }
    sb.channel("hf").on("postgres_changes", { event: "*", schema: "public", table: "hf_candidates" }, debounceReload)
      .on("postgres_changes", { event: "*", schema: "public", table: "hf_postings" }, debounceReload)
      .on("postgres_changes", { event: "*", schema: "public", table: "hf_events" }, debounceReload)
      .on("postgres_changes", { event: "*", schema: "public", table: "hf_roles" }, debounceReload).subscribe();
  }
  let _t; function debounceReload() { clearTimeout(_t); _t = setTimeout(() => loadAll().catch(() => {}), 800); }

  start();
})();
