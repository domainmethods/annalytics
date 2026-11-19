#!/bin/sh
set -eu

if command -v terraform >/dev/null 2>&1; then
  tool=terraform
elif command -v tofu >/dev/null 2>&1; then
  tool=tofu
else
  echo "Terraform/OpenTofu not installed; install one to validate infrastructure" >&2
  exit 1
fi

cd "$(dirname "$0")/../infra"
"$tool" fmt -check
"$tool" init -backend=false -input=false
"$tool" validate
