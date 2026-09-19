// The canonical Halka AST (rule #52: one program, one parse, one AST).
//
// Every node carries a span. Nodes are plain objects with a `kind` tag so the
// tree is trivially serialisable (`halka ast --json`) and easy to walk.

import type { Span } from "../util/diagnostics.ts";
import type { StrPart } from "../lexer/token.ts";

export interface Node {
  kind: string;
  span: Span;
}

export type ForeignLang = "c" | "cpp" | "py";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TypeNode =
  | NamedType
  | OptionalType
  | RefType
  | RawPtrType
  | TupleType
  | ForeignType
  | InferType;

export interface NamedType extends Node { kind: "NamedType"; name: string; args: TypeNode[] }
export interface OptionalType extends Node { kind: "OptionalType"; inner: TypeNode }
export interface RefType extends Node { kind: "RefType"; inner: TypeNode; mut: boolean }
export interface RawPtrType extends Node { kind: "RawPtrType"; inner: TypeNode; mut: boolean }
export interface TupleType extends Node { kind: "TupleType"; elements: TypeNode[] }
export interface ForeignType extends Node { kind: "ForeignType"; lang: ForeignLang; inner: TypeNode }
export interface InferType extends Node { kind: "InferType" }

// ---------------------------------------------------------------------------
// Patterns (#4 destructuring, #10 match)
// ---------------------------------------------------------------------------

export type Pattern =
  | BindPat | WildcardPat | RestPat | LiteralPat | NullPat
  | TuplePat | ListPat | MapPat | VariantPat | StructPat | TypePat;

export interface BindPat extends Node { kind: "BindPat"; name: string; type?: TypeNode }
export interface WildcardPat extends Node { kind: "WildcardPat" }
export interface RestPat extends Node { kind: "RestPat"; name?: string }
export interface LiteralPat extends Node { kind: "LiteralPat"; value: Expr }
export interface NullPat extends Node { kind: "NullPat" }
export interface TuplePat extends Node { kind: "TuplePat"; elements: Pattern[] }
export interface ListPat extends Node { kind: "ListPat"; elements: Pattern[] }
export interface MapPat extends Node { kind: "MapPat"; entries: { key: Expr; value: Pattern }[] }
export interface VariantPat extends Node { kind: "VariantPat"; name: string; args: Pattern[] }
export interface StructPat extends Node { kind: "StructPat"; name: string; fields: { name: string; pattern: Pattern }[] }
export interface TypePat extends Node { kind: "TypePat"; name: string }

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export type Expr =
  | IntLit | FloatLit | StrLit | CharLit | BoolLit | NullLit | NothingLit
  | Ident | TupleExpr | ListExpr | MapExpr | SetExpr | RecordExpr
  | CallExpr | MemberExpr | IndexExpr | SliceExpr
  | UnaryExpr | BinaryExpr | RangeExpr | CastExpr | IsExpr
  | BorrowExpr | MoveExpr | RefExpr | DerefExpr | RawExpr
  | ApplyExpr | StartExpr | AwaitExpr | ReceiveExpr | LoadExpr
  | MakeExpr | AtomicExpr | ReflectExpr | CompileExpr | LaunchExpr | DeviceExpr
  | MatchExpr | ForeignExpr | AcquireExpr | CancelledExpr | FnRefExpr | EllipsisExpr | BlockExpr;

export interface IntLit extends Node { kind: "IntLit"; value: bigint }
export interface FloatLit extends Node { kind: "FloatLit"; value: number }
export interface StrLit extends Node { kind: "StrLit"; parts: StrPartNode[]; raw: boolean; multiline: boolean }
export interface StrPartNode { kind: "text" | "expr"; text?: string; expr?: Expr; span: Span }
export interface CharLit extends Node { kind: "CharLit"; value: string }
export interface BoolLit extends Node { kind: "BoolLit"; value: boolean }
export interface NullLit extends Node { kind: "NullLit" }
export interface NothingLit extends Node { kind: "NothingLit" }
export interface Ident extends Node { kind: "Ident"; name: string }
/** `...` used as an elided argument list or a C variadic marker (#35, #42). */
export interface EllipsisExpr extends Node { kind: "EllipsisExpr" }
/** An indented suite used as a value (a thunk). Produced by nested `name:` blocks, #3. */
export interface BlockExpr extends Node { kind: "BlockExpr"; block: Block }

export interface TupleExpr extends Node { kind: "TupleExpr"; elements: Expr[] }
export interface ListExpr extends Node { kind: "ListExpr"; elements: Expr[]; elemType?: TypeNode }
export interface MapExpr extends Node { kind: "MapExpr"; entries: { key: Expr; value: Expr }[] }
export interface SetExpr extends Node { kind: "SetExpr"; elements: Expr[] }
/** A lowercase `name:` block (R3.1) — an ordered record of key/value entries. */
export interface RecordExpr extends Node { kind: "RecordExpr"; entries: { key: string; value: Expr; span: Span }[] }

