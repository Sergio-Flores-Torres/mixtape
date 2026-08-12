#!/usr/bin/env bash
set -e

# Load from .env file if it exists
if [ -f .env ]; then
  set -o allexport
  source .env
  set +o allexport
fi

# Set default placeholders if API keys are not set in environment
export GEMINI_API_KEY="${GEMINI_API_KEY:-your_gemini_api_key_here}"
export NVIDIA_API_KEY="${NVIDIA_API_KEY:-your_nvidia_api_key_here}"

exec node server.js
