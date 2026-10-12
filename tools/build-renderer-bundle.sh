#!/usr/bin/env bash
# Builds the OFFLINE bundle of the pinned Grafana Image Renderer container image (it also provides the Chromium used for PDF printing).
#   tools/build-renderer-bundle.sh [output-dir]       (needs podman or docker, and Internet access, on the build machine)
# The image is pinned by DIGEST in config/reports/renderer.env.example; the pulled image is verified against it before it is saved.
# Result: <output-dir>/grafana-image-renderer-<tag>.tar.gz  (+ .sha256).  On the isolated host (rootless and root images are SEPARATE stores)
# load it for each user that runs containers; the loader verifies the image ID and tags it localhost/grafana-image-renderer:pinned:
#   sudo /usr/local/sbin/grafana-report load-image grafana-image-renderer-*.tar.gz --as-user grafana-report    # the PDF step
#   sudo /usr/local/sbin/grafana-report load-image grafana-image-renderer-*.tar.gz                             # root store: grafana-image-renderer.service
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=${1:-dist}
ENGINE=$(command -v podman || command -v docker || true)
[ -n "$ENGINE" ] || { echo "ERROR: podman or docker is required" >&2; exit 1; }
IMAGE=$(sed -n 's/^RENDERER_IMAGE=//p' config/reports/renderer.env.example)
[ -n "$IMAGE" ] || { echo "ERROR: RENDERER_IMAGE not found in config/reports/renderer.env.example" >&2; exit 1; }
DIGEST=${IMAGE##*@}
case "$DIGEST" in sha256:????????????????????????????????????????????????????????????????) ;; *) echo "ERROR: the image is not pinned by digest: $IMAGE" >&2; exit 1;; esac
mkdir -p "$OUT"
echo "== pulling $IMAGE"
"$ENGINE" pull -q "$IMAGE" >/dev/null
GOT=$("$ENGINE" image inspect --format '{{.Digest}}' "$IMAGE" 2>/dev/null || "$ENGINE" image inspect --format '{{index .RepoDigests 0}}' "$IMAGE")
case "$GOT" in *"$DIGEST"*) echo "   digest verified: $DIGEST";; *) echo "ERROR: pulled digest '$GOT' differs from the pinned $DIGEST" >&2; exit 1;; esac
NAME=grafana-image-renderer-$(echo "$DIGEST" | cut -c8-19)
echo "== saving"
"$ENGINE" save "$IMAGE" | gzip -9 > "$OUT/$NAME.tar.gz"
( cd "$OUT" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256" )
ID=$("$ENGINE" image inspect --format '{{.Id}}' "$IMAGE"); WANT=$(sed -n 's/^RENDERER_IMAGE_ID=//p' config/reports/renderer.env.example)
[ -z "$WANT" ] || [ "$ID" = "$WANT" ] || { echo "ERROR: image ID $ID differs from RENDERER_IMAGE_ID $WANT in config/reports/renderer.env.example" >&2; exit 1; }
{ echo "grafana-image-renderer offline bundle"; echo "image: $IMAGE"; echo "image-id: $ID"; echo "built: $(date -u +%FT%TZ)"; echo "engine: $("$ENGINE" --version)"; } > "$OUT/$NAME.MANIFEST.txt"
echo "built: $OUT/$NAME.tar.gz ($(du -h "$OUT/$NAME.tar.gz" | cut -f1))"; cat "$OUT/$NAME.tar.gz.sha256"
