// External scanner for Halka's layout tokens.
//
// Mirrors compiler/src/lexer/lexer.ts:
//   * a newline terminates a statement (#49)
//   * indentation opens and closes blocks; spaces only (R12)
//   * NEWLINE / INDENT / DEDENT are suppressed inside ( ) [ ] { } (#49)
//   * blank lines and comment-only lines produce no layout tokens (#47)

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

typedef struct {
  // Stack of indentation columns; indents[0] is always 0.
  uint16_t indents[MAX_DEPTH];
  uint8_t indent_len;
  // Number of DEDENTs still owed to the parser from one dedenting line.
  uint8_t pending_dedents;
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
  s->bracket_depth = 0;
  s->eof_newline = false;
  if (length == 0) return;

  unsigned i = 0;
  s->pending_dedents = (uint8_t)buffer[i++];
  s->bracket_depth = (uint16_t)((unsigned char)buffer[i]) | (uint16_t)((unsigned char)buffer[i + 1] << 8);
  i += 2;
  s->eof_newline = buffer[i++] != 0;

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

static void advance(TSLexer *lexer) { lexer->advance(lexer, false); }
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

  // Hand back DEDENTs one at a time.
  if (s->pending_dedents > 0 && valid_symbols[DEDENT]) {
    s->pending_dedents--;
    lexer->result_symbol = DEDENT;
    return true;
  }

  // Close every open block at end of file. Each DEDENT pops the stack, so
  // that sequence terminates on its own; the final NEWLINE does not consume
  // anything, so it is handed over exactly once.
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

  // Track bracket nesting so layout is suppressed inside them (#49).
  // The main grammar consumes the bracket characters; we only observe.
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
  uint16_t column = (uint16_t)lexer->get_column(lexer);
  uint16_t current = s->indents[s->indent_len - 1];

  if (column > current && valid_symbols[INDENT]) {
    if (s->indent_len < MAX_DEPTH) s->indents[s->indent_len++] = column;
    lexer->result_symbol = INDENT;
    return true;
  }

  if (column < current && valid_symbols[DEDENT]) {
    uint8_t count = 0;
    while (s->indent_len > 1 && s->indents[s->indent_len - 1] > column) {
      s->indent_len--;
      count++;
    }
    if (count > 0) {
      s->pending_dedents = (uint8_t)(count - 1);
      lexer->result_symbol = DEDENT;
      return true;
    }
  }

  if (valid_symbols[NEWLINE]) {
    lexer->result_symbol = NEWLINE;
    return true;
  }
  return false;
}
