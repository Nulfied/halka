/* libhalka — implementation. C99, no dependencies. */

/* getenv is the portable spelling; MSVC deprecates it in favour of a
   non-standard alternative, and we only read one debug-only variable. */
#if defined(_MSC_VER) && !defined(_CRT_SECURE_NO_WARNINGS)
  #define _CRT_SECURE_NO_WARNINGS 1
#endif

#include "halka.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <math.h>
#include <sys/stat.h>
#if defined(_WIN32)
  #include <direct.h>
#else
  #include <unistd.h>
#endif

#if defined(_WIN32)
  #define WIN32_LEAN_AND_MEAN
  #include <windows.h>
#else
  #include <pthread.h>
  #include <unistd.h>
  #include <time.h>
#endif

/* ---- diagnostics -------------------------------------------------------- */

HK_NORETURN void hk_panic(const char *msg, const char *file, hk_int line) {
  fflush(stdout);
  fprintf(stderr, "halka: %s\n  at %s:%lld\n", msg, file, (long long)line);
  fflush(stderr);
  exit(101);
}

/* Live and cumulative heap objects, for the leak test. */
static hk_int hk_alive = 0;
static hk_int hk_total = 0;

hk_int hk_live_allocs(void) { return hk_alive; }
hk_int hk_total_allocs(void) { return hk_total; }

static void *hk_alloc(size_t n) {
  void *p = malloc(n);
  if (!p) hk_panic("out of memory", __FILE__, __LINE__);
  hk_alive++;
  hk_total++;
  return p;
}

static void hk_dealloc(void *p) {
  if (!p) return;
  hk_alive--;
  free(p);
}

static void *hk_realloc(void *old, size_t n) {
  void *p = realloc(old, n);
  if (!p) hk_panic("out of memory", __FILE__, __LINE__);
  if (!old) hk_alive++, hk_total++;   /* growing from nothing is a new object */
  return p;
}

/* ---- strings ------------------------------------------------------------ */

hk_str *hk_str_new(const char *bytes, hk_int len) {
  hk_str *s = (hk_str *)hk_alloc(sizeof(hk_str) + (size_t)len);
  s->rc = 1;
  s->len = len;
  /* `bytes` may be NULL to allocate room and fill it afterwards, which is
     what the file and repeat paths do; memcpy from NULL is undefined. */
  if (len && bytes) memcpy(s->data, bytes, (size_t)len);
  s->data[len] = '\0';
  return s;
}

hk_str *hk_str_lit(const char *cstr) {
  /* Literals are interned by the generated code; rc = -1 means "never free". */
  hk_int len = (hk_int)strlen(cstr);
  hk_str *s = hk_str_new(cstr, len);
  s->rc = -1;
  hk_alive--;   /* interned for the life of the program, not a leak */
  return s;
}

hk_str *hk_str_retain(hk_str *s) {
  if (s && s->rc >= 0) s->rc++;
  return s;
}

void hk_str_release(hk_str *s) {
  if (!s || s->rc < 0) return;
  if (--s->rc == 0) hk_dealloc(s);
}

hk_str *hk_str_cat(hk_str *a, hk_str *b) {
  hk_int n = a->len + b->len;
  hk_str *s = (hk_str *)hk_alloc(sizeof(hk_str) + (size_t)n);
  s->rc = 1;
  s->len = n;
  memcpy(s->data, a->data, (size_t)a->len);
  memcpy(s->data + a->len, b->data, (size_t)b->len);
  s->data[n] = '\0';
  return s;
}

hk_str *hk_str_join(int n, hk_str **parts) {
  hk_int total = 0;
  for (int i = 0; i < n; i++) total += parts[i]->len;
  hk_str *s = (hk_str *)hk_alloc(sizeof(hk_str) + (size_t)total);
  s->rc = 1;
  s->len = total;
  hk_int at = 0;
  for (int i = 0; i < n; i++) {
    memcpy(s->data + at, parts[i]->data, (size_t)parts[i]->len);
    at += parts[i]->len;
    hk_str_release(parts[i]);
  }
  s->data[total] = '\0';
  return s;
}

hk_str *hk_str_from_int(hk_int v) {
  char buf[24];
  int n = snprintf(buf, sizeof buf, "%lld", (long long)v);
  return hk_str_new(buf, n);
}

hk_str *hk_str_from_float(hk_float v) {
  char buf[40];
  int n;
  if (v != v) n = snprintf(buf, sizeof buf, "nan");
  else if (v > 1.7976931348623157e308) n = snprintf(buf, sizeof buf, "inf");
  else if (v < -1.7976931348623157e308) n = snprintf(buf, sizeof buf, "-inf");
  else if (v == (hk_float)(long long)v && v < 1e21 && v > -1e21) {
    n = snprintf(buf, sizeof buf, "%lld.0", (long long)v);
  } else {
    n = snprintf(buf, sizeof buf, "%.17g", v);
    /* Prefer the shortest representation that round-trips. */
    for (int p = 1; p <= 17; p++) {
      char t[40];
      int m = snprintf(t, sizeof t, "%.*g", p, v);
      if (strtod(t, NULL) == v) { memcpy(buf, t, (size_t)m + 1); n = m; break; }
    }
  }
  return hk_str_new(buf, n);
}

hk_str *hk_str_from_bool(hk_bool v) { return hk_str_lit(v ? "true" : "false"); }

hk_str *hk_str_from_char(hk_char v) {
  char b[5];
  int n = 0;
  if (v < 0x80) { b[n++] = (char)v; }
  else if (v < 0x800) {
    b[n++] = (char)(0xC0 | (v >> 6));
    b[n++] = (char)(0x80 | (v & 0x3F));
  } else if (v < 0x10000) {
    b[n++] = (char)(0xE0 | (v >> 12));
    b[n++] = (char)(0x80 | ((v >> 6) & 0x3F));
    b[n++] = (char)(0x80 | (v & 0x3F));
  } else {
    b[n++] = (char)(0xF0 | (v >> 18));
    b[n++] = (char)(0x80 | ((v >> 12) & 0x3F));
    b[n++] = (char)(0x80 | ((v >> 6) & 0x3F));
    b[n++] = (char)(0x80 | (v & 0x3F));
  }
  return hk_str_new(b, n);
}

hk_int hk_str_len_chars(hk_str *s) {
  hk_int n = 0;
  for (hk_int i = 0; i < s->len; i++) {
    if (((unsigned char)s->data[i] & 0xC0) != 0x80) n++;
  }
  return n;
}

hk_bool hk_str_eq(hk_str *a, hk_str *b) {
  if (a == b) return true;
  if (a->len != b->len) return false;
  return memcmp(a->data, b->data, (size_t)a->len) == 0;
}

int hk_str_cmp(hk_str *a, hk_str *b) {
  hk_int n = a->len < b->len ? a->len : b->len;
  int c = memcmp(a->data, b->data, (size_t)n);
  if (c) return c;
  return a->len < b->len ? -1 : a->len > b->len ? 1 : 0;
}

/* ---- lists -------------------------------------------------------------- */

hk_list *hk_list_new(hk_int esz, hk_int cap, hk_int ekind) {
  hk_list *l = (hk_list *)hk_alloc(sizeof(hk_list));
  l->rc = 1;
  l->len = 0;
  l->cap = cap > 0 ? cap : 0;
  l->esz = esz;
  l->ekind = ekind;
  l->edesc = NULL;
  l->data = l->cap ? hk_alloc((size_t)(l->cap * esz)) : NULL;
  return l;
}

void hk_list_reserve(hk_list *l, hk_int need) {
  if (need <= l->cap) return;
  hk_int cap = l->cap ? l->cap : 4;
  while (cap < need) cap += cap / 2 + 1;
  l->data = hk_realloc(l->data, (size_t)(cap * l->esz));
  l->cap = cap;
}

void hk_list_push_raw(hk_list *l, const void *elem) {
  hk_list_reserve(l, l->len + 1);
  memcpy((char *)l->data + l->len * l->esz, elem, (size_t)l->esz);
  l->len++;
}

hk_list *hk_list_retain(hk_list *l) {
  if (l && l->rc >= 0) l->rc++;
  return l;
}

void hk_list_release(hk_list *l) {
  if (!l || l->rc < 0) return;
  if (--l->rc == 0) {
    /* The elements are owned by the list, so they go with it. */
    if (l->ekind == HK_E_STR) {
      for (hk_int i = 0; i < l->len; i++) hk_str_release(((hk_str **)l->data)[i]);
    } else if (l->ekind == HK_E_LIST) {
      for (hk_int i = 0; i < l->len; i++) hk_list_release(((hk_list **)l->data)[i]);
    } else if (l->ekind == HK_E_TUPLE) {
      for (hk_int i = 0; i < l->len; i++) hk_tuple_drop((char *)l->data + i * l->esz, l->edesc);
    }
    hk_dealloc(l->data);
    hk_dealloc(l);
  }
}

