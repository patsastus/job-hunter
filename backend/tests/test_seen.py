import pytest
from fastapi.testclient import TestClient

import ingest
import main
import models
from database import SessionLocal, engine

DESC = ("We need a Go developer with Kubernetes experience. " * 20).strip()


@pytest.fixture
def db():
    models.Base.metadata.drop_all(bind=engine)
    models.Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    yield session
    session.close()


@pytest.fixture
def llm(monkeypatch):
    """Stub the LLM call and record what it was asked."""
    calls = []

    def fake(db, title, company, description):
        calls.append({"title": title, "company": company, "description": description})
        return 77, "Good Go match.", "v1"

    monkeypatch.setattr(main, "compute_fit", fake)
    return calls


@pytest.fixture
def client(db):
    return TestClient(main.app)


def ad(**kw):
    base = dict(title="Go Developer", company="Acme Oy", location="Helsinki",
                url="https://duunitori.fi/tyopaikat/tyo/go-dev-abc-100", descriptionSnippet=DESC,
                raw={"jsonld": {"x": 1}})
    return {**base, **kw}


def row(db, **filters):
    db.expire_all()
    return db.query(models.Job).filter_by(**filters).one()


# --- score-preview ---------------------------------------------------------------------------

def test_preview_creates_seen_record_without_text(client, db, llm):
    r = client.post("/api/score-preview", json=ad())
    assert r.status_code == 200
    assert r.json() | {"id": 0} == {"id": 0, "status": "seen", "fit_score": 77, "fit_reason": "Good Go match.",
                                    "cached": False, "created": True}
    job = db.query(models.Job).one()
    assert job.status == "seen" and job.fit_score == 77
    assert job.description_snippet is None and job.raw_payload is None
    assert llm[0]["description"] == DESC  # the text was used for scoring, just not kept


def test_second_view_is_served_from_cache(client, llm):
    client.post("/api/score-preview", json=ad())
    r = client.post("/api/score-preview", json=ad())
    assert r.json()["cached"] is True and r.json()["created"] is False and r.json()["fit_score"] == 77
    assert len(llm) == 1


def test_force_rescores(client, llm):
    client.post("/api/score-preview", json=ad())
    r = client.post("/api/score-preview?force=true", json=ad())
    assert r.json()["cached"] is False and len(llm) == 2


def test_preview_of_repost_with_new_url_reuses_the_record(client, db, llm):
    first = client.post("/api/score-preview", json=ad()).json()
    again = client.post("/api/score-preview", json=ad(url="https://duunitori.fi/tyopaikat/tyo/go-dev-xyz-999")).json()
    assert again["id"] == first["id"] and again["cached"] is True
    assert db.query(models.Job).count() == 1


def test_preview_never_changes_status_of_a_saved_job_or_stores_its_text(client, db, llm):
    saved = ingest.ingest(db, ingest.JobIn(**ad(descriptionSnippet="short", status="saved"))).job
    r = client.post("/api/score-preview", json=ad())
    assert r.json()["status"] == "saved" and r.json()["id"] == saved.id
    assert row(db, id=saved.id).description_snippet == "short"  # unchanged, not replaced by the previewed text


def test_scoring_failure_keeps_the_record_and_retries_next_view(client, db, monkeypatch):
    outcomes = iter([(None, "AI Error: boom", None), (60, "ok now", "v1")])
    monkeypatch.setattr(main, "compute_fit", lambda *a: next(outcomes))
    first = client.post("/api/score-preview", json=ad()).json()
    assert first["fit_score"] is None and "boom" in first["fit_reason"] and first["created"] is True
    second = client.post("/api/score-preview", json=ad()).json()
    assert second["fit_score"] == 60 and second["cached"] is False and second["id"] == first["id"]


def test_preview_without_description_skips_the_llm(client, llm):
    r = client.post("/api/score-preview", json=ad(descriptionSnippet=None))
    assert r.json()["fit_score"] is None and r.json()["fit_reason"] == "No description to score."
    assert llm == []


