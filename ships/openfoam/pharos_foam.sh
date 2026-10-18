#!/bin/bash
# openfoam: runs an OpenFOAM case for Pharos.
#
#   pharos_foam.sh mesh  CASE
#   pharos_foam.sh solve CASE SPEED END_TIME
#
# Both copy CASE (a case folder: system/, constant/, 0/) to /out/case and
# mesh it with blockMesh unless it already has a mesh. `mesh` stops there,
# so the geometry can be looked at; `solve` also sets the inlet speed (patch
# "inlet", if the case has one) and the end time, and runs the solver its
# controlDict names, writing cell centres for rendering. Progress goes to
# stdout as JSON lines; full logs stay in the case.
# OpenFOAM's environment script uses unset variables: load it before strict mode
source /usr/lib/openfoam/openfoam2512/etc/bashrc >/dev/null 2>&1 || true
set -euo pipefail

progress() { printf '{"progress": %s, "message": "%s"}\n' "$1" "$2"; }

mode=${1:-}
case "$mode" in
  mesh) case_in=$2 ;;
  solve) case_in=$2; speed=$3; end_time=$4 ;;
  *) echo "usage: pharos_foam.sh mesh CASE | solve CASE SPEED END_TIME" >&2; exit 2 ;;
esac
[ -d "$case_in/system" ] && [ -d "$case_in/constant" ] || { echo "$case_in is not an OpenFOAM case (needs system/ and constant/)" >&2; exit 2; }

cp -r "$case_in" /out/case
cd /out/case
chmod -R u+w .

if [ "$mode" = mesh ]; then
  if [ ! -f constant/polyMesh/points ] && [ ! -f constant/polyMesh/points.gz ]; then
    progress 0.1 "meshing"
    blockMesh > log.blockMesh 2>&1 || { tail -20 log.blockMesh >&2; exit 1; }
  fi
  cells=$(checkMesh -constant 2>/dev/null | awk '/^ *cells:/{print $2; exit}')
  progress 1.0 "${cells:-?} cells"
  exit 0
fi

if [ -f 0/U ] && foamDictionary -entry boundaryField.inlet 0/U >/dev/null 2>&1; then
  foamDictionary -entry boundaryField.inlet.value -set "uniform ($speed 0 0)" 0/U >/dev/null 2>&1
  foamDictionary -entry internalField -set "uniform ($speed 0 0)" 0/U >/dev/null 2>&1
  echo "inlet speed set to $speed"
else
  echo "no 'inlet' patch in 0/U: the inlet speed is left as the case sets it" >&2
fi
foamDictionary -entry endTime -set "$end_time" system/controlDict >/dev/null 2>&1

if [ ! -f constant/polyMesh/points ] && [ ! -f constant/polyMesh/points.gz ]; then
  progress 0.02 "meshing"
  blockMesh > log.blockMesh 2>&1 || { tail -20 log.blockMesh >&2; exit 1; }
fi
cells=$(checkMesh -constant 2>/dev/null | awk '/^ *cells:/{print $2; exit}')
app=$(foamDictionary -entry application -value system/controlDict)
echo "running $app on ${cells:-?} cells up to t = $end_time"

progress 0.05 "solving with $app"
set +e
"$app" 2>&1 | tee "log.$app" | awk -v end="$end_time" '
  /^Time = / { t = $3 + 0; p = int(100 * t / end); if (p > last) { last = p; printf "{\"progress\": %.3f, \"message\": \"t = %s of %s s\"}\n", 0.05 + 0.9 * t / end, $3, end; fflush() } }'
status=${PIPESTATUS[0]}
set -e
if [ "$status" -ne 0 ]; then
  echo "$app failed:" >&2
  tail -25 "log.$app" >&2
  exit "$status"
fi

# a time step written incompletely (seen with Docker Desktop's file sharing) holds NUL bytes;
# drop it, so a damaged result is never handed on or cached
for dir in [0-9]*; do
  [ "$dir" = "0" ] && continue
  if LC_ALL=C grep -qlP '\x00' "$dir"/* 2>/dev/null; then
    echo "time $dir was written incompletely; leaving it out" >&2
    rm -rf "$dir"
  fi
done

progress 0.97 "writing cell centres"
postProcess -func writeCellCentres -time 0 > log.writeCellCentres 2>&1 || true
progress 1.0 "done"
