#!/bin/sh
set -eu

version=${LOOKOUT_VERSION:?missing verified source version}
commit=${CI_COMMIT_SHA:?missing source SHA}
image=lookout:ci-${CI_JOB_ID:?missing image job ID}
release=
existing=false

if [ -n "${LOOKOUT_RELEASE_TAG:-}" ]; then
    if [ "${CI_COMMIT_REF_PROTECTED:-}" != true ] || [ "${CI_COMMIT_TAG:-}" != "v$version" ] || \
        [ "$LOOKOUT_RELEASE_TAG" != "$CI_COMMIT_TAG" ]; then
        printf '%s\n' 'Image publication requires a protected tag matching the verified source version.' >&2
        exit 1
    fi
    release=${CI_REGISTRY_IMAGE:?enable the GitLab registry}:$LOOKOUT_RELEASE_TAG
    DOCKER_CONFIG=$(mktemp -d)
    export DOCKER_CONFIG
    cleanup_credentials() {
        if [ -f "$DOCKER_CONFIG/config.json" ]; then unlink "$DOCKER_CONFIG/config.json"; fi
        rmdir "$DOCKER_CONFIG" 2>/dev/null || :
    }
    trap cleanup_credentials EXIT
    printf '%s' "${CI_REGISTRY_PASSWORD:?missing CI registry credential}" |
        docker login --username "${CI_REGISTRY_USER:?missing CI registry user}" --password-stdin "${CI_REGISTRY:?missing registry}"

    if result=$(docker pull --platform linux/amd64 "$release" 2>&1); then
        image=$release
        existing=true
    elif ! printf '%s\n' "$result" | grep -Eiq 'manifest unknown|manifest.*not found|name unknown'; then
        printf '%s\n' 'Could not verify whether the release image already exists in the registry.' >&2
        exit 1
    fi
fi

if [ "$existing" = false ]; then
    docker build --pull --platform linux/amd64 --build-arg "LOOKOUT_VERSION=$version" \
        --build-arg "SOURCE_COMMIT=$commit" --tag "$image" .
fi

metadata=$(docker image inspect --format '{{.Os}}/{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.version"}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
if [ "$metadata" != "linux/amd64 $version $commit" ]; then
    printf '%s\n' 'The image has an unexpected platform, version, or source revision. Refusing to replace the tag.' >&2
    exit 1
fi
sh scripts/ci/container-smoke.sh "$image" "$version" "$commit"

mkdir -p .artifacts/ci
if [ -z "$release" ]; then
    printf 'LOOKOUT_RELEASE_DIGEST=\n' > .artifacts/ci/image.env
    exit 0
fi

tested=$(docker image inspect --format '{{.Id}}' "$image")
if [ "$existing" = false ]; then
    docker tag "$image" "$release"
    docker push "$release"
fi
docker pull --platform linux/amd64 "$release"
test "$(docker image inspect --format '{{.Id}}' "$release")" = "$tested"
digest=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$release" |
    awk -v prefix="$CI_REGISTRY_IMAGE@" 'index($0, prefix) == 1 { print substr($0, length(prefix) + 1); exit }')
printf '%s\n' "$digest" | grep -Eq '^sha256:[0-9a-f]{64}$'
printf 'LOOKOUT_RELEASE_DIGEST=%s\n' "$digest" > .artifacts/ci/image.env
