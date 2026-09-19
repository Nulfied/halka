/* libhalka — the runtime the Halka native backend links against.
 *
 * Design goals, in order:
 *   1. Generated code for scalar arithmetic, loops and calls must compile to
 *      the same machine code the equivalent C would. No boxing, no tagging,
 *      no indirection on the hot path.
 *   2. Heap values (strings, lists) are reference counted, because the memory
 *      model (spec/MEMORY-MODEL.md) gives every value one owner and the
 *      compiler elides the counting wherever ownership is statically known.
 *   3. Real OS threads. There is no interpreter lock of any kind.
 *
 * C99, no dependencies beyond the C standard library and the platform's
 * threading primitives.
 */

#ifndef HALKA_H
#define HALKA_H

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ---- scalars (R22) ------------------------------------------------------ */

typedef int64_t  hk_int;
typedef uint64_t hk_uint;
typedef double   hk_float;
typedef uint32_t hk_char;   /* a Unicode scalar value */
typedef uint8_t  hk_byte;
typedef bool     hk_bool;

#define HK_INT_MIN INT64_MIN
#define HK_INT_MAX INT64_MAX

/* ---- diagnostics -------------------------------------------------------- */

/* Aborts with a message and the Halka source location, like an unrecoverable
 * error in any language. Recoverable failure is Result<T> (#22, #23). */
void hk_panic(const char *msg, const char *file, hk_int line);

#define HK_PANIC(msg) hk_panic((msg), __FILE__, __LINE__)

/* These sit on the hot path of every arithmetic loop, so they are inline
 * rather than calls into the runtime library. With them inline, generated
 * code for `total + i % 7` is the same instruction sequence C produces. */

/* Overflow-checked arithmetic; `halka build --release` emits the plain
 * operators instead (R22). */
static inline hk_int hk_add_chk(hk_int a, hk_int b, const char *file, hk_int line) {
  hk_int r;
#if defined(__GNUC__) || defined(__clang__)
  if (__builtin_add_overflow(a, b, &r)) hk_panic("integer overflow in `+`", file, line);
#else
  r = (hk_int)((hk_uint)a + (hk_uint)b);
  if (((a ^ r) & (b ^ r)) < 0) hk_panic("integer overflow in `+`", file, line);
#endif
  return r;
}

static inline hk_int hk_sub_chk(hk_int a, hk_int b, const char *file, hk_int line) {
  hk_int r;
#if defined(__GNUC__) || defined(__clang__)
  if (__builtin_sub_overflow(a, b, &r)) hk_panic("integer overflow in `-`", file, line);
#else
  r = (hk_int)((hk_uint)a - (hk_uint)b);
  if (((a ^ b) & (a ^ r)) < 0) hk_panic("integer overflow in `-`", file, line);
#endif
  return r;
}

static inline hk_int hk_mul_chk(hk_int a, hk_int b, const char *file, hk_int line) {
  hk_int r;
#if defined(__GNUC__) || defined(__clang__)
  if (__builtin_mul_overflow(a, b, &r)) hk_panic("integer overflow in `*`", file, line);
#else
  r = (hk_int)((hk_uint)a * (hk_uint)b);
  if (a != 0 && (r / a != b || (a == -1 && b == HK_INT_MIN))) {
    hk_panic("integer overflow in `*`", file, line);
  }
#endif
  return r;
}

/* Floored division and modulo, so `div(a,b)*b + a%b == a` for every sign (R21). */
static inline hk_int hk_div(hk_int a, hk_int b, const char *file, hk_int line) {
  hk_int q;
  if (b == 0) hk_panic("division by zero", file, line);
  if (b == -1 && a == HK_INT_MIN) hk_panic("integer overflow in `div`", file, line);
  q = a / b;
  if ((a % b != 0) && ((a < 0) != (b < 0))) q--;
  return q;
}

static inline hk_int hk_mod(hk_int a, hk_int b, const char *file, hk_int line) {
  hk_int r;
  if (b == 0) hk_panic("modulo by zero", file, line);
  if (b == -1) return 0;
  r = a % b;
  if (r != 0 && ((r < 0) != (b < 0))) r += b;
  return r;
}