HK_NORETURN void hk_list_oob(hk_list *l, hk_int i, const char *file, hk_int line) {
  char buf[96];
  snprintf(buf, sizeof buf, "index %lld is out of range for length %lld",
           (long long)i, (long long)l->len);
  hk_panic(buf, file, line);
}

hk_int hk_list_check(hk_list *l, hk_int i, const char *file, hk_int line) {
  return hk_list_at(l, i, file, line);
}

/* A list prints the way `inspect` prints it (#53): strings are quoted and
   escaped, chars are quoted, and a nested list recurses. Printing the raw
   element bytes as integers is what it used to do for a list of lists. */

/* Append the escape for one byte of a quoted string, or the byte itself.
   Written with byte values rather than character literals so that the
   escapes cannot be mangled by anything that rewrites this file. */
#define HK_BSLASH 92
#define HK_DQUOTE 34
#define HK_SQUOTE 39

static hk_int hk_escape_into(char *out, char c) {
  switch ((unsigned char)c) {
    case 92: out[0] = HK_BSLASH; out[1] = HK_BSLASH; return 2;
    case 34: out[0] = HK_BSLASH; out[1] = 34;  return 2;  /* " */
    case 10: out[0] = HK_BSLASH; out[1] = 110; return 2;  /* n */
    case 9:  out[0] = HK_BSLASH; out[1] = 116; return 2;  /* t */
    case 13: out[0] = HK_BSLASH; out[1] = 114; return 2;  /* r */
    case 0:  out[0] = HK_BSLASH; out[1] = 48;  return 2;  /* 0 */
    default: out[0] = c; return 1;
  }
}

static hk_str *hk_str_quoted(hk_str *v, char q) {
  hk_int worst = (v ? v->len : 0) * 2 + 2;
  hk_str *out = hk_str_new(NULL, worst);
  hk_int at = 0;
  out->data[at++] = q;
  for (hk_int i = 0; v && i < v->len; i++) at += hk_escape_into(out->data + at, v->data[i]);
  out->data[at++] = q;
  out->data[at] = 0;
  out->len = at;
  return out;
}
static hk_str *hk_join2(hk_str *a, hk_str *b) {
  hk_str *t = hk_str_cat(a, b);
  hk_str_release(a);
  hk_str_release(b);
  return t;
}

hk_str *hk_str_from_list(struct hk_list *l) {
  hk_str *acc = hk_str_new("[", 1);
  for (hk_int i = 0; i < l->len; i++) {
    if (i) acc = hk_join2(acc, hk_str_new(", ", 2));
    hk_str *piece;
    switch (l->ekind) {
      case HK_E_FLOAT: piece = hk_str_from_float(HK_AT(l, hk_float, i)); break;
      case HK_E_BOOL:  piece = hk_str_from_bool(HK_AT(l, hk_bool, i)); break;
      case HK_E_CHAR: {
        hk_str *c = hk_str_from_char(HK_AT(l, hk_char, i));
        piece = hk_str_quoted(c, HK_SQUOTE);
        hk_str_release(c);
        break;
      }
      case HK_E_STR:   piece = hk_str_quoted(HK_AT(l, hk_str *, i), HK_DQUOTE); break;
      case HK_E_LIST:  piece = hk_str_from_list(HK_AT(l, hk_list *, i)); break;
      case HK_E_TUPLE: piece = hk_str_from_tuple((char *)l->data + i * l->esz, l->edesc); break;
      default:         piece = hk_str_from_int(HK_AT(l, hk_int, i)); break;
    }
    acc = hk_join2(acc, piece);
  }
  return hk_join2(acc, hk_str_new("]", 1));
}

/* ---- output ------------------------------------------------------------- */

void hk_say(hk_str *s) { fwrite(s->data, 1, (size_t)s->len, stdout); fputc('\n', stdout); }
void hk_say_cstr(const char *s) { fputs(s, stdout); fputc('\n', stdout); }
void hk_write(hk_str *s) { fwrite(s->data, 1, (size_t)s->len, stdout); }

/* ---- threads ------------------------------------------------------------ */

struct hk_thread {
#if defined(_WIN32)
  HANDLE h;
#else
  pthread_t h;
#endif
  hk_thread_fn fn;
  void *arg;
  void *result;
};

#if defined(_WIN32)
static DWORD WINAPI hk_trampoline(LPVOID p) {
  hk_thread *t = (hk_thread *)p;
  t->result = t->fn(t->arg);
  return 0;
}
#else
static void *hk_trampoline(void *p) {
  hk_thread *t = (hk_thread *)p;
  t->result = t->fn(t->arg);
  return NULL;
}
#endif

hk_thread *hk_spawn(hk_thread_fn fn, void *arg) {
  hk_thread *t = (hk_thread *)hk_alloc(sizeof(hk_thread));
  t->fn = fn;
  t->arg = arg;
  t->result = NULL;
#if defined(_WIN32)
  t->h = CreateThread(NULL, 0, hk_trampoline, t, 0, NULL);
  if (!t->h) HK_PANIC("could not start a thread");
#else
  if (pthread_create(&t->h, NULL, hk_trampoline, t) != 0) HK_PANIC("could not start a thread");
#endif
  return t;
}

void *hk_join(hk_thread *t) {
#if defined(_WIN32)
  WaitForSingleObject(t->h, INFINITE);
  CloseHandle(t->h);
#else
  pthread_join(t->h, NULL);
#endif
  void *r = t->result;
  hk_dealloc(t);
  return r;
}

hk_int hk_cpu_count(void) {
#if defined(_WIN32)
  SYSTEM_INFO si;
  GetSystemInfo(&si);
  return (hk_int)si.dwNumberOfProcessors;
#else
  long n = sysconf(_SC_NPROCESSORS_ONLN);
  return n > 0 ? (hk_int)n : 1;
#endif
}

struct hk_mutex {
#if defined(_WIN32)
  CRITICAL_SECTION cs;
#else
  pthread_mutex_t m;
#endif
};

hk_mutex *hk_mutex_new(void) {
  hk_mutex *m = (hk_mutex *)hk_alloc(sizeof(hk_mutex));
#if defined(_WIN32)
  InitializeCriticalSection(&m->cs);
#else
  pthread_mutex_init(&m->m, NULL);
#endif
  return m;
}

void hk_mutex_lock(hk_mutex *m) {
#if defined(_WIN32)
  EnterCriticalSection(&m->cs);
#else
  pthread_mutex_lock(&m->m);
#endif
}

void hk_mutex_unlock(hk_mutex *m) {
#if defined(_WIN32)
  LeaveCriticalSection(&m->cs);
#else
  pthread_mutex_unlock(&m->m);
#endif
}

void hk_mutex_free(hk_mutex *m) {
  if (!m) return;
#if defined(_WIN32)
  DeleteCriticalSection(&m->cs);
#else
  pthread_mutex_destroy(&m->m);
#endif
  hk_dealloc(m);
}

/* ---- atomics ------------------------------------------------------------ */

#if defined(_WIN32)
hk_int hk_atomic_load(volatile hk_int *p) { return (hk_int)InterlockedOr64((volatile LONG64 *)p, 0); }
void   hk_atomic_store(volatile hk_int *p, hk_int v) { InterlockedExchange64((volatile LONG64 *)p, (LONG64)v); }
hk_int hk_atomic_add(volatile hk_int *p, hk_int d) { return (hk_int)InterlockedExchangeAdd64((volatile LONG64 *)p, (LONG64)d) + d; }
hk_int hk_atomic_exchange(volatile hk_int *p, hk_int v) { return (hk_int)InterlockedExchange64((volatile LONG64 *)p, (LONG64)v); }
hk_bool hk_atomic_cas(volatile hk_int *p, hk_int e, hk_int d) {
  return InterlockedCompareExchange64((volatile LONG64 *)p, (LONG64)d, (LONG64)e) == (LONG64)e;
}
#else
hk_int hk_atomic_load(volatile hk_int *p) { return __atomic_load_n(p, __ATOMIC_SEQ_CST); }
void   hk_atomic_store(volatile hk_int *p, hk_int v) { __atomic_store_n(p, v, __ATOMIC_SEQ_CST); }
hk_int hk_atomic_add(volatile hk_int *p, hk_int d) { return __atomic_add_fetch(p, d, __ATOMIC_SEQ_CST); }
hk_int hk_atomic_exchange(volatile hk_int *p, hk_int v) { return __atomic_exchange_n(p, v, __ATOMIC_SEQ_CST); }
hk_bool hk_atomic_cas(volatile hk_int *p, hk_int e, hk_int d) {
  return __atomic_compare_exchange_n(p, &e, d, false, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST);
}
#endif

/* ---- timing ------------------------------------------------------------- */

