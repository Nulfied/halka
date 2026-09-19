/* Hand-written C equivalent of mandel.hk. */
#include <stdio.h>
#include <stdint.h>
static int64_t escapes(double cr, double ci, int64_t limit) {
  double zr = 0.0, zi = 0.0;
  for (int64_t i = 0; i < limit; i++) {
    double zr2 = zr * zr, zi2 = zi * zi;
    if (zr2 + zi2 > 4.0) return i;
    zi = 2.0 * zr * zi + ci;
    zr = zr2 - zi2 + cr;
  }
  return limit;
}
static int64_t total(int64_t w, int64_t h, int64_t limit) {
  int64_t acc = 0;
  for (int64_t y = 0; y < h; y++)
    for (int64_t x = 0; x < w; x++) {
      double cr = -2.0 + 3.0 * (double)x / (double)w;
      double ci = -1.2 + 2.4 * (double)y / (double)h;
      acc += escapes(cr, ci, limit);
    }
  return acc;
}
int main(void) { printf("mandel = %lld\n", (long long)total(900, 900, 500)); return 0; }
