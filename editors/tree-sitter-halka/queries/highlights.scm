; Halka highlight queries (Neovim / Helix / Zed).

; ---- comments ---------------------------------------------------------------
(line_comment) @comment
(block_comment) @comment

; ---- literals ---------------------------------------------------------------
(integer) @number
(float) @number.float
(string) @string
(raw_string) @string.special
(character) @character
(escape_sequence) @string.escape
(boolean) @boolean
(null) @constant.builtin
(nothing) @constant.builtin

(interpolation "{" @punctuation.special "}" @punctuation.special)

; ---- types ------------------------------------------------------------------
(primitive_type) @type.builtin
(type_identifier) @type
(type_parameter name: (identifier) @type.parameter)
(optional_type "?" @punctuation.special)
(ffi_marker) @keyword.import

; ---- declarations -----------------------------------------------------------
(function_declaration name: (identifier) @function)
(function_declaration marker: _ @keyword.modifier)
(parameter name: (identifier) @variable.parameter)
(struct_declaration name: (type_identifier) @type.definition)
(field_declaration name: (identifier) @variable.member)
(enum_declaration name: (type_identifier) @type.definition)
(enum_variant name: (type_identifier) @constructor)
(trait_declaration name: (type_identifier) @type.definition)
(type_alias name: (type_identifier) @type.definition)
(capability_declaration name: (type_identifier) @type.definition)

; ---- calls ------------------------------------------------------------------
(call_expression function: (primary_expression (identifier) @function.call))
(call_expression function: (primary_expression (member_expression property: (identifier) @function.method.call)))
(command_call function: (identifier) @function.call)
(member_expression property: (identifier) @variable.member)

; ---- keywords ---------------------------------------------------------------
[
  "let" "const" "type" "enum" "trait" "implements" "capability"
  "macro" "generate" "specialize" "extern" "requires"
] @keyword

["import" "from" "export"] @keyword.import

[
  "if" "else" "for" "while" "match" "break" "continue"
  "give" "defer" "with" "parallel" "unsafe" "in" "step"
] @keyword.control

[
  "start" "await" "send" "receive" "make" "atomic" "load" "store"
  "cancel" "cancelled" "release" "register" "revoke" "launch" "kernel" "device"
] @keyword.coroutine

["borrow" "move" "raw" "mut"] @keyword.modifier
["and" "or" "not" "is" "as" "to" "apply"] @keyword.operator
"say" @keyword.function

; ---- operators and punctuation ----------------------------------------------
[
  "+" "-" "*" "/" "%"
  "==" "!=" "<" "<=" ">" ">="
  ".." "..=" "&" "..."
] @operator

":" @operator
"," @punctuation.delimiter
"." @punctuation.delimiter
["(" ")" "[" "]" "{" "}"] @punctuation.bracket

; ---- identifiers ------------------------------------------------------------
"_" @variable.builtin
(identifier) @variable
