#!/bin/bash
# Convert all .bmp files in a directory to .png (using macOS built-in sips)
# Usage: ./scripts/bmp2png.sh <directory>
#   or:  bash scripts/bmp2png.sh <directory>

set -euo pipefail

DIR="${1:-.}"

if [ ! -d "$DIR" ]; then
  echo "Error: '$DIR' is not a directory"
  exit 1
fi

shopt -s nullglob
bmps=("$DIR"/*.bmp "$DIR"/*.BMP)
shopt -u nullglob

if [ ${#bmps[@]} -eq 0 ]; then
  echo "No .bmp files found in '$DIR'"
  exit 0
fi

count=0
for bmp in "${bmps[@]}"; do
  png="${bmp%.bmp}.png"
  png="${png%.BMP}"
  sips -s format png "$bmp" --out "$png" > /dev/null 2>&1
  echo "✓ $(basename "$bmp") → $(basename "$png")"
  ((count++))
done

echo ""
echo "Converted $count file(s) to PNG."
