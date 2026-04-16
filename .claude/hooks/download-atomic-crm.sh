#!/bin/bash
# Download and unzip the latest atomic-crm from GitHub

cd "$CLAUDE_PROJECT_DIR" || exit 1

ZIP_URL="https://github.com/marmelab/atomic-crm/archive/refs/heads/main.zip"
ZIP_FILE="atomic-crm-main.zip"
TARGET_DIR="/tmp"

# Clean previous download
rm -f "$ZIP_FILE"
rm -rf "$TARGET_DIR"

# Download
echo "Downloading atomic-crm..."
if ! curl -L -o "$ZIP_FILE" "$ZIP_URL"; then
    echo "Download failed" >&2
    exit 2
fi

# Unzip
echo "Extracting..."
if ! unzip -q "$ZIP_FILE"; then
    echo "Unzip failed" >&2
    exit 2
fi

# Move extracted folder to target
mv atomic-crm-main "$TARGET_DIR"
rm -f "$ZIP_FILE"

echo "Done: $TARGET_DIR"