hk_float hk_now_ms(void) {
#if defined(_WIN32)
  LARGE_INTEGER f, c;
  QueryPerformanceFrequency(&f);
  QueryPerformanceCounter(&c);
  return (hk_float)c.QuadPart * 1000.0 / (hk_float)f.QuadPart;
#else
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (hk_float)ts.tv_sec * 1000.0 + (hk_float)ts.tv_nsec / 1e6;
#endif
}


/* ---- prelude: math ------------------------------------------------------- */

hk_int hk_math_gcd(hk_int a, hk_int b) {
  if (a < 0) a = -a;
  if (b < 0) b = -b;
  while (b != 0) {
    hk_int t = a % b;
    a = b;
    b = t;
  }
  return a;
}

hk_bool hk_math_is_nan(hk_float x) { return x != x; }

hk_float hk_math_clamp(hk_float x, hk_float lo, hk_float hi) {
  return x < lo ? lo : (x > hi ? hi : x);
}

hk_float hk_math_pi(void) { return 3.14159265358979323846; }
hk_float hk_math_e(void)  { return 2.71828182845904523536; }

/* ---- prelude: io, time, os, strings -------------------------------------- */

void hk_io_error(hk_str *s) {
  fputs(s ? s->data : "", stderr);
  fputc('\n', stderr);
}

hk_int hk_time_now(void) { return (hk_int)(hk_now_ms()); }

hk_str *hk_os_env(hk_str *name) {
  const char *v = getenv(name ? name->data : "");
  return hk_str_new(v ? v : "", v ? (hk_int)strlen(v) : 0);
}

hk_str *hk_os_platform(void) {
#if defined(_WIN32)
  return hk_str_lit("win32");
#elif defined(__APPLE__)
  return hk_str_lit("darwin");
#else
  return hk_str_lit("linux");
#endif
}

void hk_os_exit(hk_int code) {
  hk_shutdown();
  exit((int)code);
}

hk_str *hk_strings_repeat(hk_str *s, hk_int n) {
  if (!s || n <= 0) return hk_str_lit("");
  if (n > 0 && s->len > 0 && n > (hk_int)(0x7fffffff / s->len)) {
    HK_PANIC("`strings.repeat` would produce a string larger than this platform can hold");
  }
  hk_int len = s->len * n;
  hk_str *out = hk_str_new(NULL, len);
  for (hk_int i = 0; i < n; i++) memcpy(out->data + i * s->len, s->data, (size_t)s->len);
  out->data[len] = '\0';
  return out;
}


/* ---- prelude: lists ------------------------------------------------------
 *
 * Generic over the element size the list already records, so one
 * implementation serves every element type. A copied element that is itself
 * an owner is retained, because two lists now point at it and either may be
 * released first.
 */

static void hk_elem_retain(hk_int ekind, void *slot) {
  if (ekind == HK_E_STR) hk_str_retain(*(hk_str **)slot);
  else if (ekind == HK_E_LIST) hk_list_retain(*(hk_list **)slot);
}

/** As above, for a container that knows its tuple layout. */
static void hk_slot_retain(hk_int ekind, void *slot, const hk_tupdesc *d) {
  if (ekind == HK_E_TUPLE) hk_tuple_retain(slot, d);
  else hk_elem_retain(ekind, slot);
}

/** Append `n` elements from `src` to `out`, retaining any it now co-owns. */
static void hk_list_append(hk_list *out, const void *src, hk_int n) {
  if (n <= 0) return;
  hk_list_reserve(out, out->len + n);
  memcpy((char *)out->data + out->len * out->esz, src, (size_t)(n * out->esz));
  for (hk_int i = 0; i < n; i++) {
    hk_slot_retain(out->ekind, (char *)out->data + (out->len + i) * out->esz, out->edesc);
  }
  out->len += n;
}

hk_list *hk_lists_concat(hk_list *a, hk_list *b) {
  hk_list *out = hk_list_new(a->esz, a->len + b->len, a->ekind);
  hk_list_append(out, a->data, a->len);
  hk_list_append(out, b->data, b->len);
  return out;
}

hk_list *hk_lists_flatten(hk_list *xs) {
  /* One level, matching the interpreter: a non-list element is kept as-is,
     but a list of lists is the only shape the backend can type. */
  hk_int total = 0;
  for (hk_int i = 0; i < xs->len; i++) {
    hk_list *inner = ((hk_list **)xs->data)[i];
    if (inner) total += inner->len;
  }
  hk_list *first = xs->len ? ((hk_list **)xs->data)[0] : NULL;
  hk_list *out = hk_list_new(first ? first->esz : (hk_int)sizeof(hk_int), total,
                             first ? first->ekind : HK_E_INT);
  for (hk_int i = 0; i < xs->len; i++) {
    hk_list *inner = ((hk_list **)xs->data)[i];
    if (inner) hk_list_append(out, inner->data, inner->len);
  }
  return out;
}

hk_list *hk_lists_chunk(hk_list *xs, hk_int n) {
  if (n < 1) n = 1;
  hk_int groups = (xs->len + n - 1) / n;
  hk_list *out = hk_list_new((hk_int)sizeof(hk_list *), groups, HK_E_LIST);
  for (hk_int i = 0; i < xs->len; i += n) {
    hk_int take = xs->len - i < n ? xs->len - i : n;
    hk_list *part = hk_list_new(xs->esz, take, xs->ekind);
    hk_list_append(part, (char *)xs->data + i * xs->esz, take);
    hk_list_push_raw(out, &part);
  }
  return out;
}

static bool hk_elem_eq(hk_int ekind, const void *a, const void *b, hk_int esz) {
  if (ekind == HK_E_STR) return hk_str_eq(*(hk_str *const *)a, *(hk_str *const *)b);
  /* A nested list compares by identity, which is what comparing anything
     else would amount to here. Scalars compare by their bytes, which is
     exact for every scalar the backend emits. */
  return memcmp(a, b, (size_t)esz) == 0;
}

hk_list *hk_lists_unique(hk_list *xs) {
  hk_list *out = hk_list_new(xs->esz, xs->len, xs->ekind);
  for (hk_int i = 0; i < xs->len; i++) {
    const char *cand = (const char *)xs->data + i * xs->esz;
    bool seen = false;
    for (hk_int j = 0; j < out->len && !seen; j++) {
      seen = hk_elem_eq(xs->ekind, cand, (const char *)out->data + j * out->esz, xs->esz);
    }
    if (!seen) hk_list_append(out, cand, 1);
  }
  return out;
}

/* ---- capabilities (#45) --------------------------------------------------- */

static char hk_grants[512];

static void hk_cap_init(void) {
  const char *g = getenv("HALKA_GRANTS");
  if (!g) { hk_grants[0] = '\0'; return; }
  size_t n = strlen(g);
  if (n >= sizeof hk_grants) n = sizeof hk_grants - 1;
  memcpy(hk_grants, g, n);
  hk_grants[n] = '\0';
}

/* `FileAccess.read` is satisfied by holding it or by holding `FileAccess`,
 * which is exactly how the interpreter reads a `requires` clause. */
static bool hk_grant_contains(const char *want) {
  size_t wl = strlen(want);
  const char *p = hk_grants;
  while (*p) {
    const char *end = strchr(p, ',');
    size_t len = end ? (size_t)(end - p) : strlen(p);
    while (len && (p[0] == ' ')) { p++; len--; }
    while (len && p[len - 1] == ' ') len--;
    if (len == wl && memcmp(p, want, wl) == 0) return true;
    if (!end) break;
    p = end + 1;
  }
  return false;
}

/* Capabilities granted by an enclosing `with capability` block (#45). The
 * nesting is lexical and small, so a fixed depth is enough; overflowing it
 * would be a compiler bug rather than something a program can provoke. */
#define HK_CAP_MAX 64
static const char *hk_cap_stack[HK_CAP_MAX];
static int hk_cap_depth = 0;

void hk_cap_push(const char *name) {
  if (hk_cap_depth >= HK_CAP_MAX) HK_PANIC("`with capability` nested too deeply");
  hk_cap_stack[hk_cap_depth++] = name;
}

void hk_cap_pop(void) {
  if (hk_cap_depth > 0) hk_cap_depth--;
}

/* Holding `FileAccess` satisfies `FileAccess.read`, which is how the
 * interpreter reads a `requires` clause. */
static bool hk_cap_scoped(const char *want) {
  size_t wl = strlen(want);
  for (int i = hk_cap_depth - 1; i >= 0; i--) {
    const char *g = hk_cap_stack[i];
    size_t gl = strlen(g);
    if (gl == wl && memcmp(g, want, wl) == 0) return true;
    if (gl < wl && want[gl] == '.' && memcmp(g, want, gl) == 0) return true;
  }
  return false;
}

