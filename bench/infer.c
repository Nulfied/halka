/* Hand-written C equivalent of infer.hk: y = relu(x @ W + b), argmax per row. */
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

#define ROWS 4096
#define FEATS 512
#define CLASSES 32

static double dot(const double *x, const double *w, long xoff, long woff, long n) {
  double acc = 0.0;
  for (long j = 0; j < n; j++) acc += x[xoff + j] * w[woff + j];
  return acc;
}

int main(void) {
  double *w = malloc(sizeof(double) * FEATS * CLASSES);
  double *b = malloc(sizeof(double) * CLASSES);
  double *x = malloc(sizeof(double) * (size_t)ROWS * FEATS);
  if (!w || !b || !x) return 1;

  for (long i = 0; i < (long)FEATS * CLASSES; i++) w[i] = 0.001 * ((double)(i % 7) - 3.0);
  for (long c = 0; c < CLASSES; c++) b[c] = 0.01 * (double)c;
  for (long i = 0; i < (long)ROWS * FEATS; i++) x[i] = 0.5 * ((double)(i % 13) - 6.0);

  clock_t t0 = clock();
  long long total = 0;
  for (long r = 0; r < ROWS; r++) {
    long best = 0;
    double bestv = -1000000.0;
    for (long c = 0; c < CLASSES; c++) {
      double v = dot(x, w, r * FEATS, c * FEATS, FEATS) + b[c];
      if (v < 0.0) v = 0.0;
      if (v > bestv) { bestv = v; best = c; }
    }
    total += best;
  }
  double ms = 1000.0 * (double)(clock() - t0) / CLOCKS_PER_SEC;
  printf("infer checksum %lld\n", total);
  printf("compute %.0f ms\n", ms);
  free(w); free(b); free(x);
  return 0;
}
