"""Build SQL that mirrors the Hiring Flow tracker (xlsx) into the dashboard's Supabase tables.

Usage (on Jay's Mac, from the Hiring Flow folder):
  python3 scripts/sync_dashboard.py > scripts/dashboard_sync.sql
Then run the SQL with the Supabase execute_sql tool (or paste it in the SQL Editor).

Safe to re-run: rows are upserted, and Jay's decisions (doc.jay) are never overwritten.
Events are inserted only if that exact event is not already there.
"""
import json, sys, datetime, re, os
import openpyxl

ROLE_ID = "acquisitions-manager"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TRACKER = os.path.join(ROOT, "[C] Hiring Pipeline.xlsx")
CONFIG = os.path.join(HERE, "hiring_config.json")

def iso(v):
    if v is None or v == "": return None
    if isinstance(v, (datetime.datetime, datetime.date)): return v.strftime("%Y-%m-%d")
    return str(v)

def num(v):
    try: return None if v in (None, "") else round(float(v), 2)
    except Exception: return None

def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")[:60]

def q(s):  # SQL dollar-quoted JSON
    return "$hf$" + json.dumps(s, ensure_ascii=False) + "$hf$::jsonb"

def stage_for(d):
    st = (d.get("status") or "").lower()
    notes = (d.get("notes") or "").lower()
    if st == "not moving forward" or "removed by jay" in notes: return "out"
    if d.get("videoSent"): return "video"
    if d.get("score") is not None: return "graded"
    if d.get("assessmentSent"):
        return "no_submit" if "did not submit" in notes else "assessment"
    if (d.get("selectedForAssessment") or "").lower() == "yes": return "queued"
    return "applied"

