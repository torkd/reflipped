#!/bin/sh
# Certificates for the edge's TLS modes (runs in the certbot image; POSIX sh). Every mode leaves
# fullchain.pem and privkey.pem in /etc/letsencrypt/live/$PUBLIC_HOST/, where the edge reads them.
#   certbot.sh init        TLS=letsencrypt: first certificate with the standalone authenticator on port 80,
#                          before the edge starts (skipped when one exists, e.g. you put your own there)
#   certbot.sh renew       TLS=letsencrypt: twice a day, renew what is due through the edge's /.well-known/acme-challenge
#   certbot.sh selfsigned  TLS=selfsigned: a self-signed certificate for PUBLIC_HOST and CERT_NAMES (once)
#   certbot.sh custom      TLS=custom: copy fullchain.pem and privkey.pem from /custom (CUSTOM_CERT_DIR)
set -eu
: "${PUBLIC_HOST:?set PUBLIC_HOST in .env}"
LIVE=/etc/letsencrypt/live/$PUBLIC_HOST

# The edge runs as uid 101 and has to read the key; this container creates it as root.
fix_owner() { chown -R 101:101 /etc/letsencrypt/live /etc/letsencrypt/archive 2>/dev/null || chown -R 101:101 /etc/letsencrypt/live; }

# subjectAltName entries for PUBLIC_HOST and the comma-separated CERT_NAMES (IP addresses become IP: entries).
san_list() {
    out=
    for name in $(printf '%s,%s' "$PUBLIC_HOST" "${CERT_NAMES:-}" | tr ',' ' '); do
        case "$name" in
        *[!0-9.]*) case "$name" in *:*) entry="IP:$name" ;; *) entry="DNS:$name" ;; esac ;;
        *) entry="IP:$name" ;;
        esac
        out="${out:+$out,}$entry"
    done
    printf '%s' "$out"
}

case "${1:-}" in
init)
    if [ ! -e "$LIVE/fullchain.pem" ]; then
        set -- certonly --standalone --non-interactive --agree-tos -d "$PUBLIC_HOST"
        for name in $(printf '%s' "${CERT_NAMES:-}" | tr ',' ' '); do set -- "$@" -d "$name"; done
        if [ -n "${LE_EMAIL:-}" ]; then set -- "$@" -m "$LE_EMAIL"; else set -- "$@" --register-unsafely-without-email; fi
        [ "${LE_STAGING:-}" = 1 ] && set -- "$@" --staging
        certbot "$@"
    fi
    fix_owner
    ;;
renew)
    while :; do
        certbot renew --non-interactive --authenticator webroot --webroot-path /var/www/acme || true
        fix_owner
        sleep 12h
    done
    ;;
selfsigned)
    if [ ! -e "$LIVE/fullchain.pem" ]; then
        mkdir -p "$LIVE"
        openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days "${SELFSIGNED_DAYS:-825}" \
            -subj "/CN=$PUBLIC_HOST" -addext "subjectAltName=$(san_list)" \
            -keyout "$LIVE/privkey.pem" -out "$LIVE/fullchain.pem"
        echo "self-signed certificate for $(san_list) in $LIVE"
    fi
    openssl x509 -in "$LIVE/fullchain.pem" -noout -subject -enddate -fingerprint -sha256
    fix_owner
    ;;
custom)
    for f in fullchain.pem privkey.pem; do
        [ -r "/custom/$f" ] || { echo "TLS=custom: $f not found in CUSTOM_CERT_DIR" >&2; exit 1; }
    done
    mkdir -p "$LIVE"
    # Copy, not symlink: the edge doesn't see /custom.
    cp /custom/fullchain.pem /custom/privkey.pem "$LIVE/"
    chmod 600 "$LIVE/privkey.pem"
    fix_owner
    ;;
*)
    echo "usage: $0 init|renew|selfsigned|custom" >&2
    exit 2
    ;;
esac
