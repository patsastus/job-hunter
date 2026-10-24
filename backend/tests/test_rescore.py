import pytest
from fastapi.testclient import TestClient

import ingest
import main
import models
import profile
import rescore
from database import SessionLocal, engine


@pytest.fixture
def db():
    models.Base.metadata.drop_all(bind=engine)
    models.Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    session.add(models.ProfileDocument(title="CV", content="Go developer with five years of experience."))
    session.commit()
    yield session
    session.close()


@pytest.fixture
def version(db):
    return profile.scoring_context(db).version


_n = 0


def job(db, status="saved", score=None, scored_with=None, text="An ad text. " * 100, **kw):
    global _n
    _n += 1
    j = models.Job(title=f"Job {_n}", company="Acme", url=f"https://example.com/{_n}", status=status, fit_score=score,
                   fit_reason="old reason" if score is not None else None, scored_with=scored_with, description_snippet=text, **kw)
    db.add(j)
    db.commit()
    return j


def fresh_state():
    return {"is_running": True, "total": 0, "completed": 0, "failed": 0, "stopped": None, "current_job": ""}


class Run:
    """Runs run_rescore with a recording emitter and a recording sleeper."""
    def __init__(self, db, ids, version, compute, interval=4.1):
        self.events, self.sleeps, self.state = [], [], fresh_state()
        rescore.run_rescore(ids, version, session_factory=SessionLocal, compute=compute, interval=interval,
                            emit=lambda e, d: self.events.append((e, d)), state=self.state, sleep=self.sleeps.append)
        db.expire_all()

    def kinds(self):
        return [e for e, _ in self.events]

    def done(self):
        return self.events[-1][1]


def ok(score=80, reason="Good fit."):
    return lambda db, title, company, description: (score, reason, profile.scoring_context(db).version)


# --- which jobs are eligible, and what the button needs to know --------------------------------

def test_only_saved_jobs_that_are_not_current_and_have_text_are_eligible(db, version):
    stale = job(db, score=60, scored_with="old")
    unstamped = job(db, score=60, scored_with=None)
    unscored = job(db, score=None)
    current = job(db, score=70, scored_with=version)
    no_text = job(db, score=60, scored_with="old", text="  ")
    others = [job(db, s, score=50, scored_with="old") for s in ("applied", "rejected", "seen", "new")]
    ids, v = rescore.eligible_ids(db)
    assert v == version and ids == [stale.id, unstamped.id, unscored.id]
    assert current.id not in ids and no_text.id not in ids and not ({o.id for o in others} & set(ids))


def test_status_counts_for_the_button(db, version):
    job(db, score=60, scored_with="old")
    job(db, score=70, scored_with=version)
    job(db, score=60, scored_with="old", text="short ad")                 # runnable but rough
    job(db, score=60, scored_with="old", text="")                          # cannot be re-scored from what is stored
    job(db, "applied", score=1, scored_with="old")                         # not counted at all
    s = rescore.status(db, "gemini-3.5-flash-lite")
    assert (s["saved_total"], s["current"], s["to_rescore"], s["no_text"], s["short_text"]) == (4, 1, 2, 1, 1)
    assert s["scoring_with"] == "raw" and s["version"] == version
    assert (s["interval_seconds"], s["estimated_seconds"]) == (4.1, 8)


def test_the_button_can_go_grey_even_when_some_jobs_have_no_text(db, version):
    job(db, score=70, scored_with=version)
    job(db, score=60, scored_with="old", text="")
    assert rescore.status(db, "m")["to_rescore"] == 0, "a job that cannot be re-scored must not keep the button enabled"


def test_without_any_profile_nothing_is_eligible(db):
    db.query(models.ProfileDocument).delete()
    db.commit()
    job(db)
    assert rescore.eligible_ids(db) == ([], None)
    s = rescore.status(db, "m")
    assert s["version"] is None and s["to_rescore"] == 0 and s["scoring_with"] is None


