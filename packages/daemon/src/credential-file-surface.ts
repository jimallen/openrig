// The NARROW `@openrig/daemon/credential-file` public surface (workspaces-o9o.151): the one rule for reading a credential, token
// or hosts registry file, for the CLI. Every module reached from here imports only Node builtins and each other;
// credential-file-surface.test.ts pins that.
export { inspectCredentialFile, readCredentialFile, nodeCredentialFileReader, type CredentialFileReadOptions } from "./adapters/node-credential-file-reader.js";
export {
  ACTIVITY_ENDPOINT_POLICY, ACTIVITY_HOOK_TOKEN_POLICY, BEARER_FILE_POLICY, CODEX_AUTH_POLICY, HOSTS_REGISTRY_POLICY, PI_AUTH_POLICY,
  PI_MODELS_POLICY, SEAT_CREDENTIAL_LINKS, SLACK_SECRETS_POLICY, TERMINAL_TOKEN_POLICY, credentialFileRefusal, judgeOpenedCredentialFile,
  seatCredentialLinkPolicy, type SeatCredentialLink, type CredentialFileKind, type CredentialFilePolicy, type CredentialFileProblem, type CredentialFileRead, type CredentialFileReader,
} from "./domain/credential-file.js";
