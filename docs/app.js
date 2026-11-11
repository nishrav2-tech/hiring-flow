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
  const S = { roles: [], roleId: null, cands: [], posts: [], events: [], tab: "overview", sort: { k: "stage", dir: 1 } };

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
    if (!S.roleId || !S.roles.find((x) => x.id === S.roleId)) {
      const saved = (() => { try { return localStorage.getItem("hf_role"); } catch (_) { return null; } })();
      S.roleId = (S.roles.find((x) => x.id === saved) || S.roles[0] || {}).id || null;
    }
    pick();
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
    const r = role(), d = r.doc || {};
    const sel = $("#roleSel");
    sel.innerHTML = S.roles.map((x) => `<option value="${esc(x.id)}"${x.id === S.roleId ? " selected" : ""}>${esc(x.doc.title || x.id)}${x.doc.status && x.doc.status !== "open" ? " (" + esc(x.doc.status) + ")" : ""}</option>`).join("") || `<option>No roles yet</option>`;
    $("#roleTitle").textContent = d.title || "No role selected";
    $("#roleSub").textContent = [d.location, d.status ? "Status: " + d.status : "", d.syncedAt ? "Last synced " + new Date(d.syncedAt).toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " CT" : ""].filter(Boolean).join(" · ");
    const banner = $("#roleBanner");
    if (r.id && d.automation !== "on") { banner.innerHTML = "Automation for this role is not set up yet. Ask Claude to set up the hiring runs for it (postings, applicant pulls, assessment, grading)."; banner.classList.remove("hidden"); }
    else banner.classList.add("hidden");
    const needN = current().filter((c) => { const n = needFor(c); return n && n.k !== "pending"; }).length;
    $('#tabs [data-tab="overview"]').innerHTML = "Overview" + (needN ? `<span class="count">${needN}</span>` : "");
    renderOverview(); renderCandidates(); renderPostings(); renderWorkflow();
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
    const d = role().doc || {}, min = d.repostMinDays || { linkedin: 3, indeed: 7 }, today = todayStr();
    const posts = S.posts.slice().sort((a, b) => String(b.doc.posted).localeCompare(String(a.doc.posted)));
    $("#posts").innerHTML = posts.length ? posts.map((p) => {
      const x = p.doc, status = String(x.status || "");
      const cls = /active|open|reposted/i.test(status) ? "p-ok" : /paused|needs/i.test(status) ? "p-warn" : "p-bad";
      const live = x.posted ? daysBetween(String(x.posted).slice(0, 10), today) : null;
      const m = min[String(x.platform || "").toLowerCase()] || 7;
      const eligible = live != null && live >= m;
      const url = safeUrl(x.url);
      return `<div class="card post"><div class="top"><span class="platform">${esc(x.platform)}</span><span class="pill ${cls}">${esc(status || "Unknown")}</span></div>
        <dl class="kv"><dt>Title</dt><dd>${esc(x.title || "")}</dd><dt>Location</dt><dd>${esc(x.location || "")}</dd>
        <dt>Posted</dt><dd>${fmtDate(x.posted)}${live != null ? ` (${live} days)` : ""}</dd>
        <dt>Applicants</dt><dd>${esc(x.applicants ?? "")}</dd><dt>Last checked</dt><dd>${fmtDate(x.lastChecked)}</dd>
        <dt>Repost</dt><dd>${/paused|closed|expired/i.test(status) ? (eligible ? "Eligible now (reworded)" : `After ${m} days live`) : "Not needed"}</dd></dl>
        ${x.notes ? `<p class="sub" style="margin-top:8px;font-size:12.5px">${esc(x.notes)}</p>` : ""}
        ${url ? `<p style="margin:8px 0 0"><a href="${esc(url)}" target="_blank" rel="noopener">Open post</a></p>` : ""}</div>`;
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
    $("#modal").innerHTML = `<h2 style="font:400 22px var(--serif)">New role</h2><p class="sub">Creates the role on the dashboard. Claude then sets up its postings and scheduled runs.</p>
      <form class="form" id="roleForm">
        <label>Job title</label><input name="title" required placeholder="Dispositions Manager">
        <label>Location</label><input name="location" placeholder="Houston, TX (remote OK)">
        <label>Who gets through (criteria)</label><textarea name="criteria" placeholder="Sales experience, real estate experience, ..."></textarea>
        <label>Screening questions (one per line)</label><textarea name="screeners"></textarea>
        <label>Assessment link (optional)</label><input name="assessmentLink" type="url">
        <label>Video interview link (optional)</label><input name="videoLink" type="url">
        <label>Video recommendation score</label><input name="videoThreshold" type="number" value="89" min="0" max="100" step="1">
        <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end"><button type="button" class="btn" id="cancelRole">Cancel</button><button class="btn primary">Create role</button></div>
        <div class="err" id="roleErr"></div></form>`;
    $("#modal").classList.remove("hidden"); $("#scrim").classList.remove("hidden");
    $("#cancelRole").onclick = closeAll;
    $("#roleForm").onsubmit = async (ev) => {
      ev.preventDefault();
      const f = Object.fromEntries(new FormData(ev.target).entries());
      const id = f.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
      if (!id) return ($("#roleErr").textContent = "Enter a job title.");
      if (S.roles.find((r) => r.id === id)) return ($("#roleErr").textContent = "A role with that name already exists.");
      const doc = { title: f.title.trim(), location: f.location.trim(), status: "open", automation: "not set up", criteria: f.criteria.trim(),
        screeners: f.screeners.split("\n").map((s) => s.trim()).filter(Boolean), assessmentLink: f.assessmentLink || null, videoLink: f.videoLink || null,
        videoThreshold: Number(f.videoThreshold) || 89, deadlineDays: 5, cadence: [], rules: ["No video link without Jay's approval by name", "No rejection emails"], createdAt: new Date().toISOString() };
      if (DEMO) { S.roles.push({ id, doc }); S.roleId = id; closeAll(); pick(); return; }
      const { error } = await sb.from("hf_roles").insert({ id, doc });
      if (error) return ($("#roleErr").textContent = error.message);
      await sb.from("hf_events").insert({ role_id: id, doc: { kind: "Role created", text: `${doc.title} added on the dashboard`, source: "dashboard" } });
      S.roleId = id; try { localStorage.setItem("hf_role", id); } catch (_) {}
      closeAll(); await loadAll(); toast("Role created");
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
    $("#roleSel").onchange = (e) => { S.roleId = e.target.value; try { localStorage.setItem("hf_role", S.roleId); } catch (_) {} closeAll(); pick(); };
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
    try { await loadAll(); } catch (e) { $("#roleTitle").textContent = "Could not load data"; $("#roleSub").textContent = e.message || String(e); return; }
    if (!S.roles.length) { $("#roleTitle").textContent = "No access yet"; $("#roleSub").textContent = "Your login is not on the Hiring Flow member list (hf_members), or no roles exist yet."; }
    sb.channel("hf").on("postgres_changes", { event: "*", schema: "public", table: "hf_candidates" }, debounceReload)
      .on("postgres_changes", { event: "*", schema: "public", table: "hf_postings" }, debounceReload)
      .on("postgres_changes", { event: "*", schema: "public", table: "hf_events" }, debounceReload)
      .on("postgres_changes", { event: "*", schema: "public", table: "hf_roles" }, debounceReload).subscribe();
  }
  let _t; function debounceReload() { clearTimeout(_t); _t = setTimeout(() => loadAll().catch(() => {}), 800); }

  start();
})();
