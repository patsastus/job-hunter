"""Merge duplicate jobs that share a fingerprint (reposts of the same ad).

Dry run by default; pass --apply to write. Back up jobs.db first.
Usage: python dedupe.py [--apply]
"""
import sys
from collections import defaultdict

from sqlalchemy.orm import Session

import models

# Higher wins. The ad furthest along the pipeline is the one to keep.
STATUS_RANK = {"applied": 3, "saved": 2, "rejected": 1, "new": 0}
# Fields copied onto the keeper when it has none of its own.
FILLABLE = ["location", "published", "deadline", "salary", "job_type", "industry",
            "apply_url", "fit_score", "fit_reason", "raw_payload"]


def _keeper_sort_key(job: models.Job):
    return (
        STATUS_RANK.get(job.status, 0),
        len(job.job_skills),
        job.fit_score is not None,
        -job.id,  # oldest wins ties
    )


def merge_duplicates(db: Session, apply: bool = False) -> list[dict]:
    groups = defaultdict(list)
    for job in db.query(models.Job).filter(models.Job.fingerprint.isnot(None)).all():
        groups[job.fingerprint].append(job)

    report = []
    for fp, jobs in groups.items():
        if len(jobs) < 2:
            continue
        jobs.sort(key=_keeper_sort_key, reverse=True)
        keeper, losers = jobs[0], jobs[1:]
        report.append({
            "title": keeper.title, "company": keeper.company,
            "keep": (keeper.id, keeper.status),
            "drop": [(j.id, j.status) for j in losers],
        })
        if not apply:
            continue

        have_skills = {js.skill_id for js in keeper.job_skills}
        for loser in losers:
            for js in list(loser.job_skills):
                if js.skill_id not in have_skills:
                    js.job_id = keeper.id
                    have_skills.add(js.skill_id)
            for attr in FILLABLE:
                if getattr(keeper, attr) is None and getattr(loser, attr) is not None:
                    setattr(keeper, attr, getattr(loser, attr))
            if len(loser.description_snippet or "") > len(keeper.description_snippet or ""):
                keeper.description_snippet = loser.description_snippet
            firsts = [d for d in (keeper.first_seen_at, loser.first_seen_at) if d]
            lasts = [d for d in (keeper.last_seen_at, loser.last_seen_at) if d]
            keeper.first_seen_at = min(firsts) if firsts else None
            keeper.last_seen_at = max(lasts) if lasts else None
            db.query(models.JobUrl).filter(models.JobUrl.job_id == loser.id).update({"job_id": keeper.id})
            db.add(models.JobUrl(job_id=keeper.id, url=loser.url))
            db.flush()
            db.expire(loser, ["job_skills"])
            db.delete(loser)
        db.flush()
    if apply:
        db.commit()
    return report


if __name__ == "__main__":
    from database import SessionLocal
    session = SessionLocal()
    rows = merge_duplicates(session, apply="--apply" in sys.argv)
    for r in rows:
        print(f"{r['company']} | {r['title']}: keep {r['keep']} drop {r['drop']}")
    print(f"{len(rows)} duplicate groups, {sum(len(r['drop']) for r in rows)} rows "
          f"{'merged' if '--apply' in sys.argv else 'would be merged (dry run)'}")
