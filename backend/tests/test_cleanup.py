import csv
import datetime as dt
import sqlite3

import pytest

import cleanup
import models
from database import SessionLocal, engine

TODAY = dt.date(2026, 10, 24)
OPTS = cleanup.Options()  # new/seen > 30 days, rejected text > 14 days, keep score >= 70
_n = 0


@pytest.fixture
def db():
    models.Base.metadata.drop_all(bind=engine)
    models.Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    yield session
    session.close()


def make(db, status="new", age=0, deadline=None, score=None, text=True, last_seen_age=None, **kw):
    """A job last seen `age` days before TODAY."""
    global _n
    _n += 1
    seen = dt.datetime.combine(TODAY, dt.time(12)) - dt.timedelta(days=age if last_seen_age is None else last_seen_age)
    job = models.Job(title=f"Job {_n}", company="Acme", url=f"https://example.com/{_n}", status=status, deadline=deadline,
                     fit_score=score, created_at=dt.datetime.combine(TODAY, dt.time(12)) - dt.timedelta(days=age), last_seen_at=seen,
                     description_snippet="ad text" if text else None, raw_payload='{"x":1}' if text else None, **kw)
    db.add(job)
    db.commit()
    return job


def ids(plan, rule):
    return {j.id for j in plan.by_rule[rule]}


def plan_for(db, opts=OPTS):
    return cleanup.build_plan(db, TODAY, opts)


# --- expired ----------------------------------------------------------------------------------

def test_expired_new_and_seen_jobs_are_deleted_but_not_other_statuses(db):
    gone = [make(db, "new", deadline="2026-10-23"), make(db, "seen", deadline="2026-01-01")]
    kept = [make(db, "new", deadline="2026-10-24"),          # the deadline day itself is still open
            make(db, "new", deadline="2027-01-01"),
            make(db, "new", deadline="soon"),                # not a date: ignored, not guessed at
            make(db, "rejected", deadline="2026-10-01", text=False)]
    plan = plan_for(db)
    assert ids(plan, "expired") == {j.id for j in gone}
    assert not ({j.id for j in kept} & {j.id for j in plan.deletions()})


def test_saved_and_applied_are_never_touched_even_when_everything_else_says_stale(db):
    saved = make(db, "saved", age=400, deadline="2020-01-01", score=1)
    applied = make(db, "applied", age=400, deadline="2020-01-01", score=1)
    plan = plan_for(db, cleanup.Options(1, 1, 1, 0))
    assert plan.changes() == 0
    assert {j.id for j in plan.attention} == {saved.id, applied.id}, "reported for the user's attention instead"
    cleanup.apply_plan(db, plan)
    assert {j.id for j in db.query(models.Job)} == {saved.id, applied.id}
    assert all(j.description_snippet == "ad text" for j in db.query(models.Job))


# --- stale-new --------------------------------------------------------------------------------

def test_stale_new_boundary_scores_and_deadlines(db):
    old = make(db, "new", age=31)
    exactly = make(db, "new", age=30)                         # "more than 30 days": 30 is kept
    good = make(db, "new", age=60, score=70)                  # at the bar: spared
    meh = make(db, "new", age=60, score=69)
    unscored = make(db, "new", age=60)
    still_open = make(db, "new", age=60, deadline="2026-11-30")
    plan = plan_for(db)
    assert ids(plan, "stale-new") == {old.id, meh.id, unscored.id}
    assert {j.id for j in plan.kept_by_score} == {good.id}
    assert exactly.id not in ids(plan, "stale-new") and still_open.id not in ids(plan, "stale-new")


def test_stale_new_goes_by_when_it_was_last_seen_not_when_it_was_created(db):
    reseen = make(db, "new", age=90, last_seen_age=2)
    assert reseen.id not in ids(plan_for(db), "stale-new")


