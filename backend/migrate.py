"""Idempotent schema upgrade for an existing jobs.db.

`Base.metadata.create_all` only creates missing tables, so columns added to a model
later never reach an existing database. This adds them and backfills derived values.
Safe to run on every startup.
"""
from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

import ingest

NEW_JOB_COLUMNS = {
    "salary": "VARCHAR",
    "job_type": "VARCHAR",
    "industry": "VARCHAR",
    "apply_url": "VARCHAR",
    "fingerprint": "VARCHAR",
    "raw_payload": "TEXT",
    "first_seen_at": "DATETIME",
    "last_seen_at": "DATETIME",
    "notes": "TEXT",
    "deadline": "VARCHAR",
}


def migrate(engine: Engine) -> None:
    existing = {c["name"] for c in inspect(engine).get_columns("jobs")}
    with engine.begin() as conn:
        for name, sql_type in NEW_JOB_COLUMNS.items():
            if name not in existing:
                conn.execute(text(f"ALTER TABLE jobs ADD COLUMN {name} {sql_type}"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_jobs_fingerprint ON jobs (fingerprint)"))
        _backfill(conn)


def _backfill(conn) -> None:
    rows = conn.execute(text(
        "SELECT id, title, company, location, published, deadline, created_at "
        "FROM jobs WHERE fingerprint IS NULL OR first_seen_at IS NULL"
    )).fetchall()
    for row in rows:
        conn.execute(text(
            "UPDATE jobs SET fingerprint = :fp, first_seen_at = COALESCE(first_seen_at, :created), "
            "last_seen_at = COALESCE(last_seen_at, :created), "
            "published = :published, deadline = :deadline WHERE id = :id"
        ), {
            "id": row.id,
            "fp": ingest.fingerprint(row.title or "", row.company or "", row.location),
            "created": row.created_at,
            # Keep the original text when it can't be parsed, so nothing is lost.
            "published": ingest.normalize_date(row.published) or row.published,
            "deadline": ingest.normalize_date(row.deadline) or row.deadline,
        })
