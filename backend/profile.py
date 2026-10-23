"""The candidate profile the scorer reads, and the version stamp that goes on every score.

Scoring uses the distilled profile when there is one (short, edited by the user) and falls back to
the raw profile documents otherwise. The distilled profile is never written automatically: a draft
is generated on request, reviewed, and saved by the user.
"""
import datetime
import hashlib
from typing import Literal, NamedTuple

from sqlalchemy.orm import Session

import llm
import models

# Bump when the scoring prompt changes meaningfully, so scores made with the old prompt read as stale.
PROMPT_VERSION = "2"
MAX_DISTILLED_CHARS = 6000

DISTILL_PROMPT = """You are condensing a job seeker's CV and project write-ups into a compact profile that another model will use to judge how well job ads fit them.

Write plain text, at most about 450 words, with exactly these sections:
SUMMARY: 2-3 lines: who they are, seniority, what they are strongest at.
SKILLS: grouped as Strong / Working / Familiar. Concrete technologies only, and only ones the documents support.
EXPERIENCE: one line per role or substantial project: what it was, the technologies, scale or outcome, rough dates or duration.
EDUCATION AND LANGUAGES: degrees or programmes; spoken languages with level if stated.
PREFERENCES AND DEALBREAKERS: write "Not stated - add here." The candidate fills this in. Never invent preferences.

Rules: use only facts present in the documents. Keep numbers, dates and technology names exact. No marketing language. Leave out contact details.

Documents:
{context}
"""


class ProfileContext(NamedTuple):
    text: str
    version: str
    kind: Literal["distilled", "raw"]


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


def version_of(text: str) -> str:
    return _hash(f"{PROMPT_VERSION}\n{text}")


def raw_context(db: Session) -> str | None:
    docs = db.query(models.ProfileDocument).order_by(models.ProfileDocument.id).all()
    if not docs:
        return None
    return "\n\n".join(f"--- {d.title} ---\n{d.content}" for d in docs)


def documents_hash(db: Session) -> str | None:
    text = raw_context(db)
    return _hash(text) if text else None


def get_distilled(db: Session) -> models.DistilledProfile | None:
    row = db.get(models.DistilledProfile, 1)
    return row if row and (row.content or "").strip() else None


def scoring_context(db: Session) -> ProfileContext | None:
    distilled = get_distilled(db)
    if distilled:
        return ProfileContext(distilled.content.strip(), version_of(distilled.content.strip()), "distilled")
    raw = raw_context(db)
    return ProfileContext(raw, version_of(raw), "raw") if raw else None


def generate_draft(db: Session) -> str:
    """Ask the LLM to condense the profile documents. Returns text for the user to review; stores nothing."""
    context = raw_context(db)
    if not context:
        raise ValueError("No profile documents to distil.")
    return llm.generate(llm.get_settings(db), DISTILL_PROMPT.format(context=context),
                        json_mode=False, timeout=45).strip()


def save_distilled(db: Session, content: str) -> models.DistilledProfile:
    row = db.get(models.DistilledProfile, 1) or models.DistilledProfile(id=1)
    row.content = content.strip()
    row.source_hash = documents_hash(db)
    row.updated_at = datetime.datetime.utcnow()
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def delete_distilled(db: Session) -> None:
    row = db.get(models.DistilledProfile, 1)
    if row:
        db.delete(row)
        db.commit()


def status(db: Session) -> dict:
    distilled = get_distilled(db)
    ctx = scoring_context(db)
    current_docs = documents_hash(db)
    return {
        "exists": distilled is not None,
        "content": distilled.content if distilled else "",
        "updated_at": distilled.updated_at.isoformat() if distilled and distilled.updated_at else None,
        # True when the documents were added/edited/removed after this profile was saved.
        "source_stale": bool(distilled and distilled.source_hash != current_docs),
        "scoring_with": ctx.kind if ctx else None,
        "version": ctx.version if ctx else None,
        "max_chars": MAX_DISTILLED_CHARS,
    }
