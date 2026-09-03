#!/usr/bin/env bash
set -Eeuo pipefail

# ============================================================
# SpiderPanel VPS Installer / Starter
# Repository:
# https://github.com/amirh00sain/SpiderPanel
# ============================================================

APP_DIR="/opt/SpiderPanel"
REPO="https://github.com/amirh00sain/SpiderPanel.git"
SERVICE_NAME="spider-panel"
PYTHON_BIN="python3"

echo
echo "=========================================="
echo "        SPIDER PANEL VPS INSTALLER"
echo "=========================================="
echo

# ------------------------------------------------------------
# Root
# ------------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
    echo "[!] Run this script as root:"
    echo "    sudo bash start.sh"
    exit 1
fi

# ------------------------------------------------------------
# Detect package manager
# ------------------------------------------------------------
if command -v apt-get >/dev/null 2>&1; then
    PKG="apt-get"

    echo "[+] Updating packages..."
    apt-get update

    echo "[+] Installing dependencies..."
    apt-get install -y \
        git \
        curl \
        ca-certificates \
        python3 \
        python3-venv \
        python3-pip \
        build-essential \
        gcc \
        make \
        openssl \
        unzip \
        procps \
        iproute2 \
        net-tools \
        ping

elif command -v dnf >/dev/null 2>&1; then
    PKG="dnf"

    echo "[+] Installing dependencies..."
    dnf install -y \
        git \
        curl \
        ca-certificates \
        python3 \
        python3-pip \
        gcc \
        gcc-c++ \
        make \
        openssl \
        unzip \
        procps-ng \
        iproute \
        net-tools \
        iputils

elif command -v yum >/dev/null 2>&1; then
    PKG="yum"

    echo "[+] Installing dependencies..."
    yum install -y \
        git \
        curl \
        ca-certificates \
        python3 \
        python3-pip \
        gcc \
        gcc-c++ \
        make \
        openssl \
        unzip \
        procps \
        iproute \
        net-tools \
        iputils

else
    echo "[!] Unsupported Linux distribution."
    exit 1
fi

# ------------------------------------------------------------
# Create application directory
# ------------------------------------------------------------
echo "[+] Preparing application directory..."

if [ -d "$APP_DIR/.git" ]; then
    echo "[+] Existing SpiderPanel installation found."
    cd "$APP_DIR"

    echo "[+] Updating repository..."
    git fetch --all
    git reset --hard origin/main
else
    echo "[+] Cloning SpiderPanel..."
    rm -rf "$APP_DIR"
    git clone "$REPO" "$APP_DIR"
    cd "$APP_DIR"
fi

# ------------------------------------------------------------
# Create persistent directories
# ------------------------------------------------------------
echo "[+] Creating data directories..."

mkdir -p "$APP_DIR/data"
mkdir -p "$APP_DIR/data/scanned"
mkdir -p "$APP_DIR/xray"

# ------------------------------------------------------------
# Python virtual environment
# ------------------------------------------------------------
echo "[+] Creating Python virtual environment..."

if [ ! -d "$APP_DIR/.venv" ]; then
    "$PYTHON_BIN" -m venv "$APP_DIR/.venv"
fi

source "$APP_DIR/.venv/bin/activate"

echo "[+] Upgrading pip..."
python -m pip install --upgrade pip setuptools wheel

# ------------------------------------------------------------
# Install Python dependencies
# ------------------------------------------------------------
echo "[+] Installing SpiderPanel requirements..."

python -m pip install -r "$APP_DIR/requirements.txt"

# ------------------------------------------------------------
# Validate Python files
# ------------------------------------------------------------
echo "[+] Checking Python files..."

python -m py_compile \
    main.py \
    telegram_proxy.py \
    relay_vless.py \
    shared.py \
    pages.py \
    xhttp_siz10.py

# ------------------------------------------------------------
# Environment file
# ------------------------------------------------------------
ENV_FILE="/etc/spider-panel.env"

