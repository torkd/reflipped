#!/bin/sh
# Carries a release from the forge to the public GitHub mirror: the files attached to the forge's release (the app's
# APK and its .sha256), and with --image the server's container image, copied from the forge registry to ghcr.io.
#
#   sh scripts/release/github-release.sh [--push] [--image] [--notes-file FILE] TAG
#
# The tag must already be on GitHub: `publish.sh --push --tag TAG` makes it on the public release commit (and runs
# this script with --release / --image). Without --push it is a dry run: it downloads and checks the files, looks the
# tag and the image up, and says what it would do. Running it again is safe: files of the same name are replaced.
#
# Release: reads the forge's release for TAG, downloads every file attached to it and checks each `<file>.sha256`
# against its file, then creates the GitHub release on TAG, or adds the files to the one that exists. A tag with
# alpha, beta or pre in its name makes a pre-release, as on the forge (.gitea/scripts/release-assets.mjs). The notes
# come from --notes-file, else a short default listing the files and their SHA-256. The forge release's own notes
# are not copied: they may mention the forge or internal work.
#
# Image (--image): copies <forge registry>/<forge repo>:TAG, which .gitea/workflows/images.yml builds for every v…
# tag, to <GHCR_IMAGE>:TAG, plus :latest unless it is a pre-release, without rebuilding, so GitHub gets the image
# built and run here. crane or skopeo copy the manifest as it is (same digest); without them it falls back to
# `docker buildx imagetools create`, which wraps a single-platform image in a new index: same layers and config, but
# another digest. Install crane (a single binary, from go-containerregistry) to keep the digest.
# Log in to both registries first: `docker login <forge host>` and `docker login ghcr.io` (a classic token with
# write:packages). The first push creates the package as private: make it public once in its settings.
#
# Environment:
#   GITHUB_TOKEN    may write releases on GITHUB_REPO (fine-grained: Contents read and write); needed with --push
#   GITHUB_REPO     the mirror (default torkd/reflipped)
#   GHCR_IMAGE      default ghcr.io/<GITHUB_REPO, lower case>
#   FORGE_URL       default https://<host of the origin remote>
#   FORGE_REPO      default <owner>/<repo> of the origin remote
#   FORGE_TOKEN     a forge token that may read the repository (needed while it is private)
#   FORGE_REGISTRY  default the host of FORGE_URL
#   GITHUB_API      default https://api.github.com (for a test against a stand-in)
set -eu

cd "$(git rev-parse --show-toplevel)"
push=0
image=0
notes_file=""
tag=""
while [ $# -gt 0 ]; do
    case "$1" in
        --push) push=1 ;;
        --image) image=1 ;;
        --notes-file) notes_file="${2:?--notes-file needs a file}"; shift ;;
        -*) echo "usage: sh $0 [--push] [--image] [--notes-file FILE] TAG" >&2; exit 2 ;;
        *) tag="$1" ;;
    esac
    shift
done
[ -n "$tag" ] || { echo "usage: sh $0 [--push] [--image] [--notes-file FILE] TAG" >&2; exit 2; }
[ -z "$notes_file" ] || [ -f "$notes_file" ] || { echo "no notes file $notes_file" >&2; exit 2; }

# origin is ssh://git@host:port/owner/repo.git, git@host:owner/repo.git or https://host/owner/repo.git
origin=$(git remote get-url origin | sed -e 's|^[a-z+]*://||' -e 's|^[^@/]*@||')
forge_host=$(printf %s "$origin" | sed 's|[:/].*||')
forge_url="${FORGE_URL:-https://$forge_host}"
forge_repo="${FORGE_REPO:-$(printf %s "$origin" | sed -E -e 's#^[^:/]+(:[0-9]+)?[:/]##' -e 's#\.git$##')}"
forge_registry="${FORGE_REGISTRY:-$(printf %s "$forge_url" | sed -e 's|^[a-z]*://||' -e 's|/.*||')}"
github_repo="${GITHUB_REPO:-torkd/reflipped}"
ghcr_image="${GHCR_IMAGE:-ghcr.io/$(printf %s "$github_repo" | tr 'A-Z' 'a-z')}"
github_api="${GITHUB_API:-https://api.github.com}"
case "$tag" in
    *alpha*|*beta*|*pre*|*Alpha*|*Beta*|*Pre*) prerelease=true ;;
    *) prerelease=false ;;
