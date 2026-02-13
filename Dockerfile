FROM gitpod/openvscode-server:1.86.2

# Install language runtimes so extensions and Code Runner can execute them.
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-tk \
      openjdk-17-jdk \
      nodejs npm \
 && ln -sf /usr/bin/python3 /usr/local/bin/python \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# Keep timezone and workspace directory; then run as the normal openvscode user.
ENV TZ=UTC
USER openvscode-server
WORKDIR /home/workspace

# Default command is provided by the base image and can be overridden from docker-compose
