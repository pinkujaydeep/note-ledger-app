import hmac
import os
import re
import secrets
import uuid
from functools import wraps

from flask import Flask, jsonify, redirect, render_template, request, session, url_for
from supabase import create_client


app = Flask(__name__)
app.config.update(
    SECRET_KEY=os.getenv("SECRET_KEY") or secrets.token_hex(32),
    MAX_CONTENT_LENGTH=3 * 1024 * 1024,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=bool(os.getenv("VERCEL")),
)

FIELDS = (
    "title",
    "category",
    "blueprint_1",
    "blueprint_2",
    "blueprint_3",
    "syntax_block",
    "failure_symptom",
    "failure_root_cause",
    "failure_mitigation",
    "sketch_data",
)
TEXT_LIMITS = {
    "title": 160,
    "blueprint_1": 1000,
    "blueprint_2": 1000,
    "blueprint_3": 1000,
    "syntax_block": 12000,
    "failure_symptom": 2000,
    "failure_root_cause": 2000,
    "failure_mitigation": 2000,
}
CATEGORIES = {
    "Architecture",
    "CI/CD",
    "Cloud",
    "Containers",
    "Databases",
    "Networking",
    "Observability",
    "Security",
    "Other",
}


def get_supabase():
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_KEY")
    if not url or not key:
        raise RuntimeError("Supabase environment variables are not configured.")
    return create_client(url, key)


def csrf_token():
    if "csrf_token" not in session:
        session["csrf_token"] = secrets.token_urlsafe(32)
    return session["csrf_token"]


def csrf_valid(value):
    expected = session.get("csrf_token", "")
    return bool(expected and value and hmac.compare_digest(expected, value))


def login_required(handler):
    @wraps(handler)
    def wrapped(*args, **kwargs):
        if not session.get("authenticated"):
            if request.path.startswith("/api/"):
                return jsonify(error="Authentication required."), 401
            return redirect(url_for("login"))
        return handler(*args, **kwargs)

    return wrapped


@app.get("/login")
def login():
    return render_template("login.html", csrf_token=csrf_token())


@app.post("/login")
def login_submit():
    configured_password = os.getenv("LEDGER_PASSWORD")
    if not os.getenv("SECRET_KEY") or not configured_password:
        return render_template(
            "login.html",
            csrf_token=csrf_token(),
            error="Set SECRET_KEY and LEDGER_PASSWORD in the deployment environment.",
        ), 503
    if not csrf_valid(request.form.get("csrf_token")):
        return render_template(
            "login.html", csrf_token=csrf_token(), error="Your session expired. Try again."
        ), 400
    supplied_password = request.form.get("password", "")
    if not hmac.compare_digest(supplied_password, configured_password):
        return render_template(
            "login.html", csrf_token=csrf_token(), error="The password was not accepted."
        ), 401
    session.clear()
    session["authenticated"] = True
    csrf_token()
    return redirect(url_for("index"))


@app.post("/logout")
@login_required
def logout():
    if not csrf_valid(request.form.get("csrf_token")):
        return "Invalid request token.", 400
    session.clear()
    return redirect(url_for("login"))


@app.get("/")
@login_required
def index():
    return render_template("index.html", csrf_token=csrf_token())


@app.get("/api/entries")
@login_required
def list_entries():
    try:
        response = (
            get_supabase()
            .table("devops_ledger")
            .select("*")
            .order("created_at", desc=True)
            .limit(200)
            .execute()
        )
    except Exception:
        app.logger.exception("Could not load ledger entries")
        return jsonify(error="The ledger is temporarily unavailable."), 503
    return jsonify(entries=response.data or [])


@app.post("/api/entries")
@login_required
def create_entry():
    if not csrf_valid(request.headers.get("X-CSRF-Token")):
        return jsonify(error="Invalid request token."), 400
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify(error="A JSON object is required."), 400

    entry = {field: payload.get(field, "") for field in FIELDS}
    entry_id = payload.get("id")
    if entry_id is not None:
        if not isinstance(entry_id, str):
            return jsonify(error="The entry identifier is invalid."), 400
        try:
            entry["id"] = str(uuid.UUID(entry_id))
        except ValueError:
            return jsonify(error="The entry identifier is invalid."), 400
    if entry["sketch_data"] is None:
        entry["sketch_data"] = ""
    for field, limit in TEXT_LIMITS.items():
        value = entry[field]
        if not isinstance(value, str) or len(value) > limit:
            return jsonify(error=f"{field.replace('_', ' ').title()} is invalid or too long."), 400
        entry[field] = value.strip()
    if not entry["title"]:
        return jsonify(error="A title is required."), 400
    if not isinstance(entry["category"], str) or entry["category"].strip() not in CATEGORIES:
        return jsonify(error="Choose a valid category."), 400
    entry["category"] = entry["category"].strip()

    sketch = entry["sketch_data"]
    if not isinstance(sketch, str):
        return jsonify(error="The sketch image format is invalid."), 400
    if sketch:
        if len(sketch) > 2_500_000:
            return jsonify(error="The sketch is too large."), 400
        if not re.fullmatch(r"data:image/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}", sketch):
            return jsonify(error="The sketch image format is invalid."), 400

    try:
        table = get_supabase().table("devops_ledger")
        query = table.upsert(entry, on_conflict="id") if "id" in entry else table.insert(entry)
        response = query.execute()
    except Exception:
        app.logger.exception("Could not save ledger entry")
        return jsonify(error="The entry could not be saved."), 503
    if not response.data:
        return jsonify(error="The entry could not be saved."), 503
    return jsonify(entry=response.data[0]), 201