def test_the_pause_follows_the_model(db):
    assert rescore.interval_for("gemini-3.5-flash-lite") == 4.1
    assert rescore.interval_for("gemini-3.5-flash") == 12.5, "5 requests a minute"
    assert rescore.interval_for("gemma-4b") == 2.1
    assert rescore.interval_for("some-new-model") == rescore.DEFAULT_INTERVAL


# --- a run -------------------------------------------------------------------------------------

def test_a_run_scores_each_job_stamps_the_version_and_reports_progress(db, version):
    jobs = [job(db, score=40, scored_with="old"), job(db, score=None), job(db, score=None)]
    run = Run(db, [j.id for j in jobs], version, ok(score=77.6))
    for j in jobs:
        db.refresh(j)
        assert (j.fit_score, j.fit_reason, j.scored_with) == (78, "Good fit.", version), "rounded to a whole score"
    assert run.kinds().count("job_scored") == 3 and run.kinds()[0] == "state" and run.kinds()[-1] == "done"
    scored = [d for e, d in run.events if e == "job_scored"]
    assert [d["completed"] for d in scored] == [1, 2, 3]
    assert scored[0]["job"]["id"] == jobs[0].id and scored[0]["job"]["fit_score"] == 78 and scored[0]["job"]["scored_with"] == version
    assert run.done() == {"isRunning": False, "total": 3, "completed": 3, "failed": 0, "stopped": None, "currentJob": ""}
    assert run.state["is_running"] is False


def test_it_pauses_between_calls_at_the_models_rate_but_not_after_the_last(db, version):
    jobs = [job(db) for _ in range(3)]
    run = Run(db, [j.id for j in jobs], version, ok(), interval=12.5)
    assert run.sleeps == [12.5, 12.5]


def test_a_failed_call_keeps_the_existing_score_and_the_job_stays_stale(db, version):
    old = job(db, score=64, scored_with="old")
    new = job(db, score=None)
    calls = iter([(None, "AI Error: 500 Server Error", None), (80, "ok", version)])
    run = Run(db, [old.id, new.id], version, lambda *a: next(calls))
    db.refresh(old); db.refresh(new)
    assert (old.fit_score, old.fit_reason, old.scored_with) == (64, "old reason", "old"), "a good score must survive an error"
    assert new.fit_score == 80
    assert run.done()["failed"] == 1 and run.done()["completed"] == 2
    assert rescore.eligible_ids(db)[0] == [old.id], "so the next run retries it, and only it"
    assert any(d.get("lastError") == "AI Error: 500 Server Error" for e, d in run.events if e == "state")


def test_an_unexpected_exception_is_a_failed_job_not_a_dead_run(db, version):
    a, b = job(db, score=50, scored_with="old"), job(db, score=50, scored_with="old")
    seen = []
    def compute(*args):
        seen.append(1)
        if len(seen) == 1:
            raise RuntimeError("socket exploded")
        return 90, "fine", version
    run = Run(db, [a.id, b.id], version, compute)
    db.refresh(a); db.refresh(b)
    assert a.fit_score == 50 and b.fit_score == 90 and run.kinds()[-1] == "done"


@pytest.mark.parametrize("bad", [(None, None, None), (150, "x", "V"), (-1, "x", "V"), ("85", "x", "V"), (True, "x", "V")])
def test_scores_that_are_not_a_number_from_0_to_100_are_failures(db, version, bad):
    j = job(db, score=55, scored_with="old")
    score, reason, v = bad
    Run(db, [j.id], version, lambda *a: (score, reason, version if v else None))
    db.refresh(j)
    assert (j.fit_score, j.scored_with) == (55, "old")


