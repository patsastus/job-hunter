import json
import os
import sqlite3
import time
import requests

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(SCRIPT_DIR, 'jobs.db')

def score_op_jobs():
    print("=== Starting AI Fit Scoring for OP Kiitorata 2027 Positions ===")
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    # Get API key and model
    cursor.execute("SELECT value FROM system_settings WHERE key='api_key'")
    row = cursor.fetchone()
    if not row or not row[0]:
        print("Error: Gemini API key not found in system_settings.")
        return
    api_key = row[0]

    cursor.execute("SELECT value FROM system_settings WHERE key='gemini_model'")
    model_row = cursor.fetchone()
    model_name = model_row[0] if model_row and model_row[0] else 'gemini-3.5-flash-lite'

    # Get candidate profile documents
    cursor.execute("SELECT title, content FROM profile_documents ORDER BY id ASC")
    docs = cursor.fetchall()
    context_text = "\n\n".join([f"--- {title} ---\n{content}" for title, content in docs])

    # Get all 36 OP jobs
    cursor.execute("""
        SELECT id, title, company, description_snippet, url
        FROM jobs
        WHERE source = 'op_kiitorata_2027'
        ORDER BY id ASC
    """)
    jobs = cursor.fetchall()
    print(f"Found {len(jobs)} OP Kiitorata positions to score.")
    print(f"Using model: {model_name}\n")

    scored_jobs = []

    for idx, (job_id, title, company, snippet, url) in enumerate(jobs, 1):
        prompt = f"""You are an expert technical recruiter matching a candidate to a job.

Candidate Profile:
{context_text}

Job Ad ({company} - {title}):
{snippet}

Evaluate the candidate's fit on a scale of 0 to 100 based on their actual background, skills, completed projects, education, and technologies.
Be realistic, critical, and nuanced:
- 80-100: Strong match with direct overlap in required technologies, role expectations, and profile.
- 50-79: Moderate fit (transferable core skills, but some specific domain or tool gaps).
- 0-49: Low fit (unrelated discipline like corporate law, non-tech finance, marketing, or senior requirements).

Return ONLY valid JSON in this exact format:
{{"score": 85, "reason": "One concise sentence explaining the score and key strengths/gaps."}}
"""

        gemini_url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent"
        payload = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"response_mime_type": "application/json"}
        }

        success = False
        attempts = 0
        score = None
        reason = ""

        while not success and attempts < 3:
            attempts += 1
            try:
                res = requests.post(gemini_url, json=payload, headers={"x-goog-api-key": api_key}, timeout=20)
                if res.status_code == 200:
                    data = res.json()
                    text = data["candidates"][0]["content"]["parts"][0]["text"]
                    parsed = json.loads(text)
                    score = int(parsed.get("score", 0))
                    reason = parsed.get("reason", "")
                    success = True
                elif res.status_code == 429:
                    print(f"  [Rate limit 429 hit. Sleeping 10s before retry {attempts}...]")
                    time.sleep(10)
                else:
                    print(f"  [HTTP {res.status_code}: {res.text[:100]}]")
                    time.sleep(3)
            except Exception as e:
                print(f"  [Request error: {e}]")
                time.sleep(3)

        if success and score is not None:
            cursor.execute("UPDATE jobs SET fit_score = ?, fit_reason = ? WHERE id = ?", (score, reason, job_id))
            conn.commit()
            scored_jobs.append((score, title, company, reason, url))
            print(f"[{idx:2d}/{len(jobs)}] Score: {score:3d}/100 | {title}")
            print(f"         Reason: {reason}\n")
        else:
            print(f"[{idx:2d}/{len(jobs)}] FAILED to score: {title}\n")

        # Sleep 4.1s to respect Gemini Free tier (15 requests/minute)
        time.sleep(4.1)

    conn.close()

    print("\n" + "="*70)
    print("=== FINAL RANKINGS FOR OP KIITORATA 2027 ===")
    print("="*70)
    scored_jobs.sort(key=lambda x: x[0], reverse=True)
    for rank, (score, title, company, reason, url) in enumerate(scored_jobs, 1):
        print(f"#{rank:2d} | Score: {score:3d} | {title} ({company})")
        print(f"     Reason: {reason}")
        print(f"     URL: {url}\n")

if __name__ == '__main__':
    score_op_jobs()
