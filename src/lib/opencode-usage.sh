#!/bin/sh
set -eu

# AML deletes invocation state as each Agent ends. Retain only its database for
# the review's final collection step; run the unmodified OpenCode executable.
session_directory=${OPENCODE_DB:?}
session_directory=${session_directory%/*}
export OPENCODE_DB="${REVIEW_OPENCODE_USAGE_DIRECTORY:?}/${session_directory##*/}.db"
exec opencode "$@"
