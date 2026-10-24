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

## Docker

The image's environment lives in `/opt/venv`, outside `/app`, because compose bind-mounts `./backend` over
`/app`. The compose file masks `/app/.venv` with an empty volume so that a host `.venv` is not visible in
the container: otherwise uvicorn's reloader polls its ~2,000 files and uses about half a CPU core.
