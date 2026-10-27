# FieldKit RUNNER :: the box for programs with a window (phase 6)
#
# The Windows box (image-wine) plus a screen: a virtual X display
# nobody can see (Xvfb), a window manager that makes every window
# fill it, software OpenGL and Vulkan (Mesa: llvmpipe and lavapipe,
# enough for 2D games and Godot's Compatibility renderer), and the
# encoder that turns the screen into H.264 for the panel.
#
# fk-screen is the only new moving part: it starts all of that,
# runs the program on it, and puts video and the program's own
# output on one stream for runnerd. The sandbox around it is the
# same as for every other job (runnerd/sandbox.js), gVisor included.
FROM fieldkit-runner-wine:1

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb xauth matchbox-window-manager x11-xkb-utils xkb-data \
      ffmpeg python3-minimal libpython3-stdlib python3-xlib python3-tk nodejs bash \
      libgl1-mesa-dri libglx-mesa0 libegl1 libgles2 mesa-vulkan-drivers libvulkan1 \
      pulseaudio fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* \
 && rm -f /usr/bin/apt* /usr/bin/dpkg* 2>/dev/null || true

COPY fk-screen.py /usr/local/bin/fk-screen
RUN sed -i 's/\r$//' /usr/local/bin/fk-screen && chmod 0755 /usr/local/bin/fk-screen

USER 65534:65534
WORKDIR /work
