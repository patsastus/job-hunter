FROM python:3.12-slim

# uv, pinned. `uv sync --frozen` installs exactly what uv.lock records (like `npm ci`).
COPY --from=ghcr.io/astral-sh/uv:0.13.0 /uv /uvx /bin/

WORKDIR /app

# docker-compose bind-mounts ./backend over /app, so the environment lives outside it. That also keeps
# a host-side .venv (in the mounted folder) from being mistaken for this one.
ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PATH="/opt/venv/bin:$PATH"

COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-dev

# Copy the rest of the application code
COPY . .

# Run the FastAPI server via Uvicorn.
# --timeout-graceful-shutdown: the web app keeps a live-update stream (GET /api/jobs/score-stream) open, and on a
# code reload uvicorn would wait for it to close forever ("Waiting for connections to close"), leaving the whole API
# unresponsive. After 2 s it cancels what is still open and restarts.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--reload", "--timeout-graceful-shutdown", "2"]
