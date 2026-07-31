#!/usr/bin/env bash
# Shared helpers for install.sh / uninstall.sh.
# Source, don't execute: `source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"`
#
# Strict-mode safety notes (read before adding new helpers):
#
#   1. Never end a helper's last statement with a command whose non-zero
#      exit is a NORMAL, expected outcome (e.g. "check failed") unless
#      every call site captures it with `x=$(fn) || ...` or `if fn; then`.
#      A bare `x=$(fn)` under `set -e` aborts the whole script the instant
#      fn returns non-zero — even though the command substitution already
#      correctly captured fn's stdout.
#
#   2. Never pipe into `head -N` or `grep -q` when the producer (grep,
#      curl, dig, ...) might still be writing when the consumer decides
#      it has enough and closes its end of the pipe. The producer can be
#      killed by SIGPIPE, which — under `pipefail` — makes the WHOLE
#      pipeline report a non-zero exit status even though the correct
#      output was already produced and captured. Prefer a single `awk`
#      process (`exit` after first match, no pipe at all).
#
#   3. `if fn; then` / `fn || ...` / `fn && ...` / `! fn` all suspend
#      `set -e` for fn's ENTIRE execution, including every command inside
#      it (POSIX behavior, inherited by bash). A bare `fn` on its own line
#      does not. When in doubt, wrap it.

if [[ -t 2 ]]; then
    C_RED=$'\033[0;31m'; C_YEL=$'\033[0;33m'; C_GRN=$'\033[0;32m'
    C_BLU=$'\033[0;34m'; C_CYA=$'\033[0;36m'; C_BLD=$'\033[1m'; C_RST=$'\033[0m'
else
    C_RED=''; C_YEL=''; C_GRN=''; C_BLU=''; C_CYA=''; C_BLD=''; C_RST=''
fi

DEBUG="${DEBUG:-0}"

_ts() { date '+%Y-%m-%d %H:%M:%S'; }

# All logging goes to stderr, deliberately — several helpers below are
# called as `x=$(fn ...)` to capture a return value on stdout while
# logging their progress; if log_* wrote to stdout, that progress text
# would silently corrupt the captured value.
log_info()    { printf '%s [%sINFO %s] %s\n'  "$(_ts)" "$C_BLU" "$C_RST" "$*" >&2; }
log_warn()    { printf '%s [%sWARN %s] %s\n'  "$(_ts)" "$C_YEL" "$C_RST" "$*" >&2; }
log_error()   { printf '%s [%sERROR%s] %s\n'  "$(_ts)" "$C_RED" "$C_RST" "$*" >&2; }
log_success() { printf '%s [%s OK  %s] %s\n'  "$(_ts)" "$C_GRN" "$C_RST" "$*" >&2; }
log_step()    { printf '\n%s%s==> %s%s\n' "$C_BLD" "$C_BLU" "$*" "$C_RST" >&2; }
log_debug()   { [[ "$DEBUG" == "1" ]] && printf '%s [%sDEBUG%s] %s\n' "$(_ts)" "$C_CYA" "$C_RST" "$*" >&2; return 0; }

# Enables full command tracing (`set -x`) with a timestamped, file:line
# prefixed PS4, activated when the script is run as `DEBUG=1 ./install.sh`.
# Call once, near the top of the entrypoint script, after sourcing lib.sh.
enable_debug_mode() {
    if [[ "$DEBUG" == "1" ]]; then
        export PS4='+ [\D{%H:%M:%S}] ${BASH_SOURCE##*/}:${LINENO}:${FUNCNAME[0]:-main}() '
        set -x
        log_debug "Debug mode enabled (full command tracing to stderr)."
    fi
}

# --- Basic checks -----------------------------------------------------

check_command() {
    command -v "$1" >/dev/null 2>&1
}

check_service() {
    systemctl is-active --quiet "$1"
}

require_sudo_session() {
    log_info "Priming sudo session (you may be prompted for your password)..."
    if ! sudo -v; then
        log_error "sudo access is required to manage nginx/certbot for this install."
        return 1
    fi
    return 0
}

# Keeps the sudo credential cache warm for the lifetime of the script, so a
# long certbot call between two `sudo` invocations can never hit an
# expired-credential prompt with no TTY to answer it. Call
# start_sudo_keepalive once after require_sudo_session succeeds; the EXIT
# trap (set by the caller) should call stop_sudo_keepalive.
SUDO_KEEPALIVE_PID=""
start_sudo_keepalive() {
    ( while true; do sudo -n -v 2>/dev/null; sleep 60; done ) &
    SUDO_KEEPALIVE_PID=$!
    disown "$SUDO_KEEPALIVE_PID" 2>/dev/null || true
    log_debug "Started sudo keep-alive (pid $SUDO_KEEPALIVE_PID)"
}
stop_sudo_keepalive() {
    if [[ -n "$SUDO_KEEPALIVE_PID" ]]; then
        kill "$SUDO_KEEPALIVE_PID" >/dev/null 2>&1 || true
        wait "$SUDO_KEEPALIVE_PID" 2>/dev/null || true
        log_debug "Stopped sudo keep-alive (pid $SUDO_KEEPALIVE_PID)"
    fi
}

