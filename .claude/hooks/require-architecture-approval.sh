#!/bin/bash
# Architecture approval gate — blocks implementation edits until feature architecture is approved.
# Requires Git Bash or WSL on Windows.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty')

if [[ -z "$FILE_PATH" ]]; then exit 0; fi

# Always allow architecture/doc files
case "$FILE_PATH" in
  CLAUDE.md|ARCHITECTURE.md|PROJECT_BUILD_LOG.md|PROJECT_DECISIONS.md|PROJECT_RULES.md|PROJECT_SCORECARD.md)
    exit 0 ;;
  .claude/*|features/*|docs/*|*.md)
    exit 0 ;;
esac

# Guard implementation paths
if [[ "$FILE_PATH" =~ ^(src|app|components|pages|styles|lib|server|api|routes|services|db|prisma|supabase|scripts|ios|android)/ ]]; then
  if grep -r "Architecture approved: Yes" features/*/FEATURE_ARCHITECTURE.md >/dev/null 2>&1 && \
     grep -r "Implementation allowed: Yes" features/*/FEATURE_ARCHITECTURE.md >/dev/null 2>&1; then
    exit 0
  fi
  echo "BLOCKED: Implementation edits require approved feature architecture." >&2
  echo "Create or update features/<name>/FEATURE_ARCHITECTURE.md with:" >&2
  echo "  Architecture approved: Yes" >&2
  echo "  Implementation allowed: Yes" >&2
  exit 2
fi

exit 0
