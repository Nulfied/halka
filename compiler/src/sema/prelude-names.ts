// Names the checker treats as always in scope, mirroring runtime/prelude.ts.
// Kept in a separate file so the checker never has to import the interpreter.

export const PRELUDE_ARITY: Record<string, [number, number]> = {
  // core
  len: [1, 1], type_of: [1, 1], inspect: [1, 1], print: [0, Infinity],
  panic: [1, 1], assert: [1, 2], id: [1, 1],
  // conversions
  int: [1, 1], float: [1, 1], string: [1, 1], bool: [1, 1], char: [1, 1],
  // constructors
  list: [0, 1], array: [0, 2], tuple: [0, Infinity], set: [0, 1], map: [0, 1], range: [1, 3],
  // numbers
  abs: [1, 1], div: [2, 2], mod: [2, 2], round: [1, 1], round_to: [2, 2], floor: [1, 1], ceil: [1, 1],
  sqrt: [1, 1], pow: [2, 2], min: [1, Infinity], max: [1, Infinity], sum: [1, 1],
  // sequences
  sorted: [1, 2], reversed: [1, 1], enumerate: [1, 1], zip: [2, Infinity], contains: [2, 2],
  // atomics (#30)
  add: [2, 2], subtract: [2, 2], exchange: [2, 2], compare_exchange: [3, 3],
  // channels / tasks (#26-#31)
  close: [1, 1], sleep: [1, 1], yield_now: [0, 0],
  now_ms: [0, 0], cpu_count: [0, 0],
  acquire: [1, 1], acquire_lock: [1, 1], release_lock: [1, 1], task_state: [1, 1],
  // function values (#17)
  apply: [2, 2],
  // Result (#22)
  Ok: [1, 1], Error: [1, 1],
};

export const PRELUDE_NAMES: readonly string[] = [
  ...Object.keys(PRELUDE_ARITY),
  "Cancelled",
  // built-in type names usable in annotations and `is` tests
  "int", "uint", "float", "byte", "bool", "string", "char", "void",
  "int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64",
  "float32", "float64", "double",
  "list", "array", "map", "set", "tuple", "channel", "task", "Result",
  // module names reachable after `import`
  "math", "strings", "lists", "maps", "io", "fs", "time", "os", "json",
];
