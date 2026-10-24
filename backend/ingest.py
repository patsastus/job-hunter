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
from typing import Any, Literal, Optional

from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import models

COMPANY_SUFFIXES = {"oy", "oyj", "ab", "ltd", "inc", "gmbh", "as"}
RELATIVE_UNITS = {"minute": 0, "hour": 0, "day": 1, "week": 7, "month": 30}


JobStatus = Literal["new", "seen", "saved", "rejected", "applied"]


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
    # Only used by POST /api/jobs: the status a save/reject should leave the job in.
    status: JobStatus | None = None
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


# Query parameters that only say where a visitor came from. Everything else on an unknown site may be what
# identifies the job (e.g. Greenhouse's ?gh_jid=123), so it is kept.
TRACKING_PARAMS = {
    "fbclid", "gclid", "dclid", "msclkid", "yclid", "igshid", "mc_cid", "mc_eid", "_hsenc", "_hsmi",
    "gh_src", "lever-source", "lever-origin", "trk", "trkinfo", "trackingid", "refid", "li_fat_id", "s_cid", "cmpid",
}
TRACKING_PREFIXES = ("utm_", "hsa_", "pk_", "mtm_")


def _is_tracking(name: str) -> bool:
    name = name.lower()
    return name in TRACKING_PARAMS or name.startswith(TRACKING_PREFIXES)


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

    if host.endswith("duunitori.fi"):
        keep = ""  # an ad's identity is its path; every query string on these pages is tracking
    else:
        # Unknown site: keep what could identify the job, minus tracking, in a stable order.
        pairs = [(k, v) for k, v in urllib.parse.parse_qsl(parts.query, keep_blank_values=False) if not _is_tracking(k)]
        keep = urllib.parse.urlencode(sorted(pairs))
    return urllib.parse.urlunsplit((parts.scheme or "https", host, path, keep, ""))


def _norm_text(s: str | None) -> str:
    s = (s or "").casefold()
    s = re.sub(r"[^\w\s]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def fingerprint(title: str, company: str, location: str | None, url: str | None = None) -> str:
    """Identity of an ad independent of its URL, so reposts collapse into one row.

    Without a location, title and company cannot tell two openings apart (two "Software Engineer" roles at one
    company in different cities), so the URL becomes part of the identity: such an ad only matches itself."""
    company_words = [w for w in _norm_text(company).split() if w not in COMPANY_SUFFIXES]
    first_location = _norm_text((location or "").split(",")[0])
    parts = [_norm_text(title), " ".join(company_words), first_location]
    if not first_location and url:
        parts.append(canonical_url(url))
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()


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


def find_existing(db: Session, url: str, fp: str, raw_url: str | None = None) -> tuple[models.Job | None, str | None]:
    """Look an ad up by URL (including merged-away aliases), then by fingerprint.
    `raw_url` is the URL as sent, which matches rows stored before URLs were canonicalised."""
    urls = [url] if not raw_url or raw_url == url else [url, raw_url]
    existing = db.query(models.Job).filter(models.Job.url.in_(urls)).first()
    if not existing:
        alias = db.query(models.JobUrl).filter(models.JobUrl.url.in_(urls)).first()
        if alias:
            existing = db.get(models.Job, alias.job_id)
    if existing:
        return existing, "url"
    existing = db.query(models.Job).filter(models.Job.fingerprint == fp).first()
    return (existing, "fingerprint") if existing else (None, None)


def _lookup_keys(job: JobIn) -> tuple[str, str]:
    return canonical_url(job.url), fingerprint(job.title, job.company, job.location, job.url)


def _refresh(existing: models.Job, job: JobIn, fp: str, now: datetime.datetime, store_text: bool) -> None:
    """Re-seeing an ad refreshes it, but never overwrites anything already set."""
    existing.last_seen_at = now
    if not existing.fingerprint:
        existing.fingerprint = fp
    for attr, incoming in (
        ("salary", job.salary), ("job_type", job.jobType), ("industry", job.industry),
        ("apply_url", job.applyUrl), ("location", job.location),
    ):
        if not getattr(existing, attr) and _clean(incoming):
            setattr(existing, attr, _clean(incoming))
    if not existing.deadline:
        existing.deadline = normalize_date(job.deadline)
    if not existing.published:
        existing.published = normalize_date(job.published)
    if store_text:
        description = _clean(job.descriptionSnippet)
        if description and len(description) > len(existing.description_snippet or ""):
            existing.description_snippet = description
        if job.raw and not existing.raw_payload:
            existing.raw_payload = json.dumps(job.raw, ensure_ascii=False)


def _create(db: Session, job: JobIn, url: str, fp: str, now: datetime.datetime,
            status: str, store_text: bool) -> models.Job:
    new_job = models.Job(
        title=job.title.strip(),
        company=job.company.strip(),
        location=_clean(job.location),
        published=normalize_date(job.published),
        deadline=normalize_date(job.deadline),
        description_snippet=_clean(job.descriptionSnippet) if store_text else None,
        url=url,
        source=job.source,
        status=status,
        salary=_clean(job.salary),
        job_type=_clean(job.jobType),
        industry=_clean(job.industry),
        apply_url=_clean(job.applyUrl),
        fingerprint=fp,
        first_seen_at=now,
        last_seen_at=now,
        raw_payload=json.dumps(job.raw, ensure_ascii=False) if store_text and job.raw else None,
    )
    db.add(new_job)
    db.commit()
    db.refresh(new_job)
    return new_job


def _store(db: Session, job: JobIn, now: datetime.datetime | None, status: str,
           store_text: bool) -> IngestResult:
    now = now or datetime.datetime.utcnow()
    url, fp = _lookup_keys(job)
    existing, matched_by = find_existing(db, url, fp, job.url)
    if not existing:
        try:
            return IngestResult(_create(db, job, url, fp, now, status, store_text), created=True)
        except IntegrityError:
            # Two requests for the same ad raced (e.g. a tab reloaded mid-score); the other one won.
            db.rollback()
            existing, matched_by = find_existing(db, url, fp, job.url)
            if not existing:
                raise
    _refresh(existing, job, fp, now, store_text)
    if store_text and job.status and existing.status != "applied":
        existing.status = job.status
    db.commit()
    db.refresh(existing)
    return IngestResult(existing, created=False, matched_by=matched_by)


def ingest(db: Session, job: JobIn, now: datetime.datetime | None = None) -> IngestResult:
    """Full capture: stores the description and raw payload. `job.status` (a save or reject) is applied
    to an existing row unless it is already `applied`."""
    if job.status == "seen":
        raise ValueError("'seen' records carry no text; use record_seen()")
    return _store(db, job, now, status=job.status or "new", store_text=True)


def record_seen(db: Session, job: JobIn, now: datetime.datetime | None = None) -> IngestResult:
    """Remember that an ad was viewed, keeping metadata only: no description, no raw payload.
    An existing row keeps its status and whatever text it already has."""
    return _store(db, job, now, status="seen", store_text=False)
