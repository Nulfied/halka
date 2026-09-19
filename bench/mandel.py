def escapes(cr, ci, limit):
    zr = 0.0; zi = 0.0; i = 0
    while i < limit:
        zr2 = zr*zr; zi2 = zi*zi
        if zr2 + zi2 > 4.0: return i
        zi = 2.0*zr*zi + ci
        zr = zr2 - zi2 + cr
        i += 1
    return limit
def total(w, h, limit):
    acc = 0
    for y in range(h):
        for x in range(w):
            cr = -2.0 + 3.0*x/w
            ci = -1.2 + 2.4*y/h
            acc += escapes(cr, ci, limit)
    return acc
print(f"mandel = {total(900, 900, 500)}")
