import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

import llm
import main
import migrate
import models
import profile
from database import SessionLocal, engine

CV = "Python and Go developer, 3 years at Acme."
PROJECTS = "Built a job tracker with FastAPI."
DISTILLED = "SUMMARY: Backend developer.\nSKILLS: Strong: Go, Python."


@pytest.fixture
def db():
    models.Base.metadata.drop_all(bind=engine)
    models.Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    yield session
    session.close()


@pytest.fixture
def client(db):
    return TestClient(main.app)


@pytest.fixture
def docs(db):
    db.add_all([models.ProfileDocument(title="CV", content=CV), models.ProfileDocument(title="Projects", content=PROJECTS)])
    db.commit()


@pytest.fixture
def api(monkeypatch):
    """Stub the HTTP call to the LLM, recording prompts. `api.reply` is what the model answers."""
    class Api:
        prompts = []
        reply = json.dumps({"score": 81, "reason": "Strong Go match."})
    stub = Api()

    def fake(cfg, prompt, json_mode, timeout):
        stub.prompts.append(prompt)
        return stub.reply

    Api.prompts = []
    monkeypatch.setattr(llm, "generate", fake)
    return stub


def ad(**kw):
    base = dict(title="Go Developer", company="Acme Oy", location="Helsinki",
                url="https://duunitori.fi/tyopaikat/tyo/go-dev-1", descriptionSnippet="Go and Kubernetes work.")
    return {**base, **kw}


# --- profile module --------------------------------------------------------------------------

def test_documents_hash_is_none_without_documents_and_changes_with_content(db):
    assert profile.documents_hash(db) is None
    db.add(models.ProfileDocument(title="CV", content=CV))
    db.commit()
    first = profile.documents_hash(db)
    db.add(models.ProfileDocument(title="Projects", content=PROJECTS))
    db.commit()
    assert first and profile.documents_hash(db) != first


def test_scoring_context_prefers_distilled_then_raw_then_none(db, docs):
    raw = profile.scoring_context(db)
    assert raw.kind == "raw" and CV in raw.text and PROJECTS in raw.text
    profile.save_distilled(db, DISTILLED)
    ctx = profile.scoring_context(db)
    assert ctx.kind == "distilled" and ctx.text == DISTILLED and ctx.version != raw.version
    profile.delete_distilled(db)
    assert profile.scoring_context(db).kind == "raw"
    db.query(models.ProfileDocument).delete()
    db.commit()
    assert profile.scoring_context(db) is None


def test_version_depends_on_text_and_on_prompt_version(monkeypatch):
    assert profile.version_of("a") == profile.version_of("a") != profile.version_of("b")
    before = profile.version_of("a")
    monkeypatch.setattr(profile, "PROMPT_VERSION", "999")
    assert profile.version_of("a") != before


# --- scoring uses the right profile ----------------------------------------------------------

def test_compute_fit_sends_the_distilled_profile_not_the_raw_documents(db, docs, api):
    profile.save_distilled(db, DISTILLED)
    score, reason, version = main.compute_fit(db, "Go Developer", "Acme", "Go work")
    prompt = api.prompts[-1]
    assert DISTILLED in prompt and CV not in prompt and PROJECTS not in prompt
    assert "preferences or dealbreakers" in prompt
    assert (score, reason) == (81, "Strong Go match.") and version == profile.scoring_context(db).version


def test_compute_fit_falls_back_to_raw_documents(db, docs, api):
    main.compute_fit(db, "Go Developer", "Acme", "Go work")
    assert CV in api.prompts[-1] and PROJECTS in api.prompts[-1]


def test_compute_fit_without_any_profile(db, api):
    assert main.compute_fit(db, "t", "c", "d") == (None, "No profile documents provided for scoring.", None)
    assert api.prompts == []


