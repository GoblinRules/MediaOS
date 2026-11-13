# Build environment for the MediaOS packages and installer image: Node 22 on Debian 13 "trixie".
FROM node:22-trixie
RUN apt-get update \
 && apt-get install -y --no-install-recommends xorriso fakeroot gpg gpgv curl ca-certificates openssl dpkg-dev apt-utils \
 && rm -rf /var/lib/apt/lists/*