def test_concurrent_creation_race_returns_the_winning_row(db, monkeypatch):
    winner = ingest.record_seen(db, ingest.JobIn(**ad())).job
    real = ingest.find_existing
    calls = {"n": 0}

    def blind_first_time(*args, **kwargs):
        calls["n"] += 1
        return (None, None) if calls["n"] == 1 else real(*args, **kwargs)

    monkeypatch.setattr(ingest, "find_existing", blind_first_time)
    result = ingest.record_seen(db, ingest.JobIn(**ad()))  # tries to insert a duplicate URL
    assert result.created is False and result.job.id == winner.id
    assert db.query(models.Job).count() == 1


# --- save / reject ---------------------------------------------------------------------------

def test_save_promotes_the_seen_row_and_stores_text_without_rescoring(client, db, llm):
    seen = client.post("/api/score-preview", json=ad()).json()
    llm.clear()
    r = client.post("/api/jobs", json=ad(status="saved"))
    assert r.json()["outcome"] == "duplicate" and r.json()["id"] == seen["id"] and r.json()["status"] == "saved"
    job = row(db, id=seen["id"])
    assert job.description_snippet == DESC and '"jsonld"' in job.raw_payload
    assert job.fit_score == 77 and llm == []  # already scored on view; background scorer skipped it


def test_applied_is_never_downgraded_by_a_save(client, db, llm):
    job = ingest.ingest(db, ingest.JobIn(**ad(status="applied"))).job
    r = client.post("/api/jobs", json=ad(status="saved"))
    assert r.json()["status"] == "applied" and row(db, id=job.id).status == "applied"


def test_saving_a_previously_rejected_job_is_allowed(client, db, llm):
    ingest.ingest(db, ingest.JobIn(**ad(status="rejected")))
    assert client.post("/api/jobs", json=ad(status="saved")).json()["status"] == "saved"


def test_post_jobs_rejects_seen_status(client):
    assert client.post("/api/jobs", json=ad(status="seen")).status_code == 422


def test_post_jobs_rejects_unknown_status(client):
    assert client.post("/api/jobs", json=ad(status="bogus")).status_code == 422


def test_queued_save_for_an_ad_never_previewed_creates_a_saved_row(client, db, llm):
    r = client.post("/api/jobs", json=ad(status="saved"))
    assert r.json()["outcome"] == "created" and r.json()["status"] == "saved"


# --- PATCH / GET -----------------------------------------------------------------------------

def test_patch_edits_only_the_fields_sent(client, db, llm):
    job_id = client.post("/api/jobs", json=ad(status="saved")).json()["id"]
    r = client.patch(f"/api/jobs/{job_id}", json={"company": "Acme Group", "notes": "ask about on-call"})
    assert r.status_code == 200 and r.json()["company"] == "Acme Group" and r.json()["notes"] == "ask about on-call"
    job = row(db, id=job_id)
    assert job.title == "Go Developer" and job.location == "Helsinki" and job.status == "saved"


def test_patch_empty_text_clears_optional_fields_but_not_title(client, db, llm):
    job_id = client.post("/api/jobs", json=ad(deadline="2026-12-01")).json()["id"]
    assert client.patch(f"/api/jobs/{job_id}", json={"location": "", "deadline": ""}).status_code == 200
    job = row(db, id=job_id)
    assert job.location is None and job.deadline is None
    assert client.patch(f"/api/jobs/{job_id}", json={"title": "  "}).status_code == 422


def test_patch_normalises_deadline_and_rejects_garbage(client, llm):
    job_id = client.post("/api/jobs", json=ad()).json()["id"]
    assert client.patch(f"/api/jobs/{job_id}", json={"deadline": "30.11.2026"}).json()["deadline"] == "2026-11-30"
    assert client.patch(f"/api/jobs/{job_id}", json={"deadline": "soon"}).status_code == 422


def test_patch_rejects_unknown_status_and_missing_job(client, llm):
    job_id = client.post("/api/jobs", json=ad()).json()["id"]
    assert client.patch(f"/api/jobs/{job_id}", json={"status": "bogus"}).status_code == 422
    assert client.patch("/api/jobs/9999", json={"status": "saved"}).status_code == 404


def test_undo_save_returns_to_seen_and_drops_the_text(client, db, llm):
    seen = client.post("/api/score-preview", json=ad()).json()
    client.post("/api/jobs", json=ad(status="saved"))
    r = client.patch(f"/api/jobs/{seen['id']}", json={"status": "seen"})
    assert r.json()["status"] == "seen"
    job = row(db, id=seen["id"])
    assert job.description_snippet is None and job.raw_payload is None and job.fit_score == 77


