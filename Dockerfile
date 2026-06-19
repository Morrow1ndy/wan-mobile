FROM python:3.12-slim

WORKDIR /app

# Install Python deps first so they cache across code changes.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the whole project (.dockerignore trims .venv/.git/etc).
COPY . .

# Keep a pristine copy of the seed data. At runtime a Fly volume mounts over
# /app/data (empty on first boot), so we seed it from here in the CMD below.
RUN cp -r /app/data /app/seed-data

EXPOSE 8000

# Seed any missing data files onto the (possibly empty) volume, then serve.
CMD ["sh", "-c", "mkdir -p /app/data/saved_videos; for f in last_params.json generation_durations.json saved_videos.json prompt_templates.json generation_params.json param_presets.json; do [ -f \"/app/data/$f\" ] || cp \"/app/seed-data/$f\" \"/app/data/$f\" 2>/dev/null || true; done; exec uvicorn app.main:app --host 0.0.0.0 --port 8000"]
