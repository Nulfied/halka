; Scope and reference tracking for Halka.

(source_file) @local.scope
(function_declaration) @local.scope
(match_arm) @local.scope
(for_statement) @local.scope
(while_statement) @local.scope
(if_statement) @local.scope
(with_statement) @local.scope
(parallel_statement) @local.scope
(unsafe_statement) @local.scope

(parameter name: (identifier) @local.definition.parameter)
(function_declaration name: (identifier) @local.definition.function)
(struct_declaration name: (type_identifier) @local.definition.type)
(enum_declaration name: (type_identifier) @local.definition.type)
(enum_variant name: (type_identifier) @local.definition.constant)
(type_alias name: (type_identifier) @local.definition.type)
(let_statement pattern: (pattern (identifier) @local.definition.var))
(for_statement pattern: (pattern (identifier) @local.definition.var))

(identifier) @local.reference
