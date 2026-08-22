# =============================================================================
# Stage 1 — builder
# =============================================================================
# Use the official Python slim image pinned to an exact digest for
# reproducibility and supply-chain security. The tag alone moves with every
# upstream patch release, so it would decide nothing; the digest is what makes
# two builds of this commit the same image. Both stages carry the same one.
# Refresh them together and deliberately — a pin also freezes base-image CVE
# fixes until somebody moves it:
#   docker buildx imagetools inspect python:3.11-slim --format '{{.Manifest.Digest}}'
#
# Pinned 2026-08-22 → python 3.11.16 (index published 2026-08-13).
FROM python:3.11-slim@sha256:9c900dea9e8fb7e16277c179b555cc72d29a352dbc33cff48ad5a0412fd5bfc7 AS builder

# Prevent .pyc files and enable unbuffered stdout/stderr (important for logs)
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /build

# Install OS-level build dependencies required by OR-Tools native extensions.
# These are only needed at build time; they won't appear in the final image.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        gcc \
        g++ \
        cmake \
    && rm -rf /var/lib/apt/lists/*

# Copy and install Python dependencies into a prefix directory so we can
# cleanly copy them to the runtime stage.
COPY requirements.txt .
RUN pip install --upgrade pip \
    && pip install --prefix=/install -r requirements.txt


# =============================================================================
# Stage 2 — runtime
# =============================================================================
# Same digest as the builder stage above — see the note there before changing it.
FROM python:3.11-slim@sha256:9c900dea9e8fb7e16277c179b555cc72d29a352dbc33cff48ad5a0412fd5bfc7 AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH="/app"

# Only install runtime shared libraries that OR-Tools needs (no build tools).
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1001 appgroup \
    && useradd --uid 1001 --gid appgroup --no-create-home --shell /sbin/nologin appuser

# Pull compiled packages from the builder stage
COPY --from=builder /install /usr/local

WORKDIR /app

# Copy application source (excludes everything in .dockerignore)
COPY app/ ./app/

# Drop root privileges before starting the process
USER appuser

# Documentation only, and the default the CMD falls back to. Docker cannot
# expand ${PORT} here, so a platform-injected port will not match this line —
# that is expected and harmless; EXPOSE does not publish or bind anything.
EXPOSE 8000

# Bind ${PORT} when the platform injects one (Railway, Render, Fly, Cloud Run
# all do), falling back to 8000 for docker-compose and local runs.
#
# "sh -c" is required because the exec form does no variable expansion — an
# exec-form ${PORT} is passed to uvicorn as the literal string "${PORT}". The
# leading `exec` then replaces the shell with uvicorn, so uvicorn is still
# PID 1 and still receives SIGTERM directly; without it the shell would hold
# PID 1, swallow the signal, and the container would be SIGKILLed after the
# stop timeout instead of shutting down cleanly.
#
# No --log-config: the application owns logging. app.main:create_app calls
# configure_logging(), which installs structlog's JSON renderer on the root
# logger. Passing "--log-config /dev/null" (as this did previously) does not
# disable uvicorn's logging — uvicorn treats the path as a logging.fileConfig
# file and aborts at startup with "RuntimeError: /dev/null is an empty file",
# so the container never came up at all.
CMD ["sh", "-c", \
     "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1 --no-access-log"]