hk_bool hk_cap_held(const char *permission) {
  if (hk_cap_scoped(permission)) return true;
  if (hk_grant_contains(permission)) return true;
  const char *dot = strchr(permission, '.');
  if (!dot) return false;
  char root[64];
  size_t n = (size_t)(dot - permission);
  if (n >= sizeof root) return false;
  memcpy(root, permission, n);
  root[n] = '\0';
  return hk_grant_contains(root);
}

void hk_cap_require(const char *permission, const char *who, const char *file, hk_int line) {
  if (hk_cap_held(permission)) return;
  fprintf(stderr,
    "halka: `%s` requires the `%s` capability, which is not held here (rule #45)\n"
    "  wrap the call in `with capability`, declare `requires` on the enclosing\n"
    "  function, or run with HALKA_GRANTS=%s\n",
    who, permission, permission);
  hk_panic("missing capability", file, line);
}

/* ---- prelude: files (spec/FILE-IO.md) ------------------------------------- */

static hk_io_result hk_io_ok(void) {
  hk_io_result r;
  r.ok = true;
  r.value = NULL;
  r.error = NULL;
  r.number = 0;
  return r;
}

static hk_io_result hk_io_fail(const char *op, hk_str *path, const char *why) {
  hk_io_result r;
  const char *p = path ? path->data : "";
  hk_int need = (hk_int)(strlen(op) + strlen(p) + strlen(why) + 8);
  hk_str *msg = hk_str_new(NULL, need);
  int wrote = snprintf(msg->data, (size_t)need + 1, "%s \"%s\": %s", op, p, why);
  msg->len = wrote < 0 ? 0 : (wrote > need ? need : wrote);
  r.ok = false;
  r.value = NULL;
  r.error = msg;
  r.number = 0;
  return r;
}

hk_io_result hk_files_read(hk_str *path) {
  FILE *f = fopen(path ? path->data : "", "rb");
  if (!f) return hk_io_fail("reading", path, strerror(errno));
  if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return hk_io_fail("reading", path, strerror(errno)); }
  long size = ftell(f);
  if (size < 0) { fclose(f); return hk_io_fail("reading", path, strerror(errno)); }
  rewind(f);

  hk_str *out = hk_str_new(NULL, (hk_int)size);
  size_t got = size ? fread(out->data, 1, (size_t)size, f) : 0;
  fclose(f);
  if (size && got != (size_t)size) {
    hk_str_release(out);
    return hk_io_fail("reading", path, "the file ended early");
  }
  out->data[got] = '\0';
  out->len = (hk_int)got;

  /* Invalid UTF-8 is an error rather than replacement characters (F4). */
  {
    const unsigned char *b = (const unsigned char *)out->data;
    hk_int i = 0;
    while (i < out->len) {
      unsigned char c = b[i];
      hk_int extra = c < 0x80 ? 0 : (c >= 0xC2 && c <= 0xDF) ? 1
                   : (c >= 0xE0 && c <= 0xEF) ? 2 : (c >= 0xF0 && c <= 0xF4) ? 3 : -1;
      if (extra < 0 || i + extra >= out->len + (extra ? 0 : 1)) {
        if (extra < 0 || i + extra >= out->len) {
          hk_str_release(out);
          return hk_io_fail("reading", path, "the file is not valid UTF-8");
        }
      }
      for (hk_int k = 1; k <= extra; k++) {
        if ((b[i + k] & 0xC0) != 0x80) {
          hk_str_release(out);
          return hk_io_fail("reading", path, "the file is not valid UTF-8");
        }
      }
      i += extra + 1;
    }
  }

  hk_io_result r = hk_io_ok();
  r.value = out;
  return r;
}

static hk_io_result hk_files_put(hk_str *path, hk_str *contents, const char *mode, const char *op) {
  FILE *f = fopen(path ? path->data : "", mode);
  if (!f) return hk_io_fail(op, path, strerror(errno));
  hk_int len = contents ? contents->len : 0;
  if (len && fwrite(contents->data, 1, (size_t)len, f) != (size_t)len) {
    fclose(f);
    return hk_io_fail(op, path, strerror(errno));
  }
  if (fclose(f) != 0) return hk_io_fail(op, path, strerror(errno));
  return hk_io_ok();
}

hk_io_result hk_files_write(hk_str *path, hk_str *contents) {
  return hk_files_put(path, contents, "wb", "writing");
}

hk_io_result hk_files_append(hk_str *path, hk_str *contents) {
  return hk_files_put(path, contents, "ab", "appending to");
}

hk_io_result hk_files_size(hk_str *path) {
  FILE *f = fopen(path ? path->data : "", "rb");
  if (!f) return hk_io_fail("measuring", path, strerror(errno));
  if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return hk_io_fail("measuring", path, strerror(errno)); }
  long size = ftell(f);
  fclose(f);
  if (size < 0) return hk_io_fail("measuring", path, strerror(errno));
  hk_io_result r = hk_io_ok();
  r.number = (hk_int)size;
  return r;
}

hk_bool hk_files_exists(hk_str *path) {
#if defined(_WIN32)
  struct _stat64 st;
  return _stat64(path ? path->data : "", &st) == 0;
#else
  struct stat st;
  return stat(path ? path->data : "", &st) == 0;
#endif
}

hk_bool hk_files_is_dir(hk_str *path) {
#if defined(_WIN32)
  struct _stat64 st;
  if (_stat64(path ? path->data : "", &st) != 0) return false;
  return (st.st_mode & _S_IFDIR) != 0;
#else
  struct stat st;
  if (stat(path ? path->data : "", &st) != 0) return false;
  return S_ISDIR(st.st_mode);
#endif
}

hk_io_result hk_files_remove(hk_str *path) {
  const char *p = path ? path->data : "";
  /* One file, or one *empty* directory, and never recursively (F3). */
  if (hk_files_is_dir(path)) {
#if defined(_WIN32)
    if (_rmdir(p) != 0) return hk_io_fail("removing", path, strerror(errno));
#else
    if (rmdir(p) != 0) return hk_io_fail("removing", path, strerror(errno));
#endif
    return hk_io_ok();
  }
  if (remove(p) != 0) return hk_io_fail("removing", path, strerror(errno));
  return hk_io_ok();
}

hk_io_result hk_files_make_dir(hk_str *path) {
  /* Parents are created and an existing directory is not an error (F3). */
  const char *p = path ? path->data : "";
  size_t n = strlen(p);
  char buf[1024];
  if (n >= sizeof buf) return hk_io_fail("creating", path, "the path is too long");
  memcpy(buf, p, n + 1);

  for (size_t i = 1; i <= n; i++) {
    if (i < n && buf[i] != '/' && buf[i] != '\\') continue;
    char saved = buf[i];
    buf[i] = '\0';
#if defined(_WIN32)
    int rc = _mkdir(buf);
#else
    int rc = mkdir(buf, 0777);
#endif
    if (rc != 0 && errno != EEXIST) {
      buf[i] = saved;
      return hk_io_fail("creating", path, strerror(errno));
    }
    buf[i] = saved;
  }
  return hk_io_ok();
}

/* ---- entry -------------------------------------------------------------- */

void hk_init(int argc, char **argv) { (void)argc; (void)argv; hk_cap_init(); }

void hk_shutdown(void) {
  fflush(stdout);
  if (getenv("HALKA_REPORT_LEAKS")) {
    fprintf(stderr, "halka: %lld heap object(s) still live at exit, of %lld allocated\n",
            (long long)hk_alive, (long long)hk_total);
  }
}

/* ---- maps ----------------------------------------------------------------
 *
 * See halka.h for why this is insertion-ordered rather than a plain table.
 */

static void hk_elem_drop(hk_int kind, void *slot) {
  if (kind == HK_E_STR) hk_str_release(*(hk_str **)slot);
  else if (kind == HK_E_LIST) hk_list_release(*(hk_list **)slot);
}

/* FNV-1a. A string hashes by its bytes so that two equal strings agree
   whatever their addresses; anything else hashes by its representation,
   which is exact for every scalar the backend emits. */
static hk_int hk_hash_bytes(const unsigned char *p, hk_int n) {
  unsigned long long h = 1469598103934665603ULL;
  for (hk_int i = 0; i < n; i++) {
    h ^= (unsigned long long)p[i];
    h *= 1099511628211ULL;
  }
  return (hk_int)(h & 0x7fffffffffffffffULL);
}

static hk_int hk_key_hash(hk_int kkind, const void *key, hk_int ksz) {
  if (kkind == HK_E_STR) {
    const hk_str *s = *(const hk_str *const *)key;
    return s ? hk_hash_bytes((const unsigned char *)s->data, s->len) : 0;
  }
  return hk_hash_bytes((const unsigned char *)key, ksz);
}