static inline hk_int hk_ipow(hk_int base, hk_int exp, const char *file, hk_int line) {
  hk_int r = 1;
  if (exp < 0) hk_panic("a negative integer exponent needs `pow(x as float, e)`", file, line);
  while (exp) {
    if (exp & 1) r = hk_mul_chk(r, base, file, line);
    exp >>= 1;
    if (exp) base = hk_mul_chk(base, base, file, line);
  }
  return r;
}

static inline hk_float hk_fdiv(hk_int a, hk_int b, const char *file, hk_int line) {
  if (b == 0) hk_panic("division by zero", file, line);
  return (hk_float)a / (hk_float)b;
}


/* ---- strings ------------------------------------------------------------ */

/* Immutable, reference counted, UTF-8, NUL-terminated for cheap C interop. */
typedef struct hk_str {
  hk_int rc;
  hk_int len;    /* bytes, excluding the terminator */
  char   data[1];
} hk_str;

hk_str *hk_str_new(const char *bytes, hk_int len);
hk_str *hk_str_lit(const char *cstr);          /* static literal, rc = -1 */
hk_str *hk_str_cat(hk_str *a, hk_str *b);
hk_str *hk_str_from_int(hk_int v);
hk_str *hk_str_from_float(hk_float v);
hk_str *hk_str_from_bool(hk_bool v);
hk_str *hk_str_from_char(hk_char v);
hk_int  hk_str_len_chars(hk_str *s);           /* code points, not bytes */
hk_bool hk_str_eq(hk_str *a, hk_str *b);
int     hk_str_cmp(hk_str *a, hk_str *b);
hk_str *hk_str_retain(hk_str *s);
void    hk_str_release(hk_str *s);

/* ---- lists -------------------------------------------------------------- */

/* Unboxed storage: `data` is a flat array of `esz`-byte elements, so an
 * int list is a plain int64_t[] and indexing is one load. */
typedef struct hk_list {
  hk_int rc;
  hk_int len;
  hk_int cap;
  hk_int esz;
  void  *data;
} hk_list;

hk_list *hk_list_new(hk_int esz, hk_int cap);
void     hk_list_reserve(hk_list *l, hk_int need);
void     hk_list_push_raw(hk_list *l, const void *elem);
hk_list *hk_list_retain(hk_list *l);
void     hk_list_release(hk_list *l);
hk_int   hk_list_check(hk_list *l, hk_int i, const char *file, hk_int line);

/* Typed access. HK_AT is the unchecked form the optimiser emits once the
 * index is proven in range; HK_IDX is the checked form. */
#define HK_AT(l, T, i)  (((T *)(l)->data)[(i)])
#define HK_IDX(l, T, i) (((T *)(l)->data)[hk_list_check((l), (i), __FILE__, __LINE__)])

#define HK_PUSH(l, T, v) do {                 \
    hk_list *hk__l = (l);                     \
    hk_list_reserve(hk__l, hk__l->len + 1);   \
    ((T *)hk__l->data)[hk__l->len++] = (v);   \
  } while (0)

/* ---- output ------------------------------------------------------------- */

void hk_say(hk_str *s);
void hk_say_cstr(const char *s);
void hk_write(hk_str *s);

/* ---- threads (#26, #32) — real OS threads, no global lock --------------- */

typedef struct hk_thread hk_thread;
typedef void *(*hk_thread_fn)(void *);

hk_thread *hk_spawn(hk_thread_fn fn, void *arg);
void      *hk_join(hk_thread *t);
hk_int     hk_cpu_count(void);

typedef struct hk_mutex hk_mutex;
hk_mutex *hk_mutex_new(void);
void      hk_mutex_lock(hk_mutex *m);
void      hk_mutex_unlock(hk_mutex *m);
void      hk_mutex_free(hk_mutex *m);

/* Atomics (#30). */
hk_int  hk_atomic_load(volatile hk_int *p);
void    hk_atomic_store(volatile hk_int *p, hk_int v);
hk_int  hk_atomic_add(volatile hk_int *p, hk_int delta);
hk_int  hk_atomic_exchange(volatile hk_int *p, hk_int v);
hk_bool hk_atomic_cas(volatile hk_int *p, hk_int expect, hk_int desired);

/* ---- timing (for benchmarks) -------------------------------------------- */

hk_float hk_now_ms(void);

/* ---- entry -------------------------------------------------------------- */

void hk_init(int argc, char **argv);
void hk_shutdown(void);

#ifdef __cplusplus
}
#endif

#endif /* HALKA_H */
