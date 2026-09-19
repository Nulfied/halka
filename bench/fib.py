import sys
sys.setrecursionlimit(100000)
def fib(n): return n if n < 2 else fib(n-1) + fib(n-2)
print(f"fib(35) = {fib(35)}")
