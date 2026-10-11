#!/bin/bash
# Saves files to an SMB share on the user's NAS for agents, without them ever
# seeing the NAS password. Adds files only: it never deletes or overwrites.
#
#   ~/nas.sh ls [folder]               List a folder on the share (default: its top).
#   ~/nas.sh put <file> <folder>       Upload a file into a folder, creating the folder if needed.
#                                      Refuses if a file with that name is already there.
#   ~/nas.sh setup //<host>/<share>    For the user: asks for the NAS account in a password
#                                      dialog on desktop 1, saves it, and tests it.
#
# The share and account live in ~/.config/t3-nas/ (mode 600), outside every repository.
set -euo pipefail
dir="$HOME/.config/t3-nas"
creds="$dir/credentials"

die() { echo "$*" >&2; exit 1; }
share=$(cat "$dir/share" 2>/dev/null || true)
require_setup() {
  [ -n "$share" ] && [ -f "$creds" ] || die "The NAS isn't set up yet: run ~/nas.sh setup //<host>/<share>."
}
# Folder paths use forward slashes, without quotes or "..".
check_path() {
  [[ "$1" != *'"'* && "$1" != *'\'* && "/$1/" != *"/../"* ]] || die "Unsupported path: $1"
}
smb() { smbclient "$share" -A "$creds" -c "$1"; }

case "${1:-}" in
  ls)
    require_setup
    folder="${2:-}"
    check_path "$folder"
    smb "cd \"/$folder\"; ls"
    ;;
  put)
    require_setup
    file="${2:-}"
    folder="${3:-}"
    [ -f "$file" ] || die "usage: $0 put <file> <folder>"
    check_path "$folder"
    name="$(basename "$file")"
    check_path "$name"
    # Create each missing folder level; mkdir on an existing folder just fails.
    path=""
    IFS=/ read -ra parts <<<"$folder"
    for part in "${parts[@]}"; do
      [ -n "$part" ] || continue
      path="$path/$part"
      smb "mkdir \"$path\"" >/dev/null 2>&1 || true
    done
    if smb "cd \"/$folder\"; allinfo \"$name\"" >/dev/null 2>&1; then
      die "\"$folder/$name\" already exists on the NAS; choose a new name (for example add a date or version)."
    fi
    smb "cd \"/$folder\"; put \"$file\" \"$name\"" >/dev/null
    echo "Saved to $share/$folder/$name"
    ;;
  setup)
    target="${2:-}"
    [[ "$target" =~ ^//[^/]+/[^/]+$ ]] || die "usage: $0 setup //<host>/<share>"
    export DISPLAY=:1
    user=$(zenity --entry --title="NAS account" --text="User name for $target" --width=360) || die "Cancelled."
    pass=$(zenity --password --title="NAS password for $user") || die "Cancelled."
    mkdir -p -m 700 "$dir"
    (umask 077; printf 'username=%s\npassword=%s\n' "$user" "$pass" >"$creds.new")
    unset pass
    if smbclient "$target" -A "$creds.new" -c "ls" >/dev/null 2>&1; then
      mv "$creds.new" "$creds"
      printf '%s\n' "$target" >"$dir/share"
      zenity --info --title="NAS" --text="Connected to $target as $user." --width=320 || true
      echo "Connected to $target as $user."
    else
      rm -f "$creds.new"
      zenity --error --title="NAS" --text="Couldn't sign in to $target as $user." --width=320 || true
      die "Couldn't sign in to $target as $user; nothing was saved."
    fi
    ;;
  *)
    sed -n '2,12p' "$0"
    ;;
esac