export interface CallExpr extends Node { kind: "CallExpr"; callee: Expr; args: Arg[]; typeArgs: TypeNode[]; command: boolean }
export interface Arg { name?: string; value: Expr; span: Span }
export interface MemberExpr extends Node { kind: "MemberExpr"; obj: Expr; name: string }
export interface IndexExpr extends Node { kind: "IndexExpr"; obj: Expr; index: Expr }
export interface SliceExpr extends Node { kind: "SliceExpr"; obj: Expr; start?: Expr; end?: Expr; step?: Expr }

export type UnaryOp = "-" | "+" | "not";
export interface UnaryExpr extends Node { kind: "UnaryExpr"; op: UnaryOp; operand: Expr }

export type BinaryOp = "+" | "-" | "*" | "/" | "%" | "<" | "<=" | ">" | ">=" | "==" | "!=" | "and" | "or";
export interface BinaryExpr extends Node { kind: "BinaryExpr"; op: BinaryOp; lhs: Expr; rhs: Expr }

export interface RangeExpr extends Node { kind: "RangeExpr"; lo?: Expr; hi?: Expr; inclusive: boolean; step?: Expr }
export interface CastExpr extends Node { kind: "CastExpr"; expr: Expr; type: TypeNode; fallible: boolean }
/** `x is null`, `x is error`, `x is int`, `x is Ok` (R10). */
export interface IsExpr extends Node { kind: "IsExpr"; expr: Expr; test: string }

export interface BorrowExpr extends Node { kind: "BorrowExpr"; expr: Expr; mut: boolean }
export interface MoveExpr extends Node { kind: "MoveExpr"; expr: Expr }
export interface RefExpr extends Node { kind: "RefExpr"; expr: Expr; mut: boolean }
export interface DerefExpr extends Node { kind: "DerefExpr"; expr: Expr }
export interface RawExpr extends Node { kind: "RawExpr"; expr: Expr }

export interface ApplyExpr extends Node { kind: "ApplyExpr"; value: Expr; fn: Expr }
export interface StartExpr extends Node { kind: "StartExpr"; call: Expr }
export interface AwaitExpr extends Node { kind: "AwaitExpr"; expr: Expr }
export interface ReceiveExpr extends Node { kind: "ReceiveExpr"; channel: Expr }
export interface LoadExpr extends Node { kind: "LoadExpr"; target: Expr }
export interface MakeExpr extends Node { kind: "MakeExpr"; what: "channel" | "mutex" | "rwmutex"; type?: TypeNode; capacity?: Expr }
export interface AtomicExpr extends Node { kind: "AtomicExpr"; type?: TypeNode; init: Expr }
export interface ReflectExpr extends Node { kind: "ReflectExpr"; target: Expr }
export interface CompileExpr extends Node { kind: "CompileExpr"; expr: Expr }
export interface LaunchExpr extends Node { kind: "LaunchExpr"; call: Expr; config?: RecordExpr }
export interface DeviceExpr extends Node { kind: "DeviceExpr"; expr: Expr }
export interface AcquireExpr extends Node { kind: "AcquireExpr"; capability: string }
export interface CancelledExpr extends Node { kind: "CancelledExpr" }
export interface ForeignExpr extends Node { kind: "ForeignExpr"; lang: ForeignLang; expr: Expr }
/** A bare reference to a named function used as a value (#17). Produced by resolution. */
export interface FnRefExpr extends Node { kind: "FnRefExpr"; name: string }

export interface MatchArm { pattern: Pattern; guard?: Expr; body: Block; span: Span }
export interface MatchExpr extends Node { kind: "MatchExpr"; subject: Expr; arms: MatchArm[]; elseArm?: Block }

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export type Stmt =
  | LetStmt | AssignStmt | ExprStmt | SayStmt | GiveStmt
  | IfStmt | ForStmt | WhileStmt | MatchStmt
  | BreakStmt | ContinueStmt | DeferStmt | WithStmt
  | ParallelStmt | UnsafeStmt | IntrinsicStmt
  | FnDecl | StructDecl | ImplDecl | TraitDecl | EnumDecl | TypeAliasDecl
  | CapabilityDecl | ImportDecl | ExportDecl | ConstDecl | ExternDecl
  | GenerateDecl | SpecializeDecl;

export interface Block extends Node { kind: "Block"; stmts: Stmt[] }

export interface LetStmt extends Node { kind: "LetStmt"; pattern: Pattern; type?: TypeNode; value?: Expr; isConst: boolean }
export interface AssignStmt extends Node { kind: "AssignStmt"; target: Expr; type?: TypeNode; value: Expr }
export interface ExprStmt extends Node { kind: "ExprStmt"; expr: Expr }
export interface SayStmt extends Node { kind: "SayStmt"; args: Expr[] }
export interface GiveStmt extends Node { kind: "GiveStmt"; value?: Expr }

