/* Hand-written C equivalent of loop.hk. */
#include <stdio.h>
#include <stdint.h>
static int64_t sum_to(int64_t n) {
  int64_t total = 0;
  for (int64_t i = 0; i < n; i++) total = total + i % 7;
  return total;
}
int main(void) { printf("sum = %lld\n", (long long)sum_to(200000000)); return 0; }
