#!/bin/sh
# Strips the internal files listed in scripts/release/internal-paths.txt for publishing.
#
#   sh scripts/release/sanitise.sh links   kept Markdown and web/ files mention no internal file (any branch)
#   sh scripts/release/sanitise.sh check   no internal file is tracked, plus `links` (staging, main)
#   sh scripts/release/sanitise.sh apply   `git rm` every internal file, then `check`
#
# Releasing develop into staging, on a branch cut from staging:
#   git merge --no-ff --no-commit origin/develop
#   sh scripts/release/sanitise.sh apply    # also settles the modify/delete conflicts on internal files
#   git commit
# then open the PR into staging. Any other conflict is resolved by hand before `apply`.
set -eu

cd "$(git rev-parse --show-toplevel)"
list=scripts/release/internal-paths.txt
mode="${1:-}"

paths() {
    sed -e 's/#.*//' -e 's/[[:space:]]*$//' "$list" | grep -v '^$'
}

# Every tracked path (also unmerged ones) that a listed entry names.
tracked_internal() {
    paths | while IFS= read -r p; do
        git ls-files -- "$p"
    done | sort -u
}

check_links() {
    kept=$(mktemp)
    internal=$(mktemp)
    tracked_internal >"$internal"
    git ls-files -- '*.md' 'web/' | sort -u | comm -23 - "$internal" | grep -v "^$list\$" >"$kept" || true
    status=0
    for p in $(paths); do
        # A doc is linked by its file name (`docs/x.md`, `x.md`, `./x.md`), a folder by its path;
        # either one only as a whole name, so `air-shell.md` doesn't match `connecting-air-shell.md`.
        case "$p" in
            */) needle="$p" ;;
            *) needle=$(basename "$p") ;;
        esac
        pattern="(^|[^A-Za-z0-9_.-])$(printf '%s' "$needle" | sed 's/[.[\*^$]/\\&/g')"
        if [ -s "$kept" ] && hits=$(xargs grep -nE -- "$pattern" <"$kept"); then
            printf 'kept file mentions internal %s:\n%s\n' "$p" "$hits" >&2
            status=1
        fi
    done
    rm -f "$kept" "$internal"
    return "$status"
}

check_removed() {
    left=$(tracked_internal)
    if [ -n "$left" ]; then
        printf 'internal files still tracked:\n%s\n' "$left" >&2
        return 1
    fi
}

case "$mode" in
    links)
        check_links
        ;;
    check)
        status=0
        check_removed || status=1
        check_links || status=1
        exit "$status"
        ;;
    apply)
        for p in $(paths); do
            git rm -r -q -f --ignore-unmatch -- "$p"
        done
        check_removed
        check_links
        ;;
    *)
        echo "usage: sh $0 links|check|apply" >&2
        exit 2
        ;;
esac
