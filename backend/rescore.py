"""Re-score saved jobs against the current profile, in the background, with progress events.

When the scoring profile changes (a distilled profile saved or deleted, a document added or removed), every stored score was
made with an older version. Only `saved` jobs are worth refreshing: rejected and applied jobs are decided, viewed-only
records re-score when you look at them again.

Three rules keep this safe:
  * A failed call never touches the stored score. (`run_ai_scorer` writes whatever comes back, so a rate-limit error would
    replace a good score with an error message.) The job stays stale, so a later run picks it up.
  * The pause between calls follows the model's rate limit, and a rate-limit answer waits and retries once.
  * The run is for ONE profile version. If the profile changes while it runs, it stops instead of mixing two versions.
"""
import time

import models
import profile

# Seconds between calls, from the free-tier limits listed beside the model choice in the web app's settings.
INTERVAL_SECONDS = {
    "gemini-3.5-flash-lite": 4.1,  # 15 requests a minute
    "gemini-3.5-flash": 12.5,      # 5 requests a minute (and 20 a day)
    "gemma-4b": 2.1,               # 30 requests a minute
}
DEFAULT_INTERVAL = 6.0             # models not listed: 10 a minute, a cautious guess
RATE_LIMIT_PAUSE = 60              # seconds to wait after a rate-limit answer before the one retry
MAX_CONSECUTIVE_FAILURES = 3       # then the run stops, so a broken key or an outage does not burn through every job
SHORT_TEXT = 900                   # the old scraper cut ads at 800 characters: such a score is rougher


def interval_for(model):
    return INTERVAL_SECONDS.get(model, DEFAULT_INTERVAL)


def _needs_scoring(job, version):
    return job.fit_score is None or job.scored_with != version


def _has_text(job):
    return bool((job.description_snippet or "").strip())


def eligible_ids(db):
    """-> (ids of saved jobs to re-score, the profile version they will be scored with, or None without a profile)."""
    ctx = profile.scoring_context(db)
    if ctx is None:
        return [], None
    jobs = db.query(models.Job).filter(models.Job.status == "saved").order_by(models.Job.id).all()
    return [j.id for j in jobs if _needs_scoring(j, ctx.version) and _has_text(j)], ctx.version


def status(db, model):
    """What the 'Re-score saved jobs' button needs to know."""
    ctx = profile.scoring_context(db)
    version = ctx.version if ctx else None
    saved = db.query(models.Job).filter(models.Job.status == "saved").all()
    stale = [j for j in saved if version and _needs_scoring(j, version)]
    runnable = [j for j in stale if _has_text(j)]
    interval = interval_for(model)
    return {
        "version": version,
        "scoring_with": ctx.kind if ctx else None,
        "saved_total": len(saved),
        "current": len(saved) - len(stale),
        "to_rescore": len(runnable),
        "no_text": len(stale) - len(runnable),
        "short_text": sum(1 for j in runnable if len(j.description_snippet.strip()) < SHORT_TEXT),
        "model": model,
        "interval_seconds": interval,
        "estimated_seconds": round(len(runnable) * interval),
    }


def job_payload(job):
    return {
        "id": job.id, "title": job.title, "company": job.company, "location": job.location,
        "published": job.published, "deadline": job.deadline, "descriptionSnippet": job.description_snippet,
        "url": job.url, "status": job.status, "fit_score": job.fit_score, "fit_reason": job.fit_reason,
        "scored_with": job.scored_with, "source": job.source,
    }


def snapshot(state, current=None):
    return {
        "isRunning": state["is_running"], "total": state["total"], "completed": state["completed"],
        "failed": state["failed"], "stopped": state["stopped"],
        "currentJob": state["current_job"] if current is None else current,
    }


def _rate_limited(reason):
    text = (reason or "").lower()
    return "429" in text or "too many requests" in text or "quota" in text or "rate limit" in text


def _valid_score(score):
    return isinstance(score, (int, float)) and not isinstance(score, bool) and 0 <= score <= 100


def _call(compute, db, job):
    """The scoring call, with an unexpected exception turned into an ordinary failed result."""
    try:
        return compute(db, job.title, job.company, job.description_snippet)
    except Exception as e:  # noqa: BLE001 - anything: the run must reach its 'done' event
        return None, f"AI Error: {e}", None


def run_rescore(job_ids, target_version, *, session_factory, compute, interval, emit, state,
                sleep=time.sleep, rate_limit_pause=RATE_LIMIT_PAUSE):
    """Score each job once with `target_version`. `state` is the shared progress dict (already marked running by the
    caller); `emit(event, data)` publishes progress. Never raises: every outcome ends in a 'done' event."""
    state.update(is_running=True, total=len(job_ids), completed=0, failed=0, current_job="", stopped=None)
    emit("state", snapshot(state, "Starting..."))
    failures_in_a_row = 0
    try:
        for index, job_id in enumerate(job_ids):
            db = session_factory()
            try:
                job = db.get(models.Job, job_id)
                if job is None or job.status != "saved" or not _has_text(job):
                    state["completed"] += 1  # decided or removed since the run started: nothing to do
                    continue
                ctx = profile.scoring_context(db)
                if ctx is None or ctx.version != target_version:
                    state["stopped"] = "The profile changed while re-scoring. Start again to use the new one."
                    return
                state["current_job"] = job.title
                emit("state", snapshot(state))

                score, reason, version = _call(compute, db, job)
                if score is None and _rate_limited(reason):
                    emit("state", snapshot(state, f"Rate limited, waiting {rate_limit_pause}s..."))
                    sleep(rate_limit_pause)
                    score, reason, version = _call(compute, db, job)

                if _valid_score(score) and version == target_version:
                    job.fit_score, job.fit_reason, job.scored_with = int(round(score)), reason, version
                    db.commit()
                    state["completed"] += 1
                    failures_in_a_row = 0
                    emit("job_scored", {**snapshot(state), "job": job_payload(job)})
                else:
                    # Keep the score the job already has. It stays stale, so the next run tries it again.
                    state["completed"] += 1
                    state["failed"] += 1
                    failures_in_a_row += 1
                    why = reason or ("The profile changed during the call." if version != target_version else "No score came back.")
                    emit("state", {**snapshot(state), "lastError": why})
                    if _rate_limited(reason):
                        state["stopped"] = "Stopped: the provider is still rate limiting. Try again later."
                        return
                    if failures_in_a_row >= MAX_CONSECUTIVE_FAILURES:
                        state["stopped"] = f"Stopped after {MAX_CONSECUTIVE_FAILURES} failures in a row: {why}"
                        return
            finally:
                db.close()
            if index < len(job_ids) - 1:
                sleep(interval)
    finally:
        state["is_running"] = False
        state["current_job"] = ""
        emit("done", snapshot(state, ""))
