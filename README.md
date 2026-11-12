# Hiring Flow dashboard

A private dashboard for every role Utopian Capital is hiring for. Hosted on GitHub Pages, with the data in your Utopian CRM Supabase project (`yahosblylysopbxgztvg`), the same setup as Subdivide Finder.

- **Home (Roles):** a card for every role with applicants, how many need you, assessments out, scores, post status and the next run. Click a card to open the role.
- **Overview:** applicants, screener pass rate, assessments out, scores, video invites, and a "Needs you" list.
- **Candidates:** every applicant with stage, fit, screener answers, experience, score and deadlines. Click a name to approve the assessment, approve or hold a video invite, remove someone, or leave a note.
- **Postings:** each LinkedIn and Indeed post with status, days live, applicants and when it can be reposted.
- **Workflow:** the candidate journey with live counts, the scheduled runs and their next times, the rules, and the activity log.
- **New role:** add the job, its LinkedIn and Indeed links (or leave them blank and give a description), pay, screeners and links. The role shows "Waiting for setup" until you tell Claude "set up hiring flow for <role>"; the daily run also lists roles waiting for setup.

Decisions you make on the dashboard are saved to Supabase. The next scheduled run applies them to the tracker and sends the emails. Video invites only go to people you approve.

## Files

| File | What it does |
|---|---|
| `docs/index.html`, `docs/app.js` | The dashboard (one page) |
| `docs/config.js` | Supabase URL and public key (safe to publish; security rules keep the data private) |
| `supabase/migrations/20261111000000_hiring_flow.sql` | Creates the `hf_` tables and members-only security. Touches no other table |
| `scripts/sync_dashboard.py` | Builds SQL that copies the tracker into Supabase (the scheduled runs use it) |
| `scripts/apply_dashboard_decisions.py` | Applies your dashboard decisions to the tracker (the scheduled runs use it) |
| `docs/demo-data.json` | A private preview copy of the data for your Mac only. It is git-ignored and never uploaded |

## 1. Supabase: create the tables (5 min)

Supabase → your CRM project → **SQL Editor** → **New query** → paste all of `supabase/migrations/20261111000000_hiring_flow.sql` → **Run**.

Then load today's data: paste and run `scripts/dashboard_sync.sql` from the Hiring Flow folder on your Mac (it has candidate contact details, so it is not in this repo).

Only emails in `hf_members` can see anything. Yours (jay@utopiancapitalinvest.com and jayrav70@gmail.com) are added. To add someone: `insert into hf_members (email) values ('their@email.com');`

## 2. Supabase: allow the site's address for sign-in links

**Authentication → URL Configuration → Redirect URLs → Add URL:** `https://nishrav2-tech.github.io/hiring-flow/`

Sign in with your CRM email and password, or leave the password blank to get an email link.

## 3. GitHub: publish (5 min)

1. github.com (account `nishrav2-tech`) → **New repository** → name `hiring-flow` → Public → Create. Public is fine: no candidate data is in the repo.
2. Upload everything in this folder (drag the files in, or use the commands below).
3. Repo **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: main, folder: /docs → Save**.
4. A minute later it's live at **https://nishrav2-tech.github.io/hiring-flow/**

```bash
cd "~/Documents/Utopian Capital/Claude/Claude Homebase/02 Projects/Utopian Claude Projects/Hiring Flow/hiring-dashboard"
git init && git add . && git commit -m "Hiring Flow dashboard"
git branch -M main
git remote add origin https://github.com/nishrav2-tech/hiring-flow.git
git push -u origin main
```

## Preview without signing in

In Terminal: `cd` into this folder's `docs` folder, run `python3 -m http.server 8000`, then open http://localhost:8000/?demo=1 . It uses `docs/demo-data.json` (a snapshot of the tracker, git-ignored). Buttons work in preview but nothing is saved.
