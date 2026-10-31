#!/bin/sh
# nginx image hook (/docker-entrypoint.d, after the templates are rendered): keep the site TLS asks for
# and drop the other. With TLS on, check the certificate is there and reload nginx every 6 hours so a
# renewed (or replaced) certificate is picked up.
set -eu
CONF=/etc/nginx/conf.d

case "${TLS:-}" in
""|off)
    rm -f "$CONF/site-tls.conf"
    ;;
letsencrypt|selfsigned|custom)
    : "${PUBLIC_HOST:?TLS=$TLS needs PUBLIC_HOST}"
    live=/etc/letsencrypt/live/$PUBLIC_HOST
    if [ ! -r "$live/fullchain.pem" ] || [ ! -r "$live/privkey.pem" ]; then
        echo "edge: TLS=$TLS but no readable certificate in $live; see \`docker compose logs\` for the certificate service" >&2
        exit 1
    fi
    rm -f "$CONF/site-http.conf"
    ( while :; do sleep 6h; nginx -s reload; done ) >/dev/null 2>&1 &
    ;;
*)
    echo "edge: unknown TLS=$TLS (use off, letsencrypt, selfsigned or custom)" >&2
    exit 1
    ;;
esac
