# Job Hunter backend

FastAPI + SQLite. Python 3.12, managed with [uv](https://docs.astral.sh/uv/): the dependencies are declared in
`pyproject.toml` and pinned in `uv.lock`; the environment is `backend/.venv` (git-ignored).

```sh
cd backend
uv sync                 # create .venv and install exactly what uv.lock records
uv run pytest           # run the tests (they use a throwaway database)
uv run uvicorn main:app --reload     # run locally, outside Docker
```

## Dependencies

```sh
uv add <package>             # add a dependency (updates pyproject.toml and uv.lock)
uv add --dev <package>       # add a test/dev-only dependency
uv lock --upgrade            # move everything to the newest allowed versions
uv lock --upgrade-package <package>
uv audit                     # check the locked versions for known vulnerabilities
```

Commit `pyproject.toml` and `uv.lock` together. Docker installs with `uv sync --frozen`, so the image contains
exactly the locked versions; rebuilding the image does not change them. To pick up fixes, run
`uv lock --upgrade`, run the tests, commit, then `docker compose build backend && docker compose up -d --no-deps backend`.

## Cleaning stale entries

`cleanup.py` removes entries that have gone stale. It is a dry run unless you add `--apply`, and `--apply` takes a
consistent backup of the database first.

```sh
cd backend
uv run python cleanup.py                       # report only: what each rule would do, nothing changes
uv run python cleanup.py --list expired        # the rows behind one rule
uv run python cleanup.py --export rows.csv     # every affected row, to look through in a spreadsheet
uv run python cleanup.py --apply               # back up to ~/backups/, then do it
```

| Rule | Matches | Effect |
|---|---|---|
| `expired` | status `new`/`seen`, deadline already passed | delete |
| `stale-new` | status `new`, not seen for more than 30 days, no future deadline, score below 70 (or unscored) | delete |
| `stale-seen` | status `seen` (viewed, never decided) for more than 30 days | delete |
| `compact-rejected` | status `rejected` for more than 14 days | remove the stored ad text; the row stays, so the ad still shows as rejected |
| `orphans` | skill links and URL aliases pointing at deleted jobs, skills nothing uses | delete |

- **Saved and applied jobs are never touched.** Saved/applied jobs whose deadline has passed are listed for your attention.
- A job is counted by the first rule that matches it, so the numbers add up.
- Tune with `--new-older-than DAYS`, `--seen-older-than DAYS`, `--compact-rejected-older-than DAYS` and
  `--keep-score N` (old untriaged jobs scored at least N are spared; the report says how many). A threshold of `0`
  switches that rule off.
- `stale-new` is a heuristic: an ad that old and unseen is very likely gone, but the tool cannot check. It goes by when
  the job was last seen, and the scraper that kept re-seeing ads is stopped.
- To undo, `--apply` prints the exact command: stop the backend, copy the backup over `jobs.db`, start it again.
- It refuses to run when it cannot find `jobs.db` rather than creating an empty one, so run it from the `backend`
  folder of the checkout that holds the database (or set `DATABASE_URL`).

## Re-scoring saved jobs

Every stored score carries `scored_with`, the version of the profile (distilled profile or raw documents, plus the
prompt) that produced it. After the profile changes, saved jobs can be refreshed in one go:

- `GET /api/profile/rescore`: how many saved jobs are stale (`to_rescore`), how many cannot be re-scored because no ad text
  is stored (`no_text`), how many only have a shortened text (`short_text`), the model's pause between calls and an estimate.
- `POST /api/profile/rescore`: start a background run (202), one at a time (409 if running, or nothing to do). Progress goes
  out on the `/api/jobs/score-stream` events (`state`, `job_scored`, `done`, with `failed` and `stopped`).

Only `saved` jobs are touched. A failed call never changes a stored score. The pause follows the model (flash-lite 4.1 s,
flash 12.5 s, gemma 2.1 s, others 6 s); a rate-limit answer waits 60 s and retries once; three failures in a row stop the
run; saving the profile mid-run stops it (a run is for one profile version). Logic is in `rescore.py`.

## Docker

The image's environment lives in `/opt/venv`, outside `/app`, because compose bind-mounts `./backend` over
`/app`. The compose file masks `/app/.venv` with an empty volume so that a host `.venv` is not visible in
the container: otherwise uvicorn's reloader polls its ~2,000 files and uses about half a CPU core.
