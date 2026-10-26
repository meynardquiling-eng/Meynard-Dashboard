"""
Turns one day of Trainer Hub attendance into the Trainer Dashboard's (the training team's) attendance doc.

Trainer Hub:      attendance/<cohortId>_<date>  { records: { traineeId: { checkedIn, points } } }
Trainer Dashboard: classes/<classId>/attendance/<date>  { date, marks: {id: P|A|L}, names, late: {id: 0.25..1} }

Marks: 2 points (no call, no show) -> A. 0.25 to 1 point -> L with that many points. Checked in -> P.
Not checked in with no points -> P, listed under "unresolved" so the trainer can look.
Trainees are matched by name (both dashboards use the email username).

python3 team-attendance-sync.py <hub cohort.json> <hub attendance.json> <team trainees dir> [<team attendance.json>] > out.json
Prints { doc, changes, unresolved, unmatched } where doc is ready to write to the Trainer Dashboard.
"""
import json, sys, glob, os, time

def load(p):
    d = json.load(open(p))
    return d.get("data", d)

cohort, att = load(sys.argv[1]), load(sys.argv[2])
team = {load(f).get("name", "").strip().lower(): os.path.basename(f)[:-5] for f in glob.glob(os.path.join(sys.argv[3], "*.json"))}
old = load(sys.argv[4]) if len(sys.argv) > 4 and os.path.exists(sys.argv[4]) else {}

hub_name = {t["id"]: t["name"].strip().lower() for t in cohort["trainees"]}
marks, late, names, unresolved, unmatched = {}, {}, {}, [], []
for name, tid in team.items():
    names[tid] = name
    marks[tid] = "P"  # the Trainer Dashboard's own default for anyone not marked
for hid, r in (att.get("records") or {}).items():
    name = hub_name.get(hid)
    tid = team.get(name)
    if not tid:
        unmatched.append(name or hid)
        continue
    pts = r.get("points")
    if pts is not None and pts >= 2:
        marks[tid] = "A"
    elif pts:
        marks[tid] = "L"
        late[tid] = pts
    elif not r.get("checkedIn"):
        unresolved.append(name)

changes = []
for tid, m in marks.items():
    before = (old.get("marks") or {}).get(tid)
    bl = (old.get("late") or {}).get(tid)
    if old and (before != m or (m == "L" and bl != late.get(tid))):
        fmt = lambda x, b: f"{x}{f' ({b})' if x == 'L' else ''}"
        changes.append(f"{names[tid]}: {fmt(before, bl) if before else 'none'} -> {fmt(m, late.get(tid))}")

doc = {"date": att["date"], "marks": marks, "names": names, "late": late,
       "updatedAt": int(time.time() * 1000), "updatedBy": "meynard", "updatedByName": "Meynard (synced from Trainer Hub)"}
print(json.dumps({"doc": doc, "new": not old, "changes": changes, "unresolved": unresolved, "unmatched": unmatched}, indent=1))
