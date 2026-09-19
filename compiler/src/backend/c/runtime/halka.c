/* libhalka — implementation. C99, no dependencies. */

#include "halka.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

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

static void *hk_alloc(size_t n) {
  void *p = malloc(n);
  if (!p) hk_panic("out of memory", __FILE__, __LINE__);
  return p;
}

static void *hk_realloc(void *old, size_t n) {
  void *p = realloc(old, n);
  if (!p) hk_panic("out of memory", __FILE__, __LINE__);
  return p;
}

/* ---- strings ------------------------------------------------------------ */

hk_str *hk_str_new(const char *bytes, hk_int len) {
  hk_str *s = (hk_str *)hk_alloc(sizeof(hk_str) + (size_t)len);
  s->rc = 1;
  s->len = len;
  if (len) memcpy(s->data, bytes, (size_t)len);
  s->data[len] = '\0';
  return s;
}

hk_str *hk_str_lit(const char *cstr) {
  /* Literals are interned by the generated code; rc = -1 means "never free". */
  hk_int len = (hk_int)strlen(cstr);
  hk_str *s = hk_str_new(cstr, len);
  s->rc = -1;
  return s;
}

hk_str *hk_str_retain(hk_str *s) {
  if (s && s->rc >= 0) s->rc++;
  return s;
}

void hk_str_release(hk_str *s) {
  if (!s || s->rc < 0) return;
  if (--s->rc == 0) free(s);
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
  if (--l->rc == 0) { free(l->data); free(l); }
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
  free(t);
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
  free(m);
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

/* ---- entry -------------------------------------------------------------- */

void hk_init(int argc, char **argv) { (void)argc; (void)argv; }
void hk_shutdown(void) { fflush(stdout); }
