# Builds the AIR shell on any host with Docker (Windows, macOS, Linux). The build context is the repository root, so
# the app carries the Reflipped server for playing on the phone like every other build:
#   docker build --platform linux/amd64 -t reflipped-shell-builder -f client/air-shell/container/Dockerfile .
#   docker run --rm -it --platform linux/amd64 -v reflipped-shell-sdk:/sdk -v "<folder>:/work" reflipped-shell-builder
# <folder> holds your World Flipper APK and the AIR SDK zip you downloaded yourself (AIRSDK_Linux.zip); the APK
# and the signing key are written back to it. See docs/connecting-air-shell.md.
#
# The image contains no game files and no AIR SDK: the AIR SDK licence only lets people who accepted it download
# the SDK (docs/air-licence.md), so it comes from <folder> at run time. setup-sdk.sh fetches the JDK and the
# Android SDK into the /sdk volume on the first run and shows Google's terms; older Android tools ask for a y (hence -it).
# The Node runtime for the phone is downloaded on the first run too and kept in the /sdk volume.
# linux/amd64 only: Google ships the Android build tools for x86_64 Linux only.
# Which files go in: Dockerfile.dockerignore next to this file (BuildKit, the default builder since Docker 23).

FROM node:24-bookworm-slim
# clang, lld and llvm build the JNI launcher of the server on the phone (tools/node_runtime.py)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tar unzip python3 python3-pil coreutils \
       clang lld llvm \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . ./
# The server for playing on the phone, bundled once here without the game data (it reads that from the data pack);
# build.py packs it into the app. The context has no .git
# folder: pass the commit it reports with --build-arg REFLIPPED_COMMIT=$(git rev-parse --short=12 HEAD).
ARG REFLIPPED_COMMIT=""
RUN REFLIPPED_COMMIT="$REFLIPPED_COMMIT" npm run --silent bundle -- --minify --no-assets --out /opt/reflipped-server
RUN chmod +x client/air-shell/setup-sdk.sh client/air-shell/container/entrypoint.sh
ENV SRC=/repo/client/air-shell \
    SERVER_BUNDLE=/opt/reflipped-server
VOLUME ["/sdk", "/work"]
ENTRYPOINT ["/repo/client/air-shell/container/entrypoint.sh"]
