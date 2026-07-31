#!/usr/bin/env bash
#
# automation.eyan.fyi installer — idempotent, zero-downtime, rollback-on-failure.
#
# Fronts the already-running n8n container (deployed separately via
# `docker compose up -d` — see docker-compose.yml) with the host's existing
# nginx + certbot, following the exact same pattern already proven for
# code.eyan.fyi. This script only ever manages nginx/certbot state for
# automation.eyan.fyi — it never touches eyan.fyi or code.eyan.fyi, and it
# never starts/stops/builds the n8n stack itself.
#
# Order of operations (matches the numbered steps below):
#   1. Validate prerequisites (docker, nginx, certbot, DNS via public
#      resolvers, n8n container health, directories) — abort before
#      touching anything if any check fails.
#   2. Install an HTTP-only nginx bootstrap for automation.eyan.fyi (port 80,
#      no SSL directives — referencing a certificate file that doesn't exist
#      yet is what breaks `nginx -t` on first bootstrap).
#   3. Obtain a Let's Encrypt certificate via the webroot plugin. Webroot
#      never stops or reloads nginx and doesn't require nginx to already
#      know about SSL for this domain — zero-downtime by construction.
#   4. Verify the certificate files actually exist and are valid before
#      proceeding.
#   5. Swap in the final HTTPS config (only possible now that the files it
#      references exist), verify with `nginx -t`, reload.
#   6. Run health checks (nginx, HTTPS reachability, HTTP->HTTPS redirect,
#      websocket upgrade, n8n page reachable).
#
# Every step that mutates host state is written to be idempotent: re-running
# this script after a partial failure resumes safely without duplicating
# nginx configs, symlinks, or certificates, and without ever touching
# /etc/nginx/sites-available/eyan.fyi or code.eyan.fyi (the other
# production sites on this host) or their certificates.
#
# Usage:
#   ./scripts/install.sh              # normal run
#   ./scripts/install.sh --debug      # full command tracing (same as DEBUG=1)
#   DEBUG=1 ./scripts/install.sh      # equivalent to --debug
#
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

mkdir -p "$PROJECT_DIR/docker/logs"
LOG_FILE="$PROJECT_DIR/docker/logs/install-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG_FILE") 2>&1

DOMAIN=automation.eyan.fyi
WEBROOT=/var/www/certbot
BACKUP_DIR=/etc/nginx/backups   # never inside sites-available/ or sites-enabled/
NGINX_SITE_FILE=/etc/nginx/sites-available/automation.eyan.fyi
NGINX_SITE_LINK=/etc/nginx/sites-enabled/automation.eyan.fyi
BOOTSTRAP_SRC="$PROJECT_DIR/docker/nginx/bootstrap.automation.eyan.fyi.conf"
HTTPS_SRC="$PROJECT_DIR/docker/nginx/https.automation.eyan.fyi.conf"
N8N_PORT=5678

for arg in "$@"; do
    case "$arg" in
        --debug) DEBUG=1 ;;
        *) echo "Unknown flag: $arg (supported: --debug)" >&2; exit 1 ;;
    esac
done

enable_debug_mode
log_info "automation.eyan.fyi installer starting. Log: $LOG_FILE"
[[ "$DEBUG" == "1" ]] && log_info "DEBUG mode: full command tracing is on (verbose)."

# --- Rollback bookkeeping --------------------------------------------------
# Each mutating step pushes its own inverse command here. On any failure
# (ERR trap) everything pushed so far is undone in reverse order. Steps
# that detect a resource already existed (idempotent no-op) do NOT push a
# rollback action for it — a rerun must never undo state from a previous,
# already-successful run.
ROLLBACK_ACTIONS=()
push_rollback() { ROLLBACK_ACTIONS+=("$1"); log_debug "Registered rollback action: $1"; }

