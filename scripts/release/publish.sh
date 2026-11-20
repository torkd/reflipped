#!/bin/sh
# Publishes `main` to the public GitHub mirror without its history.
#
#   sh scripts/release/publish.sh [--push] [--tag NAME [--release] [--image] [--notes-file FILE]] [-m MESSAGE] [SOURCE]
#
# The history of `main` still holds every internal file and the contributors' emails, so it is never
# pushed. Instead each release is one new commit on the public `main`: its tree is SOURCE's tree
# (default `origin/main`) minus the forge-only files (see below), its parent is the previous public release, and its author is a fixed release
# identity. The public history is one commit per release and only moves forward, so clones just pull.
#
# Without `--push` it is a dry run: it checks SOURCE, builds the commit locally and shows what changed
# since the last public release. `--tag NAME` also tags the release on the mirror. With the tag, `--release` then
# copies the forge's release of that name (the app's APK and .sha256) to a GitHub release, and `--image` the server's
# image to ghcr.io, through scripts/release/github-release.sh (its header has what they need: GITHUB_TOKEN,
# FORGE_TOKEN, registry logins); `--notes-file` gives the release notes. In a dry run they show their plan too. If
# the push worked but the release step didn't, run github-release.sh --push on its own to finish.
#
# Environment:
#   PUBLISH_REMOTE   mirror URL (default git@github.com:torkd/reflipped.git); a local bare repo works for a test
#   PUBLISH_BRANCH   branch on the mirror (default main)
#   PUBLISH_NAME, PUBLISH_EMAIL   the release identity (default Reflipped, webmaster@torkd.space)
#
# Create the GitHub repository empty (no README or licence): the first release then becomes its root commit.
set -eu

cd "$(git rev-parse --show-toplevel)"
remote="${PUBLISH_REMOTE:-git@github.com:torkd/reflipped.git}"
branch="${PUBLISH_BRANCH:-main}"
name="${PUBLISH_NAME:-Reflipped}"
email="${PUBLISH_EMAIL:-webmaster@torkd.space}"
push=0
tag=""
release=0
image=0
notes_file=""
message="Release $(date -u +%Y-%m-%d)"
source=origin/main

while [ $# -gt 0 ]; do
    case "$1" in
        --push) push=1 ;;
        --tag) tag="${2:?--tag needs a name}"; shift ;;
        --release) release=1 ;;
        --image) image=1 ;;
        --notes-file) notes_file="${2:?--notes-file needs a file}"; shift ;;
        -m) message="${2:?-m needs a message}"; shift ;;
        -*) echo "usage: sh $0 [--push] [--tag NAME [--release] [--image] [--notes-file FILE]] [-m MESSAGE] [SOURCE]" >&2; exit 2 ;;
        *) source="$1" ;;
    esac
    shift
done
if { [ "$release" -eq 1 ] || [ "$image" -eq 1 ]; } && [ -z "$tag" ]; then
    echo "--release and --image need --tag" >&2
    exit 2
fi
# github-release.sh's options: the image only goes with the release, since the release step checks the tag first
github_release() {
    set -- "$@" ${notes_file:+--notes-file "$notes_file"}
    if [ "$image" -eq 1 ]; then set -- "$@" --image; fi
    sh scripts/release/github-release.sh "$@" "$tag"
}

if [ "$source" = origin/main ]; then
    git fetch -q origin main
fi
source_commit=$(git rev-parse --verify "$source^{commit}")

# The tree must be sanitised: check it with its own copy of sanitise.sh, in a throwaway checkout.
work=$(mktemp -d)
cleanup() {
    git worktree remove --force "$work/tree" 2>/dev/null || true
    rm -rf "$work"
}
trap cleanup EXIT INT TERM
git worktree add -q --detach "$work/tree" "$source_commit"
if [ ! -f "$work/tree/scripts/release/sanitise.sh" ]; then
    echo "$source has no scripts/release/sanitise.sh, so it predates sanitising; nothing published" >&2
    exit 1
fi
if ! (cd "$work/tree" && sh scripts/release/sanitise.sh check); then
    echo "$source is not sanitised; nothing published" >&2
    exit 1
fi

# Forge-only files stay on `staging` and `main`, where the forge's CI runs them, but are left out of the
# public tree. One path per word; a folder takes everything in it.
forge_only=".gitea"
GIT_INDEX_FILE="$work/index" git read-tree "$source_commit"
GIT_INDEX_FILE="$work/index" git rm -r -q -f --cached --ignore-unmatch -- $forge_only
tree=$(GIT_INDEX_FILE="$work/index" git write-tree)

# The previous public release, if the mirror has one.
parent=""
status=0
git ls-remote --exit-code --heads "$remote" "$branch" >/dev/null || status=$?
if [ "$status" -ne 0 ] && [ "$status" -ne 2 ]; then
    echo "can't reach $remote; nothing published" >&2
    exit 1
fi
if [ "$status" -eq 0 ]; then
    git fetch -q "$remote" "+refs/heads/$branch:refs/publish/$branch"
    parent=$(git rev-parse "refs/publish/$branch")
    if [ "$(git rev-parse "$parent^{tree}")" = "$tree" ]; then
        echo "the mirror's $branch already has $source's tree; nothing to publish"
        if [ "$release" -eq 1 ] || [ "$image" -eq 1 ]; then
            echo "to (re)make the GitHub release of a tag that is already there: sh scripts/release/github-release.sh [--push] [--image] $tag"
        fi
        exit 0
    fi
fi

commit=$(GIT_AUTHOR_NAME="$name" GIT_AUTHOR_EMAIL="$email" \
    GIT_COMMITTER_NAME="$name" GIT_COMMITTER_EMAIL="$email" \
    git commit-tree "$tree" ${parent:+-p "$parent"} -m "$message")

echo "source:  $source ($source_commit)"
echo "release: $commit \"$message\" by $name <$email>"
if [ -n "$parent" ]; then
    echo "changes since the last public release ($parent):"
    git diff --stat "$parent" "$commit" | tail -n 20
else
    echo "first release: $(git ls-tree -r --name-only "$tree" | wc -l | tr -d ' ') files"
fi

if [ "$push" -eq 0 ]; then
    if [ "$release" -eq 1 ] || [ "$image" -eq 1 ]; then
        echo "the GitHub release, as it would be made after the push:"
        github_release
    fi
    echo "dry run; add --push to publish to $remote ($branch)"
    exit 0
fi

# A plain push: if the mirror moved since the fetch, it is refused instead of overwritten.
git push "$remote" "$commit:refs/heads/$branch"
if [ -n "$tag" ]; then
    GIT_COMMITTER_NAME="$name" GIT_COMMITTER_EMAIL="$email" git tag -a -m "$message" "$tag" "$commit"
    git push "$remote" "refs/tags/$tag"
    # the tag belongs to the mirror only, so it never reaches origin with the other tags
    git tag -d "$tag" >/dev/null
fi
git update-ref "refs/publish/$branch" "$commit"
echo "published $source as $commit"
if [ "$release" -eq 1 ] || [ "$image" -eq 1 ]; then
    github_release --push
fi
