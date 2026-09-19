"""The same program in pure Python, for comparison.

Same NumPy preparation, same kernel, same 4-way split -- but the threads
cannot run concurrently, because the GIL serialises Python bytecode.
"""
import threading, time
import numpy as np

n = 400000
data = np.linspace(0.0, 6.28318, n)

def kernel_sum(xs, lo, hi):
    acc = 0.0
    for i in range(lo, hi):
        x = xs[i]
        t = x
        for _ in range(40):
            t = t - (t * t - x) / (2.0 * t + 1.0)
        acc += t / (1.0 + t * t)
    return acc

t0 = time.perf_counter()
single = kernel_sum(data, 0, n)
t1 = time.perf_counter()

q = n // 4
out = [0.0] * 4
ts = [threading.Thread(target=lambda k: out.__setitem__(k, kernel_sum(data, k * q, n if k == 3 else (k + 1) * q)), args=(k,))
      for k in range(4)]
for t in ts: t.start()
for t in ts: t.join()
t2 = time.perf_counter()
threaded = sum(out)

ms1 = (t1 - t0) * 1000
ms4 = (t2 - t1) * 1000
print(f"kernel, 1 thread : {ms1:.0f} ms")
print(f"kernel, 4 threads: {ms4:.0f} ms")
print(f"speedup          : {ms1/ms4:.2f}x")
print(f"result           : {round(single, 6)}")
assert round(single, 6) == round(threaded, 6)