# eval is used deliberately below to run the registered rollback commands.
# This is safe here specifically because every string ever pushed via
# push_rollback is built entirely from this script's own fixed paths and
# constants — never from .env contents, command output, or any other
# external/attacker-influenced input.
rollback() {
    local exit_code=$? line="${1:-?}" failed_cmd="${2:-<unknown>}"
    trap - ERR
    stop_sudo_keepalive
    log_error "Install FAILED (exit $exit_code) at scripts/install.sh:$line"
    log_error "Failing command: $failed_cmd"
    log_error "Full run log: $LOG_FILE (re-run with --debug for full command tracing)"
    if [[ ${#ROLLBACK_ACTIONS[@]} -eq 0 ]]; then
        log_info "No changes were made by this run — nothing to roll back."
        exit "$exit_code"
    fi
    log_warn "Rolling back ${#ROLLBACK_ACTIONS[@]} change(s) made by this run..."
    local i
    for (( i=${#ROLLBACK_ACTIONS[@]}-1; i>=0; i-- )); do
        log_warn "  undo: ${ROLLBACK_ACTIONS[i]}"
        eval "${ROLLBACK_ACTIONS[i]}" || log_error "  (this rollback step itself failed — continuing with the rest)"
    done
    log_error "Rollback complete. eyan.fyi and code.eyan.fyi were not modified by this script."
    exit "$exit_code"
}
trap 'rollback "$LINENO" "$BASH_COMMAND"' ERR
trap 'stop_sudo_keepalive' EXIT

fail() { log_error "$*"; exit 1; }

# ============================================================================
log_step "STEP 1/6 — Validating prerequisites"
# ============================================================================
STEP1_SUMMARY=()
note_ok() { STEP1_SUMMARY+=("$1"); log_success "$1"; }

[[ -f .env ]] || fail "Missing .env — run: cp .env.example .env, fill it in, then re-run."
note_ok ".env present"

CERTBOT_EMAIL="$(get_env_var CERTBOT_EMAIL)"
[[ -n "$CERTBOT_EMAIL" ]] || fail "CERTBOT_EMAIL validation failed: not set (or empty) in .env. Fix: add CERTBOT_EMAIL=you@example.com to .env (required for Let's Encrypt registration)."
note_ok ".env has CERTBOT_EMAIL"

check_command docker  || fail "Docker validation failed: 'docker' not found on PATH."
note_ok "docker installed"
docker compose version >/dev/null 2>&1 || fail "Docker Compose validation failed: 'docker compose' plugin not available."
note_ok "docker compose plugin available"
check_command nginx   || fail "Nginx validation failed: 'nginx' not found on PATH. Fix: this installer assumes it manages the existing eyan.fyi/code.eyan.fyi production sites already."
note_ok "nginx installed"
check_command certbot || fail "Certbot validation failed: 'certbot' not found on PATH."
note_ok "certbot installed"
check_command dig     || fail "DNS tooling validation failed: 'dig' not found on PATH. Fix: install dnsutils (e.g. 'sudo apt install dnsutils')."
note_ok "dig installed"
check_command openssl || fail "TLS tooling validation failed: 'openssl' not found on PATH."
note_ok "openssl installed"
check_command ss      || fail "Networking tooling validation failed: 'ss' not found on PATH."
note_ok "ss installed"
check_service nginx   || fail "Nginx service validation failed: nginx is installed but not currently running. Fix: this installer assumes the existing production nginx is already up (it only ever reloads it, never starts/stops it) — start it yourself first: 'sudo systemctl start nginx', confirm eyan.fyi/code.eyan.fyi still serve correctly, then re-run."
note_ok "nginx service is active"

[[ -f "$BOOTSTRAP_SRC" ]] || fail "Missing $BOOTSTRAP_SRC — this repo checkout is incomplete."
[[ -f "$HTTPS_SRC" ]] || fail "Missing $HTTPS_SRC — this repo checkout is incomplete."
note_ok "nginx templates present"

# n8n is deployed separately (docker-compose.yml, Milestone 2) — this
# installer only fronts it, it never starts/builds it.
n8n_health="$(docker inspect -f '{{.State.Health.Status}}' eyan-n8n 2>/dev/null || echo missing)"
[[ "$n8n_health" == "healthy" ]] || fail "n8n container validation failed: eyan-n8n is '$n8n_health', expected 'healthy'. Fix: run 'docker compose up -d' from the repo root first, wait for it to report healthy, then re-run this script."
note_ok "eyan-n8n container is healthy"

if port_in_use "$N8N_PORT"; then
    bound="$(ss -ltn 2>/dev/null | awk -v p=":${N8N_PORT}" 'index($4,p)==length($4)-length(p)+1 {print $4}' | head -1)"
    [[ "$bound" == 127.0.0.1:* || "$bound" == "[::1]:${N8N_PORT}" ]] || fail "Port validation failed: something is listening on ${N8N_PORT} on ${bound}, not loopback-only. Fix: n8n must be bound to 127.0.0.1:${N8N_PORT} (see docker-compose.yml) before it's safe to front with a public vhost."
    note_ok "n8n is bound to loopback only (${bound})"
else
    fail "Port validation failed: nothing is listening on ${N8N_PORT} — expected eyan-n8n to be publishing there."
fi

public_ip=$(curl -fsS -4 --max-time 5 ifconfig.me) || fail "Public IP lookup failed: could not reach ifconfig.me. Fix: check this host's outbound internet access, then re-run."
log_info "Public IP: $public_ip"

resolved_ip=$(validate_dns "$DOMAIN" "$public_ip") || fail "DNS validation failed: $DOMAIN resolves to '${resolved_ip:-nothing}' via public resolvers (1.1.1.1/8.8.8.8), expected $public_ip. Fix: add/correct the A record for $DOMAIN at your DNS provider, wait for propagation, then re-run."
note_ok "DNS: $DOMAIN -> $resolved_ip (matches this host)"

require_sudo_session || exit 1
note_ok "sudo access confirmed"
start_sudo_keepalive

log_step "STEP 1/6 summary — all checks passed"
for item in "${STEP1_SUMMARY[@]}"; do
    printf '    %s✓%s %s\n' "$C_GRN" "$C_RST" "$item" >&2
done

# ============================================================================
# STEPS 2-5 — nginx bootstrap, certificate, verification, HTTPS swap.
# Skipped in full (zero-downtime no-op) when the HTTPS config is already
# active AND the certificate is already valid — a routine rerun on an
# already-healthy install doesn't touch nginx/certbot at all.
# ============================================================================

ensure_webroot() {
    if [[ ! -d "$WEBROOT" ]]; then
        sudo mkdir -p "$WEBROOT/.well-known/acme-challenge"
        push_rollback "sudo rmdir '$WEBROOT/.well-known/acme-challenge' '$WEBROOT/.well-known' '$WEBROOT' 2>/dev/null || true"
        log_info "Created ACME webroot at $WEBROOT"
    else
        log_info "ACME webroot $WEBROOT already exists (shared with code.eyan.fyi) — reusing."
    fi
}

# Idempotently installs $1 (a template) as the single canonical
# /etc/nginx/sites-available/automation.eyan.fyi, backing up whatever was
# there before (outside sites-enabled/sites-available — see BACKUP_DIR) and
# registering rollback for it. No-ops if content is already identical.
install_nginx_conf() {
    local src="$1" label="$2"

    if [[ -f "$NGINX_SITE_FILE" ]] && cmp -s "$src" "$NGINX_SITE_FILE"; then
        log_info "$label config already active and unchanged — skipping."
    else
        if [[ -f "$NGINX_SITE_FILE" ]]; then
            sudo mkdir -p "$BACKUP_DIR"
            local backup="$BACKUP_DIR/automation.eyan.fyi.$(date +%Y%m%d%H%M%S).bak"
            sudo cp "$NGINX_SITE_FILE" "$backup"
            log_info "Backed up previous config to $backup (not inside sites-enabled/available)"
            push_rollback "sudo cp '$backup' '$NGINX_SITE_FILE' && sudo nginx -t && sudo systemctl reload nginx"
        else
            push_rollback "sudo rm -f '$NGINX_SITE_FILE'"
        fi
        sudo cp "$src" "$NGINX_SITE_FILE"
        log_info "Installed $label config to $NGINX_SITE_FILE"
    fi

    if [[ ! -L "$NGINX_SITE_LINK" ]] || [[ "$(readlink -f "$NGINX_SITE_LINK" 2>/dev/null)" != "$(readlink -f "$NGINX_SITE_FILE")" ]]; then
        [[ ! -e "$NGINX_SITE_LINK" ]] && push_rollback "sudo rm -f '$NGINX_SITE_LINK'"
        sudo ln -sf "$NGINX_SITE_FILE" "$NGINX_SITE_LINK"
        log_info "Enabled $NGINX_SITE_LINK -> $NGINX_SITE_FILE"
    else
        log_info "Site already enabled — skipping symlink."
    fi

    validate_nginx || fail "$label config failed nginx -t (see nginx's own error above) — rolling back to the previous config."
    if ! sudo systemctl reload nginx; then
        fail "nginx -t passed but 'systemctl reload nginx' failed — this is unusual; check 'sudo systemctl status nginx' and 'sudo journalctl -u nginx -n 50' by hand before re-running."
    fi
    log_success "$label config active (nginx reloaded, not restarted)"
}

ensure_certificate() {
    if validate_certificate "$DOMAIN"; then
        log_info "Valid certificate for $DOMAIN already exists — skipping issuance."
        return 0
    fi
    log_info "Requesting certificate for $DOMAIN via webroot (nginx is never stopped for this)..."
    local certbot_out
    if ! certbot_out=$(sudo certbot certonly \
            --webroot -w "$WEBROOT" \
            -d "$DOMAIN" \
            --non-interactive --agree-tos \
            -m "$CERTBOT_EMAIL" --no-eff-email \
            --keep-until-expiring 2>&1); then
        printf '%s\n' "$certbot_out" >&2
        fail "Certbot validation failed: certificate issuance failed for $DOMAIN (full certbot output above). Common causes: DNS not fully propagated yet, the webroot ACME path isn't reachable over plain HTTP (test with: curl -I http://$DOMAIN/.well-known/acme-challenge/test), or Let's Encrypt rate limits (check https://letsencrypt.org/docs/rate-limits/). Fix the cause, then re-run — issuance will be retried, nothing else is affected."
    fi
    printf '%s\n' "$certbot_out"
    push_rollback "sudo certbot delete --cert-name '$DOMAIN' --non-interactive || true"
    validate_certificate "$DOMAIN" || fail "Certbot reported success but $DOMAIN certificate files are missing or invalid under /etc/letsencrypt/live/$DOMAIN/ — inspect that directory by hand."
    log_success "Certificate issued for $DOMAIN"
}

if [[ -f "$NGINX_SITE_FILE" ]] && cmp -s "$HTTPS_SRC" "$NGINX_SITE_FILE" && validate_certificate "$DOMAIN"; then
    log_step "STEPS 2-5/6 — HTTPS already fully configured and certificate valid, skipping (zero-downtime no-op)"
else
    log_step "STEP 2/6 — Installing HTTP-only nginx bootstrap"
    ensure_webroot
    install_nginx_conf "$BOOTSTRAP_SRC" "HTTP bootstrap"

    log_step "STEP 3/6 — Obtaining Let's Encrypt certificate"
    ensure_certificate

    log_step "STEP 4/6 — Verifying certificate"
    validate_certificate "$DOMAIN" || fail "Certificate verification failed after issuance — /etc/letsencrypt/live/$DOMAIN/{fullchain,privkey}.pem missing or expiring within 24h."
    [[ -f /etc/letsencrypt/options-ssl-nginx.conf ]] || fail "Missing /etc/letsencrypt/options-ssl-nginx.conf (expected to already exist from eyan.fyi's own certbot setup)."
    [[ -f /etc/letsencrypt/ssl-dhparams.pem ]] || fail "Missing /etc/letsencrypt/ssl-dhparams.pem. Fix: generate one with 'sudo openssl dhparam -out /etc/letsencrypt/ssl-dhparams.pem 2048' (takes a minute), then re-run."
    log_success "Certificate present and valid at /etc/letsencrypt/live/$DOMAIN/"

    log_step "STEP 5/6 — Switching nginx to the final HTTPS config"
    install_nginx_conf "$HTTPS_SRC" "HTTPS production"
fi

# ============================================================================
# STEP 6/6 — Health checks.
#
# The ERR trap is intentionally removed before this point (set -e itself
# stays on, but nothing here runs as a bare unguarded statement — every
# check is invoked via `if "$@"; then`, which POSIX/bash exempts from
# set -e for the check's entire execution). A transient health-check
# hiccup should not tear down an otherwise-correct nginx config and
# certificate — doing so would also risk needlessly burning Let's
# Encrypt's issuance rate limit on the next rerun. Failures here are
# reported clearly and exit non-zero, but leave infrastructure in place
# for you to inspect and retry.
# ============================================================================
trap - ERR
log_step "STEP 6/6 — Health checks"

HEALTH_FAILED=0
check_health() {
    local desc="$1"; shift
    if "$@"; then
        log_success "$desc"
    else
        log_error "$desc — FAILED"
        HEALTH_FAILED=1
    fi
}

check_health "nginx is active" check_service nginx

check_https_reachable() {
    local resp status_line code
    resp=$(http_probe "https://$DOMAIN/")
    status_line="${resp%%$'\r'$'\n'*}"
    [[ "$status_line" == "$resp" ]] && status_line="${resp%%$'\n'*}"
    code=$(printf '%s' "$status_line" | awk '{print $2}')
    [[ "$code" == "200" || "$code" == "302" ]]
}
check_health "HTTPS reachable (https://$DOMAIN returns 200/302)" check_https_reachable

check_http_redirects() {
    local resp status_line code location
    resp=$(curl -ks -i --max-time 10 "http://$DOMAIN/" 2>/dev/null) || resp=""
    status_line="${resp%%$'\r'$'\n'*}"
    [[ "$status_line" == "$resp" ]] && status_line="${resp%%$'\n'*}"
    code=$(printf '%s' "$status_line" | awk '{print $2}')
    location=$(printf '%s' "$resp" | tr -d '\r' | awk -F': ' 'tolower($1)=="location" {print $2; exit}')
    [[ "$code" == "301" && "$location" == "https://$DOMAIN/" ]]
}
check_health "HTTP redirects to HTTPS (http://$DOMAIN -> 301)" check_http_redirects

check_websocket_upgrade() {
    local resp
    resp=$(curl -ks -i --max-time 10 \
        -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
        -H 'Sec-WebSocket-Version: 13' \
        -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" \
        "https://$DOMAIN/" 2>/dev/null) || resp=""
    local first_line="${resp%%$'\r'$'\n'*}"
    [[ "$first_line" == "$resp" ]] && first_line="${resp%%$'\n'*}"
    [[ "$first_line" != *"502"* && "$first_line" != *"504"* && "$first_line" != *"400"* ]]
}
check_health "Websocket upgrade not blocked at the proxy" check_websocket_upgrade

check_n8n_page() {
    local resp
    resp=$(http_probe "https://$DOMAIN/")
    [[ "$resp" == *"n8n"* ]]
}
check_health "n8n page reachable" check_n8n_page

check_existing_sites_unaffected() {
    local eyan_code
    eyan_code=$(curl -ks -o /dev/null -w '%{http_code}' --max-time 10 "https://eyan.fyi/" 2>/dev/null) || eyan_code="000"
    local code_code
    code_code=$(curl -ks -o /dev/null -w '%{http_code}' --max-time 10 "https://code.eyan.fyi/" 2>/dev/null) || code_code="000"
    log_info "eyan.fyi -> $eyan_code, code.eyan.fyi -> $code_code"
    [[ "$eyan_code" == "200" || "$eyan_code" == "301" || "$eyan_code" == "302" ]] && \
    [[ "$code_code" == "200" || "$code_code" == "301" || "$code_code" == "302" ]]
}
check_health "Existing sites (eyan.fyi, code.eyan.fyi) still respond normally" check_existing_sites_unaffected

echo
if [[ "$HEALTH_FAILED" -eq 1 ]]; then
    log_error "One or more health checks failed. Nginx, the certificate, and the container are left in place for you to investigate:"
    log_error "  docker compose logs n8n"
    log_error "  sudo journalctl -u nginx --no-pager -n 50"
    log_error "  DEBUG=1 ./scripts/install.sh    # safe to re-run once fixed; steps 1-5 will no-op past what's already correct"
    exit 1
fi

log_success "All health checks passed."
log_success "https://$DOMAIN is live. eyan.fyi and code.eyan.fyi were not modified."
log_info "Full log saved to $LOG_FILE"
