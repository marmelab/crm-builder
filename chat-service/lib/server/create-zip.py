#!/usr/bin/env python3
import zipfile, os, sys

content_dir = sys.argv[1]
output_path = sys.argv[2]

with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk(content_dir):
        for f in files:
            abs_path = os.path.join(root, f)
            rel_path = os.path.relpath(abs_path, content_dir)
            zf.write(abs_path, rel_path)
