// Signatures for the prelude's modules — `math`, `files`, `io`, and so on.
//
// One table, read by two places that must agree: inference, so `halka check`
// and the interpreter know what `math.hypot(3.0, 4.0)` is, and the C backend,
// so it can emit a call. Keeping them in separate lists is how they would
// come to disagree.
//
// `c` names the C function the backend emits. A member with no `c` is
// implemented for the interpreter only; the backend refuses it with a
// diagnostic naming the function, which is R23's contract — it may reject
// what the interpreter accepts, but it may not quietly do something else.

import {
  type Ty, BOOL, FLOAT, INT, NOTHING, STRING,
  any, fn, list, map, named, param, tup,
} from "./types.ts";

export interface PreludeMember {
  /** The member's type. Always a function type here. */
  ty: Ty;
  /** The C symbol the backend calls, when one exists. */
  c?: string;
  /**
   * For a function returning `Result<T>`: which field of the runtime's
   * `hk_io_result` carries the success value. The runtime cannot return a
   * `Result<T>` itself, because that type is generated per instantiation,
   * so it returns a neutral struct and the backend wraps it.
   */
  okFrom?: "value" | "number" | "none";
}

const p = (name: string, ty: Ty) => param(name, ty);
const sig = (params: [string, Ty][], ret: Ty, c?: string, okFrom?: PreludeMember["okFrom"]): PreludeMember =>
  ({ ty: fn(params.map(([n, t]) => p(n, t)), ret), c, okFrom });

/** A signature generic over the names given, e.g. `T` for a list element. */
const gsig = (generics: string[], params: [string, Ty][], ret: Ty, c?: string): PreludeMember =>
  ({ ty: fn(params.map(([n, t]) => p(n, t)), ret, generics), c });

const T = named("T");
const K = named("K");
const V = named("V");

/** `Result<T>` for a prelude function that can fail (#22). */
const result = (t: Ty): Ty => named("Result", [t]);

/** One-argument float maths, all lowering to the C library function. */
const UNARY_FLOAT: [string, string][] = [
  ["sqrt", "sqrt"], ["sin", "sin"], ["cos", "cos"], ["tan", "tan"],
  ["asin", "asin"], ["acos", "acos"], ["atan", "atan"],
  ["log", "log"], ["log2", "log2"], ["log10", "log10"], ["exp", "exp"],
  ["sinh", "sinh"], ["cosh", "cosh"], ["tanh", "tanh"], ["cbrt", "cbrt"],
];

const MATH: Record<string, PreludeMember> = {
  ...Object.fromEntries(UNARY_FLOAT.map(([name, c]) => [name, sig([["x", FLOAT]], FLOAT, c)])),
  atan2: sig([["y", FLOAT], ["x", FLOAT]], FLOAT, "atan2"),
  hypot: sig([["x", FLOAT], ["y", FLOAT]], FLOAT, "hypot"),
  gcd: sig([["a", INT], ["b", INT]], INT, "hk_math_gcd"),
  is_nan: sig([["x", FLOAT]], BOOL, "hk_math_is_nan"),
  clamp: sig([["x", FLOAT], ["lo", FLOAT], ["hi", FLOAT]], FLOAT, "hk_math_clamp"),
  // Constants are zero-argument calls, which is how the interpreter has them.
  pi: sig([], FLOAT, "hk_math_pi"),
  e: sig([], FLOAT, "hk_math_e"),
};

const IO: Record<string, PreludeMember> = {
  write: sig([["text", STRING]], NOTHING, "hk_write"),
  error: sig([["text", STRING]], NOTHING, "hk_io_error"),
  // `io.say` takes any number of values of any type; `say` the statement is
  // the native route for that.
  say: sig([["text", STRING]], NOTHING),
};

const TIME: Record<string, PreludeMember> = {
  now: sig([], INT, "hk_time_now"),
  monotonic: sig([], FLOAT, "hk_now_ms"),
  sleep: sig([["ms", INT]], NOTHING),
};