# --- .env reading -------------------------------------------------------
# Deliberately NOT `grep | head | cut` (see note #2 above): a single awk
# process that exits after the first match needs no pipe at all, so there
# is nothing for SIGPIPE to kill. Also deliberately NOT `source .env`:
# values could contain unescaped '$' that bash would try to expand.
#
# Never logs the extracted VALUE (may be a secret) — only whether the key
# was found, and only in DEBUG mode.
get_env_var() {
    local key="$1" file="${2:-.env}" value
    value=$(awk -F'=' -v k="$key" '
        $1 == k { sub(/^[^=]*=/, ""); print; found=1; exit }
        END { if (!found) exit 1 }
    ' "$file" 2>/dev/null) || true
    if [[ -n "$value" ]]; then
        log_debug "get_env_var: $key found in $file"
    else
        log_debug "get_env_var: $key NOT found (or empty) in $file"
    fi
    printf '%s' "$value"
}

# --- DNS ----------------------------------------------------------------
# Resolves $1 via 1.1.1.1, then 8.8.8.8, then the system resolver as a last
# resort (VPS-local resolver caches are frequently stale). Echoes the
# resolved IP (empty string if none) and returns 0 only if it equals $2.
validate_dns() {
    local domain="$1" expected_ip="$2"
    local resolved="" resolver
    for resolver in 1.1.1.1 8.8.8.8; do
        resolved=$(dig "@${resolver}" +time=3 +tries=1 +short "$domain" A 2>/dev/null | tail -1) || resolved=""
        if [[ -n "$resolved" ]]; then
            log_info "Resolved $domain via ${resolver}: $resolved"
            break
        fi
        log_warn "No answer from ${resolver} for $domain"
    done
    if [[ -z "$resolved" ]]; then
        log_warn "Public resolvers gave no answer — falling back to the local resolver."
        resolved=$(dig +time=3 +tries=1 +short "$domain" A 2>/dev/null | tail -1) || resolved=""
        [[ -n "$resolved" ]] && log_info "Resolved $domain via local resolver: $resolved"
    fi
    printf '%s' "$resolved"
    [[ -n "$resolved" && "$resolved" == "$expected_ip" ]]
}

# --- Nginx ------------------------------------------------------------
# Runs `nginx -t`, surfacing stderr on failure instead of swallowing it.
validate_nginx() {
    local out
    if out=$(sudo nginx -t 2>&1); then
        log_success "nginx -t passed"
        return 0
    fi
    log_error "nginx -t failed:"
    printf '%s\n' "$out" >&2
    return 1
}

# --- Certificates -----------------------------------------------------
# True if a non-expiring (>24h validity left), complete cert exists for $1.
validate_certificate() {
    local domain="$1"
    local live_dir="/etc/letsencrypt/live/${domain}"
    if ! sudo test -d "$live_dir"; then
        return 1
    fi
    if ! sudo test -f "$live_dir/fullchain.pem" || ! sudo test -f "$live_dir/privkey.pem"; then
        return 1
    fi
    sudo openssl x509 -in "$live_dir/fullchain.pem" -noout -checkend 86400 >/dev/null 2>&1
}

# --- Ports --------------------------------------------------------------
# True if something is already listening on port $1 (any interface).
port_in_use() {
    local port="$1"
    ss -ltn 2>/dev/null | awk -v p=":${port}" '
        NR>1 && index($4, p)==length($4)-length(p)+1 { found=1; exit }
        END { exit !found }
    '
}

# --- HTTP -----------------------------------------------------------------
# Single curl call, captured once into a variable — never piped into
# `head`/`grep -q` (see note #2). Echoes the full raw response (status
# line + headers + body). On any curl failure (timeout, connection
# refused, TLS error), echoes nothing rather than aborting — the caller
# decides what an empty response means. Callers that only need the status
# line or code can extract it with pure bash parameter expansion, e.g.:
#   resp=$(http_probe "$url")
#   status_line="${resp%%$'\r'$'\n'*}"; [[ "$status_line" == "$resp" ]] && status_line="${resp%%$'\n'*}"
#   code=$(printf '%s' "$status_line" | awk '{print $2}')
http_probe() {
    local url="$1"
    curl -ks -i --max-time 10 "$url" 2>/dev/null || true
}