esac
if [ "$push" -eq 1 ] && [ -z "${GITHUB_TOKEN:-}" ]; then
    echo "--push needs GITHUB_TOKEN (a token that may write releases on $github_repo)" >&2
    exit 2
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

# One field of a JSON document on stdin: `json <expression on the parsed value v>`.
json() {
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);const r=('"$1"');if(r!==undefined&&r!==null)process.stdout.write(String(r))})'
}

sha256() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# A GitHub API call; prints the HTTP status and leaves the body in $work/gh.json.
gh_api() {
    method="$1"; url="$2"; shift 2
    set -- -sS -X "$method" -o "$work/gh.json" -w '%{http_code}' -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: 2022-11-28" "$@"
    if [ -n "${GITHUB_TOKEN:-}" ]; then set -- "$@" -H "Authorization: Bearer $GITHUB_TOKEN"; fi
    curl "$@" "$url"
}

forge_get() {
    if [ -n "${FORGE_TOKEN:-}" ]; then
        curl -fsSL -H "Authorization: token $FORGE_TOKEN" "$@"
    else
        curl -fsSL "$@"
    fi
}

# --- the forge's release and its files ---
echo "forge:  $forge_url/$forge_repo, release $tag"
if ! forge_get -o "$work/forge.json" "$forge_url/api/v1/repos/$forge_repo/releases/tags/$tag"; then
    echo "no release $tag on the forge (or no access: set FORGE_TOKEN while the repository is private)" >&2
    exit 1
fi
mkdir "$work/files"
node -e 'for (const a of JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).assets ?? []) console.log(a.name + "\t" + a.browser_download_url)' \
    "$work/forge.json" >"$work/assets.tsv"