static bool hk_key_eq(hk_int kkind, const void *a, const void *b, hk_int ksz) {
  if (kkind == HK_E_STR) return hk_str_eq(*(hk_str *const *)a, *(hk_str *const *)b);
  return memcmp(a, b, (size_t)ksz) == 0;
}

static void hk_map_reindex(hk_map *m, hk_int want) {
  hk_int n = 8;
  while (n < want * 2) n *= 2;
  hk_int *idx = (hk_int *)hk_alloc((size_t)n * sizeof(hk_int));
  for (hk_int i = 0; i < n; i++) idx[i] = -1;
  hk_dealloc(m->idx);
  m->idx = idx;
  m->nidx = n;
  for (hk_int e = 0; e < m->used; e++) {
    if (!m->live[e]) continue;
    hk_int h = hk_key_hash(m->kkind, m->keys + e * m->ksz, m->ksz);
    hk_int j = h & (n - 1);
    while (idx[j] != -1) j = (j + 1) & (n - 1);
    idx[j] = e;
  }
}

static void hk_map_grow(hk_map *m, hk_int need) {
  if (need <= m->cap) return;
  hk_int cap = m->cap ? m->cap : 8;
  while (cap < need) cap *= 2;
  m->keys = (char *)hk_realloc(m->keys, (size_t)cap * (size_t)m->ksz);
  m->vals = (char *)hk_realloc(m->vals, (size_t)cap * (size_t)m->vsz);
  m->live = (hk_bool *)hk_realloc(m->live, (size_t)cap * sizeof(hk_bool));
  m->cap = cap;
}

hk_map *hk_map_new(hk_int ksz, hk_int vsz, hk_int kkind, hk_int vkind, hk_int cap) {
  hk_map *m = (hk_map *)hk_alloc(sizeof(hk_map));
  m->rc = 1;
  m->ksz = ksz; m->vsz = vsz;
  m->kkind = kkind; m->vkind = vkind;
  m->keys = NULL; m->vals = NULL; m->live = NULL;
  m->used = 0; m->count = 0; m->cap = 0;
  m->idx = NULL; m->nidx = 0;
  if (cap > 0) hk_map_grow(m, cap);
  hk_map_reindex(m, cap > 0 ? cap : 4);
  return m;
}

hk_map *hk_map_retain(hk_map *m) { if (m) m->rc++; return m; }

void hk_map_release(hk_map *m) {
  if (!m || --m->rc > 0) return;
  for (hk_int e = 0; e < m->used; e++) {
    if (!m->live[e]) continue;
    if (HK_E_OWNS(m->kkind)) hk_elem_drop(m->kkind, m->keys + e * m->ksz);
    if (HK_E_OWNS(m->vkind)) hk_elem_drop(m->vkind, m->vals + e * m->vsz);
  }
  hk_dealloc(m->keys); hk_dealloc(m->vals); hk_dealloc(m->live); hk_dealloc(m->idx);
  hk_dealloc(m);
}

/** The index slot holding `key`, or where it would go. */
static hk_int hk_map_slot(const hk_map *m, const void *key) {
  hk_int h = hk_key_hash(m->kkind, key, m->ksz);
  hk_int j = h & (m->nidx - 1);
  while (m->idx[j] != -1) {
    hk_int e = m->idx[j];
    if (hk_key_eq(m->kkind, m->keys + e * m->ksz, key, m->ksz)) return j;
    j = (j + 1) & (m->nidx - 1);
  }
  return j;
}

hk_int hk_map_find(const hk_map *m, const void *key) {
  if (!m || m->nidx == 0) return -1;
  return m->idx[hk_map_slot(m, key)];
}

void hk_map_set(hk_map *m, const void *key, const void *val) {
  hk_int j = hk_map_slot(m, key);
  if (m->idx[j] != -1) {
    /* Present already: the stored key stays, only the value changes. */
    hk_int e = m->idx[j];
    if (HK_E_OWNS(m->vkind)) hk_elem_drop(m->vkind, m->vals + e * m->vsz);
    memcpy(m->vals + e * m->vsz, val, (size_t)m->vsz);
    if (HK_E_OWNS(m->vkind)) hk_elem_retain(m->vkind, m->vals + e * m->vsz);
    return;
  }
  hk_map_grow(m, m->used + 1);
  hk_int e = m->used++;
  memcpy(m->keys + e * m->ksz, key, (size_t)m->ksz);
  memcpy(m->vals + e * m->vsz, val, (size_t)m->vsz);
  if (HK_E_OWNS(m->kkind)) hk_elem_retain(m->kkind, m->keys + e * m->ksz);
  if (HK_E_OWNS(m->vkind)) hk_elem_retain(m->vkind, m->vals + e * m->vsz);
  m->live[e] = true;
  m->count++;
  if ((m->count + 1) * 2 > m->nidx) hk_map_reindex(m, m->count + 1);
  else m->idx[hk_map_slot(m, m->keys + e * m->ksz)] = e;
}

hk_bool hk_map_get(const hk_map *m, const void *key, void *out) {
  hk_int e = hk_map_find(m, key);
  if (e < 0) return false;
  memcpy(out, m->vals + e * m->vsz, (size_t)m->vsz);
  return true;
}

hk_bool hk_map_has(const hk_map *m, const void *key) { return hk_map_find(m, key) >= 0; }

hk_bool hk_map_remove(hk_map *m, const void *key) {
  hk_int j = hk_map_slot(m, key);
  hk_int e = m->idx[j];
  if (e < 0) return false;
  if (HK_E_OWNS(m->kkind)) hk_elem_drop(m->kkind, m->keys + e * m->ksz);
  if (HK_E_OWNS(m->vkind)) hk_elem_drop(m->vkind, m->vals + e * m->vsz);
  m->live[e] = false;
  m->count--;
  /* Rebuilding is simpler than repairing a probe chain in place, and a
     removal is rare next to a lookup. */
  hk_map_reindex(m, m->count + 1);
  return true;
}

void hk_map_clear(hk_map *m) {
  for (hk_int e = 0; e < m->used; e++) {
    if (!m->live[e]) continue;
    if (HK_E_OWNS(m->kkind)) hk_elem_drop(m->kkind, m->keys + e * m->ksz);
    if (HK_E_OWNS(m->vkind)) hk_elem_drop(m->vkind, m->vals + e * m->vsz);
    m->live[e] = false;
  }
  m->used = 0;
  m->count = 0;
  hk_map_reindex(m, 4);
}

hk_int hk_map_len(const hk_map *m) { return m ? m->count : 0; }

static hk_list *hk_map_column(const hk_map *m, const char *base, hk_int sz, hk_int kind) {
  hk_list *out = hk_list_new(sz, m->count, kind);
  for (hk_int e = 0; e < m->used; e++) {
    if (!m->live[e]) continue;
    hk_list_reserve(out, out->len + 1);
    memcpy((char *)out->data + out->len * sz, base + e * sz, (size_t)sz);
    hk_elem_retain(kind, (char *)out->data + out->len * sz);
    out->len++;
  }
  return out;
}

hk_list *hk_map_keys(const hk_map *m) { return hk_map_column(m, m->keys, m->ksz, m->kkind); }
hk_list *hk_map_values(const hk_map *m) { return hk_map_column(m, m->vals, m->vsz, m->vkind); }

/** One entry rendered the way `inspect` renders it (#53). */
static hk_str *hk_cell_str(hk_int kind, const char *slot) {
  switch (kind) {
    case HK_E_FLOAT: return hk_str_from_float(*(const hk_float *)slot);
    case HK_E_BOOL:  return hk_str_from_bool(*(const hk_bool *)slot);
    case HK_E_CHAR: {
      hk_str *c = hk_str_from_char(*(const hk_char *)slot);
      hk_str *q = hk_str_quoted(c, HK_SQUOTE);
      hk_str_release(c);
      return q;
    }
    case HK_E_STR:  return hk_str_quoted(*(hk_str *const *)slot, HK_DQUOTE);
    case HK_E_LIST: return hk_str_from_list(*(hk_list *const *)slot);
    default:        return hk_str_from_int(*(const hk_int *)slot);
  }
}

hk_str *hk_str_from_map(hk_map *m) {
  /* An empty map renders as `map()`, not `[]`, because `[]` is already an
     empty list. The interpreter draws the same distinction (#53). */
  if (m->count == 0) return hk_str_new("map()", 5);
  hk_str *acc = hk_str_new("[", 1);
  bool first = true;
  for (hk_int e = 0; e < m->used; e++) {
    if (!m->live[e]) continue;
    if (!first) acc = hk_join2(acc, hk_str_new(", ", 2));
    first = false;
    acc = hk_join2(acc, hk_cell_str(m->kkind, m->keys + e * m->ksz));
    acc = hk_join2(acc, hk_str_new(": ", 2));
    acc = hk_join2(acc, hk_cell_str(m->vkind, m->vals + e * m->vsz));
  }
  return hk_join2(acc, hk_str_new("]", 1));
}

