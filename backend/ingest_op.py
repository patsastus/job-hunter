import json
import sqlite3
import time
import urllib.parse
import urllib.request
import os
from datetime import datetime, timezone
from bs4 import BeautifulSoup

# Resolve DB_PATH whether run from repo root or inside backend container
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(SCRIPT_DIR, 'jobs.db')
API_URL = 'https://op-careers.fi/services/recruiting/v1/jobs'
USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

def fetch_page_jobs(page_num: int):
    payload = json.dumps({
        'keywords': 'Kiitorata2027',
        'locale': 'fi_FI',
        'location': '',
        'pageNumber': page_num,
        'sortBy': 'recent'
    }).encode('utf-8')

    req = urllib.request.Request(
        API_URL,
        headers={'Content-Type': 'application/json', 'User-Agent': USER_AGENT},
        data=payload
    )
    with urllib.request.urlopen(req, timeout=10) as response:
        data = json.loads(response.read().decode('utf-8'))
        return data.get('jobSearchResult', []), data.get('totalJobs', 0)

def fetch_job_description(url: str) -> str:
    try:
        req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
        with urllib.request.urlopen(req, timeout=10) as response:
            html = response.read().decode('utf-8')
            soup = BeautifulSoup(html, 'html.parser')
            desc_el = soup.find(attrs={'itemprop': 'description'})
            if desc_el:
                for tag in desc_el(['script', 'style']):
                    tag.decompose()
                return desc_el.get_text(separator='\n', strip=True)
    except Exception as e:
        print(f"  [!] Warning: Failed to fetch full description from {url}: {e}")
    return ""

def ingest_op_jobs():
    print("=== Starting OP Kiitorata 2027 Job Ingestion ===")
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    total_pages = 4
    all_raw_jobs = []
    total_reported = 0

    for page in range(total_pages):
        print(f"Fetching page {page} from OP API...")
        results, total_count = fetch_page_jobs(page)
        total_reported = total_count
        all_raw_jobs.extend(results)
        time.sleep(0.3)

    print(f"Discovered {len(all_raw_jobs)} job listings (API reports {total_reported} total).")

    inserted_count = 0
    skipped_count = 0

    for idx, item in enumerate(all_raw_jobs, 1):
        resp = item.get('response', {})
        title = resp.get('unifiedStandardTitle', 'Trainee')
        job_id = resp.get('id', '')
        company = (resp.get('legalEntity_obj') or ['OP Pohjola'])[0]
        locations = ', '.join(resp.get('sfstd_jobLocation_obj') or ['Helsinki'])
        published = resp.get('unifiedStandardStart', '')
        deadline = resp.get('unifiedStandardEnd', '')

        # Build canonical OP job URL
        url_title = urllib.parse.quote(title)
        canonical_url = f"https://op-careers.fi/job/{url_title}/{job_id}-fi_FI/"

        # Check if already in DB
        cursor.execute("SELECT id FROM jobs WHERE url = ?", (canonical_url,))
        existing = cursor.fetchone()
        if existing:
            skipped_count += 1
            print(f"[{idx:2d}/{len(all_raw_jobs)}] Already exists: {title}")
            continue

        print(f"[{idx:2d}/{len(all_raw_jobs)}] Fetching details & inserting: {title}...")
        description = fetch_job_description(canonical_url)

        # Store rich description up to 4000 characters for LLM fit evaluation
        snippet = description[:4000] if description else title

        # Format deadline to ISO if matching DD.MM.YYYY
        iso_deadline = None
        if deadline:
            parts = deadline.split('.')
            if len(parts) == 3:
                iso_deadline = f"{parts[2]}-{int(parts[1]):02d}-{int(parts[0]):02d}"
            else:
                iso_deadline = deadline

        now_str = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S.%f')
        cursor.execute("""
            INSERT INTO jobs (title, company, location, published, deadline, description_snippet, url, source, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            title,
            company,
            locations,
            published,
            iso_deadline,
            snippet,
            canonical_url,
            'op_kiitorata_2027',
            'new',
            now_str
        ))
        conn.commit()
        inserted_count += 1
        time.sleep(0.3) # Polite delay

    conn.close()
    print("=" * 50)
    print(f"Ingestion complete!")
    print(f"  Inserted: {inserted_count}")
    print(f"  Already existed: {skipped_count}")
    print(f"  Total processed: {len(all_raw_jobs)}")

if __name__ == '__main__':
    ingest_op_jobs()
