"""Apply Jay's dashboard decisions to the Hiring Flow tracker.

1. Run this SQL with the Supabase execute_sql tool (project yahosblylysopbxgztvg):
     select id, doc->>'email' as email, doc->>'name' as name, doc->'jay' as jay
     from hf_candidates where role_id = 'acquisitions-manager' and doc ? 'jay';
2. Save the JSON rows to scripts/dashboard_decisions.json on the Mac.
3. python3 scripts/apply_dashboard_decisions.py   (prints what changed)

Mapping: jay.assessment = "approved"  -> Select for Assessment = Yes, Status = Selected for Assessment (if not sent yet)
         jay.video = "approved"       -> Video Approved = Yes (the run then sends the video invite; this IS Jay's approval by name)
         jay.video = "not now"        -> note only, no email
         jay.removed = true           -> Status = Not Moving Forward, no email
         jay.note                     -> appended to Notes once
"""
import json, os, sys, openpyxl
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
TRACKER = os.path.join(ROOT, "[C] Hiring Pipeline.xlsx")
rows = json.load(open(os.path.join(HERE, "dashboard_decisions.json")))
if isinstance(rows, dict) and "result" in rows: rows = rows["result"]
wb = openpyxl.load_workbook(TRACKER); cs = wb["Candidates"]
col = {c.value: i + 1 for i, c in enumerate(cs[1])}
by_email = {}
for r in range(2, cs.max_row + 1):
    em = str(cs.cell(r, col["Email"]).value or "").split(" ")[0].lower()
    if em: by_email[em] = r
changed = []
for row in rows:
    j = row.get("jay") or {}
    if isinstance(j, str): j = json.loads(j)
    r = by_email.get(str(row.get("email") or "").split(" ")[0].lower())
    if not r: changed.append(f"NOT FOUND in tracker: {row.get('name')}"); continue
    name = cs.cell(r, col["Name"]).value; notes = cs.cell(r, col["Notes"]).value or ""
    def note(t):
        global notes
        if t not in notes: notes = (notes + " | " if notes else "") + t
    if j.get("removed"):
        if cs.cell(r, col["Status"]).value != "Not Moving Forward":
            cs.cell(r, col["Status"], "Not Moving Forward"); note(f"Removed by Jay on dashboard {str(j.get('at',''))[:10]} (no email)."); changed.append(f"{name}: removed")
    else:
        if j.get("assessment") == "approved" and not cs.cell(r, col["Assessment Sent"]).value and cs.cell(r, col["Select for Assessment"]).value != "Yes":
            cs.cell(r, col["Select for Assessment"], "Yes"); cs.cell(r, col["Status"], "Selected for Assessment")
            note(f"Assessment approved by Jay on dashboard {str(j.get('at',''))[:10]}."); changed.append(f"{name}: assessment approved")
        if j.get("video") == "approved" and cs.cell(r, col["Video Approved"]).value != "Yes" and not cs.cell(r, col["Video Sent"]).value:
            cs.cell(r, col["Video Approved"], "Yes"); note(f"Video approved by Jay on dashboard {str(j.get('at',''))[:10]}."); changed.append(f"{name}: video approved")
        if j.get("video") == "not now": note("Video: not now (Jay, dashboard).")
    if j.get("note"): note(f"Jay note: {j['note']}")
    cs.cell(r, col["Notes"], notes)
wb.save(TRACKER)
print("\n".join(changed) if changed else "No new decisions.")