def test_compute_fit_reports_missing_key_and_llm_errors(db, docs, monkeypatch):
    assert main.compute_fit(db, "t", "c", "d") == (None, "API Key missing for gemini.", None)  # real llm.generate, no key

    def boom(*a, **k):
        raise RuntimeError("503 from provider")

    monkeypatch.setattr(llm, "generate", boom)
    score, reason, version = main.compute_fit(db, "t", "c", "d")
    assert score is None and version is None and reason == "AI Error: 503 from provider"


def test_llm_generate_builds_the_gemini_request(monkeypatch):
    seen = {}

    class Resp:
        def raise_for_status(self): pass
        def json(self): return {"candidates": [{"content": {"parts": [{"text": "hello"}]}}]}

    def fake_post(url, json, headers, timeout):
        seen.update(url=url, json=json, headers=headers, timeout=timeout)
        return Resp()

    monkeypatch.setattr(llm.requests, "post", fake_post)
    cfg = llm.LlmSettings(provider="gemini", api_key="KEY", model="m1")
    assert llm.generate(cfg, "hi", json_mode=True, timeout=7) == "hello"
    assert seen["url"].endswith("/models/m1:generateContent") and seen["headers"] == {"x-goog-api-key": "KEY"}
    assert seen["json"]["generationConfig"] == {"response_mime_type": "application/json"} and seen["timeout"] == 7
    llm.generate(cfg, "hi", json_mode=False, timeout=7)
    assert "generationConfig" not in seen["json"]
    with pytest.raises(llm.LlmUnavailable):
        llm.generate(llm.LlmSettings("openai", "KEY", "m"), "hi", json_mode=False, timeout=7)


# --- score versioning ------------------------------------------------------------------------

def test_scores_are_stamped_with_the_profile_version(client, db, docs, api):
    r = client.post("/api/score-preview", json=ad())
    assert r.json()["fit_score"] == 81
    job = db.query(models.Job).one()
    assert job.scored_with == profile.scoring_context(db).version
    assert client.get(f"/api/jobs/{job.id}").json()["scored_with"] == job.scored_with


def test_changing_the_profile_makes_cached_scores_stale(client, db, docs, api):
    client.post("/api/score-preview", json=ad())
    assert client.post("/api/score-preview", json=ad()).json()["cached"] is True
    assert len(api.prompts) == 1

    client.put("/api/profile/distilled", json={"content": DISTILLED})
    again = client.post("/api/score-preview", json=ad()).json()
    assert again["cached"] is False and len(api.prompts) == 2 and DISTILLED in api.prompts[-1]
    assert client.post("/api/score-preview", json=ad()).json()["cached"] is True  # fresh under the new profile


def test_scores_from_before_versioning_are_rescored_on_next_view(client, db, docs, api):
    job = models.Job(title="Go Developer", company="Acme Oy", location="Helsinki", url="https://duunitori.fi/tyopaikat/tyo/go-dev-1",
                     status="saved", fit_score=55, fit_reason="old", scored_with=None, description_snippet="Go work")
    db.add(job)
    db.commit()
    r = client.post("/api/score-preview", json=ad()).json()
    assert r["id"] == job.id and r["cached"] is False and r["fit_score"] == 81 and r["status"] == "saved"
    db.refresh(job)
    assert job.scored_with == profile.scoring_context(db).version


def test_with_no_profile_an_existing_score_is_still_served_from_cache(client, db, api):
    client.post("/api/jobs", json=ad())  # no docs: background scoring can't run
    job = db.query(models.Job).one()
    job.fit_score, job.fit_reason = 40, "kept"
    db.commit()
    r = client.post("/api/score-preview", json=ad()).json()
    assert r["cached"] is True and r["fit_score"] == 40 and api.prompts == []


def test_failed_scoring_leaves_no_version_stamp(client, db, docs, api):
    api.reply = "not json"
    r = client.post("/api/score-preview", json=ad()).json()
    assert r["fit_score"] is None and r["fit_reason"].startswith("AI Error")
    assert db.query(models.Job).one().scored_with is None


