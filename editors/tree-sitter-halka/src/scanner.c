// External scanner for Halka's layout tokens.
//
// Mirrors compiler/src/lexer/lexer.ts:
//   * a newline terminates a statement (#49)
//   * indentation opens and closes blocks; spaces only (R12)
//   * NEWLINE / INDENT / DEDENT are suppressed inside ( ) [ ] { } (#49)
//   * blank lines and comment-only lines produce no layout tokens (#47)
//
// The grammar asks for these in sequence: a block is
// `NEWLINE INDENT statement+ DEDENT`, and each statement inside it ends with
// its own NEWLINE. But one line break in the source has to produce all of
// that, and a scanner may only return one token per call. So a line break is
// scanned once and the layout it implies is *queued*: the NEWLINE goes back
// first, and the INDENT or the run of DEDENTs follows on later calls, before
// any further input is read.

#include "tree_sitter/parser.h"

#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <wctype.h>

enum TokenType {
  NEWLINE,
  INDENT,
  DEDENT,
};

#define MAX_DEPTH 256
#define NO_INDENT 0xFFFF

typedef struct {
  // Stack of indentation columns; indents[0] is always 0.
  uint16_t indents[MAX_DEPTH];
  uint8_t indent_len;
  // Number of DEDENTs still owed to the parser from one dedenting line.
  // Each one pops the stack as it is handed over.
  uint8_t pending_dedents;
  // Column of an INDENT owed to the parser, or NO_INDENT.
  uint16_t pending_indent;
  // Open bracket nesting; layout is suppressed while this is non-zero.
  uint16_t bracket_depth;
  // Whether the closing NEWLINE at end of file has already been handed over.
  // Without this the scanner returns a zero-width NEWLINE at EOF, tree-sitter
  // calls it again at the same position, NEWLINE is still valid, and the
  // parser spins forever on any input at all.
  bool eof_newline;
} Scanner;

void *tree_sitter_halka_external_scanner_create(void) {
  Scanner *s = (Scanner *)calloc(1, sizeof(Scanner));
  s->indents[0] = 0;
  s->indent_len = 1;
  s->pending_indent = NO_INDENT;
  return s;
}

void tree_sitter_halka_external_scanner_destroy(void *payload) { free(payload); }

unsigned tree_sitter_halka_external_scanner_serialize(void *payload, char *buffer) {
  Scanner *s = (Scanner *)payload;
  unsigned size = 0;

  buffer[size++] = (char)s->pending_dedents;
  buffer[size++] = (char)(s->bracket_depth & 0xFF);
  buffer[size++] = (char)((s->bracket_depth >> 8) & 0xFF);
  buffer[size++] = (char)(s->eof_newline ? 1 : 0);
  buffer[size++] = (char)(s->pending_indent & 0xFF);
  buffer[size++] = (char)((s->pending_indent >> 8) & 0xFF);

  uint8_t n = s->indent_len;
  if ((size_t)(size + 1 + n * 2) > TREE_SITTER_SERIALIZATION_BUFFER_SIZE) {
    n = (uint8_t)((TREE_SITTER_SERIALIZATION_BUFFER_SIZE - size - 1) / 2);
  }
  buffer[size++] = (char)n;
  for (uint8_t i = 0; i < n; i++) {
    buffer[size++] = (char)(s->indents[i] & 0xFF);
    buffer[size++] = (char)((s->indents[i] >> 8) & 0xFF);
  }
  return size;
}

void tree_sitter_halka_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  Scanner *s = (Scanner *)payload;
  s->indents[0] = 0;
  s->indent_len = 1;
  s->pending_dedents = 0;
  s->pending_indent = NO_INDENT;
  s->bracket_depth = 0;
  s->eof_newline = false;
  if (length == 0) return;

  unsigned i = 0;
  s->pending_dedents = (uint8_t)buffer[i++];
  s->bracket_depth = (uint16_t)((unsigned char)buffer[i]) | (uint16_t)((unsigned char)buffer[i + 1] << 8);
  i += 2;
  s->eof_newline = buffer[i++] != 0;
  s->pending_indent = (uint16_t)((unsigned char)buffer[i]) | (uint16_t)((unsigned char)buffer[i + 1] << 8);
  i += 2;

  uint8_t n = (uint8_t)buffer[i++];
  s->indent_len = 0;
  for (uint8_t k = 0; k < n && i + 1 < length; k++) {
    s->indents[s->indent_len++] =
        (uint16_t)((unsigned char)buffer[i]) | (uint16_t)((unsigned char)buffer[i + 1] << 8);
    i += 2;
  }
  if (s->indent_len == 0) {
    s->indents[0] = 0;
    s->indent_len = 1;
  }
}

static void skip(TSLexer *lexer) { lexer->advance(lexer, true); }

