import datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import ingest
import migrate
import models
from database import SessionLocal, engine
from main import app


@pytest.fixture
def db():
    models.Base.metadata.drop_all(bind=engine)
    models.Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    yield session
    session.close()


def job(**kw):
    base = dict(title="Backend Developer", company="Acme Oy", location="Helsinki",
                url="https://duunitori.fi/tyopaikat/tyo/backend-dev-abc-123")
    return ingest.JobIn(**{**base, **kw})


@pytest.mark.parametrize("raw,expected", [
    ("2026-09-19", "2026-09-19"),
    ("2026-09-19T10:00:00+03:00", "2026-09-19"),
    ("27.8.2026", "2026-08-27"),
    ("1.12.2026", "2026-12-01"),
    ("31.2.2026", None),
    ("3 days ago", "2026-10-20"),
    ("garbage", None),
    ("", None),
    (None, None),
])
def test_normalize_date(raw, expected):
    assert ingest.normalize_date(raw, today=datetime.date(2026, 10, 23)) == expected


@pytest.mark.parametrize("url,expected", [
    ("https://www.duunitori.fi/tyopaikat/tyo/x-1?utm_source=a#top", "https://duunitori.fi/tyopaikat/tyo/x-1"),
    ("https://www.linkedin.com/jobs/view/123456/?trackingId=zz", "https://www.linkedin.com/jobs/view/123456"),
    ("https://www.linkedin.com/jobs/view/dev-at-acme-123456", "https://www.linkedin.com/jobs/view/123456"),
    ("https://www.linkedin.com/jobs/collections/recommended/?currentJobId=987", "https://www.linkedin.com/jobs/view/987"),
])
def test_canonical_url(url, expected):
    assert ingest.canonical_url(url) == expected


def test_fingerprint_ignores_case_punctuation_and_company_suffix():
    a = ingest.fingerprint("Backend Developer (m/f)", "Acme Oy", "Helsinki, Finland")
    b = ingest.fingerprint("backend developer m f", "ACME", "helsinki")
    assert a == b
    assert a != ingest.fingerprint("Backend Developer (m/f)", "Acme Oy", "Tampere")


def test_create_stores_normalised_fields_and_raw(db):
    r = ingest.ingest(db, job(published="27.8.2026", deadline="2026-11-01", raw={"jsonld": {"a": 1}}))
    assert r.created and r.matched_by is None
    assert r.job.published == "2026-08-27" and r.job.deadline == "2026-11-01"
    assert r.job.first_seen_at and r.job.last_seen_at
    assert '"jsonld"' in r.job.raw_payload


def test_same_url_is_duplicate_and_preserves_user_state(db):
    first = ingest.ingest(db, job(descriptionSnippet="short")).job
    first.status = "applied"
    first.fit_score = 80
    db.commit()
    again = ingest.ingest(db, job(url=first.url + "?utm=x", descriptionSnippet="a much longer description", salary="3000"))
    assert not again.created and again.matched_by == "url"
    assert again.job.id == first.id
    assert again.job.status == "applied" and again.job.fit_score == 80
    assert again.job.description_snippet == "a much longer description"
    assert again.job.salary == "3000"
    assert db.query(models.Job).count() == 1


def test_repost_with_new_url_matches_by_fingerprint(db):
    first = ingest.ingest(db, job()).job
    repost = ingest.ingest(db, job(url="https://duunitori.fi/tyopaikat/tyo/backend-dev-xyz-999"))
    assert not repost.created and repost.matched_by == "fingerprint"
    assert repost.job.id == first.id
    assert db.query(models.Job).count() == 1


def test_recapture_does_not_overwrite_existing_fields(db):
    first = ingest.ingest(db, job(salary="3000")).job
    ingest.ingest(db, job(salary="9999"))
    db.refresh(first)
    assert first.salary == "3000"


def test_api_created_then_duplicate(db):
    client = TestClient(app)
    body = {"title": "Dev", "company": "Beta", "url": "https://x.test/job/1", "published": "27.8.2026"}
    r1 = client.post("/api/jobs", json=body)
    assert r1.status_code == 200 and r1.json()["outcome"] == "created"
    assert r1.json()["published"] == "2026-08-27"
    r2 = client.post("/api/jobs", json=body)
    assert r2.json()["outcome"] == "duplicate" and r2.json()["matched_by"] == "url"
    assert r2.json()["id"] == r1.json()["id"]
    assert len(client.get("/api/jobs").json()) == 1


def test_migrate_upgrades_old_schema_and_is_idempotent(tmp_path):
    from sqlalchemy import create_engine
    old = create_engine(f"sqlite:///{tmp_path}/old.db")
    with old.begin() as c:
        c.execute(text("CREATE TABLE jobs (id INTEGER PRIMARY KEY, title VARCHAR, company VARCHAR, location VARCHAR, "
                       "published VARCHAR, description_snippet TEXT, url VARCHAR, source VARCHAR, status VARCHAR, "
                       "fit_score INTEGER, fit_reason TEXT, created_at DATETIME)"))
        c.execute(text("INSERT INTO jobs (title, company, location, published, url, status, created_at) VALUES "
                       "('Dev', 'Acme Oy', 'Espoo', '27.8.2026', 'https://a/1', 'saved', '2026-09-01 10:00:00')"))
    migrate.migrate(old)
    migrate.migrate(old)
    with old.connect() as c:
        row = c.execute(text("SELECT published, status, fingerprint, first_seen_at FROM jobs")).one()
    assert row.published == "2026-08-27" and row.status == "saved"
    assert row.fingerprint == ingest.fingerprint("Dev", "Acme Oy", "Espoo")
    assert row.first_seen_at is not None


