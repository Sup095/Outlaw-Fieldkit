#!/bin/sh
# FieldKit runner :: the server's small AI models, for ASK (relay/tiny-ai.js).
#
#   sh tiny-ai.sh          fetch what is missing, start, say what to put in config
#   sh tiny-ai.sh stop     stop them; the files stay
#
# Each model is its own llama.cpp server, reachable only on this machine's
# tailnet address, because only the relay should talk to it: the relay is
# what checks that someone is a member. No sudo needed, only the docker group.
#
# They share the machine with RUNNER and RUNNER matters more, so they get a
# low CPU weight. Idle they cost memory and nothing else, and all of it
# together stays under 3 GB.
#
# The image and the files are pinned by hash. To change a model, change its
# line here; a file that does not match is deleted, not used.
set -eu

IMAGE="ghcr.io/ggml-org/llama.cpp@sha256:d9e9e74ba3f7ef119b1939162b1631f99b75ec703c310d140cfa2fdac8907389"
DIR="${TINY_AI_DIR:-$HOME/tiny-ai}"
THREADS="${TINY_AI_THREADS:-2}"
HF="https://huggingface.co"

# port|id|repo|file|sha256
MODELS="
8091|smollm2-360m|bartowski/SmolLM2-360M-Instruct-GGUF|SmolLM2-360M-Instruct-Q4_K_M.gguf|2fa3f013dcdd7b99f9b237717fa0b12d75bbb89984cc1274be1471a465bac9c2
8092|qwen2.5-0.5b|bartowski/Qwen2.5-0.5B-Instruct-GGUF|Qwen2.5-0.5B-Instruct-Q4_K_M.gguf|6eb923e7d26e9cea28811e1a8e852009b21242fb157b26149d3b188f3a8c8653
"

if [ "${1:-}" = "stop" ]; then
  for line in $MODELS; do
    id=$(echo "$line" | cut -d'|' -f2)
    docker rm -f "fk-ai-$id" >/dev/null 2>&1 || true
  done
  echo "stopped"
  exit 0
fi

ADDR=$(tailscale ip -4 | head -n 1)
[ -n "$ADDR" ] || { echo "this machine has no tailnet address" >&2; exit 1; }
mkdir -p "$DIR"
docker pull -q "$IMAGE" >/dev/null

for line in $MODELS; do
  port=$(echo "$line" | cut -d'|' -f1); id=$(echo "$line" | cut -d'|' -f2)
  repo=$(echo "$line" | cut -d'|' -f3); file=$(echo "$line" | cut -d'|' -f4)
  want=$(echo "$line" | cut -d'|' -f5)

  if [ ! -f "$DIR/$file" ]; then
    echo "fetching $file"
    curl -fsSL --retry 3 -C - -o "$DIR/$file.part" "$HF/$repo/resolve/main/$file"
    mv "$DIR/$file.part" "$DIR/$file"
  fi
  if [ "$(sha256sum "$DIR/$file" | cut -d' ' -f1)" != "$want" ]; then
    rm -f "$DIR/$file"
    echo "$file did not match its hash and was deleted" >&2
    exit 1
  fi

  docker rm -f "fk-ai-$id" >/dev/null 2>&1 || true
  docker run -d --name "fk-ai-$id" --restart unless-stopped \
    --publish "$ADDR:$port:8080" \
    --memory 1400m --cpu-shares 128 --pids-limit 64 \
    --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
    --volume "$DIR/$file:/model.gguf:ro" \
    "$IMAGE" \
    --model /model.gguf --host 0.0.0.0 --port 8080 \
    --threads "$THREADS" --ctx-size 2048 --parallel 1 --no-webui >/dev/null
  echo "started $id on $ADDR:$port"
done

cat <<EOF

Put this in the relay's config.json (the address is this machine's):

  "tinyAi": {
    "enabled": true,
    "maxBusy": 2,
    "models": [
      { "id": "smollm2-360m", "name": "SmolLM2 360M", "about": "quick, simple answers", "url": "http://$ADDR:8091" },
      { "id": "qwen2.5-0.5b", "name": "Qwen2.5 0.5B", "about": "better, a bit slower", "url": "http://$ADDR:8092" }
    ]
  }
EOF
