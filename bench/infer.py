"""NumPy equivalent of infer.hk: y = relu(x @ W + b), argmax per row.

This is the honest comparison for the inference claim. NumPy's matmul is
already C (and usually BLAS, multi-threaded), so this is not "compiled beats
interpreted" — it is Halka's generated C against a tuned numerical library.
"""

import time

import numpy as np

ROWS = 4096
FEATS = 512
CLASSES = 32

i = np.arange(FEATS * CLASSES, dtype=np.float64)
w = (0.001 * ((i % 7) - 3.0)).reshape(CLASSES, FEATS)

b = 0.01 * np.arange(CLASSES, dtype=np.float64)

j = np.arange(ROWS * FEATS, dtype=np.float64)
x = (0.5 * ((j % 13) - 6.0)).reshape(ROWS, FEATS)

t0 = time.perf_counter()
y = np.maximum(x @ w.T + b, 0.0)
total = int(y.argmax(axis=1).sum())
ms = (time.perf_counter() - t0) * 1000.0

print(f"infer checksum {total}")
# Reported separately because the wall-clock figure for this script is
# almost entirely `import numpy`, not arithmetic.
print(f"compute {ms:.0f} ms")