const OS: Record<string, PreludeMember> = {
  env: sig([["name", STRING]], STRING, "hk_os_env"),
  platform: sig([], STRING, "hk_os_platform"),
  exit: sig([["code", INT]], NOTHING, "hk_os_exit"),
  args: sig([], list(STRING)),
};

const STRINGS: Record<string, PreludeMember> = {
  repeat: sig([["s", STRING], ["n", INT]], STRING, "hk_strings_repeat"),
  join: sig([["parts", list(STRING)], ["sep", STRING]], STRING),
  split: sig([["s", STRING], ["sep", STRING]], list(STRING)),
  from_chars: sig([["chars", list(STRING)]], STRING),
  // Variadic after the template, so it has no fixed signature here.
  format: sig([["template", STRING]], STRING),
};

/** spec/FILE-IO.md. Every one is gated on `FileAccess` at run time (#45). */
const FILES: Record<string, PreludeMember> = {
  read: sig([["path", STRING]], result(STRING), "hk_files_read", "value"),
  write: sig([["path", STRING], ["contents", STRING]], result(NOTHING), "hk_files_write", "none"),
  append: sig([["path", STRING], ["contents", STRING]], result(NOTHING), "hk_files_append", "none"),
  remove: sig([["path", STRING]], result(NOTHING), "hk_files_remove", "none"),
  size: sig([["path", STRING]], result(INT), "hk_files_size", "number"),
  exists: sig([["path", STRING]], BOOL, "hk_files_exists"),
  is_dir: sig([["path", STRING]], BOOL, "hk_files_is_dir"),
  make_dir: sig([["path", STRING]], result(NOTHING), "hk_files_make_dir", "none"),
  // These build lists, which a prelude call does not lower to yet.
  lines: sig([["path", STRING]], result(list(STRING))),
  read_bytes: sig([["path", STRING]], result(list(INT))),
  list_dir: sig([["path", STRING]], result(list(STRING))),
};

const LISTS: Record<string, PreludeMember> = {
  concat: gsig(["T"], [["a", list(T)], ["b", list(T)]], list(T), "hk_lists_concat"),
  flatten: gsig(["T"], [["xs", list(list(T))]], list(T), "hk_lists_flatten"),
  chunk: gsig(["T"], [["xs", list(T)], ["n", INT]], list(list(T)), "hk_lists_chunk"),
  // `unique` compares elements, which the runtime can only do for a type it
  // knows the shape of; the backend refuses it rather than comparing bytes
  // of something that is not a scalar.
  unique: gsig(["T"], [["xs", list(T)]], list(T), "hk_lists_unique"),
};

const MAPS: Record<string, PreludeMember> = {
  from_entries: gsig(["K", "V"], [["entries", list(tup([K, V]))]], map(K, V)),
  merge: gsig(["K", "V"], [["a", map(K, V)], ["b", map(K, V)]], map(K, V)),
};

const JSON_MOD: Record<string, PreludeMember> = {
  // `parse` yields whatever the document held, which is `any` by nature.
  parse: sig([["text", STRING]], any("a parsed JSON document")),
  stringify: gsig(["T"], [["value", T]], STRING),
};

export const PRELUDE_MODULES: Map<string, Map<string, PreludeMember>> = new Map(
  Object.entries({
    math: MATH,
    io: IO,
    time: TIME,
    os: OS,
    files: FILES,
    strings: STRINGS,
    lists: LISTS,
    // `maps` and `json` are typed but have no C implementation: the backend
    // has no map type at all, and `json.parse` yields a value whose shape is
    // only known at run time. Typing them still helps `halka check` and the
    // interpreter; `halka build` names the function it cannot compile.
    maps: MAPS,
    json: JSON_MOD,
  }).map(([mod, members]) => [mod, new Map(Object.entries(members))]),
);

export function preludeMember(mod: string, name: string): PreludeMember | undefined {
  return PRELUDE_MODULES.get(mod)?.get(name);
}

export function isPreludeModule(name: string): boolean {
  return PRELUDE_MODULES.has(name);
}
