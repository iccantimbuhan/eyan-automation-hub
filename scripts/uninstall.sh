#!/usr/bin/env bash
#
# Removes everything install.sh added for automation.eyan.fyi. Never touches
# /etc/nginx/sites-available/eyan.fyi, code.eyan.fyi, their certificates, or
# the n8n/postgres/redis docker stack.
#
# Safe to run even if install.sh never completed, or was already run.
#
# Default is conservative: the Let's Encrypt certificate is KEPT unless you
# explicitly ask to remove it, since re-requesting a cert soon after
# deleting it can run into Let's Encrypt's issuance rate limits.
#
# Usage:
#   ./scripts/uninstall.sh                 # remove nginx site only, keep cert
#   ./scripts/uninstall.sh --remove-cert    # also delete the LE certificate
#   ./scripts/uninstall.sh --yes            # skip the confirmation prompt
#   ./scripts/uninstall.sh --debug          # full command tracing (same as DEBUG=1)
#
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

DOMAIN=automation.eyan.fyi
BACKUP_DIR=/etc/nginx/backups
NGINX_SITE_FILE=/etc/nginx/sites-available/automation.eyan.fyi
NGINX_SITE_LINK=/etc/nginx/sites-enabled/automation.eyan.fyi

REMOVE_CERT=0
ASSUME_YES=0
for arg in "$@"; do
    case "$arg" in
        --remove-cert) REMOVE_CERT=1 ;;
        --yes) ASSUME_YES=1 ;;
        --debug) DEBUG=1 ;;
        *) echo "Unknown flag: $arg (supported: --remove-cert, --yes, --debug)" >&2; exit 1 ;;
    esac
done

enable_debug_mode

fail() { log_error "$*"; exit 1; }

# No rollback stack here by design — this script only ever removes things
# it, or install.sh, added under automation.eyan.fyi-specific paths (never
# eyan.fyi's or code.eyan.fyi's own files).
on_error() {
    local exit_code=$? line="$1" failed_cmd="$2"
    log_error "Uninstall FAILED (exit $exit_code) at scripts/uninstall.sh:$line"
    log_error "Failing command: $failed_cmd"
    log_error "eyan.fyi and code.eyan.fyi were not touched — only automation.eyan.fyi-scoped resources are ever in scope here."
    log_error "Safe to re-run: ./scripts/uninstall.sh (same flags) once the underlying issue is fixed."
    exit "$exit_code"
}
trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR

log_warn "This will remove the automation.eyan.fyi nginx site."
[[ "$REMOVE_CERT" -eq 1 ]] && log_warn "  --remove-cert: the Let's Encrypt certificate WILL be deleted."
log_info "eyan.fyi and code.eyan.fyi are never touched by this script."
log_info "The n8n/postgres/redis docker stack is not touched — use 'docker compose down' separately if desired."

if [[ "$ASSUME_YES" -ne 1 ]]; then
    reply=""
    read -r -p "Continue? [y/N] " reply || true
    [[ "$reply" =~ ^[Yy]$ ]] || { log_info "Aborted, nothing changed."; exit 0; }
fi

require_sudo_session || exit 1
start_sudo_keepalive
trap 'stop_sudo_keepalive' EXIT

log_step "1/2 — Removing nginx site"
if [[ -L "$NGINX_SITE_LINK" || -e "$NGINX_SITE_LINK" ]]; then
    sudo rm -f "$NGINX_SITE_LINK"
    log_success "Removed $NGINX_SITE_LINK"
else
    log_info "$NGINX_SITE_LINK not present — skipping."
fi

if [[ -f "$NGINX_SITE_FILE" ]]; then
    sudo mkdir -p "$BACKUP_DIR"
    backup="$BACKUP_DIR/automation.eyan.fyi.removed.$(date +%Y%m%d%H%M%S).bak"
    sudo cp "$NGINX_SITE_FILE" "$backup"
    sudo rm -f "$NGINX_SITE_FILE"
    log_success "Removed $NGINX_SITE_FILE (backed up to $backup)"
else
    log_info "$NGINX_SITE_FILE not present — skipping."
fi

if sudo nginx -t; then
    sudo systemctl reload nginx
    log_success "nginx reloaded"
else
    log_error "nginx -t failed after removing the site — investigate before relying on nginx further."
    exit 1
fi

log_step "2/2 — Certificate"
if [[ "$REMOVE_CERT" -eq 1 ]]; then
    sudo certbot delete --cert-name "$DOMAIN" --non-interactive || log_warn "certbot delete reported an issue (continuing) — check 'sudo certbot certificates' by hand."
    log_success "Certificate for $DOMAIN removed"
else
    log_info "Certificate for $DOMAIN kept (pass --remove-cert to delete it)."
fi

log_success "automation.eyan.fyi nginx integration removed. eyan.fyi and code.eyan.fyi were not touched."
