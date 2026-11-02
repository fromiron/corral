# Relocatable Linux x64 artifact feasibility

`build-linux.py` builds the current helper and pinned llama.cpp source in an
ephemeral Docker container, without mounting the user's home, credentials,
Docker socket, model, or GPU devices. It accepts only a digest-pinned Linux amd64
image and a new private output directory, caps CPU/RAM/time, and removes only
its own uniquely named container. The container installs standard distribution
build packages; nothing is installed globally on the host.
The host needs Docker, Git, Python 3.11 or later, and `readelf`; Docker Buildx is
not required. Direct host execution of the container shell script is refused.

```sh
python packages/local-intelligence/decision-helper/build-linux.py \
  --llama-dir /path/to/pinned/llama.cpp \
  --work /private/new-build-directory \
  --report /private/packaging-build.json
```

The default builder is official Ubuntu 24.04 at
`sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852`.
Ubuntu 22.04's standard repositories did not provide `glslc`; this recipe does
not add a compiler-from-source dependency chain to overcome that limitation.
The source is a Git archive of llama.cpp commit
`a91eab67d8389d979d29fdf6633b2edd0718eb4b`; untracked files, existing build outputs,
and Git authentication/configuration do not enter the container.

The observed Ubuntu 24.04 toolchain is GCC 13.3.0, CMake 3.28.3, shaderc
2023.8-1build1, binutils 2.42, and glibc 2.39. Apt package versions and the image
identity are recorded per build. Apt repositories are not snapshot-pinned, so
the recipe does not promise bit-identical future output.

The package keeps the helper, core libraries, CPU plugins, Vulkan plugin, and
license notices together. Every ELF has `$ORIGIN` RUNPATH. It uses upstream
`GGML_BACKEND_DL=ON`, `GGML_CPU_ALL_VARIANTS=ON`, and `GGML_NATIVE=OFF`: the x64
baseline and feature-checked optimized CPU variants are built separately.
Generic code and feature probes use `-march=x86-64 -mtune=generic`; upstream
feature probes additionally disable LTO. The helper source is unchanged.

The measured ELF requirements are `GLIBC_2.38`, `GLIBCXX_3.4.32`,
`CXXABI_1.3.13`, and `GOMP_4.5`. This is an Ubuntu 24.04-class userland artifact,
not a generic binary for every Linux x64 installation. glibc, libstdc++, libgcc,
libgomp, and the Vulkan loader/driver remain system dependencies. The pinned
Vulkan backend requires Vulkan 1.2; its stock shader compiler enables KHR
cooperative matrices but not the newer NVIDIA cooperative-matrix2 paths.

The package completed one CPU request in a fresh Ubuntu 24.04 container with
only runtime packages installed and the artifact relocated to `/artifact`.
The helper selected the Haswell plugin on the development host's Ryzen CPU;
the token fingerprint and all first-token logits matched the prior host build.
A separate Vulkan smoke on the current host's NVIDIA 615.78.08 driver verified
the actual GPU process, repeated A/B/A isolation, and six-recipient decoding at
129/354/1024 tokens. This does not verify an Ubuntu GPU driver installation.

The generated private report records each helper/library's exact size, SHA256,
NEEDED entries, loader paths, required symbol versions, and toolchain. Preserve
that report and the compile-command evidence with the artifact. Before release,
validate lower-ISA hardware, supported kernels/userlands, Vulkan inference,
packaged desktop startup, and the independent quality/resource gates against
these exact binaries. CPU/GPU timings from the previous host-native build do
not establish performance of this package. No artifact is published or enabled
by this recipe, and no production manifest/default is changed.
