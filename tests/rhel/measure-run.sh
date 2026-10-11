#!/usr/bin/env bash
# Runs one report command and records wall time, the Node process peak RSS/CPU, and the memory/CPU of the renderer and Grafana containers
# sampled every 2 seconds while it runs. Test machine only.
#   tests/rhel/measure-run.sh <label> -- <command...>        (sets REPORT_SETTINGS before calling)
set -uo pipefail
LABEL=$1; shift; [ "$1" = "--" ] && shift
OUT=${MEASURE_OUT:-/tmp/measure-$LABEL}
rm -f "$OUT.stats" "$OUT.time"
( while true; do
    printf '%s ' "$(date +%s)" >> "$OUT.stats"
    sudo docker stats --no-stream --format '{{.Name}}={{.MemUsage}}/{{.CPUPerc}}' renderer grafana ch 2>/dev/null | tr '\n' ' ' >> "$OUT.stats"
    # rootless podman (the PDF step) is invisible to docker stats: sample its processes instead
    printf 'podman_rss_kb=%s\n' "$(ps -eo rss,comm | awk '/chrom|crun|conmon/ {s+=$1} END {print s+0}')" >> "$OUT.stats"
    sleep 2
  done ) &
SAMPLER=$!
START=$(date +%s%N)
/usr/bin/time -v -o "$OUT.time" "$@"
RC=$?
END=$(date +%s%N)
kill "$SAMPLER" 2>/dev/null; wait "$SAMPLER" 2>/dev/null
echo "== $LABEL: rc=$RC wall=$(( (END - START) / 1000000 )) ms"
grep -E 'Maximum resident|Elapsed|Percent of CPU|User time|System time' "$OUT.time" | sed 's/^\t*/   /'
node -e '
const lines = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n");
const mb = (s) => { const m = s.match(/([\d.]+)(MiB|GiB|KiB)/); return m ? Number(m[1]) * ({ KiB: 1 / 1024, MiB: 1, GiB: 1024 }[m[2]]) : 0; };
const peak = {};
for (const l of lines) for (const m of l.matchAll(/(\w+)=([\d.]+(?:MiB|GiB|KiB))[^/]*\/[^/]*\/?\s*([\d.]+)%/g)) { const k = m[1]; peak[k] = peak[k] || { mem: 0, cpu: 0 }; peak[k].mem = Math.max(peak[k].mem, mb(m[2])); peak[k].cpu = Math.max(peak[k].cpu, Number(m[3])); }
let pod = 0; for (const l of lines) { const m = l.match(/podman_rss_kb=(\d+)/); if (m) pod = Math.max(pod, Number(m[1]) / 1024); }
for (const [k, v] of Object.entries(peak)) console.log(`   ${k}: peak mem ${v.mem.toFixed(0)} MiB, peak cpu ${v.cpu.toFixed(0)} %`);
console.log(`   chromium/podman processes: peak RSS ${pod.toFixed(0)} MiB`);
' "$OUT.stats"
exit "$RC"
