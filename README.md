# Note Ledger

A private, single-page notebook built with Flask and Supabase. Its structured fields capture architecture notes, command context, failure logs, and optional topology sketches. The service-role key remains on the server; access to the page and API is protected by a password session and CSRF tokens.

## Configure Supabase

1. Create a Supabase project and run [`schema.sql`](schema.sql) in its SQL Editor.
2. Copy the project URL and service-role key from **Project Settings → API**. Never put the service-role key in browser code or commit it to Git.

The table has row-level security enabled, with direct `anon` and `authenticated` table access revoked. The Flask server uses the service-role key to read and write entries.

## Run locally

```sh
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export SECRET_KEY="$(python -c 'import secrets; print(secrets.token_hex(32))')"
export LEDGER_PASSWORD="choose-a-long-unique-password"
export SUPABASE_URL="https://your-project.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
flask --app app run --debug
```

Open the local address printed by Flask. `SUPABASE_KEY` is also accepted as a fallback for `SUPABASE_SERVICE_ROLE_KEY`.

## Deploy to Vercel

Import the repository into Vercel. The included [`vercel.json`](vercel.json) routes requests to the Python function at [`api/index.py`](api/index.py), which exposes the Flask `app` from [`app.py`](app.py). Configure these project environment variables for every environment where the app should run:

- `SECRET_KEY`: a long, random signing key; keep it stable across deployments.
- `LEDGER_PASSWORD`: a strong, unique workspace password.
- `SUPABASE_URL`: the Supabase project URL.
- `SUPABASE_SERVICE_ROLE_KEY`: the Supabase service-role key. `SUPABASE_KEY` may be used instead.

Vercel serves the app over HTTPS, and the session cookie is marked `Secure` there. Do not expose the site publicly without setting all four variables. The Supabase service-role key bypasses row-level security, so keep it only in server-side environment variables.

The list endpoint returns the newest 200 entries. Search filters those loaded entries in the browser. Theme preference is stored in browser local storage, and notes submitted offline or during a temporary server failure are queued there until connectivity returns. Queued requests carry a stable UUID and are upserted, so a retry after an ambiguous response does not create duplicates. Keep browser storage enabled while offline notes are pending; the queue contains the full note and sketch.

Sketches are stored as JPEG data URLs in `sketch_data` at 60% quality to reduce payload size. The API also accepts existing PNG data URLs; each submitted image is size-limited.