def test_three_failures_in_a_row_stop_the_run_with_the_reason_and_leave_the_rest_alone(db, version):
    jobs = [job(db, score=50, scored_with="old") for _ in range(5)]
    n = []
    run = Run(db, [j.id for j in jobs], version, lambda *a: (n.append(1), (None, "AI Error: API key invalid", None))[1])
    assert len(n) == 3, "it did not carry on burning calls"
    assert run.done()["stopped"] == "Stopped after 3 failures in a row: AI Error: API key invalid"
    assert run.done()["failed"] == 3 and run.kinds()[-1] == "done"
    db.expire_all()
    assert all(j.fit_score == 50 and j.scored_with == "old" for j in db.query(models.Job))


def test_a_success_resets_the_failure_streak(db, version):
    jobs = [job(db, score=50, scored_with="old") for _ in range(5)]
    fail = (None, "AI Error: blip", None)
    script = iter([fail, fail, (80, "ok", version), fail, fail])
    run = Run(db, [j.id for j in jobs], version, lambda *a: next(script))
    assert run.done()["stopped"] is None and run.done()["failed"] == 4 and run.done()["completed"] == 5


def test_a_rate_limit_waits_and_retries_once(db, version):
    j = job(db, score=50, scored_with="old")
    script = iter([(None, "AI Error: 429 Client Error: Too Many Requests", None), (82, "ok", version)])
    run = Run(db, [j.id], version, lambda *a: next(script))
    db.refresh(j)
    assert j.fit_score == 82 and run.sleeps == [rescore.RATE_LIMIT_PAUSE] and run.done()["failed"] == 0
    assert any("Rate limited" in d["currentJob"] for e, d in run.events if e == "state")


def test_a_rate_limit_that_persists_stops_the_run_and_keeps_the_score(db, version):
    jobs = [job(db, score=50, scored_with="old") for _ in range(3)]
    n = []
    run = Run(db, [j.id for j in jobs], version, lambda *a: (n.append(1), (None, "AI Error: 429 quota exceeded", None))[1])
    assert len(n) == 2, "one try and one retry, then it gives up on the whole run"
    assert "rate limiting" in run.done()["stopped"]
    db.expire_all()
    assert all(j.fit_score == 50 for j in db.query(models.Job))


def test_a_run_for_one_profile_stops_when_the_profile_changes(db, version):
    jobs = [job(db, score=50, scored_with="old") for _ in range(3)]
    n = []
    def compute(d, *args):
        n.append(1)
        if len(n) == 1:  # the user saves a distilled profile while the first job is being scored
            profile.save_distilled(d, "SUMMARY: a different profile")
        return 80, "ok", version
    run = Run(db, [j.id for j in jobs], version, compute)
    assert len(n) == 1 and run.done()["stopped"].startswith("The profile changed while re-scoring")
    db.expire_all()
    assert [j.fit_score for j in db.query(models.Job).order_by(models.Job.id)] == [80, 50, 50]


def test_a_score_made_with_a_different_version_than_the_run_is_not_stored(db, version):
    j = job(db, score=50, scored_with="old")
    Run(db, [j.id], version, lambda *a: (90, "x", "some-other-version"))
    db.refresh(j)
    assert (j.fit_score, j.scored_with) == (50, "old")


def test_a_job_decided_during_the_run_is_skipped_and_left_alone(db, version):
    a, b = job(db, score=50, scored_with="old"), job(db, score=50, scored_with="old")
    n = []
    def compute(d, *args):
        n.append(1)
        d.query(models.Job).filter(models.Job.id == b.id).update({"status": "rejected"})  # you reject it meanwhile
        d.commit()
        return 80, "ok", version
    run = Run(db, [a.id, b.id], version, compute)
    db.refresh(a); db.refresh(b)
    assert len(n) == 1 and a.fit_score == 80 and (b.status, b.fit_score, b.scored_with) == ("rejected", 50, "old")
    assert run.done()["completed"] == 2 and run.done()["failed"] == 0


