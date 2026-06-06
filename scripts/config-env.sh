#!/usr/bin/env bash

trim_config_value() {
  local raw="$1"
  raw="${raw%$'\r'}"
  if [[ "$raw" =~ ^\"(.*)\"$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return
  fi
  if [[ "$raw" =~ ^\'(.*)\'$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return
  fi
  printf '%s' "$raw"
}

load_config_env() {
  local config_file="$1"
  [ -f "$config_file" ] || return 0

  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [[ -z "${line//[[:space:]]/}" ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      local name="${BASH_REMATCH[2]}"
      local raw_value="${BASH_REMATCH[3]}"
      local value
      value="$(trim_config_value "$raw_value")"
      export "$name=$value"
    fi
  done < "$config_file"
}

get_config_value() {
  local config_file="$1"
  local target_key="$2"
  [ -f "$config_file" ] || return 0

  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [[ -z "${line//[[:space:]]/}" ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      local name="${BASH_REMATCH[2]}"
      if [ "$name" != "$target_key" ]; then
        continue
      fi
      trim_config_value "${BASH_REMATCH[3]}"
      return 0
    fi
  done < "$config_file"
}

get_config() {
  get_config_value "$@"
}
