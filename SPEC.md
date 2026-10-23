# Job Hunter OS: Architecture Spec

Since you want to keep your CVs and personal data local while having a smooth, web-like experience for reviewing jobs, the best approach is a **Local-First Web Architecture**. 

Instead of hosting a server on the open internet, you run a lightweight backend on your own machine. Your browser interacts with it just like a normal website, but all data stays on your hard drive.

Here is the proposed separation of concerns:

## 1. The Collectors (Data Ingestion)
Getting job postings into your system reliably.

*   **The Browser Extension (For LinkedIn / Authenticated sites):** We expand your existing Chrome extension. Instead of downloading a Markdown file, clicking "Scrape" (or having it auto-scrape in the background) sends a hidden `POST` request to `http://localhost:8000/api/jobs`. This perfectly bypasses LinkedIn's bot protections because it uses your live browser session.
*   **The Headless Scraper (For Open sites):** A local Python or Go script that runs on a cron job (e.g., twice a day). It fetches RSS feeds or scrapes public APIs from Duunitori, Oikotie, and Työmarkkinatori directly in the background and saves them to your database.

## 2. The Brain (Local Backend)
A lightweight server running on your machine (e.g., Python FastAPI or a Go API).

*   **Database:** A local SQLite database (`jobs.db`) storing job descriptions, URLs, status (New, Saved, Applied, Rejected), and LLM fit scores.
*   **The AI Engine:** When a new job is ingested, the backend reads your local `cv_15_en.tex` and `projects.tex`, bundles them with the job description, and calls an LLM API (like OpenAI or Gemini) to generate a **Fit Score (1-100)** and a 2-sentence summary of *why* it fits.
*   **The Generator:** An endpoint that, when triggered, generates a tailored Cover Letter and a tweaked LaTeX CV, and automatically compiles them using `pdflatex` in a temporary local folder.

## 3. The Dashboard (Local UI)
A React or plain HTML/JS frontend served by your local backend. You access it by going to `http://localhost:8000` in your browser.

*   **Triage View (Tinder for Jobs):** A list of new jobs sorted strictly by the AI Fit Score. You quickly click "Save" or "Reject".
*   **Pipeline View (Kanban):** Columns for "Saved", "Tailoring", "Applied". 
*   **Action Panel:** When you click a saved job, you see the AI's fit analysis. You can click a button that says "Generate Application", which triggers the Backend Generator to output the PDF files directly to your hard drive.

---

## Interaction Flow
1. **Background:** Your local script grabs 50 new jobs from Oikotie overnight.
2. **Morning:** You browse LinkedIn, see a cool job, click the Extension button to beam it to your local database.
3. **Coffee Time:** You open `localhost:8000`. You see 51 new jobs, ranked. The top 3 are a >90% fit. 
4. **Action:** You hit "Generate Application" on the top one. Your local backend reads your LaTeX, talks to the LLM, and drops a customized `coverletter.pdf` onto your Desktop, ready to send.
