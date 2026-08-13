#!/usr/bin/env bash
# Double-click this file in Finder to start the companion server.
# (First time: right-click → Open, since macOS blocks unsigned scripts by
# default on a plain double-click. After that, double-click works normally.)
cd "$(dirname "$0")"
echo "Starting Incident Console companion server..."
echo "Leave this window open while you use the tool. Close it (or Ctrl+C) to stop the server."
echo ""
node companion-server.js
read -p "Press Enter to close this window..."
