"""Clean stale entries out of the jobs database. Dry run by default; nothing changes without --apply.

    uv run python cleanup.py                      # report what each rule would do
    uv run python cleanup.py --list expired       # show the rows behind one rule
    uv run python cleanup.py --export rows.csv    # every affected row, for a spreadsheet
    uv run python cleanup.py --apply              # back up the database, then do it

Rules, applied in this order; a row is counted by the first rule that matches it:
  expired           status new/seen and the deadline has passed                          -> delete
  stale-new         status new, not seen for more than --new-older-than days, no future  -> delete
                    deadline, and a score below --keep-score (an unscored job counts as below)
  stale-seen        status seen for more than --seen-older-than days                     -> delete
  compact-rejected  status rejected for more than --compact-rejected-older-than days     -> remove the
                    stored ad text; the row stays so the ad still shows as rejected
  orphans           links and aliases pointing at jobs that no longer exist, and skills nothing uses

Jobs you saved or applied to are never touched. Set a threshold to 0 to switch its rule off.
"""
import argparse
import csv
import datetime
import os
import re
import sqlite3
import sys
from dataclasses import dataclass, field

import models
from database import SessionLocal, engine

PROTECTED = {"saved", "applied"}
RULES = ["expired", "stale-new", "stale-seen", "compact-rejected", "orphans"]
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}")


@dataclass
class Options:
    new_older_than: int = 30
    seen_older_than: int = 30
    compact_rejected_older_than: int = 14
    keep_score: int = 70


@dataclass
class Plan:
    today: datetime.date
    total_jobs: int
    by_rule: dict = field(default_factory=lambda: {r: [] for r in RULES if r != "orphans"})
    orphans: dict = field(default_factory=lambda: {"job_skills": [], "job_urls": [], "skills": []})
    kept_by_score: list = field(default_factory=list)   # old untriaged jobs spared because they scored well
    attention: list = field(default_factory=list)       # saved/applied jobs whose deadline has passed (never touched)

    def deletions(self):
        return self.by_rule["expired"] + self.by_rule["stale-new"] + self.by_rule["stale-seen"]

    def changes(self):
        return len(self.deletions()) + len(self.by_rule["compact-rejected"]) + sum(len(v) for v in self.orphans.values())


def _deadline(job):
    return job.deadline[:10] if job.deadline and ISO_DATE.match(job.deadline) else None


def _last_seen(job):
    stamp = job.last_seen_at or job.created_at
    return stamp.date() if stamp else None


def _age_days(job, today):
    seen = _last_seen(job)
    return (today - seen).days if seen else None


def build_plan(db, today, opts):
    plan = Plan(today=today, total_jobs=db.query(models.Job).count())
    iso_today = today.isoformat()
    for job in db.query(models.Job).order_by(models.Job.id):
        deadline, age = _deadline(job), _age_days(job, today)
        if job.status in PROTECTED:
            if deadline and deadline < iso_today:
                plan.attention.append(job)
            continue
        if job.status in ("new", "seen") and deadline and deadline < iso_today:
            plan.by_rule["expired"].append(job)
        elif job.status == "new" and opts.new_older_than and age is not None and age > opts.new_older_than \
                and not (deadline and deadline >= iso_today):
            if job.fit_score is not None and job.fit_score >= opts.keep_score:
                plan.kept_by_score.append(job)
            else:
                plan.by_rule["stale-new"].append(job)
        elif job.status == "seen" and opts.seen_older_than and age is not None and age > opts.seen_older_than:
            plan.by_rule["stale-seen"].append(job)
        elif job.status == "rejected" and opts.compact_rejected_older_than and age is not None \
                and age > opts.compact_rejected_older_than and (job.description_snippet or job.raw_payload):
            plan.by_rule["compact-rejected"].append(job)

    # Orphans, as they will be once the deletions above are done.
    gone = {j.id for j in plan.deletions()}
    live = {j.id for j in db.query(models.Job.id)} - gone
    skills = {s.id for s in db.query(models.Skill.id)}
    plan.orphans["job_skills"] = [js for js in db.query(models.JobSkill) if js.job_id not in live or js.skill_id not in skills]
    plan.orphans["job_urls"] = [u for u in db.query(models.JobUrl) if u.job_id not in live]
    used = {js.skill_id for js in db.query(models.JobSkill) if js.job_id in live} - set()
    plan.orphans["skills"] = [s for s in db.query(models.Skill) if s.id not in used]
    return plan


def apply_plan(db, plan):
    ids = {j.id for j in plan.deletions()}
    if ids:
        db.query(models.JobSkill).filter(models.JobSkill.job_id.in_(ids)).delete(synchronize_session=False)
        db.query(models.JobUrl).filter(models.JobUrl.job_id.in_(ids)).delete(synchronize_session=False)
        db.query(models.Job).filter(models.Job.id.in_(ids)).delete(synchronize_session=False)
    for job in plan.by_rule["compact-rejected"]:
        job.description_snippet = None
        job.raw_payload = None
    for js in plan.orphans["job_skills"]:
        db.query(models.JobSkill).filter(models.JobSkill.id == js.id).delete(synchronize_session=False)
    for url in plan.orphans["job_urls"]:
        db.query(models.JobUrl).filter(models.JobUrl.id == url.id).delete(synchronize_session=False)
    # Skills that nothing uses once the links above are gone.
    used = {r[0] for r in db.query(models.JobSkill.skill_id)}
    db.query(models.Skill).filter(~models.Skill.id.in_(used) if used else models.Skill.id.isnot(None)).delete(synchronize_session=False)
    db.commit()


