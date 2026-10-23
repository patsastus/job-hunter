import json
import re
import requests
from typing import List
from bs4 import BeautifulSoup
from sqlalchemy.orm import Session
import models

# Generic job roles that are search keywords, NOT technical skills
GENERIC_ROLE_EXCLUSIONS = {
    "developer", "software engineer", "engineer", "backend", "back-end",
    "front-end", "frontend", "fullstack", "full stack", "junior", "senior",
    "lead", "architect", "trainee", "intern", "programmer", "specialist",
    "consultant", "manager"
}

# Common tech patterns for fallback extraction when offline or API is unavailable
COMMON_TECH_PATTERNS = [
    # Languages
    r"\bPython\b", r"\bGo\b|\bGolang\b", r"\bC\+\+\b", r"\bC#\b", r"\bRust\b",
    r"\bJava\b", r"\bJavaScript\b", r"\bTypeScript\b", r"\bPHP\b", r"\bRuby\b",
    r"\bKotlin\b", r"\bSwift\b", r"\bDart\b", r"\bBash\b|\bShell\b",
    # Cloud & DevOps
    r"\bAWS\b", r"\bAzure\b", r"\bGCP\b|\bGoogle Cloud\b", r"\bDocker\b",
    r"\bKubernetes\b|\bK8s\b", r"\bTerraform\b", r"\bAnsible\b", r"\bCI/CD\b",
    r"\bGitHub Actions\b", r"\bGitLab\b", r"\bLinux\b", r"\bPrometheus\b", r"\bGrafana\b",
    r"\bGit\b",
    # Databases & Storage
    r"\bPostgreSQL\b|\bPostgres\b", r"\bMySQL\b", r"\bMongoDB\b", r"\bRedis\b",
    r"\bElasticsearch\b", r"\bSQLite\b", r"\bKafka\b", r"\bRabbitMQ\b", r"\bSQL\b",
    # Frameworks & Libraries
    r"\bReact\b", r"\bVue\b", r"\bAngular\b", r"\bNode\.js\b|\bNodejs\b",
    r"\bFastAPI\b", r"\bFlask\b", r"\bDjango\b", r"\bSpring Boot\b|\bSpring\b",
    r"\bFlutter\b", r"\.NET\b|\bdotnet\b", r"\bNext\.js\b",
    # Concepts & Protocols
    r"\bgRPC\b", r"\bREST\b|\bRESTful\b|\bREST APIs\b", r"\bGraphQL\b", r"\bOAuth\b|\bOAuth2\b",
    r"\bMicroservices\b", r"\bAgile\b", r"\bScrum\b", r"\bTDD\b"
]

def ensure_full_description(job: models.Job, db: Session) -> str:
    """
    If the description snippet is truncated or short (< 900 chars),
    and the job is from Duunitori, automatically fetch the full job ad HTML
    and update the database.
    """
    snippet = job.description_snippet or ""
    if len(snippet) < 900 and job.url and "duunitori.fi/tyopaikat/tyo/" in job.url:
        try:
            headers = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"}
            res = requests.get(job.url, headers=headers, timeout=10)
            if res.status_code == 200:
                soup = BeautifulSoup(res.text, "html.parser")
                desc_div = (
                    soup.find("div", class_="description")
                    or soup.find("div", class_="job-description")
                    or soup.find("section", class_="job-description")
                    or soup.find("article")
                )
                if desc_div:
                    full_text = desc_div.get_text("\n", strip=True)
                    if len(full_text) > len(snippet):
                        job.description_snippet = full_text
                        db.commit()
                        db.refresh(job)
                        return full_text
        except Exception:
            pass
    return snippet

def fallback_extract_skills(text: str, custom_keywords: List[str] = None) -> List[str]:
    found = set()
    if not text:
        return []
    
    # Check custom keywords registered in the database (filtering out generic roles)
    if custom_keywords:
        for kw in custom_keywords:
            if kw and kw.lower() not in GENERIC_ROLE_EXCLUSIONS:
                if re.search(r"\b" + re.escape(kw) + r"\b", text, re.IGNORECASE):
                    found.add(kw)

    # Check common tech regex patterns
    for pat in COMMON_TECH_PATTERNS:
        match = re.search(pat, text, re.IGNORECASE)
        if match:
            matched_str = match.group(0)
            # Normalize common synonyms
            if matched_str.lower() == "golang":
                matched_str = "Go"
            elif matched_str.lower() == "k8s":
                matched_str = "Kubernetes"
            elif matched_str.lower() == "postgres":
                matched_str = "PostgreSQL"
            elif matched_str.lower() in ("nodejs", "node.js"):
                matched_str = "Node.js"
            elif matched_str.lower() == "dotnet":
                matched_str = ".NET"
            found.add(matched_str)

    # Final filter to ensure no generic exclusions slipped through
    cleaned = [s for s in found if s.lower() not in GENERIC_ROLE_EXCLUSIONS]
    return sorted(cleaned)

def extract_candidate_skills(job: models.Job, db: Session) -> List[str]:
    """
    Extracts candidate skills from a job posting using LLM (Gemini) if configured,
    falling back to keyword/pattern matching if unavailable.
    """
    # Auto-expand truncated descriptions from the source page
    description = ensure_full_description(job, db)
    text = f"{job.title}\n{job.company}\n{description}"
    
    # Fetch registered keywords from database
    db_keywords = [k.word for k in db.query(models.Keyword).all()]

    # Fetch settings for LLM extraction
    provider_setting = db.query(models.SystemSetting).filter(models.SystemSetting.key == "llm_provider").first()
    key_setting = db.query(models.SystemSetting).filter(models.SystemSetting.key == "api_key").first()
    model_setting = db.query(models.SystemSetting).filter(models.SystemSetting.key == "gemini_model").first()

    provider = provider_setting.value if provider_setting else "gemini"
    api_key = key_setting.value if key_setting else ""
    model_name = model_setting.value if model_setting else "gemini-3.5-flash-lite"

    if api_key and provider == "gemini":
        prompt = f"""You are a technical recruiter. Extract the key technologies, frameworks, programming languages, databases, tools, and methodologies required in this job posting.
Focus strictly on concrete technical skills (e.g., C#, .NET, Python, SQL, REST APIs, Kubernetes, Docker, CI/CD, Azure, AWS, Git).
Do NOT include generic traits or job titles (e.g. do not include 'developer', 'engineer', 'teamwork', 'communication').
Return ONLY a JSON array of skill strings:
["Skill 1", "Skill 2"]

Job Title: {job.title}
Company: {job.company}
Ad Text:
{description}
"""
        try:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent"
            payload = {
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"response_mime_type": "application/json"}
            }
            res = requests.post(url, json=payload, headers={"x-goog-api-key": api_key}, timeout=15)
            res.raise_for_status()
            content = res.json()["candidates"][0]["content"]["parts"][0]["text"]
            skills_list = json.loads(content)
            if isinstance(skills_list, list):
                cleaned = []
                seen_lower = set()
                for s in skills_list:
                    if isinstance(s, str):
                        item = s.strip()
                        if item and item.lower() not in seen_lower and item.lower() not in GENERIC_ROLE_EXCLUSIONS:
                            seen_lower.add(item.lower())
                            cleaned.append(item)
                if cleaned:
                    return cleaned
        except Exception:
            pass

    return fallback_extract_skills(text, db_keywords)
