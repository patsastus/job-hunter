import time
import requests
from sqlalchemy.orm import Session
from database import SessionLocal
from models import Job, Keyword

def scrape_duunitori():
    print("Scraping Duunitori...")
    
    db: Session = SessionLocal()
    try:
        db_keywords = db.query(Keyword).all()
        keywords = [k.word for k in db_keywords]
        if not keywords:
            keywords = ["developer", "software engineer", "backend", "go", "python"]
            
        for keyword in keywords:
            url = f"https://duunitori.fi/api/v1/jobentries?search={keyword}"
            print(f"Fetching {url}")
            response = requests.get(url)
            
            if response.status_code != 200:
                print(f"Failed to fetch {keyword}: {response.status_code}")
                continue
                
            data = response.json()
            results = data.get("results", [])
            
            for item in results:
                job_url = f"https://duunitori.fi/tyopaikat/tyo/{item.get('slug')}"
                
                # Check if exists
                exists = db.query(Job).filter(Job.url == job_url).first()
                if exists:
                    continue
                
                # Create job
                new_job = Job(
                    title=item.get("heading", "Unknown"),
                    company=item.get("company_name", "Unknown"),
                    location=item.get("municipality_name", ""),
                    published=item.get("date_posted", "")[:10], # Just the date part
                    description_snippet=item.get("descr", "")[:800],
                    url=job_url,
                    source="duunitori_auto"
                )
                db.add(new_job)
            
            db.commit()
            time.sleep(2) # be polite to their API
            
    except Exception as e:
        print(f"Duunitori Scraper Error: {e}")
    finally:
        db.close()

def run_scraper_loop():
    print("Job Hunter Auto-Scraper Daemon Started.")
    while True:
        print("Starting scrape cycle...")
        scrape_duunitori()
        print("Scrape cycle complete. Sleeping for 12 hours.")
        time.sleep(12 * 3600)

if __name__ == "__main__":
    run_scraper_loop()