hk_map *hk_maps_merge(hk_map *a, hk_map *b) {
  hk_map *out = hk_map_new(a->ksz, a->vsz, a->kkind, a->vkind, a->count + b->count);
  for (hk_int e = 0; e < a->used; e++) {
    if (a->live[e]) hk_map_set(out, a->keys + e * a->ksz, a->vals + e * a->vsz);
  }
  for (hk_int e = 0; e < b->used; e++) {
    if (b->live[e]) hk_map_set(out, b->keys + e * b->ksz, b->vals + e * b->vsz);
  }
  return out;
}

/* ---- tuples --------------------------------------------------------------
 *
 * See halka.h. One walk over a generated descriptor serves every shape.
 */

void hk_list_set_desc(hk_list *l, const hk_tupdesc *d) { l->edesc = d; }

void hk_tuple_retain(void *p, const hk_tupdesc *d) {
  if (!d) return;
  for (hk_int i = 0; i < d->n; i++) {
    void *f = (char *)p + d->offs[i];
    switch (d->kinds[i]) {
      case HK_E_STR:   hk_str_retain(*(hk_str **)f); break;
      case HK_E_LIST:  hk_list_retain(*(hk_list **)f); break;
      case HK_E_TUPLE: hk_tuple_retain(f, d->subs[i]); break;
      default: break;
    }
  }
}

void hk_tuple_drop(void *p, const hk_tupdesc *d) {
  if (!d) return;
  for (hk_int i = 0; i < d->n; i++) {
    void *f = (char *)p + d->offs[i];
    switch (d->kinds[i]) {
      case HK_E_STR:   hk_str_release(*(hk_str **)f); break;
      case HK_E_LIST:  hk_list_release(*(hk_list **)f); break;
      case HK_E_TUPLE: hk_tuple_drop(f, d->subs[i]); break;
      default: break;
    }
  }
}

hk_str *hk_str_from_tuple(const void *p, const hk_tupdesc *d) {
  hk_str *acc = hk_str_new("(", 1);
  for (hk_int i = 0; i < d->n; i++) {
    if (i) acc = hk_join2(acc, hk_str_new(", ", 2));
    const char *f = (const char *)p + d->offs[i];
    acc = hk_join2(acc, d->kinds[i] == HK_E_TUPLE
                          ? hk_str_from_tuple(f, d->subs[i])
                          : hk_cell_str(d->kinds[i], f));
  }
  return hk_join2(acc, hk_str_new(")", 1));
}

/* ---- json ----------------------------------------------------------------
 *
 * `json.stringify` only. Output has to match the interpreter byte for byte
 * (R23), and the interpreter delegates to JavaScript's JSON.stringify, so
 * the quirks copied here are JavaScript's: an integral float prints without
 * a decimal point, a non-string map key is stringified, and a value that is
 * not finite becomes `null`.
 */

static hk_str *hk_json_value(hk_int kind, const void *slot, const hk_tupdesc *d);

hk_str *hk_json_int(hk_int v) { return hk_str_from_int(v); }

hk_str *hk_json_bool(hk_bool v) { return hk_str_new(v ? "true" : "false", v ? 4 : 5); }

hk_str *hk_json_null(void) { return hk_str_new("null", 4); }

hk_str *hk_json_float(hk_float v) {
  char buf[40];
  if (!isfinite(v)) return hk_json_null();   /* JSON has no NaN or Infinity */
  /* An integral value prints as an integer, the way JavaScript does, but
     only below 1e21; past that JavaScript switches to exponent form too. */
  if (v == floor(v) && fabs(v) < 1e21) {
    snprintf(buf, sizeof buf, "%.0f", v);
    /* "-0" is the one case where %.0f and JavaScript disagree. */
    if (buf[0] == '-' && buf[1] == '0' && buf[2] == '\0') { buf[0] = '0'; buf[1] = '\0'; }
    return hk_str_new(buf, (hk_int)strlen(buf));
  }
  /* Shortest representation that reads back exactly. */
  for (int prec = 15; prec <= 17; prec++) {
    snprintf(buf, sizeof buf, "%.*g", prec, v);
    if (strtod(buf, NULL) == v) break;
  }
  return hk_str_new(buf, (hk_int)strlen(buf));
}

/** JSON string escaping, which is not the same as `inspect`'s. */
hk_str *hk_json_str(const hk_str *s) {
  hk_int cap = 2;
  for (hk_int i = 0; s && i < s->len; i++) {
    unsigned char c = (unsigned char)s->data[i];
    cap += (c == 34 || c == 92 || c == 8 || c == 12 || c == 10 || c == 13 || c == 9) ? 2
         : c < 32 ? 6 : 1;
  }
  hk_str *out = hk_str_new(NULL, cap);
  hk_int at = 0;
  out->data[at++] = 34;                       /* " */
  for (hk_int i = 0; s && i < s->len; i++) {
    unsigned char c = (unsigned char)s->data[i];
    switch (c) {
      case 34:  out->data[at++] = 92; out->data[at++] = 34;  break;  /* \" */
      case 92:  out->data[at++] = 92; out->data[at++] = 92;  break;  /* \\ */
      case 8:   out->data[at++] = 92; out->data[at++] = 98;  break;  /* \b */
      case 12:  out->data[at++] = 92; out->data[at++] = 102; break;  /* \f */
      case 10:  out->data[at++] = 92; out->data[at++] = 110; break;  /* \n */
      case 13:  out->data[at++] = 92; out->data[at++] = 114; break;  /* \r */
      case 9:   out->data[at++] = 92; out->data[at++] = 116; break;  /* \t */
      default:
        if (c < 32) {
          static const char hex[] = "0123456789abcdef";
          out->data[at++] = 92; out->data[at++] = 117;               /* \u */
          out->data[at++] = 48; out->data[at++] = 48;                /* 00 */
          out->data[at++] = hex[(c >> 4) & 15];
          out->data[at++] = hex[c & 15];
        } else {
          out->data[at++] = (char)c;   /* UTF-8 passes through */
        }
    }
  }
  out->data[at++] = 34;
  out->len = at;
  out->data[at] = 0;
  return out;
}

hk_str *hk_json_tuple(const void *p, const hk_tupdesc *d) {
  /* A tuple has no JSON counterpart, so it becomes an array. */
  hk_str *acc = hk_str_new("[", 1);
  for (hk_int i = 0; i < d->n; i++) {
    if (i) acc = hk_join2(acc, hk_str_new(",", 1));
    acc = hk_join2(acc, hk_json_value(d->kinds[i], (const char *)p + d->offs[i],
                                      d->kinds[i] == HK_E_TUPLE ? d->subs[i] : NULL));
  }
  return hk_join2(acc, hk_str_new("]", 1));
}

hk_str *hk_json_list(const hk_list *l) {
  hk_str *acc = hk_str_new("[", 1);
  for (hk_int i = 0; i < l->len; i++) {
    if (i) acc = hk_join2(acc, hk_str_new(",", 1));
    acc = hk_join2(acc, hk_json_value(l->ekind, (const char *)l->data + i * l->esz, l->edesc));
  }
  return hk_join2(acc, hk_str_new("]", 1));
}

/** A JSON object key is always a string, so a non-string key is converted. */
static hk_str *hk_json_key(hk_int kind, const void *slot) {
  if (kind == HK_E_STR) return hk_json_str(*(hk_str *const *)slot);
  hk_str *plain = hk_json_value(kind, slot, NULL);
  hk_str *out = hk_json_str(plain);
  hk_str_release(plain);
  return out;
}

hk_str *hk_json_map(const hk_map *m) {
  hk_str *acc = hk_str_new("{", 1);
  bool first = true;
  for (hk_int e = 0; e < m->used; e++) {
    if (!m->live[e]) continue;
    if (!first) acc = hk_join2(acc, hk_str_new(",", 1));
    first = false;
    acc = hk_join2(acc, hk_json_key(m->kkind, m->keys + e * m->ksz));
    acc = hk_join2(acc, hk_str_new(":", 1));
    acc = hk_join2(acc, hk_json_value(m->vkind, m->vals + e * m->vsz, NULL));
  }
  return hk_join2(acc, hk_str_new("}", 1));
}

static hk_str *hk_json_value(hk_int kind, const void *slot, const hk_tupdesc *d) {
  switch (kind) {
    case HK_E_FLOAT: return hk_json_float(*(const hk_float *)slot);
    case HK_E_BOOL:  return hk_json_bool(*(const hk_bool *)slot);
    case HK_E_CHAR:  { hk_str *c = hk_str_from_char(*(const hk_char *)slot);
                       hk_str *q = hk_json_str(c); hk_str_release(c); return q; }
    case HK_E_STR:   return hk_json_str(*(hk_str *const *)slot);
    case HK_E_LIST:  return hk_json_list(*(hk_list *const *)slot);
    case HK_E_TUPLE: return hk_json_tuple(slot, d);
    default:         return hk_json_int(*(const hk_int *)slot);
  }
}

