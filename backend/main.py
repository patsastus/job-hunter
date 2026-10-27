from fastapi import BackgroundTasks, FastAPI, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field
from typing import List
import asyncio
import json
import os
import re
import threading
import time
import urllib.parse
from datetime import datetime

import ingest
import llm
import rescore
import migrate
import models
import profile
import skills_extractor
from database import engine, SessionLocal

VAULT_PATH = os.environ.get("VAULT_PATH", "/vault" if os.path.exists("/vault") else os.path.expanduser("~/vault"))
# The vault name as Obsidian knows it, used to build the obsidian:// link to a new application note
OBSIDIAN_VAULT_NAME = os.environ.get("OBSIDIAN_VAULT_NAME", "vault")

# Create database tables, then bring older databases up to the current columns
models.Base.metadata.create_all(bind=engine)
migrate.migrate(engine)

app = FastAPI(title="Job Hunter API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://jobs.test", "https://jobs.test"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Dependency to get DB session
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# Pydantic schema for incoming jobs
class JobAd(BaseModel):
    title: str
    company: str
    location: str | None = None
    published: str | None = None
    deadline: str | None = None
    descriptionSnippet: str | None = None
    url: str
    source: str = "extension"

class JobResponse(JobAd):
    id: int
    status: str
    fit_score: int | None
    fit_reason: str | None
    notes: str | None = None
    scored_with: str | None = None  # version stamp of the profile+prompt behind fit_score

    class Config:
        from_attributes = True

@app.get("/")
def read_root():
    return {"status": "ok", "message": "Job Hunter API is running"}

class IngestResponse(JobResponse):
    outcome: str  # "created" | "duplicate"
    matched_by: str | None = None  # "url" | "fingerprint" for duplicates

def score_new_job(job_id: int):
    # Own session: runs after the response has been sent, so the capture itself is never blocked on the LLM.
    db = SessionLocal()
    try:
        job = db.query(models.Job).filter(models.Job.id == job_id).first()
        # A job scored on view (score-preview) already has its score; don't pay for it twice.
        if job and job.fit_score is None:
            run_ai_scorer(job, db)
    finally:
        db.close()

@app.post("/api/jobs", response_model=IngestResponse)
def add_job(job: ingest.JobIn, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    if job.status == "seen":
        raise HTTPException(status_code=422, detail="'seen' records are created by /api/score-preview")
    result = ingest.ingest(db, job)
    if result.job.fit_score is None and result.job.status in ("new", "saved"):
        background_tasks.add_task(score_new_job, result.job.id)
    return IngestResponse(
        **JobResponse.model_validate(result.job, from_attributes=True).model_dump(),
        outcome="created" if result.created else "duplicate",
        matched_by=result.matched_by,
    )

class ScorePreviewResponse(BaseModel):
    id: int
    status: str
    fit_score: int | None
    fit_reason: str | None
    cached: bool  # True when the stored score was returned without calling the LLM
    created: bool  # True when this view created the `seen` record

@app.post("/api/score-preview", response_model=ScorePreviewResponse)
def score_preview(job: ingest.JobIn, force: bool = False, score: bool = True, db: Session = Depends(get_db)):
    """Score an ad that is being viewed. The text is used for scoring and then dropped: only a `seen`
    record with metadata, score and reason is kept. A saved or applied ad keeps its status.
    `score=false` only records the ad as seen, without calling the LLM (used to reject an ad that
    has not been scored yet)."""
    result = ingest.record_seen(db, job)
    row = result.job
    if not score:
        return ScorePreviewResponse(id=row.id, status=row.status, fit_score=row.fit_score,
                                    fit_reason=row.fit_reason, cached=False, created=result.created)
    ctx = profile.scoring_context(db)
    # A stored score only counts while it was made with the current profile and prompt. Scores from before
    # versioning (scored_with is NULL) read as stale, so they are refreshed the next time the ad is viewed.
    fresh = row.fit_score is not None and (ctx is None or row.scored_with == ctx.version)
    cached = fresh and not force
    if not cached:
        text = (job.descriptionSnippet or row.description_snippet or "").strip()
        if text:
            row.fit_score, row.fit_reason, row.scored_with = compute_fit(db, row.title, row.company, text)
        else:
            row.fit_score, row.fit_reason, row.scored_with = None, "No description to score.", None
        db.commit()
        db.refresh(row)
    return ScorePreviewResponse(id=row.id, status=row.status, fit_score=row.fit_score,
                                fit_reason=row.fit_reason, cached=cached, created=result.created)

class LookupRequest(BaseModel):
    urls: List[str] = Field(max_length=200)

class LookupItem(BaseModel):
    url: str  # as sent, so callers can match results to the links they asked about
    id: int | None = None
    status: str | None = None
    fit_score: int | None = None

@app.post("/api/jobs/lookup", response_model=List[LookupItem])
def lookup_jobs(req: LookupRequest, db: Session = Depends(get_db)):
    """Which of these ad URLs are already known, and in what state."""
    canon = {u: ingest.canonical_url(u) for u in req.urls}
    wanted = set(canon.values()) | set(req.urls)
    by_url = {j.url: j for j in db.query(models.Job).filter(models.Job.url.in_(wanted)).all()}
    for alias in db.query(models.JobUrl).filter(models.JobUrl.url.in_(wanted)).all():
        if alias.url not in by_url:
            by_url[alias.url] = db.get(models.Job, alias.job_id)
    items = []
    for u in req.urls:
        job = by_url.get(canon[u]) or by_url.get(u)
        items.append(LookupItem(url=u, id=job.id, status=job.status, fit_score=job.fit_score) if job
                     else LookupItem(url=u))
    return items

@app.get("/api/jobs", response_model=List[JobResponse])
def get_jobs(db: Session = Depends(get_db)):
    return db.query(models.Job).order_by(models.Job.id.desc()).all()

class JobUpdate(BaseModel):
    """Only fields present in the request are changed. Empty text clears location, deadline and notes."""
    status: ingest.JobStatus | None = None
    title: str | None = None
    company: str | None = None
    location: str | None = None
    deadline: str | None = None
    notes: str | None = None

@app.patch("/api/jobs/{job_id}", response_model=JobResponse)
def update_job(job_id: int, job_update: JobUpdate, db: Session = Depends(get_db)):
    db_job = db.query(models.Job).filter(models.Job.id == job_id).first()
    if not db_job:
        raise HTTPException(status_code=404, detail="Job not found")

    sent = job_update.model_fields_set
    for field in ("title", "company"):
        if field in sent:
            value = (getattr(job_update, field) or "").strip()
            if not value:
                raise HTTPException(status_code=422, detail=f"{field} cannot be empty")
            setattr(db_job, field, value)
    for field in ("location", "notes"):
        if field in sent:
            setattr(db_job, field, (getattr(job_update, field) or "").strip() or None)
    if "deadline" in sent:
        raw_deadline = (job_update.deadline or "").strip()
        parsed = ingest.normalize_date(raw_deadline)
        if raw_deadline and not parsed:
            raise HTTPException(status_code=422, detail="deadline must be a date like 2026-11-30 or 30.11.2026")
        db_job.deadline = parsed
    if "status" in sent and job_update.status is not None:
        if job_update.status == "seen" and db_job.status != "seen":
            if db_job.status == "applied":
                raise HTTPException(status_code=409, detail="An applied job cannot go back to 'seen'")
            # Back to a viewed-only record (e.g. undoing a save): drop the text that the save stored.
            db_job.description_snippet = None
            db_job.raw_payload = None
        db_job.status = job_update.status
    db.commit()
    db.refresh(db_job)
    return db_job

@app.post("/api/jobs/{job_id}/export-to-obsidian")
def export_job_to_obsidian(job_id: int, db: Session = Depends(get_db)):
    db_job = db.query(models.Job).filter(models.Job.id == job_id).first()
    if not db_job:
        raise HTTPException(status_code=404, detail="Job not found")

    target_dir = os.path.join(VAULT_PATH, "Job Applications", "Active")
    os.makedirs(target_dir, exist_ok=True)

    today_str = datetime.now().strftime("%Y-%m-%d")
    year_month = datetime.now().strftime("%Y-%m")

    # Clean filename: "YYYY-MM - Company - Role.md"
    safe_company = re.sub(r'[\\/*?:"<>|]', "", db_job.company or "Unknown").strip()
    safe_title = re.sub(r'[\\/*?:"<>|]', "", db_job.title or "Role").strip()[:50]
    filename = f"{year_month} - {safe_company} - {safe_title}.md"
    filepath = os.path.join(target_dir, filename)

    # Escape quotes for YAML frontmatter
    yaml_company = (db_job.company or "").replace('"', '\\"')
    yaml_title = (db_job.title or "").replace('"', '\\"')
    yaml_location = (db_job.location or "").replace('"', '\\"')
    yaml_url = (db_job.url or "").replace('"', '\\"')
    yaml_deadline = (db_job.deadline or "").replace('"', '\\"')
    fit_score_val = db_job.fit_score if db_job.fit_score is not None else 'null'

    linked_skills = [js.skill.name for js in db_job.job_skills if js.skill]
    skills_yaml = "\n".join([f"  - \"{s}\"" for s in linked_skills])
    skills_block = f"skills:\n{skills_yaml}" if linked_skills else "skills: []"

    content = f"""---
tags:
  - job-app
status: Applied
company: "{yaml_company}"
role: "{yaml_title}"
location: "{yaml_location}"
salary: ""
date_applied: {today_str}
last_contact: {today_str}
deadline: "{yaml_deadline}"
url: "{yaml_url}"
source: "{db_job.source}"
fit_score: {fit_score_val}
{skills_block}
cv_file: ""
cv_git_hash: ""
contact_person: ""
contact_email: ""
---

# {db_job.company} — {db_job.title}

## 🎯 Positioning & Strategy
- **Why this role?**: 
- **AI Fit Reason**: {db_job.fit_reason or "N/A"}
- **Key Skills Catalogued**: {', '.join(linked_skills) if linked_skills else 'None specified'}

---

## 📤 Submission Packet
- **CV Used**: 
- **Cover Letter**:
> (Draft or copy submitted cover letter here)

---

## 📝 Preserved Job Description
> [!NOTE] Preserved Job Ad
{db_job.description_snippet or 'No description snippet available.'}

---

## 📞 Communication & Interview Log
- **{today_str}**: Application created from {db_job.source} and marked Applied.

---

## 💡 Post-Mortem & Retrospective
- **Outcome**: 
- **Feedback received**: 
- **Key takeaways**: 
"""

    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)

    # Mark as applied in DB
    db_job.status = "applied"
    db.commit()
    db.refresh(db_job)

    # Generate Obsidian URI: obsidian://open?vault={OBSIDIAN_VAULT_NAME}&file=Job%20Applications/Active/{safe_encoded_filename}
    encoded_file_path = urllib.parse.quote(f"Job Applications/Active/{filename.removesuffix('.md')}")
    obsidian_uri = f"obsidian://open?vault={urllib.parse.quote(OBSIDIAN_VAULT_NAME)}&file={encoded_file_path}"

    return {
        "status": "ok",
        "path": filepath,
        "filename": filename,
        "obsidian_uri": obsidian_uri,
        "job_id": db_job.id,
        "job_status": db_job.status
    }

# Skills & Buzzwords Catalog Endpoints
class JobSkillsUpdate(BaseModel):
    skills: List[str]
    update_status: str | None = None

class SkillSummary(BaseModel):
    id: int
    name: str
    canonical_name: str | None = None
    category: str | None = None
    total_count: int
    applied_count: int
    rejected_count: int
    saved_count: int

@app.get("/api/jobs/{job_id}/skills")
def get_job_skills(job_id: int, db: Session = Depends(get_db)):
    job = db.query(models.Job).filter(models.Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    linked = [js.skill.name for js in job.job_skills if js.skill]
    return {"job_id": job.id, "skills": linked}

@app.get("/api/jobs/{job_id}/extract-skills")
def extract_job_skills(job_id: int, db: Session = Depends(get_db)):
    job = db.query(models.Job).filter(models.Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    
    linked = [js.skill.name for js in job.job_skills if js.skill]
    extracted = skills_extractor.extract_candidate_skills(job, db)
    
    # Merge existing + extracted preserving order
    combined = list(linked)
    for s in extracted:
        if s.lower() not in [x.lower() for x in combined]:
            combined.append(s)

    return {
        "job_id": job.id,
        "already_saved": linked,
        "candidate_skills": combined
    }

@app.post("/api/jobs/{job_id}/skills")
def save_job_skills(job_id: int, payload: JobSkillsUpdate, db: Session = Depends(get_db)):
    job = db.query(models.Job).filter(models.Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    # Clear existing associations for this job
    db.query(models.JobSkill).filter(models.JobSkill.job_id == job.id).delete()

    normalized_skills = []
    seen = set()
    for raw_skill in payload.skills:
        clean = raw_skill.strip()
        if clean and clean.lower() not in seen:
            seen.add(clean.lower())
            normalized_skills.append(clean)

    for skill_name in normalized_skills:
        # Check or create skill in catalog
        skill = db.query(models.Skill).filter(func.lower(models.Skill.name) == skill_name.lower()).first()
        if not skill:
            skill = models.Skill(name=skill_name)
            db.add(skill)
            db.commit()
            db.refresh(skill)

        job_skill = models.JobSkill(job_id=job.id, skill_id=skill.id)
        db.add(job_skill)

    if payload.update_status:
        job.status = payload.update_status

    db.commit()
    db.refresh(job)

    return {
        "status": "ok",
        "job_id": job.id,
        "job_status": job.status,
        "skills": normalized_skills
    }

@app.get("/api/skills", response_model=List[SkillSummary])
def get_skills_summary(db: Session = Depends(get_db)):
    skills = db.query(models.Skill).all()
    results = []
    for s in skills:
        total_count = len(s.job_skills)
        applied_count = sum(1 for js in s.job_skills if js.job and js.job.status == "applied")
        rejected_count = sum(1 for js in s.job_skills if js.job and js.job.status == "rejected")
        saved_count = sum(1 for js in s.job_skills if js.job and js.job.status == "saved")
        results.append({
            "id": s.id,
            "name": s.name,
            "canonical_name": s.canonical_name,
            "category": s.category,
            "total_count": total_count,
            "applied_count": applied_count,
            "rejected_count": rejected_count,
            "saved_count": saved_count
        })
    results.sort(key=lambda x: x["total_count"], reverse=True)
    return results


# Global state for scoring progress & SSE broadcasting
scoring_state = {
    "is_running": False,
    "total": 0,
    "completed": 0,
    "failed": 0,
    "stopped": None,
    "current_job": ""
}
rescore_lock = threading.Lock()  # claiming "a re-score is running" must be atomic
subscribers: list[asyncio.Queue] = []
main_loop = None

def broadcast_event(event_type: str, data: dict):
    global main_loop
    if not subscribers:
        return
    payload = f"event: {event_type}\ndata: {json.dumps(data)}\n\n"
    for q in list(subscribers):
        try:
            if main_loop and main_loop.is_running():
                main_loop.call_soon_threadsafe(q.put_nowait, payload)
        except Exception:
            pass

# Re-scoring saved jobs with the current profile (see rescore.py). Progress is published on the stream below.
@app.get("/api/profile/rescore")
def rescore_status(db: Session = Depends(get_db)):
    """How many saved jobs were scored with an older profile, and whether a re-score is running."""
    return {**rescore.status(db, llm.get_settings(db).model), "running": scoring_state["is_running"]}

@app.post("/api/profile/rescore", status_code=202)
def start_rescore(db: Session = Depends(get_db)):
    """Start re-scoring the saved jobs that are not scored with the current profile. One run at a time."""
    with rescore_lock:
        if scoring_state["is_running"]:
            raise HTTPException(status_code=409, detail="A re-score is already running.")
        ids, version = rescore.eligible_ids(db)
        if version is None:
            raise HTTPException(status_code=409, detail="There is no profile to score with. Add a profile document first.")
        if not ids:
            raise HTTPException(status_code=409, detail="Every saved job that has a stored ad text is already scored with the current profile.")
        scoring_state.update(is_running=True, total=len(ids), completed=0, failed=0, stopped=None, current_job="")  # claim it
    interval = rescore.interval_for(llm.get_settings(db).model)
    threading.Thread(
        target=rescore.run_rescore,
        args=(ids, version),
        kwargs=dict(session_factory=SessionLocal, compute=lambda *a: compute_fit(*a), interval=interval,
                    emit=broadcast_event, state=scoring_state),
        daemon=True,
    ).start()
    return {"status": "started", "total": len(ids), "interval_seconds": interval}

@app.get("/api/jobs/score-stream")
async def score_stream(request: Request):
    global main_loop
    if main_loop is None:
        main_loop = asyncio.get_running_loop()

    queue = asyncio.Queue()
    subscribers.append(queue)

    async def event_generator():
        try:
            # Send current state immediately upon client connection
            initial_event = rescore.snapshot(scoring_state)
            yield f"event: state\ndata: {json.dumps(initial_event)}\n\n"

            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield msg
                except asyncio.TimeoutError:
                    # Keep-alive comment
                    yield ": ping\n\n"
        finally:
            if queue in subscribers:
                subscribers.remove(queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )

@app.get("/api/jobs/{job_id}", response_model=JobResponse)
def get_job(job_id: int, db: Session = Depends(get_db)):
    # Declared after the static /api/jobs/score-stream route so "score-stream" isn't read as a job id.
    db_job = db.query(models.Job).filter(models.Job.id == job_id).first()
    if not db_job:
        raise HTTPException(status_code=404, detail="Job not found")
    return db_job

@app.post("/api/jobs/{job_id}/score", response_model=JobResponse)
def score_job(job_id: int, db: Session = Depends(get_db)):
    db_job = db.query(models.Job).filter(models.Job.id == job_id).first()
    if not db_job:
        raise HTTPException(status_code=404, detail="Job not found")
    
    run_ai_scorer(db_job, db)
    db.refresh(db_job)
    return db_job

# Keyword endpoints
class KeywordBase(BaseModel):
    word: str

class KeywordResponse(KeywordBase):
    id: int
    class Config:
        from_attributes = True

@app.get("/api/keywords", response_model=List[KeywordResponse])
def get_keywords(db: Session = Depends(get_db)):
    return db.query(models.Keyword).all()

@app.post("/api/keywords", response_model=KeywordResponse)
def add_keyword(kw: KeywordBase, db: Session = Depends(get_db)):
    existing = db.query(models.Keyword).filter(models.Keyword.word == kw.word).first()
    if existing:
        return existing
    new_kw = models.Keyword(word=kw.word)
    db.add(new_kw)
    db.commit()
    db.refresh(new_kw)
    return new_kw

@app.delete("/api/keywords/{kw_id}")
def delete_keyword(kw_id: int, db: Session = Depends(get_db)):
    kw = db.query(models.Keyword).filter(models.Keyword.id == kw_id).first()
    if kw:
        db.delete(kw)
        db.commit()
    return {"status": "deleted"}

# Profile Document endpoints
class DocumentBase(BaseModel):
    title: str
    content: str

class DocumentResponse(DocumentBase):
    id: int
    class Config:
        from_attributes = True

@app.get("/api/documents", response_model=List[DocumentResponse])
def get_documents(db: Session = Depends(get_db)):
    return db.query(models.ProfileDocument).all()

@app.post("/api/documents", response_model=DocumentResponse)
def add_document(doc: DocumentBase, db: Session = Depends(get_db)):
    new_doc = models.ProfileDocument(title=doc.title, content=doc.content)
    db.add(new_doc)
    db.commit()
    db.refresh(new_doc)
    return new_doc

@app.delete("/api/documents/{doc_id}")
def delete_document(doc_id: int, db: Session = Depends(get_db)):
    doc = db.query(models.ProfileDocument).filter(models.ProfileDocument.id == doc_id).first()
    if doc:
        db.delete(doc)
        db.commit()
    return {"status": "deleted"}

# Settings Endpoints
class SettingUpdate(BaseModel):
    key: str
    value: str

@app.get("/api/settings")
def get_settings(db: Session = Depends(get_db)):
    settings = db.query(models.SystemSetting).all()
    # Mask the API key before sending to frontend
    res = {}
    for s in settings:
        if s.key == "api_key" and s.value:
            res[s.key] = s.value[:4] + "..." + s.value[-4:] if len(s.value) > 8 else "***"
        else:
            res[s.key] = s.value
    return res

@app.post("/api/settings")
def update_setting(setting: SettingUpdate, db: Session = Depends(get_db)):
    db_setting = db.query(models.SystemSetting).filter(models.SystemSetting.key == setting.key).first()
    # If the user sends masked string, ignore it so we don't overwrite the real key
    if setting.key == "api_key" and "..." in setting.value:
        return {"status": "ignored"}
        
    if db_setting:
        db_setting.value = setting.value
    else:
        db_setting = models.SystemSetting(key=setting.key, value=setting.value)
        db.add(db_setting)
    db.commit()
    return {"status": "updated"}

def compute_fit(db: Session, title: str, company: str, description: str) -> tuple[int | None, str | None, str | None]:
    """Ask the LLM how well the profile fits an ad. Returns (score, reason, profile_version).
    score and version are None when scoring was not possible, and the reason says why.
    Does not touch the database."""
    ctx = profile.scoring_context(db)
    if ctx is None:
        return None, "No profile documents provided for scoring.", None

    prompt = f"""You are an expert technical recruiter matching a candidate to a job.
Candidate Profile:
{ctx.text}

Job Ad ({company} - {title}):
{description}

Evaluate the fit on a scale of 0 to 100. Be realistic and critical based on the required technologies and experience.
Take any preferences or dealbreakers stated in the candidate profile into account.
Return ONLY valid JSON in this exact format:
{{"score": 85, "reason": "One short sentence explaining the score."}}
"""
    try:
        result = json.loads(llm.generate(llm.get_settings(db), prompt, json_mode=True, timeout=20))
        return result.get("score"), result.get("reason"), ctx.version
    except llm.LlmUnavailable as e:
        return None, str(e), None
    except Exception as e:
        return None, f"AI Error: {str(e)}", None

def run_ai_scorer(job: models.Job, db: Session):
    job.fit_score, job.fit_reason, job.scored_with = compute_fit(db, job.title, job.company, job.description_snippet)
    db.commit()

# Distilled profile: the short, user-edited profile the scorer prefers over the raw documents
class DistilledUpdate(BaseModel):
    content: str = Field(min_length=1, max_length=profile.MAX_DISTILLED_CHARS)

@app.get("/api/profile/distilled")
def get_distilled_profile(db: Session = Depends(get_db)):
    return profile.status(db)

@app.post("/api/profile/distilled/draft")
def draft_distilled_profile(db: Session = Depends(get_db)):
    """Generate a draft from the profile documents for the user to review. Nothing is saved."""
    try:
        return {"content": profile.generate_draft(db)}
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except llm.LlmUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI Error: {str(e)}")

@app.put("/api/profile/distilled")
def save_distilled_profile(update: DistilledUpdate, db: Session = Depends(get_db)):
    if not update.content.strip():
        raise HTTPException(status_code=422, detail="content cannot be blank")
    profile.save_distilled(db, update.content)
    return profile.status(db)

@app.delete("/api/profile/distilled")
def delete_distilled_profile(db: Session = Depends(get_db)):
    """Go back to scoring with the raw profile documents."""
    profile.delete_distilled(db)
    return profile.status(db)
