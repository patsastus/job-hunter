# Job Hunter

A local-first tool for collecting job ads, scoring how well they fit your profile with an LLM, and tracking
applications. A browser extension sends ads to a FastAPI + SQLite backend; a React frontend is where you review them.
See [SPEC.md](SPEC.md) for the architecture, [backend/README.md](backend/README.md) and
[extension/README.md](extension/README.md) for the parts.

## Security: run it locally only

**The API has no authentication.** Anyone who can reach it can read and edit your profile documents, your saved ads
and your settings, including replacing the LLM API key. The CORS rule only restricts other websites in a browser; it
does not stop `curl`. Keep it bound to your own machine or a trusted private network, and never publish its port to the
internet.

### The LLM API key

- You enter the key in the app's settings page. It is stored in plain text in the `system_settings` table of the SQLite
  database (`backend/jobs.db`), which is git-ignored. It is never read from, or written to, a tracked file.
- `GET /api/settings` returns the key masked (first and last four characters only). The settings page uses a password
  input.
- The key is sent only to the Gemini API, in the `x-goog-api-key` header.
- Treat `jobs.db` like a credential: do not commit it, share it, or put it in a backup you publish. If you ever leak
  the key, revoke it in Google AI Studio and enter a new one.
- Never put the key in a `.env`, compose file or fixture that you commit.

## Run it

```sh
cp .env.example .env     # point VAULT_DIR at your Obsidian vault
docker compose up --build
```

Open <http://localhost>. The bundled Caddy serves the frontend and proxies `/api`. A git-ignored
`docker-compose.override.yml` can disable it if you route through a shared gateway instead.

The extension talks to `http://jobs.test` by default (change it in the extension's settings, or map that name to
127.0.0.1 in `/etc/hosts`).

## License

[MIT](LICENSE)