# --- distilled profile endpoints -------------------------------------------------------------

def test_get_distilled_when_none_exists(client, docs):
    body = client.get("/api/profile/distilled").json()
    assert body["exists"] is False and body["content"] == "" and body["scoring_with"] == "raw"
    assert body["source_stale"] is False and body["max_chars"] == profile.MAX_DISTILLED_CHARS


def test_put_get_delete_round_trip(client, docs):
    saved = client.put("/api/profile/distilled", json={"content": f"  {DISTILLED}\n"}).json()
    assert saved["exists"] and saved["content"] == DISTILLED and saved["scoring_with"] == "distilled"
    assert client.get("/api/profile/distilled").json()["version"] == saved["version"]
    gone = client.delete("/api/profile/distilled").json()
    assert gone["exists"] is False and gone["scoring_with"] == "raw" and gone["version"] != saved["version"]


@pytest.mark.parametrize("content", ["", "   \n", "x" * (profile.MAX_DISTILLED_CHARS + 1)])
def test_put_rejects_blank_or_oversized_content(client, docs, content):
    assert client.put("/api/profile/distilled", json={"content": content}).status_code == 422


def test_profile_is_flagged_stale_when_documents_change_after_saving(client, db, docs):
    client.put("/api/profile/distilled", json={"content": DISTILLED})
    assert client.get("/api/profile/distilled").json()["source_stale"] is False
    client.post("/api/documents", json={"title": "New project", "content": "Added later"})
    stale = client.get("/api/profile/distilled").json()
    assert stale["source_stale"] is True and stale["scoring_with"] == "distilled"  # still used, just flagged
    client.put("/api/profile/distilled", json={"content": DISTILLED})  # re-saving acknowledges the new documents
    assert client.get("/api/profile/distilled").json()["source_stale"] is False


def test_draft_returns_text_without_saving_it(client, db, docs, api):
    api.reply = "SUMMARY: drafted"
    r = client.post("/api/profile/distilled/draft")
    assert r.status_code == 200 and r.json() == {"content": "SUMMARY: drafted"}
    assert CV in api.prompts[-1] and PROJECTS in api.prompts[-1] and "Never invent preferences" in api.prompts[-1]
    assert client.get("/api/profile/distilled").json()["exists"] is False


def test_draft_failure_modes(client, db, docs, monkeypatch):
    assert client.post("/api/profile/distilled/draft").status_code == 503  # no API key configured

    def boom(*a, **k):
        raise RuntimeError("quota")

    monkeypatch.setattr(llm, "generate", boom)
    r = client.post("/api/profile/distilled/draft")
    assert r.status_code == 502 and "quota" in r.json()["detail"]

    db.query(models.ProfileDocument).delete()
    db.commit()
    assert client.post("/api/profile/distilled/draft").status_code == 409


# --- migration -------------------------------------------------------------------------------

def test_migration_adds_scored_with_and_the_new_table_is_created(tmp_path):
    old = create_engine(f"sqlite:///{tmp_path}/old.db")
    with old.begin() as c:
        c.execute(text("CREATE TABLE jobs (id INTEGER PRIMARY KEY, title VARCHAR, company VARCHAR, location VARCHAR, "
                       "published VARCHAR, description_snippet TEXT, url VARCHAR, source VARCHAR, status VARCHAR, "
                       "fit_score INTEGER, fit_reason TEXT, created_at DATETIME)"))
        c.execute(text("INSERT INTO jobs (title, company, url, status, fit_score) VALUES ('Dev', 'Acme', 'https://a/1', 'saved', 70)"))
    models.Base.metadata.create_all(old)
    migrate.migrate(old)
    with old.connect() as c:
        row = c.execute(text("SELECT fit_score, scored_with FROM jobs")).one()
        assert row.fit_score == 70 and row.scored_with is None
        assert c.execute(text("SELECT count(*) FROM distilled_profile")).scalar() == 0