/* ---- json documents ------------------------------------------------------
 *
 * See halka.h. The grammar is RFC 8259 as JavaScript's JSON.parse reads it,
 * because the interpreter uses that and the two must agree (R23). The one
 * place that needs saying: a number is an int when it is integral and a
 * float otherwise, which is how the interpreter converts a JavaScript
 * number back into a Halka value -- so `2.0` parses to `2`, not `2.0`.
 */

static hk_json *hk_json_alloc(hk_int tag) {
  hk_json *v = (hk_json *)hk_alloc(sizeof(hk_json));
  memset(v, 0, sizeof *v);
  v->rc = 1;
  v->tag = tag;
  return v;
}

hk_json *hk_json_retain(hk_json *v) { if (v) v->rc++; return v; }

void hk_json_release(hk_json *v) {
  if (!v || --v->rc > 0) return;
  if (v->tag == HK_J_STR) hk_str_release(v->as.s);
  else if (v->tag == HK_J_ARR) {
    for (hk_int i = 0; i < v->as.arr.len; i++) hk_json_release(v->as.arr.items[i]);
    hk_dealloc(v->as.arr.items);
  } else if (v->tag == HK_J_OBJ) {
    for (hk_int i = 0; i < v->as.obj.len; i++) {
      hk_str_release(v->as.obj.keys[i]);
      hk_json_release(v->as.obj.vals[i]);
    }
    hk_dealloc(v->as.obj.keys);
    hk_dealloc(v->as.obj.vals);
  }
  hk_dealloc(v);
}

/* --- parsing --- */

typedef struct {
  const char *p;
  const char *end;
  const char *start;
  const char *file;
  hk_int line;
} hk_jp;

static void hk_jp_fail(hk_jp *j) {
  char buf[64];
  snprintf(buf, sizeof buf, "invalid JSON at byte %lld", (long long)(j->p - j->start));
  hk_panic(buf, j->file, j->line);
}

static hk_json *hk_jp_value(hk_jp *j);

static void hk_jp_space(hk_jp *j) {
  while (j->p < j->end) {
    char c = *j->p;
    if (c == ' ' || c == 9 || c == 10 || c == 13) j->p++;
    else break;
  }
}

static void hk_jp_lit(hk_jp *j, const char *word, hk_int n) {
  /* Consume what matches before giving up, so the reported byte is where
     the word stopped being right -- which is where JSON.parse points too. */
  hk_int k = 0;
  while (k < n && j->p < j->end && *j->p == word[k]) { j->p++; k++; }
  if (k != n) hk_jp_fail(j);
}