def main():
    cfg = json.load(open(CONFIG))
    wb = openpyxl.load_workbook(TRACKER, data_only=True)
    out = ["begin;"]
    role = {
        "title": cfg.get("role", "Acquisitions Manager"), "location": "Houston, TX (remote OK)",
        "status": "open", "automation": "on",
        "assessmentLink": cfg.get("assessment_link"), "videoLink": cfg.get("video_interview_link"),
        "deadlineDays": cfg.get("assessment_deadline_days", 5), "videoThreshold": cfg.get("video_auto_threshold", 89),
        "screeners": ["Comfortable cold calling, negotiating with sellers, and following up by call and text?",
                      "Can take client calls on a flexible part-time schedule, keep the CRM updated, and send daily activity reports?",
                      "Comfortable with commission-based pay?"],
        "criteria": "Yes to all 3 screeners, plus sales and real estate experience. Any country.",
        "cadence": [
            {"name": "Daily deadline run", "when": "Weekdays 8:04 AM CT", "does": "Sends approved assessment invites, sends reminders (1-day extension), scores new submissions, asks Jay about video invites"},
            {"name": "Applicant pull", "when": "Mon, Wed, Fri 9:04 AM CT", "does": "Checks and rewords/reposts job posts (LinkedIn 3 days, Indeed 7 days minimum), adds new applicants, auto-sends the assessment to clear qualifiers, lists borderline ones, Friday video review list"}],
        "rules": ["No video link without Jay's approval by name", "Anything ready after 5 PM CT waits for Jay: send now or next morning",
                  "No rejection emails", "Pramod CC'd only when Jay asks", "Never pay, promote or sponsor a job post"],
        "syncedAt": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    out.append(f"insert into hf_roles (id, doc) values ('{ROLE_ID}', {q(role)}) "
               "on conflict (id) do update set doc = hf_roles.doc || excluded.doc;")

    cs = wb["Candidates"]; hdr = [c.value for c in cs[1]]; ix = {h: i for i, h in enumerate(hdr)}
    g = lambda r, k: r[ix[k]] if k in ix else None
    n = 0
    for r in cs.iter_rows(min_row=2, values_only=True):
        if not g(r, "Name"): continue
        res = cs.cell(row=n + 2, column=ix["Resume"] + 1)
        d = {
            "name": g(r, "Name"), "email": g(r, "Email"), "phone": g(r, "Phone"),
            "sales": g(r, "Sales Experience"), "realEstate": g(r, "Real Estate Experience"),
            "location": g(r, "Location"), "resumeUrl": res.hyperlink.target if res.hyperlink else None,
            "source": g(r, "Source"), "posting": g(r, "Job Posting"), "applied": iso(g(r, "Applied Date")),
            "added": iso(g(r, "Date Added")), "fit": g(r, "Fit"), "fitNotes": g(r, "Fit Notes"),
            "status": g(r, "Status"), "selectedForAssessment": g(r, "Select for Assessment"),
            "assessmentSent": iso(g(r, "Assessment Sent")), "deadline": iso(g(r, "Assessment Deadline")),
            "reminderSent": iso(g(r, "Reminder Sent")), "extendedTo": iso(g(r, "Extended To")),
            "score": num(g(r, "Assessment Score")),
            "sections": {"comm": num(g(r, "Comm /30")), "drive": num(g(r, "Drive /30")), "coach": num(g(r, "Coach /25")), "time": num(g(r, "Time /15"))},
            "interpretation": g(r, "Interpretation"), "flags": g(r, "Section Flags"),
            "videoApproved": g(r, "Video Approved"), "videoSent": iso(g(r, "Video Sent")),
            "screeners": {"cold": g(r, "Screener: Cold Calling"), "partTime": g(r, "Screener: Part-Time + CRM"), "commission": g(r, "Screener: Commission Only")},
            "all3Yes": g(r, "All 3 Yes"), "notes": g(r, "Notes"), "round": "Nov 2026",
        }
        d["stage"] = stage_for(d)
        cid = f"{ROLE_ID}:{slug(str(d['email'] or '').split(' ')[0] or d['name'])}"
        out.append(f"insert into hf_candidates (id, role_id, doc) values ('{cid}', '{ROLE_ID}', {q(d)}) "
                   "on conflict (id) do update set doc = excluded.doc || case when hf_candidates.doc ? 'jay' "
                   "then jsonb_build_object('jay', hf_candidates.doc->'jay') else '{}'::jsonb end;")
        n += 1

    pr = wb["Previous Rounds"]
    for r in pr.iter_rows(min_row=2, values_only=True):
        if not r[0]: continue
        d = {"name": r[0], "email": r[1], "location": r[2], "source": r[3], "realEstate": r[5],
             "prevStage": r[6], "score": num(r[7]), "round": "Sep-Oct 2026", "stage": "archived"}
        cid = f"{ROLE_ID}:prev-{slug(r[1] or r[0])}"
        out.append(f"insert into hf_candidates (id, role_id, doc) values ('{cid}', '{ROLE_ID}', {q(d)}) "
                   "on conflict (id) do update set doc = excluded.doc || case when hf_candidates.doc ? 'jay' "
                   "then jsonb_build_object('jay', hf_candidates.doc->'jay') else '{}'::jsonb end;")

    ps = wb["Postings"]; ph = [c.value for c in ps[1]]
    for i, r in enumerate(ps.iter_rows(min_row=2, values_only=True)):
        if not r[0]: continue
        d = dict(zip(["platform", "title", "location", "status", "posted", "expires", "lastChecked", "url", "applicants", "notes"], [iso(v) if isinstance(v, (datetime.date, datetime.datetime)) else v for v in r]))
        pid = f"{ROLE_ID}:{slug(d['platform'])}-{slug(d.get('posted') or i)}-{i}"
        out.append(f"insert into hf_postings (id, role_id, doc) values ('{pid}', '{ROLE_ID}', {q(d)}) "
                   "on conflict (id) do update set doc = hf_postings.doc || excluded.doc;")

    lg = wb["Log"]
    for r in lg.iter_rows(min_row=2, values_only=True):
        if not r[0]: continue
        d = {"date": iso(r[0]), "kind": r[1], "text": r[2], "count": r[3], "source": "tracker log"}
        at = iso(r[0]) + "T12:00:00Z"
        out.append(f"insert into hf_events (role_id, at, doc) select '{ROLE_ID}', '{at}', {q(d)} "
                   f"where not exists (select 1 from hf_events where role_id='{ROLE_ID}' and doc->>'text' = {q(d)}->>'text');")
    out.append("commit;")
    print("\n".join(out))
    print(f"-- {n} current candidates", file=sys.stderr)

if __name__ == "__main__":
    main()
