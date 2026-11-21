#!/usr/bin/env bash
# One-step PromptFlow setup for macOS: installs what's missing, gets the code,
# makes sure a local Ollama model is ready, then builds and launches the app.
#
#   curl -fsSL https://raw.githubusercontent.com/Akhil21232123/prompt-flow/main/scripts/mac-setup.sh | bash
#
# Safe to run again: it skips anything already installed and pulls new code.
set -euo pipefail

say() { printf '\n\033[1;35m== %s\033[0m\n' "$*"; }
DIR="${PROMPTFLOW_DIR:-$HOME/prompt-flow}"
MODEL="${PROMPTFLOW_OLLAMA_MODEL:-llama3.1}"

say "Checking Xcode Command Line Tools"
if ! xcode-select -p >/dev/null 2>&1; then
  xcode-select --install || true
  echo "A window opened to install the Command Line Tools. Finish it, then run this command again."
  exit 1
fi

say "Checking Homebrew"
if ! command -v brew >/dev/null 2>&1; then
  for b in /opt/homebrew/bin/brew "$HOME/.homebrew/bin/brew" /usr/local/bin/brew; do
    if [ -x "$b" ]; then eval "$("$b" shellenv)"; break; fi
  done
fi
command -v brew >/dev/null 2>&1 && echo "brew: $(command -v brew)" || echo "brew not found (only needed if cmake is missing)"

say "Checking Rust"
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
if ! command -v cargo >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  . "$HOME/.cargo/env"
fi
rustup update stable >/dev/null 2>&1 || true
cargo --version

say "Checking Bun"
export PATH="$HOME/.bun/bin:$PATH"
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi
bun --version

say "Checking CMake"
if ! command -v cmake >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    brew install cmake
  else
    echo "CMake is missing and Homebrew isn't available. Install CMake from https://cmake.org/download/ and run again."
    exit 1
  fi
fi
cmake --version | head -1

say "Checking local AI (Ollama, model: $MODEL)"
if command -v ollama >/dev/null 2>&1 || [ -d /Applications/Ollama.app ]; then
  if ! curl -fsS http://localhost:11434/api/tags >/dev/null 2>&1; then
    open -a Ollama 2>/dev/null || (nohup ollama serve >/dev/null 2>&1 &)
    for _ in $(seq 1 20); do
      curl -fsS http://localhost:11434/api/tags >/dev/null 2>&1 && break
      sleep 1
    done
  fi
  if command -v ollama >/dev/null 2>&1; then
    ollama list | awk '{print $1}' | grep -q "^${MODEL}" || ollama pull "$MODEL"
    ollama list
  fi
else
  echo "Ollama isn't installed; skipping. Get it from https://ollama.com or use a cloud key in the app."
fi

say "Getting the code into $DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone https://github.com/Akhil21232123/prompt-flow.git "$DIR"
fi
cd "$DIR"

say "Installing frontend packages"
bun install

say "Building and launching PromptFlow (first build takes 5-15 minutes)"
echo "Build log: $DIR/build.log"
bun run tauri dev 2>&1 | tee "$DIR/build.log"