def test_dedupe_keeps_most_advanced_status_and_merges_data(db):
    import dedupe
    a = ingest.ingest(db, job(url="https://x.test/a")).job
    b = models.Job(title=a.title, company=a.company, location=a.location, url="https://x.test/b",
                   fingerprint=a.fingerprint, status="saved", fit_score=70, salary="4000")
    c = models.Job(title=a.title, company=a.company, location=a.location, url="https://x.test/c",
                   fingerprint=a.fingerprint, status="rejected")
    db.add_all([b, c])
    db.commit()
    skill = models.Skill(name="Go")
    db.add(skill)
    db.commit()
    db.add(models.JobSkill(job_id=c.id, skill_id=skill.id))
    db.commit()

    assert len(dedupe.merge_duplicates(db, apply=False)) == 1
    assert db.query(models.Job).count() == 3  # dry run changes nothing

    report = dedupe.merge_duplicates(db, apply=True)
    assert report[0]["keep"][0] == b.id  # saved beats rejected/new
    rows = db.query(models.Job).all()
    assert [r.id for r in rows] == [b.id]
    assert rows[0].fit_score == 70 and [js.skill.name for js in rows[0].job_skills] == ["Go"]
    assert {u.url for u in db.query(models.JobUrl)} == {"https://x.test/a", "https://x.test/c"}
    assert dedupe.merge_duplicates(db, apply=True) == []  # idempotent


def test_merged_away_url_is_not_recreated(db):
    import dedupe
    a = ingest.ingest(db, job(url="https://x.test/a")).job
    b = models.Job(title=a.title, company=a.company, location=a.location, url="https://x.test/b",
                   fingerprint=a.fingerprint, status="applied")
    db.add(b)
    db.commit()
    dedupe.merge_duplicates(db, apply=True)
    again = ingest.ingest(db, job(url="https://x.test/a", title="Completely Different Title"))
    assert not again.created and again.matched_by == "url" and again.job.id == b.id
    assert db.query(models.Job).count() == 1


# --- unknown sites: identifying query parameters, and ads with no location ---------------------

@pytest.mark.parametrize("url,expected", [
    # the job id lives in the query: it must survive
    ("https://careers.acme.com/jobs?gh_jid=4001234", "https://careers.acme.com/jobs?gh_jid=4001234"),
    # tracking goes, the id stays, the order is stable, the fragment goes
    ("https://careers.acme.com/jobs?utm_source=x&gh_jid=4001234&fbclid=zz#apply", "https://careers.acme.com/jobs?gh_jid=4001234"),
    ("https://www.Acme.com/jobs/?b=2&a=1", "https://acme.com/jobs?a=1&b=2"),
    ("https://acme.com/jobs?a=1&b=2", "https://acme.com/jobs?a=1&b=2"),
    ("https://acme.com/jobs?gh_src=abc&lever-source=li&utm_campaign=q", "https://acme.com/jobs"),
    # known sites keep their own rules
    ("https://duunitori.fi/tyopaikat/tyo/x-1?haku=python&utm_source=a#top", "https://duunitori.fi/tyopaikat/tyo/x-1"),
])
def test_canonical_url_keeps_what_identifies_a_job_on_unknown_sites(url, expected):
    assert ingest.canonical_url(url) == expected


def test_two_openings_on_one_listing_page_stay_separate(db):
    first = ingest.ingest(db, job(url="https://careers.acme.com/jobs?gh_jid=111", title="Data Engineer", location=None))
    second = ingest.ingest(db, job(url="https://careers.acme.com/jobs?gh_jid=222", title="Data Engineer", location=None))
    assert first.created and second.created and first.job.id != second.job.id
    again = ingest.ingest(db, job(url="https://careers.acme.com/jobs?utm_source=x&gh_jid=222", title="Data Engineer", location=None))
    assert not again.created and again.job.id == second.job.id and again.matched_by == "url"
    assert db.query(models.Job).count() == 2


def test_without_a_location_the_url_is_part_of_the_identity():
    kw = dict(title="Software Engineer", company="Acme Oy", location=None)
    assert ingest.fingerprint(**kw, url="https://acme.com/jobs/1") != ingest.fingerprint(**kw, url="https://acme.com/jobs/2")
    assert ingest.fingerprint(**kw, url="https://acme.com/jobs/1?utm_source=x") == ingest.fingerprint(**kw, url="https://acme.com/jobs/1")
    # with a location the URL is ignored, so reposts under a new URL still collapse
    with_loc = dict(title="Software Engineer", company="Acme Oy", location="Helsinki")
    assert ingest.fingerprint(**with_loc, url="https://acme.com/jobs/1") == ingest.fingerprint(**with_loc, url="https://acme.com/jobs/2")


def test_same_title_and_company_without_location_are_two_records_not_one(db):
    a = ingest.record_seen(db, ingest.JobIn(title="Software Engineer", company="Acme", url="https://acme.com/jobs/1"))
    b = ingest.record_seen(db, ingest.JobIn(title="Software Engineer", company="Acme", url="https://acme.com/jobs/2"))
    assert a.created and b.created and a.job.id != b.job.id
