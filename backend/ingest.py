"""Single entry point for getting a job ad into the database.

Every collector (browser extension, Duunitori scraper, OP ingest) should call
`ingest()` so normalisation and de-duplication behave the same everywhere.
"""
import datetime
import hashlib
import json
import re
import urllib.parse
from dataclasses import dataclass
from typing import Any, Optional

from pydantic import BaseModel
from sqlalchemy.orm import Session

import models

COMPANY_SUFFIXES = {"oy", "oyj", "ab", "ltd", "inc", "gmbh", "as"}
RELATIVE_UNITS = {"minute": 0, "hour": 0, "day": 1, "week": 7, "month": 30}


class JobIn(BaseModel):
    """A job as captured by a collector. Field names match what the extension sends."""
    title: str
    company: str
    location: str | None = None
    published: str | None = None
    deadline: str | None = None
    descriptionSnippet: str | None = None
    url: str
    source: str = "extension"
    salary: str | None = None
    jobType: str | None = None
    industry: str | None = None
    applyUrl: str | None = None
    # Untouched capture, kept so parsers can be fixed later without revisiting the page.
    raw: dict[str, Any] | None = None


@dataclass
class IngestResult:
    job: models.Job
    created: bool
    matched_by: Optional[str] = None  # "url" | "fingerprint" when created is False


def canonical_url(url: str) -> str:
    """Strip tracking noise so the same ad always maps to the same URL."""
    parts = urllib.parse.urlsplit(url.strip())
    host = parts.netloc.lower().removeprefix("www.")
    path = parts.path.rstrip("/")
    query = urllib.parse.parse_qs(parts.query)

    if host.endswith("linkedin.com"):
        job_id = None
        if "currentJobId" in query:
            job_id = query["currentJobId"][0]
        else:
            m = re.search(r"/jobs/view/(?:.*-)?(\d+)$", path)
            if m:
                job_id = m.group(1)
        if job_id:
            return f"https://www.linkedin.com/jobs/view/{job_id}"

    return urllib.parse.urlunsplit((parts.scheme or "https", host, path, "", ""))


def _norm_text(s: str | None) -> str:
    s = (s or "").casefold()
    s = re.sub(r"[^\w\s]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def fingerprint(title: str, company: str, location: str | None) -> str:
    """Identity of an ad independent of its URL, so reposts collapse into one row."""
    company_words = [w for w in _norm_text(company).split() if w not in COMPANY_SUFFIXES]
    first_location = _norm_text((location or "").split(",")[0])
    key = "|".join([_norm_text(title), " ".join(company_words), first_location])
    return hashlib.sha1(key.encode("utf-8")).hexdigest()


def normalize_date(value: str | None, today: datetime.date | None = None) -> str | None:
    """Return YYYY-MM-DD, or None when the value can't be understood."""
    if not value:
        return None
    value = value.strip()
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", value)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    m = re.match(r"^(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})", value)
    if m:
        d, mo, y = (int(g) for g in m.groups())
        try:
            return datetime.date(y, mo, d).isoformat()
        except ValueError:
            return None
    m = re.match(r"^(\d+)\s+(minute|hour|day|week|month)s?\s+ago", value, re.IGNORECASE)
    if m:
        today = today or datetime.date.today()
        days = int(m.group(1)) * RELATIVE_UNITS[m.group(2).lower()]
        return (today - datetime.timedelta(days=days)).isoformat()
    return None


def _clean(value: str | None) -> str | None:
    value = (value or "").strip()
    return value or None


def ingest(db: Session, job: JobIn, now: datetime.datetime | None = None) -> IngestResult:
    now = now or datetime.datetime.utcnow()
    url = canonical_url(job.url)
    fp = fingerprint(job.title, job.company, job.location)

    existing = db.query(models.Job).filter(models.Job.url.in_([url, job.url])).first()
    matched_by = "url" if existing else None
    if not existing:
        existing = db.query(models.Job).filter(models.Job.fingerprint == fp).first()
        matched_by = "fingerprint" if existing else None

    description = _clean(job.descriptionSnippet)

    if existing:
        # Re-seeing an ad refreshes it but never touches status, score or anything the user may have edited.
        existing.last_seen_at = now
        if not existing.fingerprint:
            existing.fingerprint = fp
        if description and len(description) > len(existing.description_snippet or ""):
            existing.description_snippet = description
        for attr, incoming in (
            ("salary", job.salary), ("job_type", job.jobType), ("industry", job.industry),
            ("apply_url", job.applyUrl), ("location", job.location),
        ):
            if not getattr(existing, attr) and _clean(incoming):
                setattr(existing, attr, _clean(incoming))
        if not existing.deadline:
            existing.deadline = normalize_date(job.deadline)
        db.commit()
        db.refresh(existing)
        return IngestResult(existing, created=False, matched_by=matched_by)

    new_job = models.Job(
        title=job.title.strip(),
        company=job.company.strip(),
        location=_clean(job.location),
        published=normalize_date(job.published),
        deadline=normalize_date(job.deadline),
        description_snippet=description,
        url=url,
        source=job.source,
        salary=_clean(job.salary),
        job_type=_clean(job.jobType),
        industry=_clean(job.industry),
        apply_url=_clean(job.applyUrl),
        fingerprint=fp,
        first_seen_at=now,
        last_seen_at=now,
        raw_payload=json.dumps(job.raw, ensure_ascii=False) if job.raw else None,
    )
    db.add(new_job)
    db.commit()
    db.refresh(new_job)
    return IngestResult(new_job, created=True)
