#!/bin/sh
# Runs only in the private build container created by build-linux.py.
set -eu
if [ ! -f /.dockerenv ] || [ ! -r /input/llama.tar ] || [ ! -d /work ]; then
  echo 'This script only runs inside the private build-linux.py container.' >&2
  exit 2
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends build-essential cmake ninja-build git python3 \
  ca-certificates binutils libvulkan-dev glslc spirv-headers

mkdir -p /work/source /work/package/notices /work/evidence
tar -xf /input/llama.tar -C /work/source
cmake -S /work/source -B /work/build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
  '-DCMAKE_C_FLAGS=-march=x86-64 -mtune=generic -ffile-prefix-map=/work/source=llama.cpp' \
  '-DCMAKE_CXX_FLAGS=-march=x86-64 -mtune=generic -ffile-prefix-map=/work/source=llama.cpp' \
  -DCMAKE_BUILD_RPATH_USE_ORIGIN=ON -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON \
  '-DCMAKE_INSTALL_RPATH=$ORIGIN' \
  -DBUILD_SHARED_LIBS=ON -DGGML_NATIVE=OFF -DGGML_BACKEND_DL=ON \
  -DGGML_CPU_ALL_VARIANTS=ON -DGGML_VULKAN=ON -DGGML_RPC=OFF \
  -DGGML_CPU_KLEIDIAI=OFF -DGGML_LLAMAFILE=ON \
  -DLLAMA_BUILD_COMMON=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_TOOLS=OFF \
  -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_SERVER=OFF -DLLAMA_BUILD_APP=OFF \
  -DLLAMA_BUILD_UI=OFF -DLLAMA_OPENSSL=OFF -DLLAMA_SUBPROCESS=OFF -DLLAMA_CONNECT=OFF \
  -DLLAMA_BUILD_COMMIT="$LLAMA_COMMIT"
cmake --build /work/build --target llama --parallel "$BUILD_JOBS"

c++ -std=c++17 -O2 -Wall -Wextra -Werror -march=x86-64 -mtune=generic \
  -ffile-prefix-map=/input=corral \
  -I/work/source/include -I/work/source/ggml/include -I/work/source/vendor \
  /input/main.cpp -L/work/build/bin '-Wl,-rpath,$ORIGIN' \
  -lllama -lggml -lggml-base -o /work/package/corral-local-decision-helper
for library in libllama.so.0 libggml.so.0 libggml-base.so.0; do
  cp -L "/work/build/bin/$library" "/work/package/$library"
done
for library in /work/build/bin/libggml-cpu*.so /work/build/bin/libggml-vulkan.so; do
  cp -L "$library" "/work/package/$(basename "$library")"
done
test -f /work/package/libggml-cpu-x64.so
test -f /work/package/libggml-vulkan.so
strip --strip-unneeded /work/package/corral-local-decision-helper /work/package/*.so*

cp /work/source/LICENSE /work/package/notices/llama.cpp-MIT.txt
cp /input/project-license.txt /work/package/notices/Corral-MIT.txt
python3 - <<'PY'
from pathlib import Path
import json, subprocess
out = Path('/work/package/notices')
header = Path('/work/source/vendor/nlohmann/json.hpp').read_text()
license_lines = [line.removeprefix('// ') for line in header.splitlines()[:8] if 'SPDX-' in line]
permission = 'Permission is hereby granted' + Path('/work/source/LICENSE').read_text().split('Permission is hereby granted', 1)[1]
(out / 'nlohmann-json-3.12.0-notice.txt').write_text('\n'.join(license_lines) + '\n\n' + permission)
sgemm = Path('/work/source/ggml/src/ggml-cpu/llamafile/sgemm.cpp').read_text()
(out / 'llamafile-MIT.txt').write_text(sgemm.split('\n\n', 1)[0] + '\n')
(out / 'YaRN-MIT.txt').write_text('Copyright (c) 2023 Jeffrey Quesnelle and Bowen Peng.\n\n' + permission)
packages = ['libc6', 'libstdc++6', 'libgcc-s1', 'libgomp1', 'libvulkan1', 'libvulkan-dev',
            'glslc', 'spirv-headers', 'gcc', 'g++', 'cmake', 'ninja-build', 'binutils']
installed = {}
for package in packages:
    installed[package] = subprocess.check_output(['dpkg-query', '-W', '-f=${Version}', package], text=True)
    copyright_file = Path('/usr/share/doc') / package / 'copyright'
    if copyright_file.exists():
        (out / (package + '-copyright.txt')).write_bytes(copyright_file.read_bytes())
toolchain = {command: subprocess.check_output([command, '--version'], text=True).splitlines()[0]
             for command in ['c++', 'cmake', 'glslc', 'ldd', 'readelf']}
Path('/work/evidence/toolchain.json').write_text(json.dumps({'packages': installed, 'tools': toolchain,
    'osRelease': Path('/etc/os-release').read_text()}, indent=2) + '\n')
PY
cp /work/build/CMakeCache.txt /work/evidence/CMakeCache.txt
cp /work/build/compile_commands.json /work/evidence/compile_commands.json
chown -R "$BUILD_UID:$BUILD_GID" /work