/** Consume a `#` line comment or a `### ... ###` block comment (#47). */
static void skip_comment(TSLexer *lexer) {
  // Already positioned on the first '#'.
  skip(lexer);
  if (lexer->lookahead == '#') {
    skip(lexer);
    if (lexer->lookahead == '#') {
      skip(lexer);
      // Block comment: run to the closing ###.
      int hashes = 0;
      while (!lexer->eof(lexer)) {
        if (lexer->lookahead == '#') {
          hashes++;
          skip(lexer);
          if (hashes == 3) return;
        } else {
          hashes = 0;
          skip(lexer);
        }
      }
      return;
    }
  }
  while (!lexer->eof(lexer) && lexer->lookahead != '\n') skip(lexer);
}

bool tree_sitter_halka_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  Scanner *s = (Scanner *)payload;

  // ---- queued layout, before any further input is read -------------------

  // Hand back DEDENTs one at a time, popping as we go.
  if (s->pending_dedents > 0 && valid_symbols[DEDENT]) {
    s->pending_dedents--;
    if (s->indent_len > 1) s->indent_len--;
    lexer->result_symbol = DEDENT;
    return true;
  }

  // The INDENT owed from the line break already scanned.
  if (s->pending_indent != NO_INDENT && valid_symbols[INDENT]) {
    if (s->indent_len < MAX_DEPTH) s->indents[s->indent_len++] = s->pending_indent;
    s->pending_indent = NO_INDENT;
    lexer->result_symbol = INDENT;
    return true;
  }

  // ---- end of file -------------------------------------------------------

  // Close every open block. Each DEDENT pops the stack, so that sequence
  // terminates on its own; the final NEWLINE consumes nothing, so it is
  // handed over exactly once.
  if (lexer->eof(lexer)) {
    if (s->indent_len > 1 && valid_symbols[DEDENT]) {
      s->indent_len--;
      lexer->result_symbol = DEDENT;
      return true;
    }
    if (!s->eof_newline && valid_symbols[NEWLINE]) {
      s->eof_newline = true;
      lexer->result_symbol = NEWLINE;
      return true;
    }
    return false;
  }

  // ---- scan to the start of the next significant line --------------------

  bool saw_newline = false;
  for (;;) {
    if (lexer->lookahead == ' ' || lexer->lookahead == '\t' || lexer->lookahead == '\r') {
      skip(lexer);
      continue;
    }
    if (lexer->lookahead == '\n') {
      saw_newline = true;
      skip(lexer);
      continue;
    }
    if (lexer->lookahead == '#') {
      // A comment on its own line must not produce layout tokens.
      skip_comment(lexer);
      continue;
    }
    break;
  }

  if (!saw_newline) return false;
  if (s->bracket_depth > 0) return false;

  if (lexer->eof(lexer)) {
    if (!s->eof_newline && valid_symbols[NEWLINE]) {
      s->eof_newline = true;
      lexer->result_symbol = NEWLINE;
      return true;
    }
    return false;
  }

  lexer->mark_end(lexer);

  // A new line begins here, so anything queued from an earlier one that the
  // parser never took is stale.
  s->pending_indent = NO_INDENT;

  uint16_t column = (uint16_t)lexer->get_column(lexer);
  uint16_t current = s->indents[s->indent_len - 1];

  // Deeper: the line opens a block. The grammar wants the statement's
  // NEWLINE before the INDENT, so queue the INDENT and return the NEWLINE
  // first when that is what is expected here.
  if (column > current) {
    // NEWLINE comes first whenever it is also on offer. In a state the parser
    // reached by more than one route both can be valid at once, and taking
    // INDENT there skips the NEWLINE that `_block` requires, so the block
    // never parses.
    if (valid_symbols[NEWLINE]) {
      s->pending_indent = column;
      lexer->result_symbol = NEWLINE;
      return true;
    }
    if (valid_symbols[INDENT]) {
      if (s->indent_len < MAX_DEPTH) s->indents[s->indent_len++] = column;
      lexer->result_symbol = INDENT;
      return true;
    }
    return false;
  }

  // Shallower: the line closes one or more blocks. Same ordering problem,
  // so the run of DEDENTs is queued and the NEWLINE goes back first.
  if (column < current) {
    uint8_t count = 0;
    uint8_t probe = s->indent_len;
    while (probe > 1 && s->indents[probe - 1] > column) {
      probe--;
      count++;
    }
    if (count > 0) {
      // Same ordering rule as for INDENT above.
      if (valid_symbols[NEWLINE]) {
        s->pending_dedents = count;
        lexer->result_symbol = NEWLINE;
        return true;
      }
      if (valid_symbols[DEDENT]) {
        s->indent_len--;
        s->pending_dedents = (uint8_t)(count - 1);
        lexer->result_symbol = DEDENT;
        return true;
      }
      return false;
    }
  }

  if (valid_symbols[NEWLINE]) {
    lexer->result_symbol = NEWLINE;
    return true;
  }
  return false;
}