def test_applied_job_cannot_be_patched_back_to_seen(client, db, llm):
    job_id = client.post("/api/jobs", json=ad(status="applied")).json()["id"]
    assert client.patch(f"/api/jobs/{job_id}", json={"status": "seen"}).status_code == 409
    assert row(db, id=job_id).description_snippet == DESC


def test_reject_from_seen_stores_no_text(client, db, llm):
    seen = client.post("/api/score-preview", json=ad()).json()
    client.patch(f"/api/jobs/{seen['id']}", json={"status": "rejected"})
    job = row(db, id=seen["id"])
    assert job.status == "rejected" and job.description_snippet is None


def test_get_single_job_and_static_routes_still_win(client, llm):
    job_id = client.post("/api/jobs", json=ad()).json()["id"]
    assert client.get(f"/api/jobs/{job_id}").json()["title"] == "Go Developer"
    assert client.get("/api/jobs/9999").status_code == 404


# --- lookup ----------------------------------------------------------------------------------

def test_lookup_reports_known_and_unknown_urls_in_order(client, db, llm):
    saved = client.post("/api/jobs", json=ad(status="saved")).json()
    seen = client.post("/api/score-preview", json=ad(title="Other", company="Beta",
                                                    url="https://duunitori.fi/tyopaikat/tyo/other-200")).json()
    urls = ["https://duunitori.fi/tyopaikat/tyo/unknown-300",
            "https://www.duunitori.fi/tyopaikat/tyo/go-dev-abc-100?utm_source=x",  # same ad, noisy URL
            "https://duunitori.fi/tyopaikat/tyo/other-200"]
    items = client.post("/api/jobs/lookup", json={"urls": urls}).json()
    assert [i["url"] for i in items] == urls
    assert [i["id"] for i in items] == [None, saved["id"], seen["id"]]
    assert [i["status"] for i in items] == [None, "saved", "seen"]
    assert items[2]["fit_score"] == 77


def test_lookup_finds_merged_away_url_aliases(client, db, llm):
    job_id = client.post("/api/jobs", json=ad()).json()["id"]
    db.add(models.JobUrl(job_id=job_id, url="https://duunitori.fi/tyopaikat/tyo/old-repost-1"))
    db.commit()
    items = client.post("/api/jobs/lookup", json={"urls": ["https://duunitori.fi/tyopaikat/tyo/old-repost-1"]}).json()
    assert items[0]["id"] == job_id


def test_lookup_caps_batch_size(client):
    assert client.post("/api/jobs/lookup", json={"urls": [f"https://x.test/{i}" for i in range(201)]}).status_code == 422
    assert client.post("/api/jobs/lookup", json={"urls": []}).json() == []


# --- seen rows stay out of the old flows -----------------------------------------------------

def test_batch_scorer_ignores_seen_rows(db, monkeypatch):
    ingest.record_seen(db, ingest.JobIn(**ad()))  # unscored seen row
    new = ingest.ingest(db, ingest.JobIn(**ad(title="Other", company="Beta", url="https://x.test/2"))).job
    scored = []
    monkeypatch.setattr(main, "run_ai_scorer", lambda job, session: scored.append(job.id))
    monkeypatch.setattr(main.time, "sleep", lambda s: None)
    main.background_batch_scorer()
    assert scored == [new.id]


def test_preview_can_record_without_scoring(client, db, llm):
    r = client.post("/api/score-preview?score=false", json=ad())
    assert r.status_code == 200
    assert r.json()["status"] == "seen" and r.json()["created"] is True and r.json()["fit_score"] is None
    assert llm == []  # no LLM call
    job = db.query(models.Job).one()
    assert job.description_snippet is None and job.raw_payload is None  # still a text-less seen record
    # A later normal view scores it as usual.
    assert client.post("/api/score-preview", json=ad()).json()["fit_score"] == 77 and len(llm) == 1


def test_record_only_returns_an_existing_score_and_never_changes_status(client, db, llm):
    saved = client.post("/api/jobs", json=ad(status="saved")).json()
    client.post("/api/score-preview", json=ad())  # scores it
    r = client.post("/api/score-preview?score=false", json=ad()).json()
    assert r["id"] == saved["id"] and r["status"] == "saved" and r["fit_score"] == 77