/** Append one code point as UTF-8. */
static hk_int hk_utf8_put(char *out, unsigned long cp) {
  if (cp < 0x80) { out[0] = (char)cp; return 1; }
  if (cp < 0x800) {
    out[0] = (char)(0xC0 | (cp >> 6));
    out[1] = (char)(0x80 | (cp & 0x3F));
    return 2;
  }
  if (cp < 0x10000) {
    out[0] = (char)(0xE0 | (cp >> 12));
    out[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
    out[2] = (char)(0x80 | (cp & 0x3F));
    return 3;
  }
  out[0] = (char)(0xF0 | (cp >> 18));
  out[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
  out[2] = (char)(0x80 | ((cp >> 6) & 0x3F));
  out[3] = (char)(0x80 | (cp & 0x3F));
  return 4;
}

static unsigned long hk_jp_hex4(hk_jp *j) {
  unsigned long v = 0;
  for (int k = 0; k < 4; k++) {
    if (j->p >= j->end) hk_jp_fail(j);
    char c = *j->p++;
    v <<= 4;
    if (c >= '0' && c <= '9') v |= (unsigned long)(c - '0');
    else if (c >= 'a' && c <= 'f') v |= (unsigned long)(c - 'a' + 10);
    else if (c >= 'A' && c <= 'F') v |= (unsigned long)(c - 'A' + 10);
    else hk_jp_fail(j);
  }
  return v;
}

static hk_str *hk_jp_string(hk_jp *j) {
  if (j->p >= j->end || *j->p != '"') hk_jp_fail(j);
  j->p++;
  /* An escape never expands, so the raw span bounds the result. */
  const char *from = j->p;
  hk_int cap = (hk_int)(j->end - from) + 4;
  hk_str *out = hk_str_new(NULL, cap);
  hk_int at = 0;
  while (1) {
    if (j->p >= j->end) { hk_str_release(out); hk_jp_fail(j); }
    unsigned char c = (unsigned char)*j->p;
    if (c == '"') { j->p++; break; }
    if (c < 0x20) { hk_str_release(out); hk_jp_fail(j); }
    if (c != '\\') { out->data[at++] = (char)c; j->p++; continue; }
    j->p++;
    if (j->p >= j->end) { hk_str_release(out); hk_jp_fail(j); }
    char e = *j->p++;
    switch (e) {
      case '"':  out->data[at++] = 34; break;
      case '\\': out->data[at++] = 92; break;
      case '/':  out->data[at++] = 47; break;
      case 'b':  out->data[at++] = 8;  break;
      case 'f':  out->data[at++] = 12; break;
      case 'n':  out->data[at++] = 10; break;
      case 'r':  out->data[at++] = 13; break;
      case 't':  out->data[at++] = 9;  break;
      case 'u': {
        unsigned long cp = hk_jp_hex4(j);
        /* A surrogate pair is two escapes that make one code point. */
        if (cp >= 0xD800 && cp <= 0xDBFF && j->end - j->p >= 6 && j->p[0] == '\\' && j->p[1] == 'u') {
          const char *save = j->p;
          j->p += 2;
          unsigned long lo = hk_jp_hex4(j);
          if (lo >= 0xDC00 && lo <= 0xDFFF) cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
          else j->p = save;
        }
        at += hk_utf8_put(out->data + at, cp);
        break;
      }
      default: hk_str_release(out); hk_jp_fail(j);
    }
  }
  out->len = at;
  out->data[at] = 0;
  return out;
}

static hk_json *hk_jp_number(hk_jp *j) {
  const char *from = j->p;
  if (j->p < j->end && (*j->p == '-' || *j->p == '+')) j->p++;
  while (j->p < j->end && ((*j->p >= '0' && *j->p <= '9') || *j->p == '.' ||
                           *j->p == 'e' || *j->p == 'E' || *j->p == '-' || *j->p == '+')) {
    j->p++;
  }
  if (j->p == from) hk_jp_fail(j);
  char buf[350];
  size_t n = (size_t)(j->p - from);
  if (n >= sizeof buf) hk_jp_fail(j);
  memcpy(buf, from, n);
  buf[n] = 0;
  char *stop = NULL;
  double d = strtod(buf, &stop);
  if (stop != buf + n) hk_jp_fail(j);
  /* Integral becomes an int, matching how the interpreter turns a
     JavaScript number back into a Halka value. */
  if (d == floor(d) && isfinite(d) && fabs(d) < 9.2233720368547758e18) {
    hk_json *v = hk_json_alloc(HK_J_INT);
    v->as.i = (hk_int)d;
    return v;
  }
  hk_json *v = hk_json_alloc(HK_J_FLOAT);
  v->as.f = d;
  return v;
}

static void hk_arr_push(hk_json *v, hk_json *item) {
  if (v->as.arr.len == v->as.arr.cap) {
    hk_int cap = v->as.arr.cap ? v->as.arr.cap * 2 : 8;
    v->as.arr.items = (hk_json **)hk_realloc(v->as.arr.items, (size_t)cap * sizeof(hk_json *));
    v->as.arr.cap = cap;
  }
  v->as.arr.items[v->as.arr.len++] = item;
}

static void hk_obj_push(hk_json *v, hk_str *key, hk_json *val) {
  /* A repeated key keeps the last value, as JavaScript does. */
  for (hk_int i = 0; i < v->as.obj.len; i++) {
    if (hk_str_eq(v->as.obj.keys[i], key)) {
      hk_str_release(key);
      hk_json_release(v->as.obj.vals[i]);
      v->as.obj.vals[i] = val;
      return;
    }
  }
  if (v->as.obj.len == v->as.obj.cap) {
    hk_int cap = v->as.obj.cap ? v->as.obj.cap * 2 : 8;
    v->as.obj.keys = (hk_str **)hk_realloc(v->as.obj.keys, (size_t)cap * sizeof(hk_str *));
    v->as.obj.vals = (hk_json **)hk_realloc(v->as.obj.vals, (size_t)cap * sizeof(hk_json *));
    v->as.obj.cap = cap;
  }
  v->as.obj.keys[v->as.obj.len] = key;
  v->as.obj.vals[v->as.obj.len] = val;
  v->as.obj.len++;
}

static hk_json *hk_jp_value(hk_jp *j) {
  hk_jp_space(j);
  if (j->p >= j->end) hk_jp_fail(j);
  char c = *j->p;
  if (c == '{') {
    j->p++;
    hk_json *v = hk_json_alloc(HK_J_OBJ);
    hk_jp_space(j);
    if (j->p < j->end && *j->p == '}') { j->p++; return v; }
    while (1) {
      hk_jp_space(j);
      hk_str *key = hk_jp_string(j);
      hk_jp_space(j);
      if (j->p >= j->end || *j->p != ':') { hk_str_release(key); hk_json_release(v); hk_jp_fail(j); }
      j->p++;
      hk_obj_push(v, key, hk_jp_value(j));
      hk_jp_space(j);
      if (j->p < j->end && *j->p == ',') { j->p++; continue; }
      if (j->p < j->end && *j->p == '}') { j->p++; return v; }
      hk_json_release(v);
      hk_jp_fail(j);
    }
  }
  if (c == '[') {
    j->p++;
    hk_json *v = hk_json_alloc(HK_J_ARR);
    hk_jp_space(j);
    if (j->p < j->end && *j->p == ']') { j->p++; return v; }
    while (1) {
      hk_arr_push(v, hk_jp_value(j));
      hk_jp_space(j);
      if (j->p < j->end && *j->p == ',') { j->p++; continue; }
      if (j->p < j->end && *j->p == ']') { j->p++; return v; }
      hk_json_release(v);
      hk_jp_fail(j);
    }
  }
  if (c == '"') {
    hk_json *v = hk_json_alloc(HK_J_STR);
    v->as.s = hk_jp_string(j);
    return v;
  }
  if (c == 't') { hk_jp_lit(j, "true", 4);  hk_json *v = hk_json_alloc(HK_J_BOOL); v->as.b = true;  return v; }
  if (c == 'f') { hk_jp_lit(j, "false", 5); hk_json *v = hk_json_alloc(HK_J_BOOL); v->as.b = false; return v; }
  if (c == 'n') { hk_jp_lit(j, "null", 4);  return hk_json_alloc(HK_J_NULL); }
  return hk_jp_number(j);
}

hk_json *hk_json_parse(const hk_str *text, const char *file, hk_int line) {
  hk_jp j;
  j.start = text ? text->data : "";
  j.p = j.start;
  j.end = j.start + (text ? text->len : 0);
  j.file = file;
  j.line = line;
  hk_json *v = hk_jp_value(&j);
  hk_jp_space(&j);
  if (j.p != j.end) { hk_json_release(v); hk_jp_fail(&j); }
  return v;
}

/* --- reading --- */

hk_json *hk_json_get(const hk_json *v, hk_str *key) {
  if (v && v->tag == HK_J_OBJ) {
    for (hk_int i = 0; i < v->as.obj.len; i++) {
      if (hk_str_eq(v->as.obj.keys[i], key)) return v->as.obj.vals[i];
    }
  }
  return NULL;   /* absent reads as null (#7) */
}

hk_json *hk_json_at(const hk_json *v, hk_int i, const char *file, hk_int line) {
  hk_int len = (v && v->tag == HK_J_ARR) ? v->as.arr.len : 0;
  hk_int k = i < 0 ? i + len : i;               /* negative indices count back (#54) */
  if (v && v->tag == HK_J_ARR && k >= 0 && k < len) return v->as.arr.items[k];
  /* An array index out of range is an error, the way it is for a list --
     unlike a missing object key, which reads as null (#7). */
  char buf[96];
  snprintf(buf, sizeof buf, "index %lld is out of range for length %lld",
           (long long)i, (long long)len);
  hk_panic(buf, file, line);
  return NULL;
}

hk_int hk_json_count(const hk_json *v) {
  if (!v) return 0;
  if (v->tag == HK_J_ARR) return v->as.arr.len;
  if (v->tag == HK_J_OBJ) return v->as.obj.len;
  if (v->tag == HK_J_STR) return hk_str_len_chars(v->as.s);
  return 0;
}

/* --- rendering --- */

hk_str *hk_json_inspect(const hk_json *v) {
  if (!v) return hk_str_new("null", 4);
  switch (v->tag) {
    case HK_J_NULL:  return hk_str_new("null", 4);
    case HK_J_BOOL:  return hk_str_from_bool(v->as.b);
    case HK_J_INT:   return hk_str_from_int(v->as.i);
    case HK_J_FLOAT: return hk_str_from_float(v->as.f);
    case HK_J_STR:   return hk_str_quoted(v->as.s, HK_DQUOTE);
    case HK_J_ARR: {
      hk_str *acc = hk_str_new("[", 1);
      for (hk_int i = 0; i < v->as.arr.len; i++) {
        if (i) acc = hk_join2(acc, hk_str_new(", ", 2));
        acc = hk_join2(acc, hk_json_inspect(v->as.arr.items[i]));
      }
      return hk_join2(acc, hk_str_new("]", 1));
    }
    default: {
      /* An object is the Halka map the interpreter would have built, and an
         empty map prints as `map()` rather than `[]`. */
      if (v->as.obj.len == 0) return hk_str_new("map()", 5);
      hk_str *acc = hk_str_new("[", 1);
      for (hk_int i = 0; i < v->as.obj.len; i++) {
        if (i) acc = hk_join2(acc, hk_str_new(", ", 2));
        acc = hk_join2(acc, hk_str_quoted(v->as.obj.keys[i], HK_DQUOTE));
        acc = hk_join2(acc, hk_str_new(": ", 2));
        acc = hk_join2(acc, hk_json_inspect(v->as.obj.vals[i]));
      }
      return hk_join2(acc, hk_str_new("]", 1));
    }
  }
}

hk_str *hk_json_display(const hk_json *v) {
  /* `say` shows a string bare and everything else as `inspect` does. */
  if (v && v->tag == HK_J_STR) return hk_str_retain(v->as.s);
  return hk_json_inspect(v);
}

hk_str *hk_json_dump(const hk_json *v) {
  if (!v) return hk_json_null();
  switch (v->tag) {
    case HK_J_NULL:  return hk_json_null();
    case HK_J_BOOL:  return hk_json_bool(v->as.b);
    case HK_J_INT:   return hk_json_int(v->as.i);
    case HK_J_FLOAT: return hk_json_float(v->as.f);
    case HK_J_STR:   return hk_json_str(v->as.s);
    case HK_J_ARR: {
      hk_str *acc = hk_str_new("[", 1);
      for (hk_int i = 0; i < v->as.arr.len; i++) {
        if (i) acc = hk_join2(acc, hk_str_new(",", 1));
        acc = hk_join2(acc, hk_json_dump(v->as.arr.items[i]));
      }
      return hk_join2(acc, hk_str_new("]", 1));
    }
    default: {
      hk_str *acc = hk_str_new("{", 1);
      for (hk_int i = 0; i < v->as.obj.len; i++) {
        if (i) acc = hk_join2(acc, hk_str_new(",", 1));
        acc = hk_join2(acc, hk_json_str(v->as.obj.keys[i]));
        acc = hk_join2(acc, hk_str_new(":", 1));
        acc = hk_join2(acc, hk_json_dump(v->as.obj.vals[i]));
      }
      return hk_join2(acc, hk_str_new("}", 1));
    }
  }
}

/* ---- shared ownership (M3) ---------------------------------------------- */

hk_shared *hk_shared_new(const void *value, hk_int esz, hk_dropfn drop) {
  hk_shared *s = (hk_shared *)hk_alloc(sizeof(hk_shared));
  s->rc = 1;
  s->wc = 0;
  s->drop = drop;
  s->data = hk_alloc((size_t)esz);
  memcpy(s->data, value, (size_t)esz);
  return s;
}

hk_shared *hk_shared_retain(hk_shared *s) {
  if (s) s->rc++;
  return s;
}

void hk_shared_release(hk_shared *s) {
  if (!s || --s->rc > 0) return;
  /* The last owner runs T's releaser, so whatever the payload owns goes
     with it rather than leaking behind the box. */
  if (s->drop) s->drop(s->data);
  hk_dealloc(s->data);
  s->data = NULL;
  /* The control block has to outlive the value while anything is still
     watching, or asking a weak handle would read freed memory. */
  if (s->wc == 0) hk_dealloc(s);
}

hk_shared *hk_weak_from(hk_shared *s) {
  if (s) s->wc++;
  return s;
}

void hk_weak_release(hk_shared *s) {
  if (!s || --s->wc > 0) return;
  if (s->rc == 0) hk_dealloc(s);
}

hk_bool hk_weak_alive(const hk_shared *s) { return s && s->rc > 0; }
