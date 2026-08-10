#!/usr/bin/env bash
# Run this from a terminal: ./start-companion-server.sh
# (Most Linux file managers don't execute scripts on double-click by default
# for security reasons — that's a file-manager setting, not something this
# script can change. Terminal is the reliable way to run it.)
cd "$(dirname "$0")"
echo "Starting Incident Console companion server..."
echo "Leave this terminal open while you use the tool. Ctrl+C to stop the server."
echo ""
node companion-server.js
