#!/usr/bin/env bash
# make-demo-gif.sh — turn a screen recording into a polished demo mp4 + gif.
#
# Usage:
#   bash scripts/make-demo-gif.sh ~/Desktop/demo.mov            # single clip
#   SPEED=6 START=3 END=70 bash scripts/make-demo-gif.sh in.mov # tuned
#   bash scripts/make-demo-gif.sh a.mov b.mov c.mov             # multi-clip + transitions
#
# Env knobs (all optional):
#   SPEED=4     playback speed-up factor
#   START=0     trim start (seconds, source time)
#   END=        trim end (seconds, source time; empty = to the end)
#   W=1100      output width (px)
#   FPS=12      gif frame rate (lower = smaller file)
#   CROP=       crop a window region: "w:h:x:y" (e.g. 1200:760:100:120)
#   TRANS=fade  transition between clips (fade|dissolve|wipeleft|slideup|circleopen|smoothleft …)
#   OUT=demo    output basename
set -euo pipefail

command -v ffmpeg >/dev/null || { echo "ffmpeg not found — brew install ffmpeg"; exit 1; }
[ "$#" -ge 1 ] || { echo "usage: $0 <recording.mov> [more.mov ...]"; exit 1; }

SPEED=${SPEED:-4}; START=${START:-0}; END=${END:-}; W=${W:-1100}
FPS=${FPS:-12}; CROP=${CROP:-}; TRANS=${TRANS:-fade}; OUT=${OUT:-demo}
FADE=0.5  # in/out fade seconds
NORM="format=yuv420p,setsar=1"
[ -n "$CROP" ] && PRE="crop=$CROP," || PRE=""

dur() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1"; }

# ---- normalize one input into a temp mp4 (trim, speed, scale, fps) ----
norm_clip() {
  local in="$1" out="$2"
  local ss=("-ss" "$START"); local tt=()
  [ -n "$END" ] && tt=("-t" "$(awk "BEGIN{print $END-$START}")")
  ffmpeg -y -loglevel error "${ss[@]}" "${tt[@]}" -i "$in" \
    -vf "${PRE}setpts=(PTS-STARTPTS)/${SPEED},scale=${W}:-2:flags=lanczos,fps=${FPS},${NORM}" \
    -an "$out"
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if [ "$#" -eq 1 ]; then
  norm_clip "$1" "$TMP/0.mp4"
  STAGE="$TMP/0.mp4"
else
  # normalize every clip, then chain xfade transitions with cumulative offsets
  i=0; for f in "$@"; do norm_clip "$f" "$TMP/$i.mp4"; i=$((i+1)); done
  cur="$TMP/0.mp4"; off=$(dur "$cur")
  for ((j=1; j<$#; j++)); do
    next="$TMP/$j.mp4"
    o=$(awk "BEGIN{print $off-$FADE}")
    ffmpeg -y -loglevel error -i "$cur" -i "$next" -filter_complex \
      "[0][1]xfade=transition=${TRANS}:duration=${FADE}:offset=${o},${NORM}" \
      -an "$TMP/m$j.mp4"
    cur="$TMP/m$j.mp4"
    off=$(awk "BEGIN{print $off+$(dur "$next")-$FADE}")
  done
  STAGE="$cur"
fi

# ---- fade in/out on the final timeline ----
OD=$(dur "$STAGE"); FO=$(awk "BEGIN{v=$OD-$FADE; print (v<0)?0:v}")
ffmpeg -y -loglevel error -i "$STAGE" \
  -vf "fade=t=in:st=0:d=${FADE},fade=t=out:st=${FO}:d=${FADE},${NORM}" \
  -c:v libx264 -crf 20 -pix_fmt yuv420p -an "${OUT}.mp4"

# ---- high-quality gif via per-frame palette ----
ffmpeg -y -loglevel error -i "${OUT}.mp4" \
  -vf "fps=${FPS},scale=${W}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" \
  -loop 0 "${OUT}.gif"

sz=$(( $(stat -f%z "${OUT}.gif") / 1024 ))
echo "✓ ${OUT}.mp4 and ${OUT}.gif  (gif ${sz} KB)"
[ "$sz" -gt 5120 ] && echo "⚠ gif > 5MB — rerun with lower FPS (e.g. FPS=10) or W=900"
exit 0