def test_every_run_ends_with_a_done_event_and_clears_the_running_flag(db, version):
    run = Run(db, [], version, ok())
    assert run.kinds() == ["state", "done"] and run.state["is_running"] is False


# --- the API -----------------------------------------------------------------------------------

class SyncThread:
    """Stands in for threading.Thread: runs the work immediately, with no real pauses."""
    started = []
    def __init__(self, target, args=(), kwargs=None, daemon=None):
        self.target, self.args, self.kwargs = target, args, dict(kwargs or {}, sleep=lambda s: None)
    def start(self):
        SyncThread.started.append(self)
        self.target(*self.args, **self.kwargs)


class HeldThread(SyncThread):
    """Never finishes: the run stays 'running'."""
    def start(self):
        SyncThread.started.append(self)


@pytest.fixture
def client(db, monkeypatch):
    main.scoring_state.update(is_running=False, total=0, completed=0, failed=0, stopped=None, current_job="")
    SyncThread.started = []
    monkeypatch.setattr(main.threading, "Thread", SyncThread)
    monkeypatch.setattr(main, "compute_fit", lambda d, *a: (81, "Re-scored.", profile.scoring_context(d).version))
    return TestClient(main.app)


def test_status_endpoint(client, db, version):
    job(db, score=60, scored_with="old")
    body = client.get("/api/profile/rescore").json()
    assert body["to_rescore"] == 1 and body["running"] is False and body["version"] == version and body["interval_seconds"] == 4.1


def test_start_rescores_only_the_stale_saved_jobs(client, db, version):
    stale = job(db, score=60, scored_with="old")
    current = job(db, score=70, scored_with=version)
    others = [job(db, s, score=33, scored_with="old") for s in ("applied", "rejected", "seen", "new")]
    r = client.post("/api/profile/rescore")
    assert r.status_code == 202 and r.json() == {"status": "started", "total": 1, "interval_seconds": 4.1}
    db.expire_all()
    assert db.get(models.Job, stale.id).fit_score == 81 and db.get(models.Job, current.id).fit_score == 70
    assert all(db.get(models.Job, o.id).fit_score == 33 for o in others), "applied, rejected, viewed-only and new jobs keep their scores"
    status = client.get("/api/profile/rescore").json()
    assert status["to_rescore"] == 0 and status["running"] is False, "the button is grey once everything is current"


def test_start_refuses_when_there_is_nothing_to_do_and_changes_nothing(client, db, version):
    job(db, score=70, scored_with=version)
    r = client.post("/api/profile/rescore")
    assert r.status_code == 409 and "already scored with the current profile" in r.json()["detail"] and SyncThread.started == []


def test_start_refuses_without_a_profile(client, db):
    db.query(models.ProfileDocument).delete(); db.commit()
    job(db)
    r = client.post("/api/profile/rescore")
    assert r.status_code == 409 and "no profile" in r.json()["detail"].lower()


def test_only_one_run_at_a_time(client, db, monkeypatch):
    job(db, score=60, scored_with="old")
    monkeypatch.setattr(main.threading, "Thread", HeldThread)
    assert client.post("/api/profile/rescore").status_code == 202
    again = client.post("/api/profile/rescore")
    assert again.status_code == 409 and "already running" in again.json()["detail"]
    assert client.get("/api/profile/rescore").json()["running"] is True and len(SyncThread.started) == 1


def test_the_old_inbox_scoring_endpoint_is_gone(client):
    assert client.post("/api/jobs/score-all").status_code in (404, 405)


def test_the_stream_snapshot_carries_failures_and_the_stop_reason():
    main.scoring_state.update(is_running=False, total=5, completed=4, failed=2, stopped="Stopped: x", current_job="")
    snap = rescore.snapshot(main.scoring_state)
    assert snap == {"isRunning": False, "total": 5, "completed": 4, "failed": 2, "stopped": "Stopped: x", "currentJob": ""}
    main.scoring_state.update(total=0, completed=0, failed=0, stopped=None)