if [ ! -f "$ENV_FILE" ]; then
    echo "[+] Creating environment file..."

    SECRET_KEY="$(python - <<'PY'
import secrets
print(secrets.token_urlsafe(48))
PY
)"

    ADMIN_PASSWORD="$(python - <<'PY'
import secrets
print(secrets.token_urlsafe(16))
PY
)"

    cat > "$ENV_FILE" <<EOF
# SpiderPanel environment

ADMIN_PASSWORD=$ADMIN_PASSWORD
SECRET_KEY=$SECRET_KEY

DATA_DIR=$APP_DIR/data

# SpiderPanel currently uses port 8080 internally.
PORT=8080

# VPS domain/IP can be configured inside the panel.
RAILWAY_PUBLIC_DOMAIN=

WORKER_SYNC_INTERVAL=3600
EOF

    chmod 600 "$ENV_FILE"

    echo
    echo "=========================================="
    echo " INITIAL ADMIN PASSWORD"
    echo "=========================================="
    echo "$ADMIN_PASSWORD"
    echo "=========================================="
    echo
    echo "[!] Save this password."
    echo
else
    echo "[+] Existing environment file preserved."
fi

# ------------------------------------------------------------
# Permissions
# ------------------------------------------------------------
echo "[+] Setting permissions..."

chmod +x "$APP_DIR/run.sh" 2>/dev/null || true

chown -R root:root "$APP_DIR"

chmod 700 "$APP_DIR/data"
chmod 700 "$APP_DIR/data/scanned"

# ------------------------------------------------------------
# Systemd service
# ------------------------------------------------------------
echo "[+] Creating systemd service..."

cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=SpiderPanel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple

User=root
Group=root

WorkingDirectory=$APP_DIR

EnvironmentFile=$ENV_FILE

Environment=PYTHONUNBUFFERED=1
Environment=PYTHONDONTWRITEBYTECODE=1
Environment=PIP_NO_CACHE_DIR=1

ExecStart=$APP_DIR/.venv/bin/uvicorn main:app --host 0.0.0.0 --port 8080

Restart=always
RestartSec=5

TimeoutStartSec=120
TimeoutStopSec=30

KillMode=mixed

[Install]
WantedBy=multi-user.target
EOF

# ------------------------------------------------------------
# Reload systemd
# ------------------------------------------------------------
echo "[+] Reloading systemd..."

systemctl daemon-reload

systemctl enable "$SERVICE_NAME"

# ------------------------------------------------------------
# Start / restart
# ------------------------------------------------------------
echo "[+] Starting SpiderPanel..."

systemctl restart "$SERVICE_NAME"

sleep 3

# ------------------------------------------------------------
# Status
# ------------------------------------------------------------
echo
echo "=========================================="
echo "        SPIDER PANEL STATUS"
echo "=========================================="

if systemctl is-active --quiet "$SERVICE_NAME"; then
    echo "[+] SpiderPanel is RUNNING"
else
    echo "[!] SpiderPanel failed to start."
    echo
    echo "Last logs:"
    journalctl -u "$SERVICE_NAME" -n 80 --no-pager
    exit 1
fi

# ------------------------------------------------------------
# Detect public IP
# ------------------------------------------------------------
SERVER_IP="$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"

echo
echo "=========================================="
echo "             INSTALLATION DONE"
echo "=========================================="

if [ -n "$SERVER_IP" ]; then
    echo
    echo "Panel:"
    echo "http://$SERVER_IP:8080/spider"
fi

echo
echo "Service:"
echo "systemctl status $SERVICE_NAME"

echo
echo "Logs:"
echo "journalctl -u $SERVICE_NAME -f"

echo
echo "Restart:"
echo "systemctl restart $SERVICE_NAME"

echo
echo "Environment:"
echo "$ENV_FILE"

echo
echo "Application:"
echo "$APP_DIR"

echo
echo "=========================================="