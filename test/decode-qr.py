#!/usr/bin/env python3
"""Independent QR verification: render the module matrix produced by the
vendored JS QR library (test/run-tests.mjs section B) to a PNG and decode
it with OpenCV. The decoded text must equal the BIP21 URI the app intended
to encode — this proves the QR codes actually scan to the right payment.

Usage:  python3 test/decode-qr.py [/tmp/bchpay-qr.json]
Requires: opencv-python-headless, numpy (dev-only test dependency).
"""
import json
import sys

import cv2
import numpy as np

path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/bchpay-qr.json"
with open(path) as f:
    data = json.load(f)

modules = np.array(data["modules"], dtype=np.uint8)
n = modules.shape[0]
scale, border = 10, 4
img = np.ones(((n + 2 * border) * scale, (n + 2 * border) * scale), dtype=np.uint8) * 255
for r in range(n):
    for c in range(n):
        if modules[r, c]:
            y, x = (r + border) * scale, (c + border) * scale
            img[y:y + scale, x:x + scale] = 0

png_path = "/tmp/bchpay-qr.png"
cv2.imwrite(png_path, img)

decoded, points, _ = cv2.QRCodeDetector().detectAndDecode(cv2.imread(png_path))
print("expected:", data["uri"])
print("decoded :", decoded)
if decoded == data["uri"]:
    print("QR DECODE MATCH ✓")
    sys.exit(0)
print("QR DECODE MISMATCH ✗")
sys.exit(1)
