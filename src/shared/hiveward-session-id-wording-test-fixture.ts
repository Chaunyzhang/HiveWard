/** Detect address used as a noun for HiveWard session identity; exclude verbs and distinct run:/dispatch:/group mailboxes. */
export const HIVEWARD_SESSION_ID_AS_ADDRESS =
  /\b(?:orchestration|session|HiveWard|coordinator's|your(?: own)?) address\b|caller\.address|naming its address/i
