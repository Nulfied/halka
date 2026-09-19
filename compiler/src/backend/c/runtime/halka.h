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

struct hk_list;

/* Immutable, reference counted, UTF-8, NUL-terminated for cheap C interop. */
typedef struct hk_str {
  hk_int rc;
  hk_int len;    /* bytes, excluding the terminator */
  char   data[1];
} hk_str;

/* `bytes` may be NULL: allocate `len` bytes and fill them afterwards. */
hk_str *hk_str_new(const char *bytes, hk_int len);
hk_str *hk_str_lit(const char *cstr);          /* static literal, rc = -1 */
hk_str *hk_str_cat(hk_str *a, hk_str *b);
/* Concatenates `n` parts and releases each of them. The caller owns every
   part it passes in, so interpolation leaves no intermediates behind. */
hk_str *hk_str_join(int n, hk_str **parts);
hk_str *hk_str_from_int(hk_int v);
hk_str *hk_str_from_float(hk_float v);
hk_str *hk_str_from_bool(hk_bool v);
hk_str *hk_str_from_char(hk_char v);
hk_int  hk_str_len_chars(hk_str *s);           /* code points, not bytes */
hk_str *hk_str_from_list(struct hk_list *l); /* renders like `inspect` (#53) */
hk_bool hk_str_eq(hk_str *a, hk_str *b);
int     hk_str_cmp(hk_str *a, hk_str *b);
hk_str *hk_str_retain(hk_str *s);
void    hk_str_release(hk_str *s);

/* ---- lists -------------------------------------------------------------- */

/* Unboxed storage: `data` is a flat array of `esz`-byte elements, so an
 * int list is a plain int64_t[] and indexing is one load. */
/* What a list's elements are. One code serves two purposes: releasing a
 * list has to release elements that are owners, and printing one has to
 * render them the way `inspect` does. Recording only "scalar or not" meant
 * a list of strings leaked its strings, and a list of lists printed its
 * element pointers as integers. */
#define HK_E_INT   0
#define HK_E_FLOAT 1
#define HK_E_BOOL  2
#define HK_E_CHAR  3
#define HK_E_STR   4
#define HK_E_LIST  5
#define HK_E_OWNS(k) ((k) >= HK_E_STR)

typedef struct hk_list {
  hk_int rc;
  hk_int len;
  hk_int cap;
  hk_int esz;
  hk_int ekind;
  void  *data;
} hk_list;

hk_list *hk_list_new(hk_int esz, hk_int cap, hk_int ekind);
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

/* Expression form, for a push used where a value is expected. `l` is
   evaluated more than once, so the generated code binds it to a temporary. */
#define HK_PUSH_E(l, T, v) \
  (hk_list_reserve((l), (l)->len + 1), ((T *)(l)->data)[(l)->len++] = (v), 0)

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

/* ---- allocation accounting ---------------------------------------------- */

/* Live heap objects. Two counters cost nothing measurable and turn "does the
 * compiler actually free what it allocates" into a test rather than a claim.
 * Set HALKA_REPORT_LEAKS=1 to have the program report on exit. */
hk_int hk_live_allocs(void);
hk_int hk_total_allocs(void);

/* ---- timing (for benchmarks) -------------------------------------------- */

hk_float hk_now_ms(void);

/* ---- prelude modules ----------------------------------------------------- */

/* `math`. The one-argument functions lower straight to libm, so only the
 * ones with no C equivalent appear here. */
hk_int   hk_math_gcd(hk_int a, hk_int b);
hk_bool  hk_math_is_nan(hk_float x);
hk_float hk_math_clamp(hk_float x, hk_float lo, hk_float hi);
hk_float hk_math_pi(void);
hk_float hk_math_e(void);

/* `io`, `time`, `os`, `strings`. */
void     hk_io_error(hk_str *s);
hk_int   hk_time_now(void);
hk_str  *hk_os_env(hk_str *name);
hk_str  *hk_os_platform(void);
void     hk_os_exit(hk_int code);
hk_str  *hk_strings_repeat(hk_str *s, hk_int n);

/* `lists`. Generic over the element size the list records, so one
 * implementation serves every element type. Each copies elements into a new
 * list and retains anything the new list now co-owns, so releasing either
 * list is safe. */
hk_list *hk_lists_concat(hk_list *a, hk_list *b);
hk_list *hk_lists_flatten(hk_list *xs);
hk_list *hk_lists_chunk(hk_list *xs, hk_int n);
hk_list *hk_lists_unique(hk_list *xs);