def test_thresholds_of_zero_switch_rules_off_and_the_bar_is_adjustable(db):
    n, s, r = make(db, "new", age=90), make(db, "seen", age=90), make(db, "rejected", age=90)
    off = plan_for(db, cleanup.Options(0, 0, 0, 70))
    assert off.changes() == 0
    strict = plan_for(db, cleanup.Options(30, 30, 14, 0))  # a bar of 0 spares every scored job
    scored = make(db, "new", age=90, score=1)
    assert scored.id in {j.id for j in plan_for(db, cleanup.Options(30, 30, 14, 0)).kept_by_score}
    assert scored.id in ids(plan_for(db, cleanup.Options(30, 30, 14, 101)), "stale-new")
    assert {n.id, s.id, r.id} <= {j.id for j in strict.deletions()} | ids(strict, "compact-rejected")


# --- stale-seen and compact-rejected ----------------------------------------------------------

def test_stale_seen_deletes_old_viewed_only_records(db):
    old, fresh = make(db, "seen", age=31), make(db, "seen", age=30)
    assert ids(plan_for(db), "stale-seen") == {old.id}


def test_compact_rejected_strips_text_but_keeps_the_row_its_status_and_score(db):
    old = make(db, "rejected", age=20, score=55)
    fresh = make(db, "rejected", age=14)
    bare = make(db, "rejected", age=99, text=False)
    plan = plan_for(db)
    assert ids(plan, "compact-rejected") == {old.id}, "a fresh one and one with no text are left alone"
    cleanup.apply_plan(db, plan)
    db.expire_all()
    row = db.get(models.Job, old.id)
    assert (row.status, row.fit_score) == ("rejected", 55)
    assert row.description_snippet is None and row.raw_payload is None
    assert db.get(models.Job, fresh.id).description_snippet == "ad text"
    assert db.query(models.Job).count() == 3


def test_a_row_is_counted_by_the_first_rule_that_matches_it(db):
    both = make(db, "new", age=90, deadline="2026-10-01")     # expired AND stale
    plan = plan_for(db)
    assert ids(plan, "expired") == {both.id} and ids(plan, "stale-new") == set()
    assert len(plan.deletions()) == 1


# --- orphans and cascades ---------------------------------------------------------------------

def test_deleting_a_job_removes_its_skill_links_and_url_aliases_and_the_skills_nothing_uses(db):
    doomed = make(db, "new", age=90)
    survivor = make(db, "saved", age=90)
    shared, only_doomed = models.Skill(name="Go"), models.Skill(name="COBOL")
    db.add_all([shared, only_doomed])
    db.commit()
    db.add_all([models.JobSkill(job_id=doomed.id, skill_id=shared.id), models.JobSkill(job_id=doomed.id, skill_id=only_doomed.id),
                models.JobSkill(job_id=survivor.id, skill_id=shared.id),
                models.JobUrl(job_id=doomed.id, url="https://old.example/1"), models.JobUrl(job_id=survivor.id, url="https://old.example/2")])
    db.commit()
    cleanup.apply_plan(db, plan_for(db))
    db.expire_all()
    assert [j.id for j in db.query(models.Job)] == [survivor.id]
    assert [(js.job_id, js.skill_id) for js in db.query(models.JobSkill)] == [(survivor.id, shared.id)]
    assert [u.url for u in db.query(models.JobUrl)] == ["https://old.example/2"]
    assert [s.name for s in db.query(models.Skill)] == ["Go"]


def test_existing_orphans_are_found_and_removed(db):
    job = make(db, "saved")
    db.add_all([models.JobSkill(job_id=9999, skill_id=1), models.JobUrl(job_id=9999, url="https://ghost.example/")])
    db.commit()
    plan = plan_for(db)
    assert len(plan.orphans["job_skills"]) == 1 and len(plan.orphans["job_urls"]) == 1
    cleanup.apply_plan(db, plan)
    db.expire_all()
    assert db.query(models.JobSkill).count() == 0 and db.query(models.JobUrl).count() == 0 and db.get(models.Job, job.id)


# --- the command line: dry run, backup, apply, idempotence ------------------------------------

def run(args, tmp_path, capsys):
    code = cleanup.main(["--backup-dir", str(tmp_path / "backups"), "--today", TODAY.isoformat(), *args])
    return code, capsys.readouterr().out


