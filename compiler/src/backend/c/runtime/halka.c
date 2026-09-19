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

void hk_panic(const char *msg, const char *file, hk_int line) {
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

hk_list *hk_list_new(hk_int esz, hk_int cap) {
  hk_list *l = (hk_list *)hk_alloc(sizeof(hk_list));
  l->rc = 1;
  l->len = 0;
  l->cap = cap > 0 ? cap : 0;
  l->esz = esz;
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
  if (--l->rc == 0) { hk_dealloc(l->data); hk_dealloc(l); }
}

hk_int hk_list_check(hk_list *l, hk_int i, const char *file, hk_int line) {
  hk_int j = i < 0 ? i + l->len : i;   /* negative indices count from the end (#54) */
  if (j < 0 || j >= l->len) {
    char buf[96];
    snprintf(buf, sizeof buf, "index %lld is out of range for length %lld",
             (long long)i, (long long)l->len);
    hk_panic(buf, file, line);
  }
  return j;
}

/* A list prints the way `inspect` prints it: [1, 2, 3] (#53). */
hk_str *hk_str_from_list(struct hk_list *l, int kind) {
  hk_str *acc = hk_str_new("[", 1);
  for (hk_int i = 0; i < l->len; i++) {
    if (i) {
      hk_str *sep = hk_str_new(", ", 2);
      hk_str *t = hk_str_cat(acc, sep);
      hk_str_release(acc); hk_str_release(sep);
      acc = t;
    }
    hk_str *piece;
    switch (kind) {
      case 1:  piece = hk_str_from_float(HK_AT(l, hk_float, i)); break;
      case 2:  piece = hk_str_from_bool(HK_AT(l, hk_bool, i)); break;
      case 3:  piece = hk_str_from_char(HK_AT(l, hk_char, i)); break;
      case 4:  piece = hk_str_retain(HK_AT(l, hk_str *, i)); break;
      default: piece = hk_str_from_int(HK_AT(l, hk_int, i)); break;
    }
    hk_str *t = hk_str_cat(acc, piece);
    hk_str_release(acc); hk_str_release(piece);
    acc = t;
  }
  hk_str *close = hk_str_new("]", 1);
  hk_str *out = hk_str_cat(acc, close);
  hk_str_release(acc); hk_str_release(close);
  return out;
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

hk_bool hk_cap_held(const char *permission) {
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
    "  a compiled program takes capabilities from HALKA_GRANTS; run it with "
    "HALKA_GRANTS=FileAccess\n",
    who, permission);
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
