// Public surface for the culture-file guard (domain/culture-file-guard.ts), so the CLI reads a culture
// file with the same checks the daemon applies (regular file, one link, size cap, O_NONBLOCK) instead of
// a plain read that a FIFO would hang.
export { checkCultureFile, CULTURE_FILE_MAX_BYTES, type CultureFileCheck } from "./domain/culture-file-guard.js";