def backup_database(db_path, directory, now=None):
    """A consistent copy taken with SQLite's own backup API (safe while the app is running)."""
    os.makedirs(directory, exist_ok=True)
    stamp = (now or datetime.datetime.now()).strftime("%Y%m%d-%H%M%S")
    dest = os.path.join(directory, f"jobs-cleanup-{stamp}.db")
    source, target = sqlite3.connect(db_path), sqlite3.connect(dest)
    try:
        source.backup(target)
    finally:
        target.close()
        source.close()
    return dest


def _row(job, rule, today):
    return [rule, job.id, job.status, (job.last_seen_at or job.created_at or "") and str((job.last_seen_at or job.created_at))[:10],
            job.deadline or "", "" if job.fit_score is None else job.fit_score, job.company or "", job.title or "", job.url or ""]


def affected_rows(plan):
    for rule in ("expired", "stale-new", "stale-seen", "compact-rejected"):
        for job in plan.by_rule[rule]:
            yield _row(job, rule, plan.today)


DESCRIPTIONS = {
    "expired": "delete   status new/seen, deadline already passed",
    "stale-new": "delete   status new, not seen for a long time, no future deadline, score below the bar",
    "stale-seen": "delete   status seen, viewed long ago and never decided",
    "compact-rejected": "strip    remove the stored ad text of rejected jobs (the row stays)",
}


def print_report(plan, opts, apply):
    print(f"Cleanup report ({'APPLYING' if apply else 'dry run: nothing is changed'}) for {plan.today}: {plan.total_jobs} jobs in the database")
    print(f"  thresholds: new > {opts.new_older_than or 'off'} days, seen > {opts.seen_older_than or 'off'} days, "
          f"rejected text > {opts.compact_rejected_older_than or 'off'} days, keep scores >= {opts.keep_score}\n")
    print(f"  {'rule':<17}{'rows':>5}   what happens")
    for rule in ("expired", "stale-new", "stale-seen", "compact-rejected"):
        print(f"  {rule:<17}{len(plan.by_rule[rule]):>5}   {DESCRIPTIONS[rule]}")
    o = plan.orphans
    print(f"  {'orphans':<17}{sum(len(v) for v in o.values()):>5}   delete   {len(o['job_skills'])} skill links, {len(o['job_urls'])} URL aliases, {len(o['skills'])} unused skills")
    deleted = len(plan.deletions())
    print(f"\n  => {deleted} jobs deleted, {len(plan.by_rule['compact-rejected'])} stripped, leaving {plan.total_jobs - deleted} jobs")
    if plan.kept_by_score:
        print(f"\n  kept because they scored >= {opts.keep_score}: {len(plan.kept_by_score)} old untriaged jobs (lower --keep-score to include them)")
    if plan.attention:
        print(f"  for your attention, never touched: {len(plan.attention)} saved/applied job(s) whose deadline has passed:")
        for job in plan.attention[:5]:
            print(f"    #{job.id} [{job.status}] {job.deadline}  {job.company} - {job.title}")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Clean stale entries out of the jobs database (dry run unless --apply).")
    parser.add_argument("--apply", action="store_true", help="back up the database, then make the changes")
    parser.add_argument("--list", metavar="RULE", choices=RULES[:-1], help="print the rows behind one rule")
    parser.add_argument("--export", metavar="FILE.csv", help="write every affected row to a CSV file")
    parser.add_argument("--new-older-than", type=int, default=30, metavar="DAYS")
    parser.add_argument("--seen-older-than", type=int, default=30, metavar="DAYS")
    parser.add_argument("--compact-rejected-older-than", type=int, default=14, metavar="DAYS")
    parser.add_argument("--keep-score", type=int, default=70, metavar="N", help="spare old untriaged jobs scored at least N")
    parser.add_argument("--backup-dir", default=os.path.expanduser("~/backups"))
    parser.add_argument("--today", type=datetime.date.fromisoformat, default=None, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    opts = Options(args.new_older_than, args.seen_older_than, args.compact_rejected_older_than, args.keep_score)
    today = args.today or datetime.date.today()

    # SQLite creates a missing file on connect; a cleanup tool must never invent an empty database and report on it.
    path = engine.url.database
    if not path or not os.path.exists(path):
        print(f"No database at {path!r}. Run this from the backend folder that holds jobs.db, or set DATABASE_URL.", file=sys.stderr)
        return 2

    db = SessionLocal()
    try:
        plan = build_plan(db, today, opts)
        print_report(plan, opts, args.apply)
        if args.list:
            print(f"\nRows for rule '{args.list}':")
            for job in plan.by_rule[args.list]:
                print(f"  #{job.id:<5} {job.status:<9} seen {str(_last_seen(job)):<11} deadline {job.deadline or '-':<11} score {job.fit_score if job.fit_score is not None else '-':<4} {job.company} - {job.title}")
        if args.export:
            with open(args.export, "w", newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                writer.writerow(["rule", "id", "status", "last_seen", "deadline", "score", "company", "title", "url"])
                writer.writerows(affected_rows(plan))
            print(f"\nWrote {args.export}")
        if not args.apply:
            print("\nDry run only. Re-run with --apply to back up the database and make these changes.")
            return 0
        if not plan.changes():
            print("\nNothing to do.")
            return 0
        backup = backup_database(path, args.backup_dir)
        print(f"\nBacked up the database to {backup}")
        apply_plan(db, plan)
        print(f"Done. To undo: docker compose stop backend && cp '{backup}' '{path}' && docker compose start backend")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