def test_dry_run_reports_and_changes_nothing(db, tmp_path, capsys):
    make(db, "new", deadline="2026-10-01"), make(db, "rejected", age=40)
    before = [(j.id, j.status, j.description_snippet) for j in db.query(models.Job).order_by(models.Job.id)]
    code, out = run([], tmp_path, capsys)
    assert code == 0 and "dry run: nothing is changed" in out and "Dry run only" in out
    assert "expired" in out and "compact-rejected" in out
    db.expire_all()
    assert [(j.id, j.status, j.description_snippet) for j in db.query(models.Job).order_by(models.Job.id)] == before
    assert not (tmp_path / "backups").exists(), "no backup is made for a dry run"


def test_apply_backs_up_first_then_changes_exactly_what_the_report_said(db, tmp_path, capsys):
    doomed = make(db, "new", deadline="2026-10-01")
    stripped = make(db, "rejected", age=40)
    keep = make(db, "saved")
    doomed_id, stripped_id, keep_id = doomed.id, stripped.id, keep.id  # read before the rows change
    code, out = run(["--apply"], tmp_path, capsys)
    assert code == 0 and "Backed up the database to" in out and "To undo:" in out
    (backup,) = list((tmp_path / "backups").glob("jobs-cleanup-*.db"))
    snapshot = sqlite3.connect(backup)
    assert snapshot.execute("select count(*) from jobs").fetchone()[0] == 3, "the backup holds the state from before the changes"
    assert snapshot.execute("select description_snippet from jobs where id=?", (stripped_id,)).fetchone()[0] == "ad text"
    snapshot.close()
    db.expire_all()
    assert db.get(models.Job, doomed_id) is None
    assert db.get(models.Job, stripped_id).description_snippet is None
    assert db.get(models.Job, keep_id).description_snippet == "ad text"


def test_a_second_apply_has_nothing_to_do(db, tmp_path, capsys):
    make(db, "new", deadline="2026-10-01"), make(db, "rejected", age=40)
    run(["--apply"], tmp_path, capsys)
    code, out = run(["--apply"], tmp_path, capsys)
    assert code == 0 and "Nothing to do" in out
    assert len(list((tmp_path / "backups").glob("*.db"))) == 1, "and it does not make a pointless second backup"


def test_apply_with_nothing_to_do_makes_no_backup(db, tmp_path, capsys):
    make(db, "saved")
    code, out = run(["--apply"], tmp_path, capsys)
    assert "Nothing to do" in out and not (tmp_path / "backups").exists()


def test_list_and_export_show_the_affected_rows(db, tmp_path, capsys):
    a = make(db, "new", deadline="2026-10-01")
    b = make(db, "rejected", age=40)
    code, out = run(["--list", "expired"], tmp_path, capsys)
    assert f"#{a.id}" in out and f"#{b.id}" not in out.split("Rows for rule")[1]
    target = tmp_path / "rows.csv"
    run(["--export", str(target)], tmp_path, capsys)
    rows = list(csv.reader(target.open()))
    assert rows[0][:3] == ["rule", "id", "status"]
    assert {(r[0], r[1]) for r in rows[1:]} == {("expired", str(a.id)), ("compact-rejected", str(b.id))}


def test_it_refuses_a_missing_database_instead_of_creating_one(tmp_path, monkeypatch, capsys):
    class FakeEngine:
        class url:
            database = str(tmp_path / "nope" / "jobs.db")
    monkeypatch.setattr(cleanup, "engine", FakeEngine)
    assert cleanup.main(["--today", TODAY.isoformat()]) == 2
    assert "No database at" in capsys.readouterr().err
    assert not (tmp_path / "nope").exists()


def test_the_backup_is_a_consistent_copy_taken_with_sqlite_itself(db, tmp_path):
    make(db, "new")
    path = engine.url.database
    backup = cleanup.backup_database(path, str(tmp_path), now=dt.datetime(2026, 10, 24, 13, 0, 0))
    assert backup.endswith("jobs-cleanup-20261024-130000.db")
    make(db, "new")  # the live database moves on; the backup must not
    copy = sqlite3.connect(backup)
    assert copy.execute("select count(*) from jobs").fetchone()[0] == 1
    assert copy.execute("pragma integrity_check").fetchone()[0] == "ok"
    copy.close()
