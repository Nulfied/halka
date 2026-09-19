"""The GIL, measured.

Runs the same Mandelbrot work single-threaded and then split across 8 Python
threads. Pure-Python threads cannot run bytecode concurrently, so the second
number does not improve -- this is the wall Halka's `parallel:` does not hit.
"""
import threading, time, sys

W = H = 300
LIMIT = 200

def escapes(cr, ci, limit):
    zr = 0.0; zi = 0.0; i = 0
    while i < limit:
        zr2 = zr * zr; zi2 = zi * zi
        if zr2 + zi2 > 4.0:
            return i
        zi = 2.0 * zr * zi + ci
        zr = zr2 - zi2 + cr
        i += 1
    return limit

def band(y0, y1, out, slot):
    acc = 0
    for y in range(y0, y1):
        for x in range(W):
            cr = -2.0 + 3.0 * x / W
            ci = -1.2 + 2.4 * y / H
            acc += escapes(cr, ci, LIMIT)
    out[slot] = acc

def timed(fn):
    t0 = time.perf_counter()
    r = fn()
    return (time.perf_counter() - t0) * 1000.0, r

def single():
    out = [0]
    band(0, H, out, 0)
    return out[0]

def threaded(n=8):
    out = [0] * n
    step = (H + n - 1) // n
    ts = [threading.Thread(target=band, args=(i * step, min(H, (i + 1) * step), out, i)) for i in range(n)]
    for t in ts: t.start()
    for t in ts: t.join()
    return sum(out)

ms1, r1 = timed(single)
ms8, r8 = timed(lambda: threaded(8))
assert r1 == r8, (r1, r8)
print(f"python 1 thread : {ms1:8.0f} ms")
print(f"python 8 threads: {ms8:8.0f} ms   speedup {ms1/ms8:.2f}x   <- the GIL")
print(f"result = {r1}")
