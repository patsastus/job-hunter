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

## Docker

The image's environment lives in `/opt/venv`, outside `/app`, because compose bind-mounts `./backend` over
`/app`. The compose file masks `/app/.venv` with an empty volume so that a host `.venv` is not visible in
the container: otherwise uvicorn's reloader polls its ~2,000 files and uses about half a CPU core.