export interface IfStmt extends Node {
  kind: "IfStmt";
  cond: Expr;
  then: Block;
  elifs: { cond: Expr; block: Block; span: Span }[];
  else?: Block;
}
export interface ForStmt extends Node { kind: "ForStmt"; pattern: Pattern; iter: Expr; body: Block }
export interface WhileStmt extends Node { kind: "WhileStmt"; cond: Expr; body: Block }
export interface MatchStmt extends Node { kind: "MatchStmt"; expr: MatchExpr }
export interface BreakStmt extends Node { kind: "BreakStmt" }
export interface ContinueStmt extends Node { kind: "ContinueStmt" }
export interface DeferStmt extends Node { kind: "DeferStmt"; stmt: Stmt }
export interface WithStmt extends Node { kind: "WithStmt"; subject: Expr; capability: boolean; body: Block }
export interface ParallelStmt extends Node { kind: "ParallelStmt"; body: Block }
export interface UnsafeStmt extends Node { kind: "UnsafeStmt"; body: Block }

/**
 * Keyword operations with a target/operand association (R1.2):
 * `send ch : v`, `store a : v`, `add a : v`, `subtract a : v`,
 * `cancel t`, `register h`, `release l`, `revoke C from w`, `give C to w`.
 */
export interface IntrinsicStmt extends Node {
  kind: "IntrinsicStmt";
  op: "send" | "store" | "add" | "subtract" | "cancel" | "register" | "release" | "acquire" | "revoke" | "grant" | "specialize";
  target: Expr;
  value?: Expr;
}

// ---- declarations ----------------------------------------------------------

export interface Param {
  name: string;
  type?: TypeNode;
  default?: Expr;
  variadic: boolean;
  span: Span;
}

export interface FnDecl extends Node {
  kind: "FnDecl";
  name: string;
  generics: GenericParam[];
  params: Param[];
  retType?: TypeNode;
  body?: Block;
  /** Declaration markers: #39 compile, #40 macro, #38 callback, #44 kernel/device. */
  isMacro: boolean;
  isCompile: boolean;
  isCallback: boolean;
  isKernel: boolean;
  isDevice: boolean;
  /** #45 — `f() requires Cap, Cap2,` */
  requires: string[];
  /** Set when the function is a trait member with no body. */
  isSignature: boolean;
  foreign?: ForeignLang;
}

export interface GenericParam { name: string; bounds: string[]; span: Span }

export interface FieldDecl { name: string; type?: TypeNode; default?: Expr; span: Span }

export interface StructDecl extends Node {
  kind: "StructDecl";
  name: string;
  generics: GenericParam[];
  fields: FieldDecl[];
  foreign?: ForeignLang;
}

export interface ImplDecl extends Node { kind: "ImplDecl"; typeName: string; traits: string[]; members: FnDecl[] }
export interface TraitDecl extends Node { kind: "TraitDecl"; name: string; generics: GenericParam[]; members: FnDecl[] }
export interface EnumVariant { name: string; fields: Param[]; span: Span }
export interface EnumDecl extends Node { kind: "EnumDecl"; name: string; generics: GenericParam[]; variants: EnumVariant[] }
export interface TypeAliasDecl extends Node { kind: "TypeAliasDecl"; name: string; generics: GenericParam[]; type: TypeNode }
export interface CapabilityDecl extends Node { kind: "CapabilityDecl"; name: string; perms: string[] }

export interface ImportDecl extends Node {
  kind: "ImportDecl";
  /** `import math` | `from math import a, b` */
  form: "module" | "from";
  foreign?: ForeignLang;
  /** Dotted path or quoted package path. */
  path: string;
  names: { name: string; alias?: string }[];
  alias?: string;
}

export interface ExportDecl extends Node { kind: "ExportDecl"; names: string[] }
export interface ConstDecl extends Node { kind: "ConstDecl"; name: string; type?: TypeNode; value: Expr }
export interface ExternDecl extends Node { kind: "ExternDecl"; lang?: ForeignLang; name?: string; abi?: Record<string, string> }
export interface GenerateDecl extends Node { kind: "GenerateDecl"; target?: string; lang?: ForeignLang; body: Block }
export interface SpecializeDecl extends Node { kind: "SpecializeDecl"; items: { name: string; typeArgs: TypeNode[]; span: Span }[] }

export interface Module extends Node {
  kind: "Module";
  file: string;
  stmts: Stmt[];
}

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

/** Generic child-node visitor. Visits every Node-shaped value reachable from `n`. */
export function children(n: unknown): Node[] {
  const out: Node[] = [];
  if (!n || typeof n !== "object") return out;
  for (const v of Object.values(n as Record<string, unknown>)) {
    if (Array.isArray(v)) {
      for (const e of v) {
        if (isNode(e)) out.push(e);
        else if (e && typeof e === "object") out.push(...children(e));
      }
    } else if (isNode(v)) out.push(v);
  }
  return out;
}

export function isNode(v: unknown): v is Node {
  return !!v && typeof v === "object" && typeof (v as Node).kind === "string" && "span" in (v as object);
}

export function walk(root: Node, visit: (n: Node, parent: Node | null) => void | false): void {
  const go = (n: Node, parent: Node | null) => {
    if (visit(n, parent) === false) return;
    for (const c of children(n)) go(c, n);
  };
  go(root, null);
}
