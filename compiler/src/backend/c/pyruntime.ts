// The CPython embedding layer emitted into a program that uses `py` (#37).
//
// It is emitted into the generated C rather than living in libhalka, so that a
// program with no Python interop does not link against libpython.
//
// Design notes:
//   * Crossing *into* Python is implicit — a Halka scalar converts on the way
//     in, because the target type is unambiguous.
//   * Crossing *back out* is explicit, with `as` (#15). A Python value has no
//     static type, so the program has to say what it expects. `to` gives the
//     fallible form and yields a Result, which is how #37's "translated into
//     HALKA-compatible values and safe error results" is honoured.
//   * Every Halka thread that touches Python takes the GIL around the call and
//     releases it immediately after, so Halka's own `parallel:` keeps running
//     on all cores while Python work is serialised only where it must be.

export const PY_RUNTIME = String.raw`
/* ---- CPython embedding (#37) ------------------------------------------- */

static int hk_py_ready = 0;

static void hk_py_fail(const char *what, const char *file, hk_int line) {
  char buf[512];
  PyObject *type = NULL, *value = NULL, *tb = NULL;
  if (PyErr_Occurred()) {
    PyErr_Fetch(&type, &value, &tb);
    PyErr_NormalizeException(&type, &value, &tb);
    PyObject *s = value ? PyObject_Str(value) : NULL;
    const char *msg = s ? PyUnicode_AsUTF8(s) : "unknown error";
    snprintf(buf, sizeof buf, "python: %s: %s", what, msg ? msg : "unknown error");
    Py_XDECREF(s);
    Py_XDECREF(type); Py_XDECREF(value); Py_XDECREF(tb);
  } else {
    snprintf(buf, sizeof buf, "python: %s", what);
  }
  hk_panic(buf, file, line);
}

static void hk_py_start(void) {
  if (hk_py_ready) return;
#ifdef HK_PYTHONHOME
  /* An embedded interpreter has no sys.executable to infer its prefix from,
     so the build bakes in the one it linked against. */
  if (!getenv("PYTHONHOME")) {
#if defined(_WIN32)
    _putenv_s("PYTHONHOME", HK_PYTHONHOME);
#else
    setenv("PYTHONHOME", HK_PYTHONHOME, 0);
#endif
  }
#endif
  Py_InitializeEx(1);
  /* Release the GIL held by the initialising thread so Halka threads can take
     it individually; each call below reacquires it for its own duration. */
  PyEval_SaveThread();
  hk_py_ready = 1;
}

static void hk_py_stop(void) {
  if (!hk_py_ready) return;
  PyGILState_Ensure();
  Py_Finalize();
  hk_py_ready = 0;
}

static PyObject *hk_py_import(const char *name, const char *file, hk_int line) {
  PyGILState_STATE g = PyGILState_Ensure();
  PyObject *m = PyImport_ImportModule(name);
  if (!m) hk_py_fail(name, file, line);   /* reads PyErr, so keep the GIL */
  PyGILState_Release(g);
  return m;
}

/* ---- Halka -> Python ---------------------------------------------------- */

/* Every one of these takes the GIL, because the generated code evaluates
   arguments before it reaches hk_py_call. Touching a PyObject without the GIL
   is an access violation, not a race you might get away with. */
static PyObject *hk_py_from_int(hk_int v) {
  PyGILState_STATE g = PyGILState_Ensure();
  PyObject *o = PyLong_FromLongLong((long long)v);
  PyGILState_Release(g);
  return o;
}

static PyObject *hk_py_from_float(hk_float v) {
  PyGILState_STATE g = PyGILState_Ensure();
  PyObject *o = PyFloat_FromDouble(v);
  PyGILState_Release(g);
  return o;
}

static PyObject *hk_py_from_bool(hk_bool v) {
  PyGILState_STATE g = PyGILState_Ensure();
  PyObject *o = PyBool_FromLong(v ? 1 : 0);
  PyGILState_Release(g);
  return o;
}

static PyObject *hk_py_from_str(hk_str *s) {
  PyGILState_STATE g = PyGILState_Ensure();
  PyObject *o = PyUnicode_FromStringAndSize(s->data, (Py_ssize_t)s->len);
  PyGILState_Release(g);
  return o;
}

static PyObject *hk_py_from_list_int(hk_list *l) {
  PyGILState_STATE g = PyGILState_Ensure();
  PyObject *out = PyList_New((Py_ssize_t)l->len);
  for (hk_int i = 0; i < l->len; i++) {
    PyList_SET_ITEM(out, (Py_ssize_t)i, PyLong_FromLongLong((long long)HK_AT(l, hk_int, i)));
  }
  PyGILState_Release(g);
  return out;
}

static PyObject *hk_py_from_list_float(hk_list *l) {
  PyGILState_STATE g = PyGILState_Ensure();
  PyObject *out = PyList_New((Py_ssize_t)l->len);
  for (hk_int i = 0; i < l->len; i++) {
    PyList_SET_ITEM(out, (Py_ssize_t)i, PyFloat_FromDouble(HK_AT(l, hk_float, i)));
  }
  PyGILState_Release(g);
  return out;
}

/* ---- calling ------------------------------------------------------------ */

static PyObject *hk_py_attr(PyObject *obj, const char *name, const char *file, hk_int line) {
  PyGILState_STATE g = PyGILState_Ensure();
  PyObject *a = PyObject_GetAttrString(obj, name);
  if (!a) hk_py_fail(name, file, line);
  PyGILState_Release(g);
  return a;
}

/* Calls 'fn' with 'n' already-converted arguments and steals their references. */
static PyObject *hk_py_call(PyObject *fn, PyObject **args, int n, const char *what,
                            const char *file, hk_int line) {
  PyGILState_STATE g = PyGILState_Ensure();
  PyObject *tuple = PyTuple_New(n);
  for (int i = 0; i < n; i++) PyTuple_SET_ITEM(tuple, i, args[i]); /* steals */
  PyObject *r = PyObject_CallObject(fn, tuple);
  Py_DECREF(tuple);
  if (!r) hk_py_fail(what, file, line);
  PyGILState_Release(g);
  return r;
}

static PyObject *hk_py_call_method(PyObject *obj, const char *name, PyObject **args, int n,
                                   const char *file, hk_int line) {
  PyObject *fn = hk_py_attr(obj, name, file, line);
  PyObject *r = hk_py_call(fn, args, n, name, file, line);
  Py_DECREF(fn);
  return r;
}

/* ---- Python -> Halka (explicit, via 'as' / 'to') ------------------------ */

static hk_int hk_py_to_int(PyObject *o, const char *file, hk_int line) {
  PyGILState_STATE g = PyGILState_Ensure();
  long long v = 0;
  if (PyLong_Check(o)) v = PyLong_AsLongLong(o);
  else if (PyFloat_Check(o)) v = (long long)PyFloat_AsDouble(o);
  else {
    PyObject *n = PyNumber_Long(o);
    if (!n) { hk_py_fail("value is not a whole number", file, line); }
    v = PyLong_AsLongLong(n);
    Py_DECREF(n);
  }
  if (PyErr_Occurred()) { hk_py_fail("converting to int", file, line); }
  PyGILState_Release(g);
  return (hk_int)v;
}

static hk_float hk_py_to_float(PyObject *o, const char *file, hk_int line) {
  PyGILState_STATE g = PyGILState_Ensure();
  double v = PyFloat_AsDouble(o);
  if (PyErr_Occurred()) { hk_py_fail("converting to float", file, line); }
  PyGILState_Release(g);
  return (hk_float)v;
}

static hk_bool hk_py_to_bool(PyObject *o) {
  PyGILState_STATE g = PyGILState_Ensure();
  int v = PyObject_IsTrue(o);
  PyGILState_Release(g);
  return v > 0;
}

static hk_str *hk_py_to_str(PyObject *o, const char *file, hk_int line) {
  PyGILState_STATE g = PyGILState_Ensure();
  PyObject *s = PyObject_Str(o);
  if (!s) { hk_py_fail("converting to string", file, line); }
  Py_ssize_t n = 0;
  const char *p = PyUnicode_AsUTF8AndSize(s, &n);
  hk_str *out = hk_str_new(p ? p : "", (hk_int)(p ? n : 0));
  Py_DECREF(s);
  PyGILState_Release(g);
  return out;
}

static hk_list *hk_py_to_list_int(PyObject *o, const char *file, hk_int line) {
  PyGILState_STATE g = PyGILState_Ensure();
  PyObject *seq = PySequence_Fast(o, "value is not a sequence");
  if (!seq) { hk_py_fail("converting to list(int)", file, line); }
  Py_ssize_t n = PySequence_Fast_GET_SIZE(seq);
  hk_list *l = hk_list_new((hk_int)sizeof(hk_int), (hk_int)n, HK_E_SCALAR);
  for (Py_ssize_t i = 0; i < n; i++) {
    long long v = PyLong_AsLongLong(PySequence_Fast_GET_ITEM(seq, i));
    HK_PUSH(l, hk_int, (hk_int)v);
  }
  Py_DECREF(seq);
  PyGILState_Release(g);
  return l;
}

static hk_list *hk_py_to_list_float(PyObject *o, const char *file, hk_int line) {
  PyGILState_STATE g = PyGILState_Ensure();
  PyObject *seq = PySequence_Fast(o, "value is not a sequence");
  if (!seq) { hk_py_fail("converting to list(float)", file, line); }
  Py_ssize_t n = PySequence_Fast_GET_SIZE(seq);
  hk_list *l = hk_list_new((hk_int)sizeof(hk_float), (hk_int)n, HK_E_SCALAR);
  for (Py_ssize_t i = 0; i < n; i++) {
    double v = PyFloat_AsDouble(PySequence_Fast_GET_ITEM(seq, i));
    HK_PUSH(l, hk_float, (hk_float)v);
  }
  Py_DECREF(seq);
  PyGILState_Release(g);
  return l;
}
`;

/** The conversion to call when a Python value crosses back into Halka. */
export function pyConverter(cType: string): string | null {
  switch (cType) {
    case "hk_int": return "hk_py_to_int";
    case "hk_float": return "hk_py_to_float";
    case "hk_bool": return "hk_py_to_bool";
    case "hk_str *": return "hk_py_to_str";
    default: return null;
  }
}

/** The conversion to call when a Halka value crosses into Python. */
export function pyLifter(cType: string): string | null {
  switch (cType) {
    case "hk_int": return "hk_py_from_int";
    case "hk_float": return "hk_py_from_float";
    case "hk_bool": return "hk_py_from_bool";
    case "hk_str *": return "hk_py_from_str";
    case "PyObject *": return null; // already a Python value
    default: return null;
  }
}