/* ---- maps ----------------------------------------------------------------
 *
 * Insertion-ordered. The interpreter's map is a JS Map, so iterating one or
 * printing it has to produce the same sequence (R23) — a plain hash table
 * would not. Entries live in dense arrays in insertion order; a separate
 * open-addressed index maps a hash to a position in them. Removing an entry
 * clears its live flag and leaves the slot alone, which keeps every other
 * entry's position stable.
 *
 * Keys and values carry HK_E_* kinds, as list elements do, so one
 * implementation hashes, compares, prints and releases every shape.
 */
typedef struct hk_map {
  hk_int  rc;
  hk_int  ksz, vsz;
  hk_int  kkind, vkind;
  char   *keys;   /* cap * ksz, in insertion order */
  char   *vals;   /* cap * vsz */
  hk_bool *live;  /* cap — false once removed */
  hk_int  used;   /* slots consumed, removed ones included */
  hk_int  count;  /* live entries */
  hk_int  cap;
  hk_int *idx;    /* nidx slots: -1 empty, else an entry position */
  hk_int  nidx;   /* a power of two */
} hk_map;

hk_map  *hk_map_new(hk_int ksz, hk_int vsz, hk_int kkind, hk_int vkind, hk_int cap);
hk_map  *hk_map_retain(hk_map *m);
void     hk_map_release(hk_map *m);
/** The entry position for `key`, or -1. */
hk_int   hk_map_find(const hk_map *m, const void *key);
/** Insert or overwrite. The map retains what it keeps; the caller keeps its own. */
void     hk_map_set(hk_map *m, const void *key, const void *val);
/** Copy the value for `key` into `out` (borrowed, not retained). */
hk_bool  hk_map_get(const hk_map *m, const void *key, void *out);
hk_bool  hk_map_has(const hk_map *m, const void *key);
hk_bool  hk_map_remove(hk_map *m, const void *key);
void     hk_map_clear(hk_map *m);
hk_int   hk_map_len(const hk_map *m);
hk_list *hk_map_keys(const hk_map *m);
hk_list *hk_map_values(const hk_map *m);
hk_str  *hk_str_from_map(hk_map *m);
hk_map  *hk_maps_merge(hk_map *a, hk_map *b);


/* ---- capabilities (#45) --------------------------------------------------
 *
 * The interpreter refuses a file operation unless `FileAccess` is held, and
 * a compiled program has to refuse it on the same terms or the capability
 * would mean nothing once built. `with capability` is not compiled yet, so
 * the only route here is HALKA_GRANTS, read once at startup. That is
 * narrower than the interpreter, never wider.
 */
hk_bool hk_cap_held(const char *permission);
void    hk_cap_require(const char *permission, const char *who, const char *file, hk_int line);

/* `with capability X,` — X is held for the duration of the block. The push
 * and the matching pop are emitted around the block, including on the paths
 * out of it, so a `give` from inside cannot leave the grant standing. */
void    hk_cap_push(const char *name);
void    hk_cap_pop(void);

#define HK_CAP(perm, who) hk_cap_require((perm), (who), __FILE__, __LINE__)

/* ---- files (spec/FILE-IO.md) ---------------------------------------------
 *
 * A file operation reports failure as a `Result`, whose C type depends on
 * the payload and so is generated per instantiation. The runtime therefore
 * returns this neutral struct and the generated code wraps it into the
 * right `Result`.
 */
typedef struct hk_io_result {
  hk_bool ok;
  hk_str *value;   /* the contents, for `read` */
  hk_str *error;   /* the message, when `ok` is false */
  hk_int  number;  /* the size, for `size` */
} hk_io_result;

hk_io_result hk_files_read(hk_str *path);
hk_io_result hk_files_write(hk_str *path, hk_str *contents);
hk_io_result hk_files_append(hk_str *path, hk_str *contents);
hk_io_result hk_files_remove(hk_str *path);
hk_io_result hk_files_size(hk_str *path);
hk_io_result hk_files_make_dir(hk_str *path);
hk_bool      hk_files_exists(hk_str *path);
hk_bool      hk_files_is_dir(hk_str *path);

/* ---- entry -------------------------------------------------------------- */

void hk_init(int argc, char **argv);
void hk_shutdown(void);

#ifdef __cplusplus
}
#endif

#endif /* HALKA_H */
