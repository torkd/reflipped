# Builds the AIR shell on any host with Docker (Windows, macOS, Linux). The build context is client/air-shell:
#   docker build --platform linux/amd64 -t reflipped-shell-builder -f client/air-shell/container/Dockerfile client/air-shell
#   docker run --rm -it --platform linux/amd64 -v reflipped-shell-sdk:/sdk -v "<folder>:/work" reflipped-shell-builder
# <folder> holds your World Flipper APK and the AIR SDK zip you downloaded yourself (AIRSDK_Linux.zip); the APK
# and the signing key are written back to it. See docs/connecting-air-shell.md.
#
# The image contains no game files and no AIR SDK: the AIR SDK licence only lets people who accepted it download
# the SDK (docs/air-licence.md), so it comes from <folder> at run time. setup-sdk.sh fetches the JDK and the
# Android SDK into the /sdk volume on the first run and shows Google's terms; older Android tools ask for a y (hence -it).
# linux/amd64 only: Google ships the Android build tools for x86_64 Linux only.

FROM debian:12-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tar unzip python3 python3-pil coreutils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# .dockerignore keeps build/ (game files and APKs from earlier local builds) out of the image
COPY . ./
RUN chmod +x setup-sdk.sh container/entrypoint.sh
VOLUME ["/sdk", "/work"]
ENTRYPOINT ["/src/container/entrypoint.sh"]