[ -s "$work/assets.tsv" ] || { echo "the forge's release $tag has no files" >&2; exit 1; }
while IFS="	" read -r name url; do
    case "$name" in */*|.*|"") echo "unexpected file name $name" >&2; exit 1 ;; esac
    forge_get -o "$work/files/$name" "$url"
done <"$work/assets.tsv"

checked=0
for f in "$work"/files/*.sha256; do
    [ -e "$f" ] || continue
    base="${f%.sha256}"
    [ -f "$base" ] || { echo "$(basename "$f") has no $(basename "$base") beside it" >&2; exit 1; }
    want=$(cut -d' ' -f1 <"$f" | head -n 1)
    have=$(sha256 "$base")
    if [ "$want" != "$have" ]; then
        echo "$(basename "$base"): SHA-256 $have, but its .sha256 says $want" >&2
        exit 1
    fi
    checked=$((checked + 1))
done
for f in "$work"/files/*; do
    printf '  %s  %s bytes\n' "$(basename "$f")" "$(wc -c <"$f" | tr -d ' ')"
done
echo "  $checked file(s) match their .sha256"

if [ -n "$notes_file" ]; then
    cp "$notes_file" "$work/notes.md"
else
    {
        printf 'Reflipped %s.\n\nInstall the app with the [player guide](https://github.com/%s/blob/main/docs/connecting-air-shell.md).\n\nSHA-256:\n' "$tag" "$github_repo"
        for f in "$work"/files/*; do
            case "$f" in *.sha256) continue ;; esac
            printf -- '- `%s`: `%s`\n' "$(basename "$f")" "$(sha256 "$f")"
        done
    } >"$work/notes.md"
fi

# --- GitHub ---
status=$(gh_api GET "$github_api/repos/$github_repo/git/ref/tags/$tag")
if [ "$status" != 200 ]; then
    if [ "$push" -eq 1 ]; then
        echo "no tag $tag on $github_repo (HTTP $status): publish it first with publish.sh --push --tag $tag" >&2
        exit 1
    fi
    echo "github: no tag $tag on $github_repo yet (publish.sh --push --tag $tag makes it)"
fi
status=$(gh_api GET "$github_api/repos/$github_repo/releases/tags/$tag")
release_id=""
if [ "$status" = 200 ]; then
    release_id=$(json v.id <"$work/gh.json")
    upload_url=$(json 'v.upload_url.replace(/\{.*$/, "")' <"$work/gh.json")
    echo "github: release $tag exists ($release_id); files of the same name will be replaced"
else
    echo "github: release $tag will be created (pre-release: $prerelease)"
fi

if [ "$image" -eq 1 ]; then
    src="$forge_registry/$(printf %s "$forge_repo" | tr 'A-Z' 'a-z'):$tag"
    targets="$ghcr_image:$tag"
    [ "$prerelease" = true ] || targets="$targets $ghcr_image:latest"
    echo "image:  $src -> $targets"
    if [ "$push" -eq 0 ] && docker buildx version >/dev/null 2>&1; then
        if digest=$(docker buildx imagetools inspect --format '{{json .Manifest.Digest}}' "$src" 2>/dev/null); then
            echo "        found, $digest"
        else
            echo "        not found on the forge registry (or not logged in: docker login $forge_registry)"
        fi
    fi
fi

if [ "$push" -eq 0 ]; then
    echo "notes:"
    sed 's/^/  | /' "$work/notes.md"
    echo "dry run; add --push to publish"
    exit 0
fi

# --- publish the release ---
if [ -z "$release_id" ]; then
    node -e 'const fs=require("fs");const [tag,pre,notes]=process.argv.slice(1);process.stdout.write(JSON.stringify({tag_name:tag,name:tag,body:fs.readFileSync(notes,"utf8"),prerelease:pre==="true",draft:false}))' \
        "$tag" "$prerelease" "$work/notes.md" >"$work/create.json"
    status=$(gh_api POST "$github_api/repos/$github_repo/releases" -H "Content-Type: application/json" --data-binary "@$work/create.json")
    [ "$status" = 201 ] || { echo "creating the release failed (HTTP $status): $(cat "$work/gh.json")" >&2; exit 1; }
    release_id=$(json v.id <"$work/gh.json")
    upload_url=$(json 'v.upload_url.replace(/\{.*$/, "")' <"$work/gh.json")
    echo "created release $tag ($release_id)"
fi
status=$(gh_api GET "$github_api/repos/$github_repo/releases/$release_id/assets?per_page=100")
[ "$status" = 200 ] || { echo "listing the release's files failed (HTTP $status)" >&2; exit 1; }
cp "$work/gh.json" "$work/existing.json"
for f in "$work"/files/*; do
    name=$(basename "$f")
    old=$(json "(v.find(a => a.name === $(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$name")) || {}).id" <"$work/existing.json")
    if [ -n "$old" ]; then
        status=$(gh_api DELETE "$github_api/repos/$github_repo/releases/assets/$old")
        [ "$status" = 204 ] || { echo "replacing $name failed (HTTP $status)" >&2; exit 1; }
    fi
    status=$(gh_api POST "$upload_url?name=$name" \
        -H "Content-Type: application/octet-stream" --data-binary "@$f")
    [ "$status" = 201 ] || { echo "uploading $name failed (HTTP $status): $(cat "$work/gh.json")" >&2; exit 1; }
    echo "uploaded $name"
done
echo "release: https://github.com/$github_repo/releases/tag/$tag"

# --- the image ---
if [ "$image" -eq 1 ]; then
    for dst in $targets; do
        if command -v crane >/dev/null 2>&1; then
            crane copy "$src" "$dst"
        elif command -v skopeo >/dev/null 2>&1; then
            skopeo copy --all "docker://$src" "docker://$dst"
        elif docker buildx version >/dev/null 2>&1; then
            echo "no crane or skopeo: copying with docker buildx imagetools, which gives $dst a new digest"
            docker buildx imagetools create --tag "$dst" "$src"
        else
            echo "copying the image needs crane, skopeo or docker buildx" >&2
            exit 1
        fi
        echo "copied $src to $dst"
    done
fi
