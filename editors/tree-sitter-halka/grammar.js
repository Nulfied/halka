/**
 * Tree-sitter grammar for Halka (V49).
 *
 * Layout tokens (_newline, _indent, _dedent) come from the external scanner in
 * src/scanner.c, which also suppresses layout inside brackets exactly as the
 * reference lexer does (R12).
 *
 * This grammar exists for editors: highlighting, folding, indentation and text
 * objects. The reference parser in `compiler/src/parser` remains normative.
 */

const PREC = {
  or: 1,
  and: 2,
  not: 3,
  compare: 4,
  range: 5,
  add: 6,
  mul: 7,
  cast: 8,
  unary: 9,
  postfix: 10,
};

module.exports = grammar({
  name: "halka",

  externals: ($) => [$._newline, $._indent, $._dedent],

  extras: ($) => [/[ \t]/, $.line_comment, $.block_comment, $.line_continuation],

  word: ($) => $.identifier,

  conflicts: ($) => [
    [$._type, $._primary_expression],
    [$.range_expression],
    [$._type, $.generic_type],
    [$.generic_type, $._primary_expression],
    [$.pattern, $.null],
    [$.struct_declaration, $._primary_expression],
    [$.function_declaration, $._primary_expression],
  ],

  // `pattern` is deliberately not a supertype. A supertype is erased from
  // the tree in favour of its concrete member, and queries/locals.scm asks
  // for `(let_statement pattern: (pattern (identifier)))` — which could never
  // match while it was one, so no local variable was ever captured.
  supertypes: ($) => [$._statement, $._expression, $._type],

  rules: {
    source_file: ($) => repeat($._statement),

    // ---- trivia ----------------------------------------------------------

    line_comment: (_) => token(seq("#", /[^\n]*/)),
    block_comment: (_) => token(seq("###", /[^#]*(#[^#][^#]*)*/, "###")),
    line_continuation: (_) => token(seq("\\", /\r?\n/)),

    // ---- statements ------------------------------------------------------

    _statement: ($) =>
      choice(
        $.function_declaration,
        $.struct_declaration,
        $.enum_declaration,
        $.trait_declaration,
        $.implements_declaration,
        $.type_alias,
        $.capability_declaration,
        $.import_statement,
        $.from_import_statement,
        $.export_statement,
        $.let_statement,
        $.assignment,
        $.if_statement,
        $.for_statement,
        $.while_statement,
        $.match_statement,
        $.with_statement,
        $.parallel_statement,
        $.unsafe_statement,
        $.generate_declaration,
        $.specialize_declaration,
        $.extern_declaration,
        $.defer_statement,
        $.say_statement,
        $.give_statement,
        $.break_statement,
        $.continue_statement,
        $.channel_statement,
        $.expression_statement,
        $._newline,
      ),

    _end: ($) => seq(optional(","), $._newline),

    _block: ($) => seq(optional(","), optional(":"), $._newline, $._indent, repeat1($._statement), $._dedent),

    // ---- declarations ----------------------------------------------------

    // `square(x),` is also a call followed by a statement end; only the
    // indented block that may follow tells them apart, which is further than
    // the parser can look. The conflict with `primary_expression` keeps both
    // readings alive, and this prefers the declaration once both complete.
    function_declaration: ($) =>
      prec.dynamic(2, seq(
        optional(field("marker", choice("macro", "compile", "kernel", "callback", "device"))),
        field("name", $.identifier),
        optional(field("generics", $.type_parameters)),
        field("parameters", $.parameter_list),
        choice(
          // With a body: the block is what tells a declaration apart from a
          // call statement, so nothing else is needed.
          seq(
            optional(seq(":", field("return_type", $._type))),
            optional(seq("requires", commaSep1(field("capability", $.capability_path)))),
            field("body", $._block),
          ),
          // Bodyless — a contract or a trait member. `name(args)` on its own
          // is a call statement, and that is much the commoner form, so a
          // bodyless declaration has to carry a return type or a capability
          // list to be read as one.
          seq(
            ":", field("return_type", $._type),
            optional(seq("requires", commaSep1(field("capability", $.capability_path)))),
            $._end,
          ),
          seq(
            "requires", commaSep1(field("capability", $.capability_path)),
            $._end,
          ),
        ),
      )),

    parameter_list: ($) => seq("(", optional(commaSep(choice($.parameter, "..."))), optional(","), ")"),

    parameter: ($) =>
      seq(
        field("name", $.identifier),
        optional(seq(":", optional("..."), field("type", $._type))),
        optional(seq(":", field("default", $._expression))),
      ),

    type_parameters: ($) => seq("<", commaSep1($.type_parameter), ">"),
    type_parameter: ($) => seq(field("name", $.identifier), optional(seq(":", sep1($.identifier, "+")))),

    struct_declaration: ($) =>
      seq(
        optional(seq(field("marker", $.ffi_marker), choice("struct", "class"))),
        field("name", $.type_identifier),
        optional(field("generics", $.type_parameters)),
        ":",
        $._newline,
        $._indent,
        repeat1($.field_declaration),
        $._dedent,
      ),

    field_declaration: ($) =>
      seq(field("name", $.identifier), optional(seq(":", field("type", $._type))), optional(seq(":", field("default", $._expression))), $._end),

    enum_declaration: ($) =>
      seq(
        "enum",
        field("name", $.type_identifier),
        optional(field("generics", $.type_parameters)),
        optional(choice(":", ",")),
        $._newline,
        $._indent,
        repeat1($.enum_variant),
        $._dedent,
      ),

    enum_variant: ($) => seq(field("name", $.type_identifier), optional($.parameter_list), $._end),

    trait_declaration: ($) =>
      seq("trait", field("name", $.type_identifier), optional(field("generics", $.type_parameters)), $._block),

    implements_declaration: ($) =>
      seq(field("type", $.type_identifier), "implements", commaSep1(field("trait", $.type_identifier)), $._block),

    type_alias: ($) =>
      seq("type", field("name", $.type_identifier), optional(field("generics", $.type_parameters)), ":", field("value", $._type), $._end),

    capability_declaration: ($) =>
      seq("capability", field("name", $.type_identifier), ":", $._newline, $._indent, repeat1(seq($.identifier, $._end)), $._dedent),

    capability_path: ($) => sep1($.identifier, "."),

    // ---- modules ---------------------------------------------------------

    import_statement: ($) =>
      seq("import", optional(field("lang", $.ffi_marker)), field("path", choice($.module_path, $.string)), optional(seq(":", field("alias", $.identifier))), $._end),

    from_import_statement: ($) =>
      seq("from", optional(field("lang", $.ffi_marker)), field("path", choice($.module_path, $.string)), "import", commaSep1(field("name", $.identifier)), $._end),

    export_statement: ($) =>
      seq("export", choice(seq(commaSep1($.identifier), $._end), seq(":", $._newline, $._indent, repeat1(seq($.identifier, $._end)), $._dedent))),

    module_path: ($) => sep1($.identifier, "."),
    ffi_marker: (_) => choice("c", "cpp", "py"),

    // ---- simple statements -----------------------------------------------

    let_statement: ($) =>
      seq(
        choice("let", "const"),
        field("pattern", $.pattern),
        optional(seq(":", optional(field("type", $._type)), optional(seq(":", field("value", $._expression))))),
        optional(seq(":", field("value", $._expression))),
        choice($._end, $._record_block),
      ),

    assignment: ($) =>
      seq(field("target", $._expression), ":", optional(seq(field("type", $._type), ":")), choice(seq(field("value", $._expression), $._end), $._record_block)),

    _record_block: ($) => seq($._newline, $._indent, repeat1($._statement), $._dedent),

    say_statement: ($) => seq("say", optional(commaSep1($._expression)), $._end),
    give_statement: ($) => seq("give", optional($._expression), $._end),
    break_statement: ($) => seq("break", $._end),
    continue_statement: ($) => seq("continue", $._end),
    defer_statement: ($) => seq("defer", $._statement),

    channel_statement: ($) =>
      seq(field("op", choice("send", "store", "cancel", "register", "release", "revoke")), field("target", $._expression), optional(seq(choice(":", "from"), field("value", $._expression))), $._end),

    expression_statement: ($) => seq(choice($._expression, $.command_call), $._end),

    /** `say x`, `close file`, `add counter : 1` — parenthesis-free calls (R7). */
    command_call: ($) =>
      prec(
        -1,
        seq(field("function", $.identifier), field("argument", $._command_argument), optional(seq(":", field("value", $._expression)))),
      ),

    /**
     * A command call is the *parenthesis-free* form, so its argument may not
     * begin with `(`. That rules out `member_expression` and
     * `index_expression` too, since both start with an expression that may
     * itself be parenthesised. Allowing it to made `identifier (` a three-way fork —
     * parameter list, argument list, or command argument — which the
     * generator then settled silently against the declaration, so no
     * function declaration ever parsed as one.
     */
    _command_argument: ($) =>
      choice(
        $.identifier,
        $.type_identifier,
        $.list_expression,
        $.map_expression,
        $.set_expression,
        $._literal,
      ),

    // ---- control flow ----------------------------------------------------

    if_statement: ($) =>
      seq(
        "if",
        field("condition", $._expression),
        field("consequence", $._block),
        repeat(field("alternative", $.else_if_clause)),
        optional(field("alternative", $.else_clause)),
      ),

    else_if_clause: ($) => seq(optional(","), "else", "if", field("condition", $._expression), $._block),
    else_clause: ($) => seq(optional(","), "else", $._block),

    for_statement: ($) => seq("for", field("pattern", $.pattern), "in", field("iterable", $._expression), field("body", $._block)),
    while_statement: ($) => seq("while", field("condition", $._expression), field("body", $._block)),

    match_statement: ($) =>
      seq("match", field("subject", $._expression), optional(","), optional(":"), $._newline, $._indent, repeat1($.match_arm), $._dedent),

    match_arm: ($) =>
      seq(choice(seq(field("pattern", $.pattern), optional(seq("if", field("guard", $._expression)))), "else"), field("body", $._block), optional(",")),

    with_statement: ($) => seq("with", optional("capability"), field("subject", $._expression), field("body", $._block)),
    parallel_statement: ($) => seq("parallel", ":", $._newline, $._indent, repeat1($._statement), $._dedent),
    unsafe_statement: ($) => seq("unsafe", ":", $._newline, $._indent, repeat1($._statement), $._dedent),

    generate_declaration: ($) => seq("generate", optional(choice($.ffi_marker, $.type_identifier)), ":", $._newline, $._indent, repeat1($._statement), $._dedent),
    specialize_declaration: ($) => seq("specialize", choice(seq($.identifier, optional($.type_arguments), $._end), seq(":", $._newline, $._indent, repeat1(seq($.identifier, optional($.type_arguments), $._end)), $._dedent))),
    extern_declaration: ($) => seq("extern", choice(seq(optional($.ffi_marker), $.identifier, $._end), seq(":", $._newline, $._indent, repeat1($._statement), $._dedent))),

    // ---- patterns --------------------------------------------------------

    pattern: ($) =>
      choice($.identifier, $.type_identifier, "_", $.rest_pattern, $.tuple_pattern, $.list_pattern, $.variant_pattern, $.struct_pattern, $._literal, "null"),

    rest_pattern: ($) => seq("...", optional($.identifier)),
    tuple_pattern: ($) => seq("(", optional(commaSep($.pattern)), optional(","), ")"),
    list_pattern: ($) => seq("[", optional(commaSep($.pattern)), optional(","), "]"),
    variant_pattern: ($) => seq(field("name", $.type_identifier), "(", optional(commaSep($.pattern)), ")"),
    struct_pattern: ($) => seq(field("name", $.type_identifier), "{", optional(commaSep(seq($.identifier, optional(seq(":", $.pattern))))), "}"),

    // ---- types -----------------------------------------------------------

    _type: ($) => choice($.primitive_type, $.generic_type, $.optional_type, $.reference_type, $.raw_pointer_type, $.tuple_type, $.type_identifier, $.identifier),

    primitive_type: (_) =>
      choice("int", "uint", "float", "byte", "bool", "string", "char", "void",
        "int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64", "float32", "float64", "double"),

    generic_type: ($) => seq(field("name", choice($.type_identifier, $.identifier, $.primitive_type)), choice($.type_arguments, seq("(", commaSep1($._type), ")"))),
    type_arguments: ($) => seq("<", commaSep1($._type), ">"),
    optional_type: ($) => prec(PREC.postfix, seq($._type, "?")),
    reference_type: ($) => seq("&", optional("mut"), $._type),
    raw_pointer_type: ($) => seq("raw", "*", optional("mut"), $._type),
    tuple_type: ($) => seq("(", commaSep1($._type), optional(","), ")"),

    // ---- expressions -----------------------------------------------------

    _expression: ($) =>
      choice(
        $.binary_expression,
        $.unary_expression,
        $.cast_expression,
        $.is_expression,
        $.range_expression,
        $.keyword_expression,
        $.apply_expression,
        $._primary_expression,
      ),

    // Hidden: a wrapper that only says "this is a primary expression" adds a
    // node to every expression in the tree and tells a reader nothing.
    _primary_expression: ($) =>
      choice(
        $.call_expression,
        $.member_expression,
        $.index_expression,
        $.slice_expression,
        $.parenthesized_expression,
        $.tuple_expression,
        $.list_expression,
        $.map_expression,
        $.set_expression,
        $.identifier,
        $.type_identifier,
        $._literal,
      ),

    binary_expression: ($) =>
      choice(
        ...[
          ["or", PREC.or],
          ["and", PREC.and],
          ["==", PREC.compare], ["!=", PREC.compare],
          ["<", PREC.compare], ["<=", PREC.compare], [">", PREC.compare], [">=", PREC.compare],
          ["+", PREC.add], ["-", PREC.add],
          ["*", PREC.mul], ["/", PREC.mul], ["%", PREC.mul],
        ].map(([op, p]) =>
          prec.left(p, seq(field("left", $._expression), field("operator", op), field("right", $._expression))),
        ),
      ),

    unary_expression: ($) =>
      choice(
        prec.right(PREC.not, seq("not", $._expression)),
        prec.right(PREC.unary, seq(choice("-", "+", "*"), $._expression)),
        prec.right(PREC.unary, seq("&", optional("mut"), $._expression)),
      ),

    cast_expression: ($) => prec.left(PREC.cast, seq(field("value", $._expression), field("operator", choice("as", "to")), field("type", $._type))),
    is_expression: ($) => prec.left(PREC.compare, seq(field("value", $._expression), "is", field("test", choice("null", "error", "ok", "cancelled", $.identifier, $.type_identifier, $.primitive_type)))),

    range_expression: ($) =>
      prec.left(
        PREC.range,
        choice(
          seq(optional(field("start", $._expression)), choice("..", "..="), optional(field("end", $._expression))),
          seq("range", field("start", $._expression), choice("..", "..="), field("end", $._expression), optional(seq("step", field("step", $._expression)))),
        ),
      ),

    /** Keyword-prefixed value forms: `start f()`, `await t`, `borrow x`, ... */
    keyword_expression: ($) =>
      prec.right(
        PREC.unary,
        choice(
          seq(choice("start", "await", "receive", "load", "reflect", "compile", "move", "raw", "device", "launch", "acquire"), $._expression),
          seq("borrow", optional("mut"), $._expression),
          seq("make", choice(seq("channel", optional(seq("(", $._type, ")")), optional(seq(":", $._expression))), "mutex", "rwmutex")),
          seq("atomic", "(", optional($._expression), ")", optional(seq(":", $._expression))),
          "cancelled",
        ),
      ),

    apply_expression: ($) => prec.right(seq("apply", field("value", $._expression), ":", field("function", $._expression))),

    call_expression: ($) =>
      prec(PREC.postfix, seq(field("function", $._primary_expression), optional($.type_arguments), field("arguments", $.argument_list))),
    argument_list: ($) => seq("(", optional(commaSep(choice(seq(optional(seq($.identifier, ":")), $._expression), "..."))), optional(","), ")"),

    member_expression: ($) => prec(PREC.postfix, seq(field("object", $._primary_expression), ".", field("property", $.identifier))),
    index_expression: ($) => prec(PREC.postfix, seq(field("object", $._primary_expression), "[", field("index", $._expression), "]")),
    slice_expression: ($) =>
      prec(PREC.postfix, seq(field("object", $._primary_expression), "[", optional($._expression), ":", optional($._expression), optional(seq(":", optional($._expression))), "]")),

    parenthesized_expression: ($) => seq("(", $._expression, ")"),
    tuple_expression: ($) => seq("(", $._expression, ",", optional(commaSep($._expression)), optional(","), ")"),
    list_expression: ($) => seq("[", optional(commaSep($._expression)), optional(","), "]"),
    map_expression: ($) => seq("[", commaSep1(seq(field("key", $._expression), ":", field("value", $._expression))), optional(","), "]"),
    set_expression: ($) => seq("{", optional(commaSep($._expression)), optional(","), "}"),

    // ---- literals --------------------------------------------------------

    _literal: ($) => choice($.integer, $.float, $.string, $.raw_string, $.character, $.boolean, $.null, $.nothing),

    integer: (_) => token(choice(/0[xX][0-9a-fA-F_]+/, /0[bB][01_]+/, /0[oO][0-7_]+/, /[0-9][0-9_]*/)),
    float: (_) => token(choice(/[0-9][0-9_]*\.[0-9][0-9_]*([eE][+-]?[0-9_]+)?/, /[0-9][0-9_]*[eE][+-]?[0-9_]+/)),

    string: ($) => choice($._triple_string, $._single_string),
    _triple_string: ($) => seq('"""', repeat(choice($.interpolation, $.escape_sequence, $.string_fragment_multi)), '"""'),
    _single_string: ($) => seq('"', repeat(choice($.interpolation, $.escape_sequence, $.string_fragment)), '"'),
    string_fragment: (_) => token.immediate(prec(1, /[^"\\{}\n]+/)),
    string_fragment_multi: (_) => token.immediate(prec(1, /[^"\\{}]+/)),
    raw_string: (_) => token(seq('r"', /[^"]*/, '"')),
    interpolation: ($) => seq("{", $._expression, "}"),
    escape_sequence: (_) => token.immediate(seq("\\", choice(/[ntr0\\"'{}e]/, /u\{[0-9a-fA-F]+\}/))),
    character: ($) => seq("'", choice($.escape_sequence, /[^'\\]/), "'"),

    boolean: (_) => choice("true", "false"),
    null: (_) => "null",
    nothing: (_) => "nothing",

    // ---- identifiers -----------------------------------------------------

    identifier: (_) => /[a-z_][a-zA-Z0-9_]*/,
    type_identifier: (_) => /[A-Z][a-zA-Z0-9_]*/,
  },
});

function commaSep(rule) {
  return seq(rule, repeat(seq(",", rule)));
}

function commaSep1(rule) {
  return seq(rule, repeat(seq(",", rule)));
}

function sep1(rule, separator) {
  return seq(rule, repeat(seq(separator, rule)));
}
